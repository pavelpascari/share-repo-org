import * as repo from "@sharerepo/db";
import {
  type AuditEvent,
  accountDeletionConfirmed,
  auditEvent,
  type CommercialSource,
  dailyOffsetMs,
  EXPORT_RATE_LIMIT,
  exportRateLimitBuckets,
  type Instant,
  LIFECYCLE_BATCH_SIZE,
  OutboxKind,
  PurgeBlock,
  pruneCutoffs,
  purgeBlock,
  purgeDue,
  rateLimitWindowStart,
  WORKSPACE_DELETION_DELAY_MS,
  WORKSPACE_EXPORT_FORMAT_VERSION,
  type WorkspaceStatus,
  workspaceDeletionConfirmed,
  workspacesBlockingAccountDeletion,
} from "@sharerepo/domain";
import { asAuditActor, atOneInstant, type ServiceContext, type UserActor } from "./context.ts";
import { type CommerceDeps, disconnectWorkspacePaddle } from "./paddle.ts";
import { reconcileOutboxRow } from "./reconciliation.ts";
import { refreshOutboxRow } from "./subscriptions.ts";
import { openWorkspace, type WorkspaceSummary } from "./workspaces.ts";

// The data lifecycle (decision 0015): retention pruning, workspace export, workspace deletion and
// its purge, and account deletion.

const SYSTEM = { type: "system", id: null } as const;

/** Every commercial source a workspace's subscriptions can come from. */
const ALL_SOURCES: readonly CommercialSource[] = ["paddle", "simulated"];

// Retention ------------------------------------------------------------------------------------

/**
 * One pruning run (`prune_data`): deletes up to {@link LIFECYCLE_BATCH_SIZE} rows per table that
 * are past their retention period and referenced by nothing, and writes one account-scoped
 * `data.pruned` system event with the counts. Returns the counts.
 */
export async function pruneData(context: ServiceContext): Promise<repo.DeletedRows> {
  const ctx = atOneInstant(context);
  return repo.pruneExpiredData(ctx.db, {
    cutoffs: pruneCutoffs(ctx.clock.now()),
    limit: LIFECYCLE_BATCH_SIZE,
    audit: (deleted) => [
      auditEvent(
        "data.pruned",
        { actor: SYSTEM, targetId: ctx.ids.next(), details: { deleted } },
        ctx,
      ),
    ],
  });
}

/** The `prune_data` outbox subject: one pruning job at a time, system-wide. */
export const PRUNE_JOB_KEY = "retention";

/**
 * The daily lifecycle work, queued by the daily cron: one `prune_data`, and a `purge_workspace`
 * for each workspace whose deletion is due. Each is spread over the day by a hash of its key, and
 * not queued again while one is pending. Both are system work (no workspace on the row): a purge
 * deletes its workspace's own outbox rows. Returns how many rows it queued.
 */
export async function queueLifecycleJobs(context: ServiceContext): Promise<number> {
  const ctx = atOneInstant(context);
  const now = ctx.clock.now();
  const row = (kind: repo.NewOutboxRow["kind"], subjectId: string): repo.NewOutboxRow => ({
    id: ctx.ids.next(),
    kind,
    subjectId,
    createdAt: now,
    availableAt: now + dailyOffsetMs(kind, subjectId),
    workspaceId: null,
  });
  let queued = 0;
  const rows = [
    row(OutboxKind.PruneData, PRUNE_JOB_KEY),
    ...(await repo.listDuePurges(ctx.db, now)).map((id) => row(OutboxKind.PurgeWorkspace, id)),
  ];
  for (const candidate of rows) {
    if (await repo.enqueueOutboxOnce(ctx.db, candidate)) queued += 1;
  }
  return queued;
}

// Workspace purge ------------------------------------------------------------------------------

/** Purge batches one job runs before it queues its own continuation. */
export const PURGE_BATCHES_PER_RUN = 40;

