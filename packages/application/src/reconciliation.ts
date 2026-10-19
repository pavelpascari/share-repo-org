import * as repo from "@sharerepo/db";
import {
  type AccessLevel,
  type AuditDetails,
  type AuditEvent,
  type AuditEventInput,
  auditEvent,
  classifyMutationFailure,
  type GrantFields,
  type GrantObservationChange,
  INVITATION_LIFETIME_MS,
  INVITATION_WINDOW_MS,
  type InvitationBudget,
  invitationBudget,
  MAX_MUTATIONS_PER_RUN,
  type MutationOperation,
  nextReconcileAt,
  type ObservedCollaborator,
  OutboxKind,
  observeGrants,
  type ProviderFailure,
  planReconciliation,
  RECONCILE_IDLE_MS,
  RECONCILE_POLL_MS,
  RETRY_BACKOFF_MS,
  type ReconciliationDecision,
  type RepositoryObservation,
} from "@sharerepo/domain";
import { GitHubApiError, type GitHubAppPort } from "@sharerepo/integrations";
import { ConflictError, NotFoundError } from "@sharerepo/platform";
import {
  asAuditActor,
  atOneInstant,
  type ServiceContext,
  type UserActor,
  type WorkspaceAuditAction,
} from "./context.ts";
import { encodeReconcileKey, type ReconcileRef } from "./entitlement-source.ts";
import { capabilitiesOf } from "./offers.ts";
import { openWorkspace } from "./workspaces.ts";

// Reconciliation (phase-4 plan § Reconciliation job; decision 0010): one run per repository
// takes the repository's lease, observes GitHub, plans against the live entitlements, performs
// at most a bounded number of provider mutations (each written ahead before it is sent), observes
// again, and schedules the next run. Every grant write is guarded on the lease.

const SYSTEM = { type: "system", id: null } as const;

/** How long one run holds a repository; a run that crashes is taken over after it. */
export const RECONCILE_LEASE_MS = 2 * 60_000;

/**
 * `done`: the run finished (or stopped early and scheduled its next run); `busy`: another run
 * holds the repository, or took it over mid-run; `out_of_scope`: the workspace has no such
 * repository.
 */
export type ReconcileOutcome = "done" | "busy" | "out_of_scope";

/** A `reconcile_resource` outbox row for the resource, available now. */
export function reconcileOutboxRow(ctx: ServiceContext, ref: ReconcileRef): repo.NewOutboxRow {
  const now = ctx.clock.now();
  return {
    id: ctx.ids.next(),
    kind: OutboxKind.ReconcileResource,
    subjectId: encodeReconcileKey(ref),
    createdAt: now,
    availableAt: now,
  };
}

/** One run's fixed facts. */
interface Run {
  readonly ctx: ServiceContext;
  readonly now: number;
  readonly lease: repo.LeaseKey;
  readonly resource: repo.Resource;
  readonly connection: repo.Connection;
  readonly github: GitHubAppPort;
}

/** What a run reads before observing, planning and scheduling. */
interface State {
  readonly entitlements: repo.Entitlement[];
  readonly grants: repo.Grant[];
  readonly subjects: Map<string, repo.Subject>;
  readonly operations: Map<string, MutationOperation>;
  readonly open: repo.ProviderMutation[];
  readonly budget: InvitationBudget;
}

async function load(run: Run): Promise<State> {
  const { db } = run.ctx;
  const key = { workspaceId: run.lease.workspaceId, resourceId: run.lease.resourceId };
  const [entitlements, grants, operations, open, starts] = await Promise.all([
    repo.listLiveEntitlementsForResource(db, key),
    repo.listGrantsForResource(db, key),
    repo.latestMutationOperations(db, key),
    repo.listOpenMutations(db, key),
    repo.listInviteStarts(db, { ...key, since: run.now - INVITATION_WINDOW_MS }),
  ]);
  const ids = new Set([...entitlements, ...grants].map((row) => row.subjectId));
  const subjects = await repo.listSubjects(db, { workspaceId: key.workspaceId, ids: [...ids] });
  return {
    entitlements,
    grants,
    subjects: new Map(subjects.map((subject) => [subject.id, subject])),
    operations,
    open,
    budget: invitationBudget(starts, run.now),
  };
}

