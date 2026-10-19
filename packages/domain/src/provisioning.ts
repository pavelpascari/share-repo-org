import type { AccessLevel } from "./entitlement.ts";
import type { GrantState, MutationOperation, MutationStatus, RetryClass } from "./grant.ts";
import { type InvitationBudget, preferredGrant } from "./reconciliation.ts";
import type { Instant } from "./time.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long a provider invitation stays acceptable after it is sent (GitHub: 7 days). */
export const INVITATION_LIFETIME_MS = 7 * 24 * HOUR_MS;
/** Invitations ShareRepo sends per repository in any rolling window (decision 0010). */
export const INVITATION_BUDGET = 40;
/** The rolling window of the invitation budget. */
export const INVITATION_WINDOW_MS = 24 * HOUR_MS;
/**
 * How long a fresh change may be missing from the provider's lists (eventual consistency) before
 * observation believes the lists over the stored intent.
 */
export const OBSERVATION_GRACE_MS = 5 * MINUTE_MS;
/** Provider mutations one reconciliation run performs at most. */
export const MAX_MUTATIONS_PER_RUN = 10;
/** How soon a repository is reconciled again while anything on it is in flight. */
export const RECONCILE_POLL_MS = 15 * MINUTE_MS;
/** How soon a repository is reconciled again when nothing on it is in flight. */
export const RECONCILE_IDLE_MS = 6 * HOUR_MS;
/** Backoff after a grant's 1st, 2nd, 3rd and 4th consecutive retryable failure; then the last. */
export const RETRY_BACKOFF_MS = [1, 5, 15, 60].map((minutes) => minutes * MINUTE_MS);
/** The access level an observed invitation gives: v1 invites to personal repositories (0008). */
const INVITED_ACCESS_LEVEL: AccessLevel = "write";

// Observation ---------------------------------------------------------------------------------

/** A collaborator the provider lists on the repository. */
export interface ObservedCollaborator {
  /** The provider's immutable user ID; people are matched by it, never by login. */
  readonly userId: string;
  readonly login: string;
  readonly accessLevel: AccessLevel;
  /** Listed among the direct collaborators; false when only the full list has them. */
  readonly direct: boolean;
}

/** An invitation to the repository the provider lists, accepted or not. */
export interface ObservedInvitation {
  readonly invitationId: string;
  readonly userId: string;
  readonly login: string;
  readonly createdAt: Instant;
  /** The provider says it has lapsed. */
  readonly expired: boolean;
}

/** One repository's access as the provider lists it. */
export interface RepositoryObservation {
  readonly collaborators: readonly ObservedCollaborator[];
  readonly invitations: readonly ObservedInvitation[];
}

/** A grant's latest provider mutation, whatever its status. */
export interface LatestMutation {
  readonly operation: MutationOperation;
  readonly status: MutationStatus;
  readonly retryClass: RetryClass | null;
  readonly startedAt: Instant;
}

/** The stored grant fields observation reads. */
export interface ObservableGrant {
  readonly id: string;
  readonly subjectId: string;
  readonly accessLevel: AccessLevel;
  readonly state: GrantState;
  readonly managed: boolean;
  readonly indirect: boolean;
  readonly externalGrantId: string | null;
  readonly expiresAt: Instant | null;
  readonly lastErrorCode: string | null;
  readonly retryClass: RetryClass | null;
  readonly nextAttemptAt: Instant | null;
  readonly updatedAt: Instant;
  /**
   * The grant's latest mutation, so an `error` or intermediate grant knows what it was doing and
   * how that ended: whether listed access is ShareRepo's or was granted by hand.
   */
  readonly lastMutation: LatestMutation | null;
}

/** The grant fields observation writes. */
export interface GrantFields {
  readonly state: GrantState;
  readonly accessLevel: AccessLevel;
  readonly managed: boolean;
  readonly indirect: boolean;
  readonly externalGrantId: string | null;
  readonly expiresAt: Instant | null;
  readonly lastErrorCode: string | null;
  readonly retryClass: RetryClass | null;
  readonly nextAttemptAt: Instant | null;
}

/** A grant to store for a subject that had none. */
export interface GrantObservationCreate {
  readonly kind: "create";
  readonly grantId: string;
  readonly subjectId: string;
  readonly set: GrantFields;
}