/**
 * How a purge run ended:
 * - `gone`: the workspace no longer exists (already purged);
 * - `not_due`: it is not being deleted, or its `delete_after` has not passed;
 * - `waiting`: access ShareRepo granted is not yet revoked; the reason is recorded
 *   (`purge_blocked:<workspaceId>` in `system_state`) for the failure pages;
 * - `continuing`: rows remain, and another `purge_workspace` is queued;
 * - `purged`: the workspace and all its rows are gone, and the tombstone is written.
 */
export type PurgeOutcome = "gone" | "not_due" | "waiting" | "continuing" | "purged";

function continuation(ctx: ServiceContext, workspaceId: string): repo.NewOutboxRow {
  const now = ctx.clock.now();
  return {
    id: ctx.ids.next(),
    kind: OutboxKind.PurgeWorkspace,
    subjectId: workspaceId,
    createdAt: now,
    availableAt: now,
    workspaceId: null,
  };
}

/**
 * Purges a workspace being deleted (`purge_workspace`, decision 0015), once its `delete_after`
 * has passed and no entitlement is live and no managed grant remains; otherwise it records why it
 * waits (and queues refreshes of the subscriptions whose entitlements are still live) and changes
 * nothing else. The first batch moves the workspace to `purging`; then every workspace-owned
 * table is emptied in bounded batches, in foreign-key order, ending with its audit events. A run
 * stops after {@link PURGE_BATCHES_PER_RUN} batches and queues its continuation. The last batch
 * deletes the workspace and writes the account-scoped `workspace.purged` tombstone with the
 * counts. Re-running after a failure at any point continues where it stopped.
 */
export async function purgeWorkspace(
  context: ServiceContext,
  workspaceId: string,
  options: { readonly batchesPerRun?: number } = {},
): Promise<PurgeOutcome> {
  const ctx = atOneInstant(context);
  const now = ctx.clock.now();
  const workspace = await repo.getWorkspace(ctx.db, workspaceId);
  if (workspace === null) return "gone";
  if (!purgeDue(workspace, now)) return "not_due";
  let start = workspace.status === "deleting";
  if (start) {
    const block = purgeBlock(await repo.countRemainingAccess(ctx.db, workspaceId));
    if (block !== null) {
      await repo.recordPurgeBlocked(ctx.db, { workspaceId, reason: block, now });
      // The repair path: refreshes, and evaluations of manual accesses, end the entitlements of a
      // workspace being deleted.
      if (block === PurgeBlock.EntitlementsRemaining) {
        await repo.queueWorkspaceRefreshes(ctx.db, { workspaceId, sources: ALL_SOURCES, now });
        await repo.markManualAccessesDue(ctx.db, { workspaceId, now });
      }
      return "waiting";
    }
  }
  const budget = options.batchesPerRun ?? PURGE_BATCHES_PER_RUN;
  let batches = 0;
  for (const table of repo.PURGE_ORDER) {
    // An empty table costs no batch, except the first, which starts the purge.
    if (!start && !(await repo.purgeTableHasRows(ctx.db, { workspaceId, table }))) continue;
    for (;;) {
      if (batches === budget) {
        await repo.enqueueOutbox(ctx.db, continuation(ctx, workspaceId));
        return "continuing";
      }
      const batch = await repo.purgeBatch(ctx.db, {
        workspaceId,
        table,
        limit: LIFECYCLE_BATCH_SIZE,
        now,
        start,
      });
      batches += 1;
      // Access appeared, or the deletion was cancelled, between the check and the first batch.
      if (!batch.purging) return "waiting";
      start = false;
      if (batch.deleted < LIFECYCLE_BATCH_SIZE) break;
    }
  }
  try {
    // False only when a concurrent run deleted the workspace first: purged either way.
    await repo.finishPurge(ctx.db, {
      workspaceId,
      audit: (deleted) => [
        auditEvent(
          "workspace.purged",
          { actor: SYSTEM, targetId: workspaceId, details: { deleted } },
          ctx,
        ),
      ],
    });
    return "purged";
  } catch (error) {
    // Another job wrote a row for the workspace after its table was emptied: run again.
    if (!repo.isForeignKeyViolation(error)) throw error;
    await repo.enqueueOutbox(ctx.db, continuation(ctx, workspaceId));
    return "continuing";
  }
}