/** A workspace-scoped audit event by the system, at the run's instant. */
function systemEvent<A extends WorkspaceAuditAction>(
  run: Run,
  action: A,
  targetId: string,
  details: AuditDetails<A>,
): AuditEvent {
  return auditEvent(
    action,
    // TypeScript cannot resolve WorkspaceField<A> for a generic A; A is workspace-scoped here.
    {
      workspaceId: run.lease.workspaceId,
      actor: SYSTEM,
      targetId,
      details,
    } as unknown as AuditEventInput<A>,
    run.ctx,
  );
}

/** What every `provider.mutation_*` event says about its mutation. */
function mutationDetails(run: Run, mutation: repo.ProviderMutation, subject: repo.Subject) {
  return {
    mutationId: mutation.id,
    operation: mutation.operation,
    resourceId: mutation.resourceId,
    subjectId: mutation.subjectId,
    resourceExternalId: run.resource.externalId,
    subjectExternalId: subject.externalSubjectId,
    accessLevel: mutation.accessLevel,
    entitlementIds: JSON.parse(mutation.entitlementIds) as string[],
  };
}

// Observation ---------------------------------------------------------------------------------

type ObserveResult = "observed" | "skipped" | "lease_lost" | GitHubApiError;

/** GitHub's collaborator permission as a grant access level (`admin` grants write and more). */
const levelOf = (permission: "read" | "write" | "admin"): AccessLevel =>
  permission === "read" ? "read" : "write";

/**
 * Reads the repository's access from GitHub and records it. Skipped while the connection is not
 * active or the repository is not selected: ShareRepo may not look, and must not act.
 */
async function observe(run: Run, state: State): Promise<ObserveResult> {
  if (run.connection.status !== "active" || run.resource.selection !== "selected") {
    return "skipped";
  }
  const installation = run.connection.installationId;
  const name = run.resource.nameSnapshot;
  let observation: RepositoryObservation;
  try {
    const [direct, all, invitations] = await Promise.all([
      run.github.listCollaborators(installation, name, "direct"),
      run.github.listCollaborators(installation, name, "all"),
      run.github.listInvitations(installation, name),
    ]);
    const directIds = new Set(direct.map((c) => c.id));
    const listed = [...all, ...direct.filter((c) => !all.some((other) => other.id === c.id))];
    observation = {
      collaborators: listed.map(
        (c): ObservedCollaborator => ({
          userId: c.id,
          login: c.login,
          accessLevel: levelOf(c.permission),
          direct: directIds.has(c.id),
        }),
      ),
      invitations: invitations.map((i) => ({
        invitationId: i.id,
        userId: i.inviteeId,
        login: i.inviteeLogin,
        createdAt: i.createdAt,
        expired: i.expired,
      })),
    };
  } catch (error) {
    if (error instanceof GitHubApiError) return error;
    throw error;
  }

  const changes = observeGrants({
    now: run.now,
    subjects: [...state.subjects.values()].map(({ id, externalSubjectId }) => ({
      id,
      externalSubjectId,
    })),
    grants: state.grants.map((grant) => ({
      ...grant,
      lastOperation: state.operations.get(grant.id) ?? null,
    })),
    observation,
    newGrantId: () => run.ctx.ids.next(),
  });
  const { audit, creates, updates, resolved } = observationWrites(run, state, changes);
  if (creates.length + updates.length + state.grants.length === 0) return "observed";
  const result = await repo.applyGrantObservation(
    run.ctx.db,
    {
      ...run.lease,
      now: run.now,
      creates,
      updates,
      touch: state.grants.map((grant) => grant.id),
      resolve: { mutationIds: resolved },
    },
    audit,
  );
  return result.ok ? "observed" : "lease_lost";
}