/** A change to a stored grant; `set` holds only the fields that change, and at least one. */
export interface GrantObservationUpdate {
  readonly kind: "update";
  readonly grantId: string;
  readonly subjectId: string;
  readonly from: GrantFields;
  readonly set: Partial<GrantFields>;
  /**
   * The change settles an intent (`provisioning`, `revoking`) or a failed mutation's outcome, so
   * the caller resolves the grant's `started` mutations.
   */
  readonly settlesIntent: boolean;
}

export type GrantObservationChange = GrantObservationCreate | GrantObservationUpdate;

/** A workspace subject observation looks for, by the provider's immutable user ID. */
export interface GrantObservationSubject {
  readonly id: string;
  readonly externalSubjectId: string;
}

export interface GrantObservationInput {
  readonly now: Instant;
  /** The workspace's subjects to observe; anyone else the provider lists is ignored. */
  readonly subjects: readonly GrantObservationSubject[];
  /** The repository's stored grants. */
  readonly grants: readonly ObservableGrant[];
  readonly observation: RepositoryObservation;
  readonly newGrantId: () => string;
}

/** What the provider lists for one person. A collaborator wins over an invitation. */
type Presence =
  | { readonly kind: "none" }
  | { readonly kind: "collaborator"; readonly accessLevel: AccessLevel; readonly indirect: boolean }
  | {
      readonly kind: "invitation";
      readonly invitationId: string;
      readonly createdAt: Instant;
      readonly expiresAt: Instant;
    };

interface Next {
  readonly fields: GrantFields;
  readonly settlesIntent: boolean;
}

/**
 * Turns one repository's observation into grant changes (decision 0010), sorted by subject ID.
 * Pure. Each subject has at most one grant: when several are stored, the one with the highest
 * level, then the lowest ID, is updated (keeping its level if another holds the listed one) and
 * the rest are left alone. Observation sets `managed` only while ShareRepo's own invitation intent
 * is outstanding (`provisioning`, an error from an `invite` whose response may have been lost, or
 * a managed grant keeping its own invitation), and clears it whenever the access is gone. Access
 * listed after ShareRepo's revoke succeeded, or after GitHub refused its invitation, was granted
 * by hand and is unmanaged. Applying the changes and observing the same lists again changes
 * nothing.
 */
export function observeGrants(input: GrantObservationInput): GrantObservationChange[] {
  const { now, observation } = input;
  const changes: GrantObservationChange[] = [];
  for (const subjectId of input.subjects.map((s) => s.id).sort()) {
    const subject = input.subjects.find((s) => s.id === subjectId) as GrantObservationSubject;
    const own = input.grants.filter((g) => g.subjectId === subjectId);
    const grant = preferredGrant(own);
    const presence = presenceOf(subject.externalSubjectId, observation, grant, now);
    if (grant === undefined) {
      if (presence.kind === "none") continue;
      const set = fieldsFor(presence, NEW_GRANT, false);
      changes.push({ kind: "create", grantId: input.newGrantId(), subjectId, set });
      continue;
    }
    const from = fieldsOf(grant);
    const next = transition(grant, from, presence, now);
    if (next === null) continue;
    // A subject holds one grant per level (the grants unique key), so a level another of its
    // grants holds is not taken over; the preferred grant, and so the outcome, stays stable.
    const taken = own.some((g) => g.accessLevel === next.fields.accessLevel);
    const set = changed(
      from,
      taken ? { ...next.fields, accessLevel: from.accessLevel } : next.fields,
    );
    if (Object.keys(set).length === 0) continue;
    changes.push({
      kind: "update",
      grantId: grant.id,
      subjectId,
      from,
      set,
      settlesIntent: next.settlesIntent,
    });
  }
  return changes;
}