// Workspace settings, deletion and export ------------------------------------------------------

/** Statuses in which an owner can still open the settings, export, and cancel a deletion. */
const OWNER_LIFECYCLE_STATUSES: readonly WorkspaceStatus[] = ["active", "deleting"];

/** A workspace's deletion, as its settings page shows it. */
export interface WorkspaceDeletion {
  readonly deleteAfter: Instant;
  /** Why the purge waits, once it is due, or null. */
  readonly blocked: { readonly reason: PurgeBlock; readonly since: Instant } | null;
}

export interface WorkspaceSettings {
  readonly workspace: WorkspaceSummary;
  /** Null unless the workspace is being deleted. */
  readonly deletion: WorkspaceDeletion | null;
}

/** The owner's settings view, for an active workspace or one being deleted. */
export async function getWorkspaceSettings(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
): Promise<WorkspaceSettings> {
  const ctx = atOneInstant(context);
  const { workspace } = await openWorkspace(ctx, actor, slug, "workspace.manage", {
    writableIn: OWNER_LIFECYCLE_STATUSES,
  });
  const state = await repo.getWorkspaceDeletionState(ctx.db, workspace.id);
  const deletion =
    state?.deleteAfter == null
      ? null
      : {
          deleteAfter: state.deleteAfter,
          blocked:
            state.blocked === null
              ? null
              : { reason: state.blocked.reason as PurgeBlock, since: state.blocked.since },
        };
  return { workspace, deletion };
}

export type RequestDeletionResult =
  | {
      readonly ok: true;
      readonly deleteAfter: Instant;
      /** A Paddle destination ShareRepo could not delete: the creator must delete it in Paddle. */
      readonly orphanedDestinationId: string | null;
    }
  | { readonly ok: false; readonly reason: "confirmation_mismatch" | "not_active" };

/**
 * An owner asks to delete their workspace (decision 0015), confirmed by typing its slug. The
 * Paddle connection is disconnected first, as a disconnect does (credentials erased; the
 * destination deleted when Paddle can be asked). Then, in one batch, the workspace becomes
 * `deleting` until 30 days from now, and every subscription is queued for a refresh, which ends
 * its entitlements (`workspace_deleted`) so reconciliation revokes managed access. From then on
 * the workspace refuses writes, checkout and claims. A failure after the disconnect leaves the
 * workspace active, and the request can simply be made again.
 */
export async function requestWorkspaceDeletion(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  input: { readonly confirmation: string },
  commerce: CommerceDeps | null,
): Promise<RequestDeletionResult> {
  const ctx = atOneInstant(context);
  const { scope, workspace } = await openWorkspace(ctx, actor, slug, "workspace.manage");
  if (!workspaceDeletionConfirmed(workspace.slug, input.confirmation)) {
    return { ok: false, reason: "confirmation_mismatch" };
  }
  const { workspaceId } = scope;
  const paddle = await disconnectWorkspacePaddle(ctx, actor, workspaceId, commerce);
  const now = ctx.clock.now();
  const deleteAfter = now + WORKSPACE_DELETION_DELAY_MS;
  const result = await repo.scheduleWorkspaceDeletion(
    ctx.db,
    { workspaceId, requestedBy: actor.userId, now, deleteAfter },
    [
      auditEvent(
        "workspace.deletion_requested",
        {
          workspaceId,
          actor: asAuditActor(actor),
          targetId: workspaceId,
          details: { deleteAfter },
        },
        ctx,
      ),
    ],
  );
  if (!result.ok) return { ok: false, reason: "not_active" };
  return {
    ok: true,
    deleteAfter,
    orphanedDestinationId: paddle.ok && !paddle.destinationDeleted ? paddle.destinationId : null,
  };
}