/** The rows and audit events of one observation's grant changes. */
function observationWrites(run: Run, state: State, changes: readonly GrantObservationChange[]) {
  const audit: AuditEvent[] = [];
  const creates: repo.Grant[] = [];
  const updates: repo.GrantUpdate[] = [];
  const resolved: string[] = [];
  const shown = (fields: GrantFields) => ({
    state: fields.state,
    managed: fields.managed,
    indirect: fields.indirect,
    accessLevel: fields.accessLevel,
  });
  for (const change of changes) {
    if (change.kind === "create") {
      creates.push({
        ...change.set,
        id: change.grantId,
        workspaceId: run.lease.workspaceId,
        connectionId: run.resource.connectionId,
        subjectId: change.subjectId,
        resourceId: run.resource.id,
        entitlementId: null,
        observedAt: run.now,
        lastAttemptAt: null,
        createdAt: run.now,
        updatedAt: run.now,
      });
      audit.push(
        systemEvent(run, "grant.observed", change.grantId, {
          resourceId: run.resource.id,
          subjectId: change.subjectId,
          from: null,
          to: shown(change.set),
        }),
      );
      continue;
    }
    updates.push({ id: change.grantId, set: change.set });
    const to = { ...change.from, ...change.set };
    const visible =
      to.state !== change.from.state ||
      to.managed !== change.from.managed ||
      to.indirect !== change.from.indirect ||
      to.accessLevel !== change.from.accessLevel;
    // Details alone (an invitation's lapse instant or ID, an error's details) are bookkeeping.
    if (visible) {
      audit.push(
        systemEvent(run, "grant.observed", change.grantId, {
          resourceId: run.resource.id,
          subjectId: change.subjectId,
          from: shown(change.from),
          to: shown(to),
        }),
      );
    }
    if (!change.settlesIntent) continue;
    // The observation settled what the grant's unfinished mutations were doing (a lost response
    // or a crash between the call and its record).
    for (const mutation of state.open.filter((m) => m.grantId === change.grantId)) {
      resolved.push(mutation.id);
      const subject = state.subjects.get(mutation.subjectId) as repo.Subject;
      audit.push(
        systemEvent(run, "provider.mutation_resolved", change.grantId, {
          ...mutationDetails(run, mutation, subject),
          state: to.state,
        }),
      );
    }
  }
  return { audit, creates, updates, resolved };
}

// Mutations -----------------------------------------------------------------------------------

/** What a sent mutation changes on the grant when it succeeds. */
interface Sent {
  readonly externalId: string | null;
  readonly grant: Partial<repo.GrantWritable>;
}

interface MutationInput {
  readonly operation: MutationOperation;
  readonly decision: ReconciliationDecision;
  readonly subject: repo.Subject;
  /** The grant before this mutation, or null when the subject has none yet. */
  readonly grant: repo.Grant | null;
  readonly accessLevel: AccessLevel;
  /** The grant's intent, written ahead: `provisioning` or `revoking`. */
  readonly intent: Partial<repo.GrantWritable>;
  /** The provider ID the mutation is about, known before it is sent (an invitation to cancel). */
  readonly externalId: string | null;
  readonly send: () => Promise<Sent>;
}

type MutationResult =
  | { readonly status: "succeeded"; readonly grant: repo.Grant }
  | { readonly status: "failed"; readonly stopRun: boolean }
  /** A failure that stops the run and leaves the grant as it was. */
  | { readonly status: "stopped" }
  | { readonly status: "lease_lost" };

/**
 * The attempt number of a grant's next try, for the backoff: 1 unless the grant is already in
 * error. A failed attempt stores `last_attempt_at` and `next_attempt_at` from the same instant,
 * so their difference is the backoff that attempt used: RETRY_BACKOFF_MS[k - 1] after the k-th
 * consecutive failure, which makes this one the (k + 1)-th. A gap that is no backoff (a rate
 * limit's wait, or the owner's "Retry", which sets `next_attempt_at` to now) starts again at 1.
 * The domain caps the attempt at the last backoff.
 */
export function consecutiveAttempt(grant: repo.Grant | null): number {
  if (grant?.state !== "error" || grant.nextAttemptAt === null || grant.lastAttemptAt === null) {
    return 1;
  }
  return RETRY_BACKOFF_MS.indexOf(grant.nextAttemptAt - grant.lastAttemptAt) + 2;
}