/** The stored grant's next fields for what the provider lists, or null to leave it alone. */
function transition(
  grant: ObservableGrant,
  from: GrantFields,
  presence: Presence,
  now: Instant,
): Next | null {
  // When nothing is listed, the fields are absent and unmanaged whatever `managed` says.
  const to = (managed: boolean, settlesIntent = false): Next => ({
    fields: fieldsFor(presence, from, managed),
    settlesIntent,
  });
  const fresh = now - grant.updatedAt < OBSERVATION_GRACE_MS;
  switch (grant.state) {
    case "unknown":
    case "absent":
      return to(false);
    case "provisioning":
      // Nothing listed yet: the PUT may not show for a moment, or it never landed.
      if (presence.kind === "none" && fresh) return null;
      return to(true, true);
    case "pending_invitation":
      if (presence.kind === "none" && grant.managed && invitedRecently(grant, now)) return null;
      return to(keepsManaged(grant, presence));
    case "active":
      return to(
        presence.kind === "invitation"
          ? grant.managed && presence.invitationId === grant.externalGrantId
          : grant.managed,
      );
    case "revoking":
      // Still listed: the DELETE may not show for a moment, or it never landed.
      if (presence.kind !== "none" && fresh) return null;
      return to(keepsManagedWhileRevoking(grant, presence), true);
    case "error":
      return fromError(grant, from, presence);
  }
}

/** An errored grant settles by what its failed mutation was doing. */
function fromError(grant: ObservableGrant, from: GrantFields, presence: Presence): Next | null {
  switch (grant.lastMutation?.operation ?? null) {
    case "invite": {
      // While nothing is listed, it is still to be retried.
      if (presence.kind === "none") return null;
      // A retryable failure (an outage, a lost response) may have landed after all; any other
      // means GitHub refused it, so what is listed was granted by hand.
      const landed = (grant.lastMutation as LatestMutation).retryClass === "retryable";
      return { fields: fieldsFor(presence, from, landed), settlesIntent: true };
    }
    case "remove_collaborator":
    case "cancel_invitation": {
      if (presence.kind === "none") return { fields: absent(from), settlesIntent: true };
      // Still listed: the error stands, with the details refreshed.
      const listed = fieldsFor(presence, from, keepsManaged(grant, presence));
      return { fields: { ...listed, state: "error", ...errorOf(from) }, settlesIntent: false };
    }
    case null:
      // No mutation to settle: like `unknown`, but an error with no access stays visible.
      if (presence.kind === "none") return null;
      return { fields: fieldsFor(presence, from, false), settlesIntent: false };
  }
}

/**
 * Whether a managed grant stays managed for what is listed: an invitation must be its own (the
 * stored ID, or the first one seen after ShareRepo invited); a collaborator is the accepted
 * invitation. Never makes an unmanaged grant managed.
 */
function keepsManaged(grant: ObservableGrant, presence: Presence): boolean {
  if (presence.kind !== "invitation") return grant.managed;
  return (
    grant.managed &&
    (presence.invitationId === grant.externalGrantId || grant.externalGrantId === null)
  );
}

/**
 * Whether a revoking grant whose access is still listed (after the grace window) stays managed.
 * Once its revoke succeeded, the access is the creator's, granted again by hand. While the
 * revoke's outcome is unknown, the access may be ShareRepo's that the DELETE never removed, so it
 * stays as it was, and the planner revokes again; but an invitation created after the revoke
 * started cannot be ShareRepo's.
 */
function keepsManagedWhileRevoking(grant: ObservableGrant, presence: Presence): boolean {
  const revoke = grant.lastMutation?.operation === "invite" ? null : grant.lastMutation;
  if (revoke == null) return grant.managed;
  if (revoke.status === "succeeded") return false;
  if (presence.kind !== "invitation") return grant.managed;
  return grant.managed && presence.createdAt < revoke.startedAt;
}

/** A managed invitation sent within the grace window may not be listed yet. */
function invitedRecently(grant: ObservableGrant, now: Instant): boolean {
  // A grant with no lapse instant has no invitation sent at all.
  const sentAt = (grant.expiresAt ?? Number.NEGATIVE_INFINITY) - INVITATION_LIFETIME_MS;
  return now - sentAt < OBSERVATION_GRACE_MS;
}

const NO_ERROR = { lastErrorCode: null, retryClass: null, nextAttemptAt: null } as const;

const NEW_GRANT: GrantFields = {
  state: "absent",
  accessLevel: INVITED_ACCESS_LEVEL,
  managed: false,
  indirect: false,
  externalGrantId: null,
  expiresAt: null,
  ...NO_ERROR,
};