/**
 * An owner cancels their workspace's deletion before its purge started: it is `active` again, and
 * its subscriptions are refreshed so their entitlements come back. Paddle subscriptions come back
 * when Paddle is reconnected (the connect re-reads them). Refused unless it is `deleting`.
 */
export async function cancelWorkspaceDeletion(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
): Promise<{ readonly ok: boolean }> {
  const ctx = atOneInstant(context);
  const { scope, workspace } = await openWorkspace(ctx, actor, slug, "workspace.manage", {
    writableIn: OWNER_LIFECYCLE_STATUSES,
  });
  if (workspace.status !== "deleting") return { ok: false };
  const { workspaceId } = scope;
  // The deletion disconnected Paddle, so only simulated subscriptions can be read now. Paddle ones
  // are refreshed when Paddle is connected again (`connectPaddle`).
  const sources: CommercialSource[] = ["simulated"];
  return repo.cancelWorkspaceDeletion(ctx.db, { workspaceId, now: ctx.clock.now(), sources }, [
    auditEvent(
      "workspace.deletion_cancelled",
      { workspaceId, actor: asAuditActor(actor), targetId: workspaceId, details: {} },
      ctx,
    ),
  ]);
}

/**
 * The workspace export (decision 0015): everything an owner may take away, from an allow-list of
 * columns per table. Never credentials, envelopes, token or email hashes, claim references,
 * claims, or emails.
 */
export type WorkspaceExport = Omit<repo.WorkspaceExportRows, "offerVersions" | "auditEvents"> & {
  readonly formatVersion: typeof WORKSPACE_EXPORT_FORMAT_VERSION;
  readonly exportedAt: Instant;
  readonly offerVersions: readonly (Omit<
    repo.WorkspaceExportRows["offerVersions"][number],
    "snapshot"
  > & { readonly snapshot: unknown })[];
  readonly auditEvents: readonly (Omit<
    repo.WorkspaceExportRows["auditEvents"][number],
    "details"
  > & { readonly details: unknown })[];
};

export type ExportWorkspaceResult =
  | { readonly ok: true; readonly document: WorkspaceExport; readonly filename: string }
  | { readonly ok: false; readonly reason: "rate_limited"; readonly retryAt: Instant };

/**
 * Builds a workspace's export for an owner, while it is active or being deleted. Limited to
 * {@link EXPORT_RATE_LIMIT} per workspace, and audited as `workspace.exported`.
 */
export async function exportWorkspace(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
): Promise<ExportWorkspaceResult> {
  const ctx = atOneInstant(context);
  const { scope, workspace } = await openWorkspace(ctx, actor, slug, "workspace.manage", {
    writableIn: OWNER_LIFECYCLE_STATUSES,
  });
  const { workspaceId } = scope;
  const now = ctx.clock.now();
  if (!(await repo.takeRateLimits(ctx.db, exportRateLimitBuckets(workspaceId), now))) {
    const { windowMs } = EXPORT_RATE_LIMIT;
    return {
      ok: false,
      reason: "rate_limited",
      retryAt: rateLimitWindowStart(windowMs, now) + windowMs,
    };
  }
  const rows = await repo.readWorkspaceExport(ctx.db, workspaceId);
  const document: WorkspaceExport = {
    formatVersion: WORKSPACE_EXPORT_FORMAT_VERSION,
    exportedAt: now,
    ...rows,
    offerVersions: rows.offerVersions.map((v) => ({ ...v, snapshot: JSON.parse(v.snapshot) })),
    auditEvents: rows.auditEvents.map((e) => ({ ...e, details: JSON.parse(e.details) })),
  };
  await repo.appendAuditEvents(ctx.db, [
    auditEvent(
      "workspace.exported",
      {
        workspaceId,
        actor: asAuditActor(actor),
        targetId: workspaceId,
        details: { formatVersion: WORKSPACE_EXPORT_FORMAT_VERSION },
      },
      ctx,
    ),
  ]);
  const date = new Date(now).toISOString().slice(0, 10);
  return { ok: true, document, filename: `sharerepo-${workspace.slug}-${date}.json` };
}