const providerFailure = (error: GitHubApiError): ProviderFailure => ({
  kind: error.kind,
  ...(error.status === undefined ? {} : { status: error.status }),
  ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  ...(error.target === undefined ? {} : { target: error.target }),
});

/** The grant fields a run restores when a failure leaves the grant as it was. */
function restored(before: repo.Grant | null): Partial<repo.GrantWritable> {
  if (before === null) {
    return {
      state: "absent",
      managed: false,
      indirect: false,
      externalGrantId: null,
      expiresAt: null,
      lastErrorCode: null,
      retryClass: null,
      nextAttemptAt: null,
      lastAttemptAt: null,
    };
  }
  const { state, managed, indirect, accessLevel, externalGrantId, expiresAt } = before;
  const { lastErrorCode, retryClass, nextAttemptAt, lastAttemptAt } = before;
  return {
    state,
    managed,
    indirect,
    accessLevel,
    externalGrantId,
    expiresAt,
    lastErrorCode,
    retryClass,
    nextAttemptAt,
    lastAttemptAt,
  };
}

/**
 * One provider mutation: the write-ahead (grant intent, `started` row, `attempted` event), the
 * request, and its recorded outcome. A `GitHubApiError` is classified; anything else propagates
 * and leaves the mutation `started` for the next observation to resolve.
 */
async function mutate(run: Run, input: MutationInput): Promise<MutationResult> {
  const { ctx, now } = run;
  const before = input.grant;
  const grant: repo.Grant =
    before === null
      ? {
          id: ctx.ids.next(),
          workspaceId: run.lease.workspaceId,
          connectionId: run.resource.connectionId,
          subjectId: input.subject.id,
          resourceId: run.resource.id,
          accessLevel: input.accessLevel,
          state: "provisioning",
          managed: true,
          indirect: false,
          // Only a provision creates a grant, and a live entitlement backs every provision.
          entitlementId: input.decision.entitlementIds[0] as string,
          externalGrantId: null,
          expiresAt: null,
          observedAt: null,
          lastAttemptAt: now,
          lastErrorCode: null,
          retryClass: null,
          nextAttemptAt: null,
          createdAt: now,
          updatedAt: now,
          ...input.intent,
        }
      : { ...before, ...input.intent, lastAttemptAt: now, updatedAt: now };
  const mutation: repo.ProviderMutation = {
    id: ctx.ids.next(),
    workspaceId: run.lease.workspaceId,
    connectionId: run.resource.connectionId,
    grantId: grant.id,
    subjectId: input.subject.id,
    resourceId: run.resource.id,
    operation: input.operation,
    accessLevel: input.accessLevel,
    status: "started",
    errorCode: null,
    retryClass: null,
    externalId: input.externalId,
    entitlementIds: JSON.stringify(input.decision.entitlementIds),
    correlationId: ctx.correlationId,
    startedAt: now,
    finishedAt: null,
  };
  const details = mutationDetails(run, mutation, input.subject);
  const begun = await repo.beginMutation(
    ctx.db,
    {
      ...run.lease,
      now,
      grant:
        before === null
          ? { create: grant }
          : { update: { id: grant.id, set: { ...input.intent, lastAttemptAt: now } } },
      mutation,
    },
    [systemEvent(run, "provider.mutation_attempted", grant.id, details)],
  );
  if (!begun.ok) return { status: "lease_lost" };

  const finish = async (
    result: repo.FinishMutation["result"],
    set: Partial<repo.GrantWritable>,
    event: AuditEvent,
  ) =>
    repo.finishMutation(
      ctx.db,
      { ...run.lease, now, mutationId: mutation.id, result, grant: { id: grant.id, set } },
      [event],
    );
  const succeeded = async (sent: Sent): Promise<MutationResult> => {
    const written = await finish(
      { status: "succeeded", errorCode: null, retryClass: null, externalId: sent.externalId },
      sent.grant,
      systemEvent(run, "provider.mutation_succeeded", grant.id, details),
    );
    return written.ok
      ? { status: "succeeded", grant: { ...grant, ...sent.grant } }
      : { status: "lease_lost" };
  };

  let sent: Sent;
  try {
    sent = await input.send();
  } catch (error) {
    if (!(error instanceof GitHubApiError)) throw error;
    const outcome = classifyMutationFailure({
      operation: input.operation,
      failure: providerFailure(error),
      attempt: consecutiveAttempt(before),
      now,
    });
    switch (outcome.outcome) {
      case "already_done":
        return succeeded({ externalId: input.externalId, grant: {} });
      case "failed": {
        const written = await finish(
          {
            status: "failed",
            errorCode: outcome.errorCode,
            retryClass: outcome.retryClass,
            externalId: null,
          },
          {
            state: "error",
            lastErrorCode: outcome.errorCode,
            retryClass: outcome.retryClass,
            nextAttemptAt: outcome.nextAttemptAt,
          },
          systemEvent(run, "provider.mutation_failed", grant.id, {
            ...details,
            errorCode: outcome.errorCode,
            retryClass: outcome.retryClass,
          }),
        );
        return written.ok
          ? { status: "failed", stopRun: outcome.stopRun }
          : { status: "lease_lost" };
      }
      case "stop_run": {
        // The failed row needs a retry class (CHECK); the event says the grant is unchanged.
        const written = await finish(
          {
            status: "failed",
            errorCode: outcome.reason,
            retryClass: "retryable",
            externalId: null,
          },
          restored(before),
          systemEvent(run, "provider.mutation_failed", grant.id, {
            ...details,
            errorCode: outcome.reason,
            retryClass: null,
          }),
        );
        if (!written.ok) return { status: "lease_lost" };
        // The repository is gone or renamed, or the installation suspended: a resync finds out.
        await queueResync(run);
        return { status: "stopped" };
      }
    }
  }
  return succeeded(sent);
}

