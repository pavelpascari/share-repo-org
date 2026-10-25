import * as repo from "@sharerepo/db";
import {
  type AccessDecisionReason,
  type AuditEvent,
  auditEvent,
  type EntitlementPlan,
  type Instant,
  type LiveEntitlement,
  MANUAL_ACCESS_OPEN_LIMIT,
  type ManualAccessNoteError,
  ManualAccessRevokeCause,
  type ManualAccessStatus,
  manualAccessRateLimitBuckets,
  manualAccessStatus,
  parseManualAccessEnd,
  parseManualAccessNote,
  planManualEntitlements,
  workspaceWithdrawal,
} from "@sharerepo/domain";
import type { GitHubAppPort } from "@sharerepo/integrations";
import { ConflictError, NotFoundError } from "@sharerepo/platform";
import { asAuditActor, atOneInstant, type ServiceContext, type UserActor } from "./context.ts";
import { type GitHubAccountError, resolveGitHubAccount } from "./github-accounts.ts";
import { reconcileOutboxRow } from "./reconciliation.ts";
import { subjectFor } from "./subscriptions.ts";
import { openWorkspace } from "./workspaces.ts";

// Manual access (decision 0016): a workspace owner grants an offer's repositories to a GitHub
// account by hand, with no subscription, for early buyers and trials. It is an entitlement
// source of its own: every change re-plans its entitlements with the same rules as a
// subscription's, writes them in one guarded batch, and reconciliation grants or revokes the
// access. The recipient needs no ShareRepo account. Audit details carry IDs and the account's
// immutable GitHub ID, never a login or email; the owner's note is the event's reason.

const SYSTEM = { type: "system", id: null } as const;
const MAX_ATTEMPTS = 3;

/** One manual access, as the owner's page shows it. */
export interface ManualAccessSummary {
  readonly id: string;
  readonly offerId: string;
  readonly offerName: string;
  /** The account's login when it was last seen, and its immutable GitHub ID. */
  readonly login: string;
  readonly githubUserId: string;
  readonly endsAt: Instant | null;
  readonly note: string | null;
  readonly status: ManualAccessStatus;
  readonly revokedAt: Instant | null;
  readonly revokeCause: ManualAccessRevokeCause | null;
  readonly grantedAt: Instant;
  /** How many of its repositories it currently entitles (reconciliation follows). */
  readonly liveEntitlements: number;
}

export interface ManualAccessView {
  /** Offers that can be granted now: active, with at least one repository. */
  readonly offers: readonly { readonly id: string; readonly name: string }[];
  readonly accesses: readonly ManualAccessSummary[];
}

/** The workspace's manual accesses and the offers an owner can grant. Owner only. */
export async function listManualAccess(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
): Promise<ManualAccessView> {
  const ctx = atOneInstant(context);
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const now = ctx.clock.now();
  const [offers, rows] = await Promise.all([
    repo.listOffers(ctx.db, scope.workspaceId),
    repo.listManualAccesses(ctx.db, scope.workspaceId),
  ]);
  return {
    offers: offers
      .filter((offer) => offer.status === "active" && offer.accesses.length > 0)
      .map((offer) => ({ id: offer.id, name: offer.name })),
    accesses: rows.map(
      ({ access, offerName, subjectLogin, subjectExternalId, liveEntitlements }) => ({
        id: access.id,
        offerId: access.offerId,
        offerName,
        login: subjectLogin,
        githubUserId: subjectExternalId,
        endsAt: access.endsAt,
        note: access.note,
        status: manualAccessStatus(access, now),
        revokedAt: access.revokedAt,
        revokeCause: access.revokeCause,
        grantedAt: access.createdAt,
        liveEntitlements,
      }),
    ),
  };
}

// Planning and writing ------------------------------------------------------------------------

const liveEntitlement = (row: repo.Entitlement): LiveEntitlement => ({
  id: row.id,
  offerId: row.offerId,
  offerVersion: row.offerVersion,
  resourceId: row.resourceId,
  subjectId: row.subjectId,
  accessLevel: row.accessLevel,
  validFrom: row.validFrom,
  validUntil: row.validUntil,
  decisionReason: row.decisionReason as AccessDecisionReason,
  policyVersion: row.policyVersion,
});

const planSize = (plan: EntitlementPlan) =>
  plan.create.length + plan.update.length + plan.end.length;