// Account deletion -----------------------------------------------------------------------------

/** A workspace as the account page lists it. */
export interface AccountWorkspace {
  readonly slug: string;
  readonly name: string;
  readonly status: WorkspaceStatus;
}

export interface AccountView {
  /** The GitHub login that confirms a deletion, or null without a linked identity. */
  readonly login: string | null;
  /** Owned workspaces that are not being deleted: each refuses the account's deletion. */
  readonly blockingWorkspaces: readonly AccountWorkspace[];
}

async function blockingWorkspaces(ctx: ServiceContext, userId: string) {
  const memberships = (await repo.listWorkspacesForUser(ctx.db, userId)).map((m) => ({
    slug: m.workspace.slug as string,
    name: m.workspace.name as string,
    status: m.workspace.status,
    role: m.role,
  }));
  return workspacesBlockingAccountDeletion(memberships).map(({ slug, name, status }) => ({
    slug,
    name,
    status,
  }));
}

/** What the signed-in user's account page needs. */
export async function getAccountView(
  context: ServiceContext,
  actor: UserActor,
): Promise<AccountView> {
  const ctx = atOneInstant(context);
  const identity = await repo.findExternalIdentityForUser(ctx.db, {
    userId: actor.userId,
    provider: "github",
  });
  return {
    login: identity?.usernameSnapshot ?? null,
    blockingWorkspaces: await blockingWorkspaces(ctx, actor.userId),
  };
}

export type DeleteAccountResult =
  | { readonly ok: true; readonly unlinkedSubjects: number; readonly deleted: repo.DeletedRows }
  | { readonly ok: false; readonly reason: "confirmation_mismatch" }
  | {
      readonly ok: false;
      readonly reason: "owns_workspaces";
      readonly workspaces: readonly AccountWorkspace[];
    };

/**
 * Deletes the signed-in user's own account (decision 0015), confirmed by typing their GitHub
 * login, and refused while they own a workspace that is not being deleted. First, workspace by
 * workspace, every subject of their GitHub account (linked to their identity, or naming no user,
 * as a simulated subscription, a manual link or an earlier deletion leaves it) is cleared: it is
 * unlinked from the identity, its customers are unlinked, a creator's open manual accesses to it
 * are revoked (decision 0016), its live entitlements end
 * (`account_deleted`), and reconciles of the repositories and refreshes of the customers'
 * subscriptions are queued, so reconciliation revokes managed access. Then one batch deletes
 * their claims, claim requests and consumed claim tokens, connection intents, memberships,
 * sessions, Better Auth accounts and profile, identities and `users` row, with `user.deleted`
 * (counts only; `unlinkedSubjects` is the account's subjects, all unlinked now). Re-running after
 * a failure part-way continues: a workspace with nothing left to clear is skipped, and the last
 * batch is atomic. The caller signs the user out.
 */