/** Queues a resync of the run's connection, unless one is already pending. */
async function queueResync(run: Run): Promise<void> {
  await repo.enqueueOutboxOnce(run.ctx.db, {
    id: run.ctx.ids.next(),
    kind: OutboxKind.ResyncConnection,
    subjectId: run.connection.id,
    createdAt: run.now,
    availableAt: run.now,
  });
}

/**
 * The subject's current login, from its immutable GitHub ID: a rename never invites or removes
 * the wrong account. A changed login is recorded, audited as `subject.login_updated`; a
 * concurrent update of the same snapshot wins.
 */
async function currentLogin(run: Run, subject: repo.Subject): Promise<string> {
  const user = await run.github.getUserById(
    run.connection.installationId,
    subject.externalSubjectId,
  );
  if (user.login !== subject.loginSnapshot) {
    await repo.updateSubjectLogin(
      run.ctx.db,
      {
        workspaceId: run.lease.workspaceId,
        subjectId: subject.id,
        previousLogin: subject.loginSnapshot,
        login: user.login,
        now: run.now,
      },
      [
        systemEvent(run, "subject.login_updated", subject.id, {
          provider: "github",
          externalSubjectId: subject.externalSubjectId,
          previousLogin: subject.loginSnapshot,
          login: user.login,
        }),
      ],
    );
  }
  return user.login;
}

/** What acting on one decision did. */
type Acted = "continue" | "stop" | "lease_lost";

const settled = (result: MutationResult): Acted => {
  switch (result.status) {
    case "succeeded":
      return "continue";
    case "failed":
      return result.stopRun ? "stop" : "continue";
    case "stopped":
      return "stop";
    case "lease_lost":
      return "lease_lost";
  }
};

/** A managed invitation that lapsed: cancelled before it is reissued (decision 0010). */
const lapsedInvitation = (grant: repo.Grant | null, decision: ReconciliationDecision) =>
  decision.reason === "invitation_expired" && grant?.externalGrantId != null;