/** The fields for what is listed; leaving any state but `error` clears the error fields. */
function fieldsFor(presence: Presence, base: GrantFields, managed: boolean): GrantFields {
  switch (presence.kind) {
    case "none":
      return absent(base);
    case "collaborator":
      return {
        ...base,
        ...NO_ERROR,
        state: "active",
        accessLevel: presence.accessLevel,
        managed,
        indirect: presence.indirect,
        externalGrantId: null,
        expiresAt: null,
      };
    case "invitation":
      return {
        ...base,
        ...NO_ERROR,
        state: "pending_invitation",
        managed,
        indirect: false,
        externalGrantId: presence.invitationId,
        expiresAt: presence.expiresAt,
      };
  }
}

/** No access is listed: the grant is absent and no longer managed. */
function absent(base: GrantFields): GrantFields {
  return {
    ...base,
    ...NO_ERROR,
    state: "absent",
    managed: false,
    indirect: false,
    externalGrantId: null,
    expiresAt: null,
  };
}

function errorOf(
  fields: GrantFields,
): Pick<GrantFields, "lastErrorCode" | "retryClass" | "nextAttemptAt"> {
  return {
    lastErrorCode: fields.lastErrorCode,
    retryClass: fields.retryClass,
    nextAttemptAt: fields.nextAttemptAt,
  };
}

/** What the provider lists for a user. */
function presenceOf(
  userId: string,
  observation: RepositoryObservation,
  grant: ObservableGrant | undefined,
  now: Instant,
): Presence {
  const collaborators = observation.collaborators.filter((c) => c.userId === userId);
  if (collaborators.length > 0) {
    // Direct access wins over indirect, then the higher level.
    const direct = collaborators.filter((c) => c.direct);
    const candidates = direct.length > 0 ? direct : collaborators;
    const write = candidates.some((c) => c.accessLevel === "write");
    return {
      kind: "collaborator",
      accessLevel: write ? "write" : "read",
      indirect: direct.length === 0,
    };
  }
  const invitation = preferredInvitation(
    observation.invitations.filter((i) => i.userId === userId),
    grant?.externalGrantId ?? null,
  );
  if (invitation === undefined) return { kind: "none" };
  const lapses = invitation.createdAt + INVITATION_LIFETIME_MS;
  let expiresAt = lapses;
  if (invitation.expired) {
    // An invitation the provider calls expired has lapsed by now at the latest. Keep the instant
    // already stored for it, so observing it again changes nothing.
    const stored =
      grant?.externalGrantId === invitation.invitationId ? (grant.expiresAt ?? now) : now;
    expiresAt = Math.min(lapses, stored, now);
  }
  return {
    kind: "invitation",
    invitationId: invitation.invitationId,
    createdAt: invitation.createdAt,
    expiresAt,
  };
}

/** The grant's own invitation if listed, else the newest live one, then the lowest ID. */
function preferredInvitation(
  invitations: readonly ObservedInvitation[],
  storedId: string | null,
): ObservedInvitation | undefined {
  const own = invitations.find((i) => i.invitationId === storedId);
  if (own !== undefined) return own;
  // By ID first; the stable sort then keeps the lowest ID among equals.
  const byId = invitations
    .map((i) => i.invitationId)
    .sort()
    .map((id) => invitations.find((i) => i.invitationId === id) as ObservedInvitation);
  return byId.sort((a, b) => Number(a.expired) - Number(b.expired) || b.createdAt - a.createdAt)[0];
}

function fieldsOf(grant: ObservableGrant): GrantFields {
  return {
    state: grant.state,
    accessLevel: grant.accessLevel,
    managed: grant.managed,
    indirect: grant.indirect,
    externalGrantId: grant.externalGrantId,
    expiresAt: grant.expiresAt,
    lastErrorCode: grant.lastErrorCode,
    retryClass: grant.retryClass,
    nextAttemptAt: grant.nextAttemptAt,
  };
}

function changed(from: GrantFields, to: GrantFields): Partial<GrantFields> {
  const keys = Object.keys(to) as (keyof GrantFields)[];
  return Object.fromEntries(
    keys.filter((key) => from[key] !== to[key]).map((key) => [key, to[key]]),
  );
}

// Failure classification ----------------------------------------------------------------------

/** How a provider call failed, in provider-neutral terms. Adapters map their errors to these. */
export const PROVIDER_FAILURE_KINDS = [
  "not_found",
  "suspended",
  "rate_limited",
  "transient",
  "rejected",
  "malformed_response",
] as const;
export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];

