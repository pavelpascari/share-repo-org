import type { CommercialSource, Instant } from "@sharerepo/domain";
import { and, asc, eq, gte, isNotNull, isNull, lte, min, type SQL, sql } from "drizzle-orm";
import { type AuditEvents, conditionalAuditInserts } from "./audit-repository.ts";
import { runBatch } from "./batch.ts";
import type { Db } from "./client.ts";
import type { OutboxRow } from "./outbox-repository.ts";
import {
  connections,
  customers,
  entitlements,
  grants,
  offerAccesses,
  offers,
  outbox,
  paddleConnections,
  resources,
  subjects,
  subscriptions,
  systemState,
  workspaces,
} from "./schema/index.ts";

// Failure records (decision 0014): outbox rows that failed for good, repositories that keep
// failing to reconcile, and connections that stopped working. Every read and write of a failure
// names its workspace explicitly (null: system-wide work), never the row ID alone.

/**
 * A failure's workspace: an ID, or null for system-wide work. `outbox.workspace_id IS NULL` is
 * how SQL compares a null, so a system-wide row never matches a workspace and vice versa.
 */
const inWorkspace = (workspaceId: string | null): SQL =>
  workspaceId === null ? isNull(outbox.workspaceId) : eq(outbox.workspaceId, workspaceId);

/** One outbox row by ID, whatever its state; for the jobs Worker, which knows only the ID. */
export async function getOutboxRow(db: Db, id: string): Promise<OutboxRow | null> {
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id)).limit(1);
  return row ?? null;
}

/**
 * Records a job's terminal failure (a non-retryable error, its last attempt, or the dead-letter
 * queue) with its `job.failed` audit event, in one batch. Only a row that is neither sent nor
 * already failed changes, so a replay, or a failure that lost to a success, writes nothing.
 * Returns whether the row was marked.
 */
export async function failOutboxRow(
  db: Db,
  input: { id: string; now: Instant; errorCode: string },
  audit: AuditEvents,
): Promise<boolean> {
  const [changed] = await runBatch(db, [
    db
      .update(outbox)
      .set({ failedAt: input.now, lastErrorCode: input.errorCode })
      .where(and(eq(outbox.id, input.id), isNull(outbox.sentAt), isNull(outbox.failedAt))),
    ...conditionalAuditInserts(db, audit, sql`changes() = 1`),
  ]);
  return changed === 1;
}