/** Provision (or retry): cancel a lapsed invitation first, then invite. */
async function provision(
  run: Run,
  decision: ReconciliationDecision,
  subject: repo.Subject,
  grant: repo.Grant | null,
  count: (mutations: number) => void,
): Promise<Acted> {
  let current = grant;
  if (lapsedInvitation(grant, decision)) {
    const invitationId = (grant as repo.Grant).externalGrantId as string;
    count(1);
    const cancelled = await mutate(run, {
      operation: "cancel_invitation",
      decision,
      subject,
      grant,
      accessLevel: (grant as repo.Grant).accessLevel,
      intent: { state: "revoking" },
      externalId: invitationId,
      send: async () => {
        await run.github.cancelInvitation(
          run.connection.installationId,
          run.resource.nameSnapshot,
          invitationId,
        );
        return { externalId: invitationId, grant: {} };
      },
    });
    if (cancelled.status !== "succeeded") return settled(cancelled);
    current = cancelled.grant;
  }
  count(1);
  const level = decision.accessLevel as AccessLevel;
  return settled(
    await mutate(run, {
      operation: "invite",
      decision,
      subject,
      grant: current,
      accessLevel: level,
      intent: {
        state: "provisioning",
        managed: true,
        indirect: false,
        accessLevel: level,
        externalGrantId: null,
        expiresAt: null,
        lastErrorCode: null,
        retryClass: null,
        nextAttemptAt: null,
      },
      externalId: null,
      send: async () => {
        const login = await currentLogin(run, subject);
        const result = await run.github.addCollaborator(
          run.connection.installationId,
          run.resource.nameSnapshot,
          login,
        );
        if (result.outcome === "already_collaborator") {
          // Observed absent moments ago, so the access is ShareRepo's own (decision 0010).
          return { externalId: null, grant: { state: "active", managed: true } };
        }
        return {
          externalId: result.invitationId,
          grant: {
            state: "pending_invitation",
            managed: true,
            externalGrantId: result.invitationId,
            expiresAt: result.createdAt + INVITATION_LIFETIME_MS,
          },
        };
      },
    }),
  );
}

/**
 * Revoke: cancel a pending invitation, or remove the collaborator. The grant stays `revoking`
 * after a success; the next observation settles it to `absent` once GitHub's lists agree, so a
 * lagging list is never mistaken for access ShareRepo does not manage.
 */
async function revoke(
  run: Run,
  decision: ReconciliationDecision,
  subject: repo.Subject,
  grant: repo.Grant,
): Promise<Acted> {
  const base = {
    decision,
    subject,
    grant,
    accessLevel: grant.accessLevel,
    intent: { state: "revoking", lastErrorCode: null, retryClass: null, nextAttemptAt: null },
  } as const;
  const invitationId = grant.externalGrantId;
  if (invitationId !== null) {
    return settled(
      await mutate(run, {
        ...base,
        operation: "cancel_invitation",
        externalId: invitationId,
        send: async () => {
          await run.github.cancelInvitation(
            run.connection.installationId,
            run.resource.nameSnapshot,
            invitationId,
          );
          return { externalId: invitationId, grant: {} };
        },
      }),
    );
  }
  // An active collaborator, or an errored grant whose invitation never showed: removing someone
  // who is not a collaborator is a success, which settles the grant through observation.
  return settled(
    await mutate(run, {
      ...base,
      operation: "remove_collaborator",
      externalId: null,
      send: async () => {
        const login = await currentLogin(run, subject);
        await run.github.removeCollaborator(
          run.connection.installationId,
          run.resource.nameSnapshot,
          login,
        );
        return { externalId: null, grant: {} };
      },
    }),
  );
}

/**
 * Acts on the plan, in subject order, within the mutation cap and the invitation budget. Returns
 * whether anything was sent, whether actionable decisions were left over, or that the lease was
 * lost.
 */
async function act(
  run: Run,
  state: State,
  decisions: readonly ReconciliationDecision[],
): Promise<{ mutated: boolean; leftover: boolean } | "lease_lost"> {
  let mutations = 0;
  let invitations = state.budget.remaining;
  let leftover = false;
  const count = (n: number) => {
    mutations += n;
  };
  for (const decision of decisions) {
    const grant = state.grants.find((g) => g.id === decision.grantId) ?? null;
    const subject = state.subjects.get(decision.subjectId) as repo.Subject;
    let acted: Acted;
    if (decision.action === "revoke") {
      // A revocation that failed waits for its retry time; the owner's "Retry" makes it due.
      const g = grant as repo.Grant;
      if (g.state === "error" && g.nextAttemptAt !== null && g.nextAttemptAt > run.now) continue;
      if (mutations + 1 > MAX_MUTATIONS_PER_RUN) {
        leftover = true;
        break;
      }
      count(1);
      acted = await revoke(run, decision, subject, g);
    } else if (decision.action === "provision" || decision.action === "retry") {
      const needed = lapsedInvitation(grant, decision) ? 2 : 1;
      if (mutations + needed > MAX_MUTATIONS_PER_RUN) {
        leftover = true;
        break;
      }
      if (invitations <= 0) {
        leftover = true;
        continue;
      }
      invitations -= 1;
      acted = await provision(run, decision, subject, grant, count);
    } else {
      continue;
    }
    if (acted === "lease_lost") return "lease_lost";
    if (acted === "stop") break;
  }
  return { mutated: mutations > 0, leftover };
}