export interface ProviderFailure {
  readonly kind: ProviderFailureKind;
  /** The provider's HTTP status, when it gave one. */
  readonly status?: number;
  /** How long the provider asked to wait. */
  readonly retryAfterMs?: number;
  /**
   * What a `not_found` was about, when the adapter can tell. `installation`: the app's
   * installation is gone (its access token could not be minted).
   */
  readonly target?: "account" | "repository" | "installation";
}

/** Why a grant's last mutation failed. Stable codes, stored and shown to creators. */
export const GRANT_ERROR_CODES = [
  "provider_unavailable",
  "rate_limited",
  "invitation_rejected",
  "app_permission_missing",
  "account_not_found",
  "provider_rejected",
] as const;
export type GrantErrorCode = (typeof GRANT_ERROR_CODES)[number];

/**
 * Why a failure stops the whole run and leaves the grant unchanged. Also the error code of the
 * failed mutation. Each makes the caller queue a resync of the connection.
 */
export const MUTATION_STOP_REASONS = [
  "suspended",
  "repository_not_found",
  "installation_missing",
] as const;
export type MutationStopReason = (typeof MUTATION_STOP_REASONS)[number];

export type MutationFailureOutcome =
  /** What the mutation wanted is already true: a success. */
  | { readonly outcome: "already_done" }
  | {
      readonly outcome: "failed";
      readonly errorCode: GrantErrorCode;
      readonly retryClass: RetryClass;
      /** When it may be retried; null when a person must act first. */
      readonly nextAttemptAt: Instant | null;
      /** Stop the run: further calls would fail the same way. */
      readonly stopRun: boolean;
    }
  | { readonly outcome: "stop_run"; readonly reason: MutationStopReason };

export interface MutationFailureInput {
  readonly operation: MutationOperation;
  readonly failure: ProviderFailure;
  /** This grant's consecutive failures, this one included (1-based). */
  readonly attempt: number;
  readonly now: Instant;
}

/** Classifies a failed provider mutation (phase 4 plan, errors table). Pure. */
export function classifyMutationFailure(input: MutationFailureInput): MutationFailureOutcome {
  const { operation, failure, now } = input;
  const revokes = operation !== "invite";
  switch (failure.kind) {
    case "transient":
    case "malformed_response":
      return failed("provider_unavailable", "retryable", now + retryBackoff(input.attempt));
    case "rate_limited": {
      const wait = Math.max(failure.retryAfterMs ?? 0, MINUTE_MS);
      // Every further call would be limited too.
      return failed("rate_limited", "rate_limited", now + wait, true);
    }
    case "rejected":
      if (failure.status === 403) {
        return failed("app_permission_missing", "user_action_required", null);
      }
      if (failure.status === 422 && !revokes) {
        return failed("invitation_rejected", "user_action_required", null);
      }
      return failed("provider_rejected", "terminal", null);
    case "not_found":
      if (failure.target === "repository") {
        return { outcome: "stop_run", reason: "repository_not_found" };
      }
      if (failure.target === "installation") {
        return { outcome: "stop_run", reason: "installation_missing" };
      }
      // Removing what is already gone succeeded; an invitee that is gone must be fixed by a person.
      return revokes
        ? { outcome: "already_done" }
        : failed("account_not_found", "user_action_required", null);
    case "suspended":
      return { outcome: "stop_run", reason: "suspended" };
  }
}

function failed(
  errorCode: GrantErrorCode,
  retryClass: RetryClass,
  nextAttemptAt: Instant | null,
  stopRun = false,
): MutationFailureOutcome {
  return { outcome: "failed", errorCode, retryClass, nextAttemptAt, stopRun };
}

/** Why a repository's last observation failed. Stable codes, stored and shown to creators. */
export const OBSERVATION_ERROR_CODES = [
  "provider_unavailable",
  "rate_limited",
  "provider_rejected",
  "malformed_response",
  "suspended",
  "repository_not_found",
  "installation_missing",
] as const;
export type ObservationErrorCode = (typeof OBSERVATION_ERROR_CODES)[number];

export interface ObservationFailureInput {
  readonly failure: ProviderFailure;
  /** The repository's consecutive failed observations, this one included (1-based). */
  readonly failures: number;
  readonly now: Instant;
}