/** What a decision about one manual access needs: the change, and how to audit it. */
interface Decision {
  readonly workspaceId: string;
  /** The access as stored, or null to create `next`. */
  readonly stored: repo.ManualAccess | null;
  /** The access as the decision leaves it, before its timer is set from the plan. */
  readonly next: repo.ManualAccess;
  /** The actor of the entitlement events: the owner for their own change, else the system. */
  readonly actor: AuditEvent["actor"];
  /** Events that explain the change itself, before the entitlement events. */
  readonly events: (plan: EntitlementPlan) => AuditEvent[];
  /** True when nothing needs writing unless the plan or timer changes. */
  readonly onlyIfChanged: boolean;
  /**
   * The owner making the change, who must still own the workspace, and the workspace must still
   * be active, when it is written: an owner never writes to a workspace being deleted.
   */
  readonly ownerUserId?: string;
  /** A new grant: the offer version it was validated at, which the plan must still use. */
  readonly offerVersion?: number;
}

/**
 * Plans the access's entitlements against its offer's current version and the workspace's
 * status, and writes the decision in one batch. `false` when the write was stale or wrote
 * nothing because nothing changed; the caller decides whether to read again.
 */
async function decide(
  ctx: ServiceContext,
  decision: Decision,
): Promise<repo.ManualAccessWriteResult | "unchanged"> {
  const { workspaceId, stored, next } = decision;
  const now = ctx.clock.now();
  const [offer, workspace, live] = await Promise.all([
    repo.getOffer(ctx.db, { workspaceId, offerId: next.offerId }) as Promise<repo.OfferWithConfig>,
    repo.getWorkspace(ctx.db, workspaceId) as Promise<repo.Workspace>,
    stored === null
      ? Promise.resolve([])
      : repo.listLiveEntitlementsForManualAccess(ctx.db, {
          workspaceId,
          manualAccessId: stored.id,
        }),
  ]);
  const plan = planManualEntitlements({
    now,
    access: next,
    offer: {
      offerId: offer.id,
      version: offer.version,
      status: offer.status,
      accesses: offer.accesses.map(({ resourceId, accessLevel }) => ({ resourceId, accessLevel })),
    },
    live: live.map(liveEntitlement),
    withdrawn: workspaceWithdrawal(workspace.status),
  });
  // An owner acts only in an active workspace, on the offer as it was validated: anything else
  // committed since the owner was authorized makes the decision stale.
  if (
    (decision.ownerUserId !== undefined && workspace.status !== "active") ||
    (decision.offerVersion !== undefined && decision.offerVersion !== offer.version)
  ) {
    return { ok: false, reason: "stale" };
  }
  const access: repo.ManualAccess = {
    ...next,
    nextEvaluationAt: next.revokedAt === null ? plan.nextEvaluationAt : null,
    version: (stored?.version ?? 0) + 1,
    updatedAt: stored === null ? next.updatedAt : now,
  };
  if (
    decision.onlyIfChanged &&
    stored !== null &&
    planSize(plan) === 0 &&
    access.nextEvaluationAt === stored.nextEvaluationAt
  ) {
    return "unchanged";
  }

  const event =
    (action: "entitlement.created" | "entitlement.updated" | "entitlement.ended") =>
    (targetId: string, details: object) =>
      auditEvent(action, { workspaceId, actor: decision.actor, targetId, details } as never, ctx);
  const created = plan.create.map(
    (entitlement): repo.NewEntitlement => ({
      ...entitlement,
      id: ctx.ids.next(),
      workspaceId,
      sourceType: "manual",
      sourceId: access.id,
      state: "active",
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const previous = new Map(live.map((row) => [row.id, row]));
  const audit: AuditEvent[] = [
    ...decision.events(plan),
    ...created.map((row) =>
      event("entitlement.created")(row.id, {
        subjectId: row.subjectId,
        resourceId: row.resourceId,
        accessLevel: row.accessLevel,
        manualAccessId: access.id,
        offerId: row.offerId,
        offerVersion: row.offerVersion,
        policyVersion: row.policyVersion,
        validUntil: row.validUntil,
        reason: row.decisionReason,
      }),
    ),
    ...plan.update.map(({ id, set }) =>
      event("entitlement.updated")(id, {
        validUntil: { from: (previous.get(id) as repo.Entitlement).validUntil, to: set.validUntil },
        reason: set.decisionReason,
        offerVersion: set.offerVersion,
        policyVersion: set.policyVersion,
      }),
    ),
    ...plan.end.map(({ id, state, reason }) => event("entitlement.ended")(id, { state, reason })),
  ];
  const touched = new Set([
    ...created.map((row) => row.resourceId),
    ...[...plan.update, ...plan.end].map(
      ({ id }) => (previous.get(id) as repo.Entitlement).resourceId,
    ),
  ]);
  return repo.applyManualAccessWrite(
    ctx.db,
    {
      workspaceId,
      now,
      expectedVersion: stored?.version ?? 0,
      access,
      offer: { offerId: offer.id, version: offer.version },
      ...(stored === null ? { openLimit: MANUAL_ACCESS_OPEN_LIMIT } : {}),
      workspaceStatus: workspace.status,
      ...(decision.ownerUserId === undefined ? {} : { ownerUserId: decision.ownerUserId }),
      entitlements: { create: created, update: plan.update, end: plan.end },
      reconcile: [...touched]
        .sort()
        .map((resourceId) => reconcileOutboxRow(ctx, { workspaceId, resourceId })),
    },
    audit as [AuditEvent, ...AuditEvent[]],
  );
}

// The owner's actions -------------------------------------------------------------------------

/**
 * Why a grant was refused: an invalid note or end date, a GitHub login that does not resolve to a
 * user account (see `GitHubAccountError`), `offer_unavailable` (archived, or no repositories),
 * `already_granted` (the account has an open manual access to the offer: edit its end date),
 * `limit_reached` (the workspace has {@link MANUAL_ACCESS_OPEN_LIMIT} open ones) or `rate_limited`
 * (50 new ones a day per workspace).
 */
export type GrantManualAccessError =
  | ManualAccessNoteError
  | "end_not_in_future"
  | GitHubAccountError
  | "offer_unavailable"
  | "already_granted"
  | "limit_reached"
  | "rate_limited";

export type GrantManualAccessResult =
  | {
      readonly ok: true;
      readonly manualAccessId: string;
      /** The account's login, as GitHub reports it now. */
      readonly login: string;
    }
  | { readonly ok: false; readonly error: GrantManualAccessError };

/**
 * An owner grants an offer's repositories to a GitHub account, with no subscription (decision
 * 0016). Needs `workspace.manage` in an active workspace. The login is resolved to its immutable
 * ID through the workspace's GitHub connection; the account's subject is created on first sight.
 * One batch stores the access, its entitlements, the reconcile requests and the audit events
 * (`access.granted_manually` by the owner, with the note as reason). A repeated request for the
 * same offer and account, such as a resubmitted form, is `already_granted` and writes nothing.
 */
export async function grantManualAccess(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  input: {
    readonly offerId: string;
    readonly githubLogin: string;
    readonly endsAt: Instant | null;
    readonly note: string;
  },
  deps: { readonly github: GitHubAppPort },
): Promise<GrantManualAccessResult> {
  const ctx = atOneInstant(context);
  const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  const { workspaceId } = scope;
  const now = ctx.clock.now();
  const fail = (error: GrantManualAccessError) => ({ ok: false, error }) as const;
  const note = parseManualAccessNote(input.note);
  if (!note.ok) return fail(note.error);
  const endsAt = parseManualAccessEnd(input.endsAt, now);
  if (!endsAt.ok) return fail(endsAt.error);
  const offer = await repo.getOffer(ctx.db, { workspaceId, offerId: input.offerId });
  if (offer === null) throw new NotFoundError("offer not found in workspace");
  if (offer.status !== "active" || offer.accesses.length === 0) return fail("offer_unavailable");
  // Before GitHub is asked: the limit bounds lookups and invitations alike.
  if (!(await repo.takeRateLimits(ctx.db, manualAccessRateLimitBuckets(workspaceId), now))) {
    return fail("rate_limited");
  }
  const resolved = await resolveGitHubAccount(ctx, workspaceId, input.githubLogin, deps.github);
  if (!resolved.ok) return fail(resolved.error);
  const { account } = resolved;
  const by = asAuditActor(actor);
  const subject = await subjectFor(
    ctx,
    workspaceId,
    { provider: "github", externalSubjectId: account.id, login: account.login },
    by,
  );

  const access: repo.ManualAccess = {
    id: ctx.ids.next(),
    workspaceId,
    offerId: offer.id,
    subjectId: subject.id,
    endsAt: endsAt.value,
    note: note.value,
    revokedAt: null,
    revokeCause: null,
    nextEvaluationAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const result = await decide(ctx, {
    workspaceId,
    stored: null,
    next: access,
    actor: by,
    onlyIfChanged: false,
    ownerUserId: actor.userId,
    offerVersion: offer.version,
    events: () => [
      auditEvent(
        "access.granted_manually",
        {
          workspaceId,
          actor: by,
          targetId: access.id,
          ...(note.value === null ? {} : { reason: note.value }),
          details: {
            offerId: offer.id,
            subjectId: subject.id,
            externalSubjectId: account.id,
            endsAt: access.endsAt,
          },
        },
        ctx,
      ),
    ],
  });
  if (result === "unchanged") throw new Error("a new manual access always writes");
  if (!result.ok) {
    if (result.reason === "already_open") return fail("already_granted");
    if (result.reason === "limit_reached") return fail("limit_reached");
    // Stale: the offer changed, or the workspace or the actor's role did, since they were read.
    // Authorizing again turns a lost role or a deletion into the error it is.
    await openWorkspace(ctx, actor, slug, "workspace.manage");
    throw new ConflictError("the offer changed while granting access; retry");
  }
  return { ok: true, manualAccessId: access.id, login: account.login };
}

/** An owner's change to a manual access by ID, in their workspace. */
async function ownerChange(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  manualAccessId: string,
  change: (
    stored: repo.ManualAccess,
    subject: repo.Subject,
    now: Instant,
  ) => { next: repo.ManualAccess; event: AuditEvent } | "noop",
): Promise<"noop" | "written"> {
  for (let attempt = 1; ; attempt += 1) {
    const ctx = atOneInstant(context);
    const { scope } = await openWorkspace(ctx, actor, slug, "workspace.manage");
    const { workspaceId } = scope;
    // Looked up in the actor's workspace only: another workspace's access is not found.
    const stored = await repo.getManualAccess(ctx.db, { workspaceId, id: manualAccessId });
    if (stored === null) throw new NotFoundError("manual access not found in workspace");
    const subject = (await repo.getSubject(ctx.db, {
      workspaceId,
      subjectId: stored.subjectId,
    })) as repo.Subject;
    const changed = change(stored, subject, ctx.clock.now());
    if (changed === "noop") return "noop";
    const result = await decide(ctx, {
      workspaceId,
      stored,
      next: changed.next,
      actor: asAuditActor(actor),
      onlyIfChanged: false,
      ownerUserId: actor.userId,
      events: () => [changed.event],
    });
    if (result !== "unchanged" && result.ok) return "written";
    if (attempt === MAX_ATTEMPTS) {
      throw new ConflictError("the manual access kept changing; retry");
    }
  }
}

export type UpdateManualAccessResult =
  | { readonly ok: true; readonly outcome: "updated" | "unchanged" }
  | { readonly ok: false; readonly error: "end_not_in_future" | "revoked" };

/**
 * An owner changes a manual access's end date (null: no end). A new date must be in the future.
 * An access whose end date passed is granted again by a later one; a revoked one cannot change.
 * Audited `access.updated_manually`; the same date again writes nothing.
 */
export async function updateManualAccessEnd(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  input: { readonly manualAccessId: string; readonly endsAt: Instant | null },
): Promise<UpdateManualAccessResult> {
  let error: "end_not_in_future" | "revoked" | null = null;
  const outcome = await ownerChange(
    context,
    actor,
    slug,
    input.manualAccessId,
    (stored, subject, now) => {
      if (stored.revokedAt !== null) {
        error = "revoked";
        return "noop";
      }
      if (input.endsAt === stored.endsAt) return "noop";
      const parsed = parseManualAccessEnd(input.endsAt, now);
      if (!parsed.ok) {
        error = parsed.error;
        return "noop";
      }
      return {
        next: { ...stored, endsAt: parsed.value },
        event: auditEvent(
          "access.updated_manually",
          {
            workspaceId: stored.workspaceId,
            actor: asAuditActor(actor),
            targetId: stored.id,
            details: {
              offerId: stored.offerId,
              subjectId: stored.subjectId,
              externalSubjectId: subject.externalSubjectId,
              endsAt: { from: stored.endsAt, to: parsed.value },
            },
          },
          { ...context, clock: { now: () => now } },
        ),
      };
    },
  );
  if (error !== null) return { ok: false, error };
  return { ok: true, outcome: outcome === "written" ? "updated" : "unchanged" };
}

/**
 * An owner revokes a manual access: its entitlements end (`manual_revoked`) and reconciliation
 * removes the access ShareRepo granted. Final. Revoking it again, such as a resubmitted form, is
 * `already_revoked` and writes nothing. Audited `access.revoked_manually` (cause `owner`).
 */
export async function revokeManualAccess(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  input: { readonly manualAccessId: string },
): Promise<{ readonly ok: true; readonly outcome: "revoked" | "already_revoked" }> {
  const outcome = await ownerChange(
    context,
    actor,
    slug,
    input.manualAccessId,
    (stored, subject, now) =>
      stored.revokedAt !== null
        ? "noop"
        : {
            next: {
              ...stored,
              revokedAt: now,
              revokeCause: ManualAccessRevokeCause.Owner,
            },
            event: auditEvent(
              "access.revoked_manually",
              {
                workspaceId: stored.workspaceId,
                actor: asAuditActor(actor),
                targetId: stored.id,
                details: {
                  offerId: stored.offerId,
                  subjectId: stored.subjectId,
                  externalSubjectId: subject.externalSubjectId,
                  cause: ManualAccessRevokeCause.Owner,
                },
              },
              { ...context, clock: { now: () => now } },
            ),
          },
  );
  return { ok: true, outcome: outcome === "written" ? "revoked" : "already_revoked" };
}

// System evaluation ---------------------------------------------------------------------------

/** Identifies one manual access, within its workspace. */
export interface ManualAccessRef {
  readonly workspaceId: string;
  readonly manualAccessId: string;
}

/**
 * Evaluates one manual access again (system work): its end date passed, its offer changed, or its
 * workspace's deletion was requested or cancelled. Re-plans its entitlements from the stored
 * facts, at the offer's current version, and writes only what changed, with the next timer and a
 * `manual_access.evaluated` event. Idempotent: run twice, the second run writes nothing. A
 * concurrent writer makes an attempt stale; after three it throws a retryable ConflictError.
 * Returns whether it wrote; an access that is gone (purged) is `absent`.
 */
export async function evaluateManualAccess(
  context: ServiceContext,
  ref: ManualAccessRef,
): Promise<"absent" | "unchanged" | "written"> {
  for (let attempt = 1; ; attempt += 1) {
    const ctx = atOneInstant(context);
    const { workspaceId } = ref;
    const stored = await repo.getManualAccess(ctx.db, { workspaceId, id: ref.manualAccessId });
    if (stored === null) return "absent";
    const result = await decide(ctx, {
      workspaceId,
      stored,
      next: stored,
      actor: SYSTEM,
      onlyIfChanged: true,
      events: (plan) => [
        auditEvent(
          "manual_access.evaluated",
          {
            workspaceId,
            actor: SYSTEM,
            targetId: stored.id,
            details: {
              nextEvaluationAt: stored.revokedAt === null ? plan.nextEvaluationAt : null,
            },
          },
          ctx,
        ),
      ],
    });
    if (result === "unchanged") return "unchanged";
    if (result.ok) return "written";
    if (attempt === MAX_ATTEMPTS) {
      throw new ConflictError("manual access kept changing during evaluation; retry later");
    }
  }
}

export interface ManualSweepSummary {
  readonly evaluated: number;
  /** Accesses whose evaluation threw; each stays due and is tried again next tick. */
  readonly failed: number;
}

/**
 * The per-minute sweep's manual access timers (decision 0013 model, decision 0016): evaluates up
 * to `limit` manual accesses, in any workspace, whose `next_evaluation_at` has passed, oldest
 * first. The work is local (no provider is read), so it runs in the tick rather than through the
 * queue; each write is guarded, so a replayed or concurrent tick changes nothing twice. A failing
 * access does not stop the others.
 */
export async function evaluateDueManualAccesses(
  context: ServiceContext,
  input: { readonly limit: number },
): Promise<ManualSweepSummary> {
  const due = await repo.listDueManualAccesses(context.db, {
    now: context.clock.now(),
    limit: input.limit,
  });
  let failed = 0;
  for (const { workspaceId, id } of due) {
    try {
      await evaluateManualAccess(context, { workspaceId, manualAccessId: id });
    } catch {
      failed += 1;
    }
  }
  return { evaluated: due.length - failed, failed };
}