// The run ---------------------------------------------------------------------------------------

/** Ends the run: schedules the next one and releases the lease. */
async function release(run: Run, next: number): Promise<ReconcileOutcome> {
  const released = await repo.releaseReconcileLease(run.ctx.db, {
    ...run.lease,
    now: run.now,
    nextReconcileAt: next,
  });
  return released ? "done" : "busy";
}

/**
 * An observation GitHub refused. An outage or rate limit retries after GitHub's wait or the first
 * backoff. A suspended installation, or a repository that is gone or renamed, queues a resync of
 * the connection; its changes queue the next run, and a suspended connection then blocks.
 */
async function observationFailed(run: Run, error: GitHubApiError): Promise<ReconcileOutcome> {
  switch (error.kind) {
    case "suspended":
      await queueResync(run);
      return release(run, run.now + RECONCILE_IDLE_MS);
    case "not_found":
      await queueResync(run);
      return release(run, run.now + RECONCILE_POLL_MS);
    default:
      return release(
        run,
        run.now + Math.max(error.retryAfterMs ?? 0, RETRY_BACKOFF_MS[0] as number),
      );
  }
}

/**
 * Converges one repository's GitHub access with its live entitlements (decision 0010). System
 * work, safe to run any number of times and concurrently: a run that cannot take the
 * repository's lease returns `busy` and does nothing. Nothing is sent without an observation in
 * the same run that shows it is still needed, so a lost response or a crash is settled by the
 * next run's observation, never by sending again blindly. Errors other than GitHub's propagate;
 * the lease then expires and the scheduled sweep picks the repository up again.
 */
export async function reconcileResource(
  context: ServiceContext,
  ref: ReconcileRef,
  github: GitHubAppPort,
): Promise<ReconcileOutcome> {
  const ctx = atOneInstant(context);
  const now = ctx.clock.now();
  const resource = await repo.getResource(ctx.db, ref);
  if (resource === null) return "out_of_scope";
  const lease = { workspaceId: ref.workspaceId, resourceId: resource.id, token: ctx.ids.next() };
  const claimed = await repo.claimReconcileLease(ctx.db, {
    ...lease,
    now,
    leaseMs: RECONCILE_LEASE_MS,
  });
  if (!claimed) return "busy";
  // A resource always belongs to a connection of its workspace (composite foreign key).
  const connection = (await repo.getConnection(ctx.db, {
    workspaceId: ref.workspaceId,
    connectionId: resource.connectionId,
  })) as repo.Connection;
  const run: Run = { ctx, now, lease, resource, connection, github };

  const observed = await observe(run, await load(run));
  if (observed === "lease_lost") return "busy";
  if (observed instanceof GitHubApiError) return observationFailed(run, observed);

  let leftover = false;
  // Only what this run observed may be acted on.
  if (observed === "observed") {
    const state = await load(run);
    const decisions = planReconciliation({
      now,
      entitlements: state.entitlements,
      grants: state.grants,
      resources: [{ ...resource, capabilities: capabilitiesOf(resource) }],
      connections: [connection],
      invitationBudgets: new Map([[resource.id, state.budget]]),
    });
    const acted = await act(run, state, decisions);
    if (acted === "lease_lost") return "busy";
    leftover = acted.leftover;
    if (acted.mutated) {
      // Record what the mutations did. A failure here only ends the run: the next one observes.
      const again = await observe(run, await load(run));
      if (again === "lease_lost") return "busy";
    }
  }

  const final = await load(run);
  return release(
    run,
    nextReconcileAt({ now, grants: final.grants, budget: final.budget, leftover }),
  );
}