export async function deleteAccount(
  context: ServiceContext,
  actor: UserActor,
  input: { readonly confirmation: string },
): Promise<DeleteAccountResult> {
  const ctx = atOneInstant(context);
  const { userId } = actor;
  const by = asAuditActor(actor);
  const identity = await repo.findExternalIdentityForUser(ctx.db, { userId, provider: "github" });
  if (
    identity === null ||
    !accountDeletionConfirmed(identity.usernameSnapshot, input.confirmation)
  ) {
    return { ok: false, reason: "confirmation_mismatch" };
  }
  const blocking = await blockingWorkspaces(ctx, userId);
  if (blocking.length > 0) return { ok: false, reason: "owns_workspaces", workspaces: blocking };

  const subjects = await repo.listSubjectsOfIdentity(ctx.db, identity);
  const byWorkspace = new Map<string, repo.LinkedSubject[]>();
  for (const subject of subjects) {
    byWorkspace.set(subject.workspaceId, [
      ...(byWorkspace.get(subject.workspaceId) ?? []),
      subject,
    ]);
  }
  const now = ctx.clock.now();
  for (const [workspaceId, ofAccount] of byWorkspace) {
    const subjectIds = ofAccount.map((subject) => subject.id);
    const access = await repo.readSubjectAccess(ctx.db, { workspaceId, subjectIds });
    const stillLinked = new Set(
      await repo.subjectsLinkedToIdentity(ctx.db, {
        workspaceId,
        identityId: identity.id,
        subjectIds,
      }),
    );
    const linked = ofAccount.filter((subject) => stillLinked.has(subject.id));
    // Nothing left to clear here (an earlier run, or a crash after this workspace's batch).
    const open = access.manualAccesses;
    if (
      linked.length + access.customers.length + access.liveEntitlements.length + open.length ===
      0
    ) {
      continue;
    }
    const externalIdOf = new Map(ofAccount.map((s) => [s.id, s.externalSubjectId]));
    const event = (action: Parameters<typeof auditEvent>[0], targetId: string, details: object) =>
      auditEvent(action, { workspaceId, actor: by, targetId, details } as never, ctx);
    const audit: AuditEvent[] = [
      ...linked.map((subject) =>
        event("subject.identity_unlinked", subject.id, {
          provider: subject.provider,
          externalSubjectId: subject.externalSubjectId,
        }),
      ),
      ...access.customers.map((customer) =>
        event("customer.linked", customer.id, {
          previousSubjectId: customer.subjectId,
          subjectId: null,
        }),
      ),
      // A creator's manual access to the account is revoked too (decision 0016), so no later
      // evaluation grants it again.
      ...open.map((manual) =>
        event("access.revoked_manually", manual.id, {
          offerId: manual.offerId,
          subjectId: manual.subjectId,
          externalSubjectId: externalIdOf.get(manual.subjectId),
          cause: "account_deleted",
        }),
      ),
      ...access.liveEntitlements.map((entitlement) =>
        event("entitlement.ended", entitlement.id, { state: "revoked", reason: "account_deleted" }),
      ),
    ];
    const resources = [...new Set(access.liveEntitlements.map((e) => e.resourceId))].sort();
    await repo.unlinkSubjectsFromIdentity(
      ctx.db,
      {
        workspaceId,
        identityId: identity.id,
        subjectIds,
        entitlementIds: access.liveEntitlements.map((e) => e.id),
        now,
        work: [
          ...resources.map((resourceId) => reconcileOutboxRow(ctx, { workspaceId, resourceId })),
          ...access.subscriptions.map((subscription) =>
            refreshOutboxRow(ctx, {
              workspaceId,
              source: subscription.source as CommercialSource,
              externalSubscriptionId: subscription.externalSubscriptionId,
            }),
          ),
        ],
      },
      audit as [AuditEvent, ...AuditEvent[]],
    );
  }
  const deleted = await repo.deleteAccountRows(ctx.db, {
    userId,
    audit: (counts) => [
      auditEvent(
        "user.deleted",
        {
          actor: by,
          targetId: userId,
          details: { unlinkedSubjects: subjects.length, deleted: counts },
        },
        ctx,
      ),
    ],
  });
  if (deleted === null) {
    // A deletion of one of their workspaces was cancelled meanwhile: they own it again.
    return {
      ok: false,
      reason: "owns_workspaces",
      workspaces: await blockingWorkspaces(ctx, userId),
    };
  }
  return { ok: true, unlinkedSubjects: subjects.length, deleted };
}