/** A failed row of the workspace (null: system-wide), dismissed or not; null when none. */
export async function getFailedOutboxRow(
  db: Db,
  key: { id: string; workspaceId: string | null },
): Promise<OutboxRow | null> {
  const [row] = await db
    .select()
    .from(outbox)
    .where(and(eq(outbox.id, key.id), inWorkspace(key.workspaceId), isNotNull(outbox.failedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Makes a failed row of the workspace due again now, with its attempts reset and its error and any
 * dismissal cleared, with its `job.retried` audit event, in one batch. Returns false, writing
 * nothing, when the row is not a failure of that workspace (any more), or is dismissed and
 * `dismissed` is `refused` (an owner's retry: only an operator undoes a dismissal).
 */
export async function retryOutboxFailure(
  db: Db,
  input: {
    id: string;
    workspaceId: string | null;
    now: Instant;
    dismissed: "allowed" | "refused";
  },
  audit: AuditEvents,
): Promise<boolean> {
  const [changed] = await runBatch(db, [
    db
      .update(outbox)
      .set({
        failedAt: null,
        lastErrorCode: null,
        attempts: 0,
        availableAt: input.now,
        dismissedAt: null,
        dismissedBy: null,
        dismissReason: null,
      })
      .where(
        and(
          eq(outbox.id, input.id),
          inWorkspace(input.workspaceId),
          isNotNull(outbox.failedAt),
          isNull(outbox.sentAt),
          input.dismissed === "refused" ? isNull(outbox.dismissedAt) : undefined,
        ),
      ),
    ...conditionalAuditInserts(db, audit, sql`changes() = 1`),
  ]);
  return changed === 1;
}

/**
 * Dismisses an open failure of the workspace: who and why, with its `job.dismissed` audit event,
 * in one batch. Returns false, writing nothing, when it is not an open failure of that workspace.
 */
export async function dismissOutboxFailure(
  db: Db,
  input: { id: string; workspaceId: string | null; now: Instant; by: string; reason: string },
  audit: AuditEvents,
): Promise<boolean> {
  const [changed] = await runBatch(db, [
    db
      .update(outbox)
      .set({ dismissedAt: input.now, dismissedBy: input.by, dismissReason: input.reason })
      .where(
        and(
          eq(outbox.id, input.id),
          inWorkspace(input.workspaceId),
          isNotNull(outbox.failedAt),
          isNull(outbox.dismissedAt),
        ),
      ),
    ...conditionalAuditInserts(db, audit, sql`changes() = 1`),
  ]);
  return changed === 1;
}

/** An open failure: a failed, undismissed outbox row, with its workspace's slug and name. */
export type OpenOutboxFailure = OutboxRow & {
  readonly workspaceSlug: string | null;
  readonly workspaceName: string | null;
};

/**
 * Open failures, oldest first, at most `limit`: of one workspace, or (`all`, for operators) of
 * every workspace and the system-wide ones. Served by `outbox_open_failures_idx`.
 */
export async function listOpenOutboxFailures(
  db: Db,
  input: { workspaceId: string; limit: number } | { all: true; limit: number },
): Promise<OpenOutboxFailure[]> {
  const rows = await db
    .select({ row: outbox, workspaceSlug: workspaces.slug, workspaceName: workspaces.name })
    .from(outbox)
    .leftJoin(workspaces, eq(workspaces.id, outbox.workspaceId))
    .where(
      and(
        isNotNull(outbox.failedAt),
        isNull(outbox.dismissedAt),
        // A row the drain delivered after the dead-letter queue failed it succeeded after all.
        isNull(outbox.sentAt),
        "workspaceId" in input ? eq(outbox.workspaceId, input.workspaceId) : undefined,
      ),
    )
    .orderBy(asc(outbox.failedAt), asc(outbox.id))
    .limit(input.limit);
  return rows.map(({ row, workspaceSlug, workspaceName }) => ({
    ...row,
    workspaceSlug,
    workspaceName,
  }));
}

/** A selected repository that kept failing to reconcile. */
export interface FailingResource {
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  readonly resourceId: string;
  readonly name: string;
  readonly reconcileFailures: number;
  readonly lastReconcileError: string | null;
  readonly lastReconciledAt: Instant | null;
}

/**
 * Selected repositories with at least `minFailures` consecutive reconcile failures, most failures
 * first: of one workspace, or of every workspace (`all`, for operators).
 */
export async function listFailingResources(
  db: Db,
  input: ({ workspaceId: string } | { all: true }) & { minFailures: number; limit: number },
): Promise<FailingResource[]> {
  return db
    .select({
      workspaceId: resources.workspaceId,
      workspaceSlug: workspaces.slug,
      workspaceName: workspaces.name,
      resourceId: resources.id,
      name: resources.nameSnapshot,
      reconcileFailures: resources.reconcileFailures,
      lastReconcileError: resources.lastReconcileError,
      lastReconciledAt: resources.lastReconciledAt,
    })
    .from(resources)
    .innerJoin(workspaces, eq(workspaces.id, resources.workspaceId))
    .where(
      and(
        gte(resources.reconcileFailures, input.minFailures),
        eq(resources.selection, "selected"),
        "workspaceId" in input ? eq(resources.workspaceId, input.workspaceId) : undefined,
      ),
    )
    .orderBy(sql`${resources.reconcileFailures} DESC`, asc(resources.id))
    .limit(input.limit);
}

/** A GitHub installation that is suspended or deleted, or a Paddle connection whose key failed. */
export interface UnhealthyConnection {
  readonly provider: "github" | "paddle";
  readonly connectionId: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  /** The GitHub account login, or the Paddle seller's name (or ID when it has none). */
  readonly name: string;
  readonly status: string;
  /** When the connection last changed. */
  readonly since: Instant;
}

/**
 * Every workspace's unhealthy connections (operators), oldest change first: suspended GitHub
 * connections, unauthorized Paddle ones, and deleted GitHub connections that were deleted at or
 * after `deletedSince` or still have managed access (grants ShareRepo created and may need to
 * revoke). An old deletion with nothing left to revoke is history, not a failure.
 */
export async function listUnhealthyConnections(
  db: Db,
  input: { limit: number; deletedSince: Instant },
): Promise<UnhealthyConnection[]> {
  const [github, paddle] = await Promise.all([
    db
      .select({
        connectionId: connections.id,
        workspaceId: connections.workspaceId,
        workspaceSlug: workspaces.slug,
        workspaceName: workspaces.name,
        name: connections.accountLoginSnapshot,
        status: connections.status,
        since: connections.updatedAt,
      })
      .from(connections)
      .innerJoin(workspaces, eq(workspaces.id, connections.workspaceId))
      .where(
        sql`${connections.status} = 'suspended' OR (${connections.status} = 'deleted' AND (
          ${connections.updatedAt} >= ${input.deletedSince} OR EXISTS (SELECT 1 FROM ${grants}
            WHERE ${grants.workspaceId} = ${connections.workspaceId}
              AND ${grants.connectionId} = ${connections.id} AND ${grants.managed} = 1)))`,
      )
      .orderBy(asc(connections.updatedAt), asc(connections.id))
      .limit(input.limit),
    db
      .select({
        connectionId: paddleConnections.id,
        workspaceId: paddleConnections.workspaceId,
        workspaceSlug: workspaces.slug,
        workspaceName: workspaces.name,
        name: sql<string>`coalesce(${paddleConnections.sellerName}, ${paddleConnections.sellerId})`,
        status: paddleConnections.status,
        since: paddleConnections.updatedAt,
      })
      .from(paddleConnections)
      .innerJoin(workspaces, eq(workspaces.id, paddleConnections.workspaceId))
      .where(eq(paddleConnections.status, "unauthorized"))
      .orderBy(asc(paddleConnections.updatedAt), asc(paddleConnections.id))
      .limit(input.limit),
  ]);
  return [
    ...github.map((row) => ({ ...row, provider: "github" as const })),
    ...paddle.map((row) => ({ ...row, provider: "paddle" as const })),
  ].sort((a, b) => a.since - b.since);
}

/** The `system_state` key of the sweep's last heartbeat (Phase 6 T2). */
export const SWEEP_HEARTBEAT_KEY = "sweep.heartbeat";

/** How far behind the sweeps are: the oldest due row of each, and the last heartbeat. */
export interface SweepHealth {
  readonly oldestDueEvaluationAt: Instant | null;
  readonly oldestDueReconcileAt: Instant | null;
  readonly oldestDueOutboxAt: Instant | null;
  /** When the heartbeat was last stored, or null when it never was. */
  readonly lastHeartbeatAt: Instant | null;
}

export async function readSweepHealth(db: Db, now: Instant): Promise<SweepHealth> {
  const [[evaluation], [reconcile], [pending], [heartbeat]] = await Promise.all([
    db
      .select({ at: min(subscriptions.nextEvaluationAt) })
      .from(subscriptions)
      .where(lte(subscriptions.nextEvaluationAt, now)),
    db
      .select({ at: min(resources.nextReconcileAt) })
      .from(resources)
      .where(lte(resources.nextReconcileAt, now)),
    db
      .select({ at: min(outbox.availableAt) })
      .from(outbox)
      .where(and(isNull(outbox.sentAt), isNull(outbox.failedAt), lte(outbox.availableAt, now))),
    db
      .select({ at: systemState.updatedAt })
      .from(systemState)
      .where(eq(systemState.key, SWEEP_HEARTBEAT_KEY)),
  ]);
  return {
    oldestDueEvaluationAt: (evaluation?.at ?? null) as Instant | null,
    oldestDueReconcileAt: (reconcile?.at ?? null) as Instant | null,
    oldestDueOutboxAt: (pending?.at ?? null) as Instant | null,
    lastHeartbeatAt: heartbeat?.at ?? null,
  };
}

/** Names of the access a failed job affects, for the failure pages. */
export interface AccessNames {
  readonly repositories: readonly string[];
  readonly subscribers: readonly string[];
  readonly offers: readonly string[];
}

const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();

/**
 * The access a subscription affects in its workspace: its subscriber, and every offer and
 * repository it has had entitlements for. Empty when the workspace has no such subscription.
 */
export async function subscriptionAccessNames(
  db: Db,
  key: { workspaceId: string; source: CommercialSource; externalSubscriptionId: string },
): Promise<AccessNames> {
  const [subscription] = await db
    .select({ id: subscriptions.id, subscriber: subjects.loginSnapshot })
    .from(subscriptions)
    .innerJoin(
      customers,
      and(
        eq(customers.workspaceId, subscriptions.workspaceId),
        eq(customers.id, subscriptions.customerId),
      ),
    )
    .leftJoin(
      subjects,
      and(eq(subjects.workspaceId, customers.workspaceId), eq(subjects.id, customers.subjectId)),
    )
    .where(
      and(
        eq(subscriptions.workspaceId, key.workspaceId),
        eq(subscriptions.source, key.source),
        eq(subscriptions.externalSubscriptionId, key.externalSubscriptionId),
      ),
    )
    .limit(1);
  if (subscription === undefined) return { repositories: [], subscribers: [], offers: [] };
  const rows = await db
    .select({
      repository: resources.nameSnapshot,
      subscriber: subjects.loginSnapshot,
      offer: offers.name,
    })
    .from(entitlements)
    .innerJoin(
      resources,
      and(
        eq(resources.workspaceId, entitlements.workspaceId),
        eq(resources.id, entitlements.resourceId),
      ),
    )
    .innerJoin(
      subjects,
      and(
        eq(subjects.workspaceId, entitlements.workspaceId),
        eq(subjects.id, entitlements.subjectId),
      ),
    )
    .innerJoin(
      offers,
      and(eq(offers.workspaceId, entitlements.workspaceId), eq(offers.id, entitlements.offerId)),
    )
    .where(
      and(
        eq(entitlements.workspaceId, key.workspaceId),
        eq(entitlements.sourceId, subscription.id),
      ),
    );
  return {
    repositories: sortedUnique(rows.map((row) => row.repository)),
    subscribers: sortedUnique([
      ...rows.map((row) => row.subscriber),
      ...(subscription.subscriber === null ? [] : [subscription.subscriber]),
    ]),
    offers: sortedUnique(rows.map((row) => row.offer)),
  };
}

/** The access an offer affects in its workspace: its name and its repositories. */
export async function offerAccessNames(
  db: Db,
  key: { workspaceId: string; offerId: string },
): Promise<AccessNames> {
  const rows = await db
    .select({ offer: offers.name, repository: resources.nameSnapshot })
    .from(offers)
    // Every offer grants at least one repository (an offer without one is refused).
    .innerJoin(
      offerAccesses,
      and(eq(offerAccesses.workspaceId, offers.workspaceId), eq(offerAccesses.offerId, offers.id)),
    )
    .innerJoin(
      resources,
      and(
        eq(resources.workspaceId, offerAccesses.workspaceId),
        eq(resources.id, offerAccesses.resourceId),
      ),
    )
    .where(and(eq(offers.workspaceId, key.workspaceId), eq(offers.id, key.offerId)));
  return {
    repositories: sortedUnique(rows.map((row) => row.repository)),
    subscribers: [],
    offers: sortedUnique(rows.map((row) => row.offer)),
  };
}