export interface ObservationFailureOutcome {
  readonly errorCode: ObservationErrorCode;
  readonly nextReconcileAt: Instant;
  /** Queue a resync of the connection: the installation or the repository may be gone. */
  readonly resync: boolean;
}

/**
 * Classifies a failed observation of a repository. Pure. A provider failure backs off by the
 * repository's consecutive failures (a rate limit waits at least the provider's wait), so a
 * repository GitHub keeps refusing is not polled every minute; a refusal or a malformed response
 * is recorded and shown, and keeps backing off. A suspended or missing installation, or a
 * repository that is gone or renamed, queues a resync, whose changes queue the next run.
 */
export function classifyObservationFailure(
  input: ObservationFailureInput,
): ObservationFailureOutcome {
  const { failure, now } = input;
  const backoff = retryBackoff(input.failures);
  const outcome = (
    errorCode: ObservationErrorCode,
    wait: number,
    resync = false,
  ): ObservationFailureOutcome => ({ errorCode, nextReconcileAt: now + wait, resync });
  switch (failure.kind) {
    case "transient":
      return outcome("provider_unavailable", backoff);
    case "rate_limited":
      return outcome("rate_limited", Math.max(failure.retryAfterMs ?? 0, backoff));
    case "rejected":
      return outcome("provider_rejected", backoff);
    case "malformed_response":
      return outcome("malformed_response", backoff);
    case "suspended":
      return outcome("suspended", RECONCILE_IDLE_MS, true);
    case "not_found":
      return failure.target === "installation"
        ? outcome("installation_missing", RECONCILE_IDLE_MS, true)
        : outcome("repository_not_found", RECONCILE_POLL_MS, true);
  }
}

/** The wait before retrying after the attempt-th consecutive retryable failure. */
export function retryBackoff(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), RETRY_BACKOFF_MS.length) - 1;
  return RETRY_BACKOFF_MS[index] as number;
}

// Scheduling ----------------------------------------------------------------------------------

/**
 * The repository's invitation budget at `now`, from the instants ShareRepo started invitations
 * (decision 0010): starts within `(now - INVITATION_WINDOW_MS, now]` count. While none is left,
 * `opensAt` is when enough starts have left the window for one more.
 */
export function invitationBudget(inviteStarts: readonly Instant[], now: Instant): InvitationBudget {
  const counted = inviteStarts
    .filter((start) => start > now - INVITATION_WINDOW_MS && start <= now)
    .sort((a, b) => a - b);
  const remaining = Math.max(INVITATION_BUDGET - counted.length, 0);
  if (remaining > 0) return { remaining, opensAt: null };
  const leaving = counted[counted.length - INVITATION_BUDGET] as Instant;
  return { remaining, opensAt: leaving + INVITATION_WINDOW_MS };
}

export interface NextReconcileInput {
  readonly now: Instant;
  readonly grants: readonly {
    readonly state: GrantState;
    readonly nextAttemptAt: Instant | null;
    readonly expiresAt: Instant | null;
    readonly retryClass: RetryClass | null;
  }[];
  readonly budget: InvitationBudget | null;
  /** The run left decisions unacted on. */
  readonly leftover: boolean;
}

const IN_FLIGHT: readonly GrantState[] = ["pending_invitation", "provisioning", "revoking"];

/**
 * When a repository should be reconciled next. Now when a run left work over; otherwise the
 * earliest of: a short poll while anything is in flight or retryable, each error's retry time,
 * each pending invitation's lapse, the budget reopening, and the idle interval. Never before now.
 */
export function nextReconcileAt(input: NextReconcileInput): Instant {
  const { now } = input;
  if (input.leftover) return now;
  const candidates = [now + RECONCILE_IDLE_MS];
  if (input.budget?.opensAt != null) candidates.push(input.budget.opensAt);
  for (const grant of input.grants) {
    const retryable = grant.retryClass === "retryable" || grant.retryClass === "rate_limited";
    if (IN_FLIGHT.includes(grant.state) || (grant.state === "error" && retryable)) {
      candidates.push(now + RECONCILE_POLL_MS);
    }
    if (grant.state === "error" && grant.nextAttemptAt !== null) {
      candidates.push(grant.nextAttemptAt);
    }
    const lapses = grant.expiresAt ?? now;
    if (grant.state === "pending_invitation" && lapses > now) candidates.push(lapses);
  }
  return Math.max(Math.min(...candidates), now);
}