// Owner controls --------------------------------------------------------------------------------

/**
 * A queued reconciliation: the outbox row to hand to the queue at once. When the same work was
 * already pending (queued by a refresh or the sweep, waiting for the outbox drain), that row is
 * handed over instead; null only when it was delivered in between.
 */
export interface ReconcileRequest {
  readonly outboxId: string | null;
  /** The row's key, to send with it. */
  readonly subjectId: string;
}

/** The row to hand to the queue: the one just queued, or the pending one that deduplicated it. */
async function rowToSend(
  ctx: ServiceContext,
  row: repo.NewOutboxRow,
  queued: boolean,
): Promise<ReconcileRequest> {
  const outboxId = queued ? row.id : await repo.pendingOutboxId(ctx.db, row.kind, row.subjectId);
  return { outboxId, subjectId: row.subjectId };
}

/**
 * "Check now": queues a reconciliation of one of the workspace's repositories. Needs
 * `workspace.manage`; audited as `reconciliation.requested` even when one was already queued.
 */
export async function requestReconcileNow(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  resourceId: string,
): Promise<ReconcileRequest> {
  const ctx = atOneInstant(context);
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const { workspaceId } = scope;
  const resource = await repo.getResource(ctx.db, { workspaceId, resourceId });
  if (resource === null) throw new NotFoundError("repository not found in workspace");
  const row = reconcileOutboxRow(ctx, { workspaceId, resourceId: resource.id });
  const { outboxId } = await repo.requestReconcile(
    ctx.db,
    { workspaceId, resourceId: resource.id, outboxRow: row },
    [
      auditEvent(
        "reconciliation.requested",
        {
          workspaceId,
          actor: asAuditActor(actor),
          targetId: resource.id,
          details: { resourceId: resource.id, kind: "check" },
        },
        ctx,
      ),
    ],
  );
  return rowToSend(ctx, row, outboxId !== null);
}

/**
 * "Retry" on a grant in error: it becomes due now (and retryable when it waited for a person),
 * audited as `reconciliation.requested`, and its repository's reconciliation is queued. Needs
 * `workspace.manage`. A grant that is not the workspace's is not found; one not in error is a
 * ConflictError (reload and look again).
 */
export async function retryGrant(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  grantId: string,
): Promise<ReconcileRequest> {
  const ctx = atOneInstant(context);
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const { workspaceId } = scope;
  const grant = await repo.getGrant(ctx.db, { workspaceId, grantId });
  if (grant === null) throw new NotFoundError("grant not found in workspace");
  const reset = await repo.resetGrantRetry(ctx.db, { workspaceId, grantId, now: ctx.clock.now() }, [
    auditEvent(
      "reconciliation.requested",
      {
        workspaceId,
        actor: asAuditActor(actor),
        targetId: grant.resourceId,
        details: { resourceId: grant.resourceId, grantId, kind: "retry" },
      },
      ctx,
    ),
  ]);
  // Grants are never deleted, so the grant just read can only have left `error`.
  if (!reset.ok) throw new ConflictError("grant is not in error; reload and retry");
  const row = reconcileOutboxRow(ctx, { workspaceId, resourceId: grant.resourceId });
  // Queueing is bookkeeping: the request itself is audited above.
  return rowToSend(ctx, row, await repo.enqueueOutboxOnce(ctx.db, row));
}

/**
 * The per-minute sweep: queues a `reconcile_resource` for up to `limit` repositories, in any
 * workspace, that are due (or, the repair path, have live access but nothing scheduled). Returns
 * how many it queued.
 */
export async function queueDueReconciles(
  context: ServiceContext,
  input: { readonly limit: number },
): Promise<number> {
  const ctx = atOneInstant(context);
  return repo.claimDueReconciles(ctx.db, {
    now: ctx.clock.now(),
    limit: input.limit,
    makeOutboxRow: (resource) =>
      reconcileOutboxRow(ctx, { workspaceId: resource.workspaceId, resourceId: resource.id }),
  });
}
