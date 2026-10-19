import {
  type AuditEvent,
  type Instant,
  type MutationOperation,
  OutboxKind,
  type RetryClass,
} from "@sharerepo/domain";
import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { type AuditEvents, auditInserts, conditionalAuditInserts } from "./audit-repository.ts";
import { insertWhere, runBatch, type Statement } from "./batch.ts";
import { chunked } from "./chunks.ts";
import type { Db } from "./client.ts";
import type { Grant } from "./grant-repository.ts";
import {
  assertReconcileRows,
  dedupedOutboxInsert,
  type NewOutboxRow,
  pendingOutbox,
} from "./outbox-repository.ts";
import { entitlements, grants, providerMutations, resources } from "./schema/index.ts";
import type { Entitlement } from "./subscription-repository.ts";

/** A change ShareRepo asked an access provider to make (decision 0010). */
export type ProviderMutation = typeof providerMutations.$inferSelect;

/** What a reconciliation run may write on an existing grant; its identity never changes. */
export type GrantWritable = Omit<
  Grant,
  "id" | "workspaceId" | "connectionId" | "subjectId" | "resourceId" | "createdAt"
>;

/** A change to one existing grant of the resource. `updated_at` is always set to `now`. */
export interface GrantUpdate {
  id: string;
  set: Partial<GrantWritable>;
}

/** The result of a write guarded on a run's reconcile lease. */
export type LeaseGuardedResult =
  | { ok: true }
  /** Another run holds the resource's lease now: nothing was written. Stop the run. */
  | { ok: false; reason: "lease_lost" };

/** Identifies a reconciliation run: the resource it holds and the token of its lease. */
export interface LeaseKey {
  workspaceId: string;
  resourceId: string;
  token: string;
}

/** The `reconcile_resource` outbox key of a resource: `<workspaceId>:<resourceId>`. */
export function reconcileKey(workspaceId: string, resourceId: string): string {
  return `${workspaceId}:${resourceId}`;
}

/** {@link reconcileKey} of the resource row in scope, in SQL, for sweeps over resources. */
export const reconcileKeyOfRow: SQL = sql`${resources.workspaceId} || ':' || ${resources.id}`;

const ofResource = (workspaceId: string, resourceId: string) =>
  and(eq(resources.workspaceId, workspaceId), eq(resources.id, resourceId)) as SQL;

// ---------------------------------------------------------------------------------------------
// Lease

/**
 * Takes the resource's reconcile lease for `token` until `now + leaseMs`, unless another lease is
 * live. One conditional UPDATE, so two runs racing for the same resource cannot both win; a lease
 * past its end is taken over. Returns whether this call took it.
 */
export async function claimReconcileLease(
  db: Db,
  input: { workspaceId: string; resourceId: string; token: string; now: Instant; leaseMs: number },
): Promise<boolean> {
  const [changed] = await runBatch(db, [
    db
      .update(resources)
      .set({ reconcileToken: input.token, reconcileLeaseUntil: input.now + input.leaseMs })
      .where(
        and(
          ofResource(input.workspaceId, input.resourceId),
          or(isNull(resources.reconcileLeaseUntil), lte(resources.reconcileLeaseUntil, input.now)),
        ),
      ),
  ]);
  return changed === 1;
}

/**
 * Ends a run: if the resource still carries `token`, clears the lease, stamps `last_reconciled_at`
 * and schedules the next run. Returns false, writing nothing, when another run took the lease.
 */
export async function releaseReconcileLease(
  db: Db,
  input: LeaseKey & { now: Instant; nextReconcileAt: Instant },
): Promise<boolean> {
  const [changed] = await runBatch(db, [
    db
      .update(resources)
      .set({
        reconcileToken: null,
        reconcileLeaseUntil: null,
        lastReconciledAt: input.now,
        nextReconcileAt: input.nextReconcileAt,
      })
      .where(
        and(
          ofResource(input.workspaceId, input.resourceId),
          eq(resources.reconcileToken, input.token),
        ),
      ),
  ]);
  return changed === 1;
}

// ---------------------------------------------------------------------------------------------
// Reads

/** The resource's grants, by subject. */
export async function listGrantsForResource(
  db: Db,
  key: { workspaceId: string; resourceId: string },
): Promise<Grant[]> {
  return db
    .select()
    .from(grants)
    .where(and(eq(grants.workspaceId, key.workspaceId), eq(grants.resourceId, key.resourceId)))
    .orderBy(asc(grants.subjectId), asc(grants.id));
}

/** The resource's live (`active`) entitlements, oldest first. */
export async function listLiveEntitlementsForResource(
  db: Db,
  key: { workspaceId: string; resourceId: string },
): Promise<Entitlement[]> {
  return db
    .select()
    .from(entitlements)
    .where(
      and(
        eq(entitlements.workspaceId, key.workspaceId),
        eq(entitlements.resourceId, key.resourceId),
        eq(entitlements.state, "active"),
      ),
    )
    .orderBy(asc(entitlements.createdAt), asc(entitlements.id));
}

/**
 * When each invitation to the resource started after `since`, oldest first, for the invitation
 * budget. Failed invitations are not counted: GitHub did not create them. Started, succeeded and
 * resolved ones are.
 */
export async function listInviteStarts(
  db: Db,
  key: { workspaceId: string; resourceId: string; since: Instant },
): Promise<Instant[]> {
  const rows = await db
    .select({ startedAt: providerMutations.startedAt })
    .from(providerMutations)
    .where(
      and(
        eq(providerMutations.workspaceId, key.workspaceId),
        eq(providerMutations.resourceId, key.resourceId),
        eq(providerMutations.operation, "invite"),
        sql`${providerMutations.startedAt} > ${key.since}`,
        ne(providerMutations.status, "failed"),
      ),
    )
    .orderBy(asc(providerMutations.startedAt));
  return rows.map((row) => row.startedAt);
}

/** The resource's `started` mutations, whose outcome is not recorded yet, oldest first. */
export async function listOpenMutations(
  db: Db,
  key: { workspaceId: string; resourceId: string },
): Promise<ProviderMutation[]> {
  return db
    .select()
    .from(providerMutations)
    .where(
      and(
        eq(providerMutations.workspaceId, key.workspaceId),
        eq(providerMutations.resourceId, key.resourceId),
        eq(providerMutations.status, "started"),
      ),
    )
    .orderBy(asc(providerMutations.startedAt), asc(providerMutations.id));
}

/**
 * For each grant of the resource, the operation of its latest `started` or `failed` mutation (by
 * `started_at`, then ID): what the grant was last attempting, for a grant in error.
 */
export async function latestMutationOperations(
  db: Db,
  key: { workspaceId: string; resourceId: string },
): Promise<Map<string, MutationOperation>> {
  const ranked = db
    .select({
      grantId: providerMutations.grantId,
      operation: providerMutations.operation,
      rank: sql<number>`row_number() OVER (PARTITION BY ${providerMutations.grantId} ORDER BY ${providerMutations.startedAt} DESC, ${providerMutations.id} DESC)`.as(
        "rank",
      ),
    })
    .from(providerMutations)
    .where(
      and(
        eq(providerMutations.workspaceId, key.workspaceId),
        eq(providerMutations.resourceId, key.resourceId),
        inArray(providerMutations.status, ["started", "failed"]),
      ),
    )
    .as("ranked");
  const rows = await db
    .select({ grantId: ranked.grantId, operation: ranked.operation })
    .from(ranked)
    .where(eq(ranked.rank, 1));
  return new Map(rows.map((row) => [row.grantId, row.operation]));
}

// ---------------------------------------------------------------------------------------------
// Lease-guarded writes

/**
 * Lease-lost detection. Every guarded write is one batch whose first statement is a no-op UPDATE
 * of the resource that matches only while it carries the run's token. SQLite counts a matched row
 * as changed even when no value changes, so that statement changes exactly one row while the lease
 * is held, and none once another run took it. Every later statement is guarded on the same
 * condition ({@link leaseHeld}), and nothing in the batch changes the token, so the batch (one
 * transaction) writes everything or nothing, and the first statement's count tells which.
 */
function leaseCheck(db: Db, lease: LeaseKey) {
  return db
    .update(resources)
    .set({ reconcileToken: sql`${resources.reconcileToken}` })
    .where(
      and(
        ofResource(lease.workspaceId, lease.resourceId),
        eq(resources.reconcileToken, lease.token),
      ),
    );
}

const leaseHeld = (lease: LeaseKey): SQL =>
  sql`EXISTS (SELECT 1 FROM ${resources} WHERE ${resources.workspaceId} = ${lease.workspaceId} AND ${resources.id} = ${lease.resourceId} AND ${resources.reconcileToken} = ${lease.token})`;

async function runLeased(
  db: Db,
  lease: LeaseKey,
  statements: readonly Statement[],
): Promise<LeaseGuardedResult> {
  const [held] = await runBatch(db, [leaseCheck(db, lease), ...statements]);
  return held === 1 ? { ok: true } : { ok: false, reason: "lease_lost" };
}

/** A grant UPDATE of the leased resource; `set` is applied with `extra`, guarded on the lease. */
function grantUpdate(db: Db, lease: LeaseKey, update: GrantUpdate, extra: Partial<GrantWritable>) {
  return db
    .update(grants)
    .set({ ...update.set, ...extra })
    .where(
      and(
        eq(grants.workspaceId, lease.workspaceId),
        eq(grants.resourceId, lease.resourceId),
        eq(grants.id, update.id),
        leaseHeld(lease),
      ),
    );
}

function assertScoped(ok: boolean, operation: string): void {
  if (!ok) {
    throw new Error(`${operation}: rows must belong to the leased resource's workspace`);
  }
}

const grantOfResource = (lease: LeaseKey, grant: Grant) =>
  grant.workspaceId === lease.workspaceId && grant.resourceId === lease.resourceId;

export interface GrantObservation extends LeaseKey {
  now: Instant;
  /** New grants, observed now (`observed_at` is expected to be `now`). */
  creates: readonly Grant[];
  /** Changed grants; `updated_at` and `observed_at` are set to `now`. */
  updates: readonly GrantUpdate[];
  /** Grants observed unchanged; only `observed_at` is set to `now`. */
  touch: readonly string[];
  /** `started` mutations whose outcome this observation settled (a lost response or a crash). */
  resolve: { mutationIds: readonly string[] };
}

/**
 * Records one observation of the resource's access in one batch, guarded on the run's lease:
 * new and changed grants, `observed_at` on the grants found unchanged, the `started` mutations
 * the observation resolved (`resolved`, `finished_at = now`), and the audit events.
 *
 * An observation that changes nothing only stamps `observed_at`, which is bookkeeping, like a
 * schedule. `grant.observed` is audited only when a grant's state, ownership, indirectness or
 * level changes, so an update of details alone (a pending invitation's lapse instant or ID, or an
 * error's refreshed details) is bookkeeping too, and `audit` may then be empty. Any created grant
 * or resolved mutation requires an audit event.
 */
export async function applyGrantObservation(
  db: Db,
  input: GrantObservation,
  audit: readonly AuditEvent[],
): Promise<LeaseGuardedResult> {
  const { workspaceId, resourceId, now } = input;
  assertScoped(
    input.creates.every((grant) => grantOfResource(input, grant)),
    "applyGrantObservation",
  );
  const changes = input.creates.length + input.resolve.mutationIds.length;
  if (changes > 0 && audit.length === 0) {
    throw new Error(
      "applyGrantObservation: a new grant or resolved mutation requires an audit event",
    );
  }
  const held = leaseHeld(input);
  return runLeased(db, input, [
    ...input.creates.map((grant) => insertWhere(db, grants, grant, held)),
    ...input.updates.map((update) =>
      grantUpdate(db, input, update, { updatedAt: now, observedAt: now }),
    ),
    ...chunked(input.touch).map((ids) =>
      db
        .update(grants)
        .set({ observedAt: now })
        .where(
          and(
            eq(grants.workspaceId, workspaceId),
            eq(grants.resourceId, resourceId),
            inArray(grants.id, ids),
            held,
          ),
        ),
    ),
    ...chunked(input.resolve.mutationIds).map((ids) =>
      db
        .update(providerMutations)
        .set({ status: "resolved", finishedAt: now })
        .where(
          and(
            eq(providerMutations.workspaceId, workspaceId),
            eq(providerMutations.resourceId, resourceId),
            eq(providerMutations.status, "started"),
            inArray(providerMutations.id, ids),
            held,
          ),
        ),
    ),
    ...conditionalAuditInserts(db, audit as AuditEvents, held),
  ]);
}

export interface BeginMutation extends LeaseKey {
  now: Instant;
  /** The grant moving to `provisioning` or `revoking`: a new one, or a change to an existing one. */
  grant: { create: Grant } | { update: GrantUpdate };
  /** The mutation about to be sent, `started`, for that grant. */
  mutation: ProviderMutation;
}

/**
 * The write-ahead of a provider mutation, before the request is sent, in one batch guarded on
 * the run's lease: the grant's intent, the `started` mutation row and its audit events.
 */
export async function beginMutation(
  db: Db,
  input: BeginMutation,
  audit: AuditEvents,
): Promise<LeaseGuardedResult> {
  const { mutation } = input;
  const grantId = "create" in input.grant ? input.grant.create.id : input.grant.update.id;
  assertScoped(
    mutation.workspaceId === input.workspaceId &&
      mutation.resourceId === input.resourceId &&
      mutation.grantId === grantId &&
      mutation.status === "started" &&
      mutation.finishedAt === null &&
      ("update" in input.grant || grantOfResource(input, input.grant.create)),
    "beginMutation",
  );
  const held = leaseHeld(input);
  return runLeased(db, input, [
    "create" in input.grant
      ? insertWhere(db, grants, input.grant.create, held)
      : grantUpdate(db, input, input.grant.update, { updatedAt: input.now }),
    insertWhere(db, providerMutations, mutation, held),
    ...conditionalAuditInserts(db, audit, held),
  ]);
}

export interface FinishMutation extends LeaseKey {
  now: Instant;
  mutationId: string;
  result: {
    status: "succeeded" | "failed";
    errorCode: string | null;
    retryClass: RetryClass | null;
    externalId: string | null;
  };
  grant: GrantUpdate;
}

/**
 * Records a provider mutation's outcome in one batch guarded on the run's lease: the mutation is
 * settled (`finished_at = now`) if it is still `started`, and the grant and audit events are
 * written. A mutation already settled is left as it is; the table's trigger forbids settling twice.
 */
export async function finishMutation(
  db: Db,
  input: FinishMutation,
  audit: AuditEvents,
): Promise<LeaseGuardedResult> {
  const held = leaseHeld(input);
  return runLeased(db, input, [
    db
      .update(providerMutations)
      .set({ ...input.result, finishedAt: input.now })
      .where(
        and(
          eq(providerMutations.workspaceId, input.workspaceId),
          eq(providerMutations.resourceId, input.resourceId),
          eq(providerMutations.id, input.mutationId),
          eq(providerMutations.status, "started"),
          held,
        ),
      ),
    grantUpdate(db, input, input.grant, { updatedAt: input.now }),
    ...conditionalAuditInserts(db, audit, held),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Owner controls (not lease-guarded: a run in progress re-observes)

export type ResetGrantRetryResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_in_error" };

/**
 * The owner's "Retry" on a grant in `error`: it becomes due now (`next_attempt_at = now`), and an
 * error that waited for a person (`user_action_required` or `terminal`) becomes `retryable`, so
 * the planner tries again. `last_error_code` is kept, so the grant stays classified.
 *
 * One batch: the UPDATE matches only a grant of the workspace still in `error`, and each audit
 * insert runs `WHERE changes() = 1`. `changes()` is the count of the statement just before it:
 * the UPDATE for the first event, and the previous event's insert (1 only if it was written) for
 * each later one. So the events are written exactly when the grant was.
 */
export async function resetGrantRetry(
  db: Db,
  input: { workspaceId: string; grantId: string; now: Instant },
  audit: AuditEvents,
): Promise<ResetGrantRetryResult> {
  const ofWorkspace = and(eq(grants.workspaceId, input.workspaceId), eq(grants.id, input.grantId));
  const [reset] = await runBatch(db, [
    db
      .update(grants)
      .set({
        nextAttemptAt: input.now,
        retryClass: sql`CASE WHEN ${grants.retryClass} IN ('user_action_required', 'terminal') THEN 'retryable' ELSE ${grants.retryClass} END`,
        updatedAt: input.now,
      })
      .where(and(ofWorkspace, eq(grants.state, "error"))),
    ...conditionalAuditInserts(db, audit, sql`changes() = 1`),
  ]);
  if (reset === 1) return { ok: true };
  const found = await db.select({ id: grants.id }).from(grants).where(ofWorkspace).limit(1);
  return { ok: false, reason: found.length === 0 ? "not_found" : "not_in_error" };
}

/**
 * The owner's "Check now" (and the queueing half of "Retry"): queues the resource's
 * reconciliation unless one is already pending, and writes the audit events either way. Returns
 * the queued row's ID, or null when a pending row already existed.
 */
export async function requestReconcile(
  db: Db,
  input: { workspaceId: string; resourceId: string; outboxRow: NewOutboxRow },
  audit: AuditEvents,
): Promise<{ outboxId: string | null }> {
  const row = input.outboxRow;
  assertReconcileRows([row], input.workspaceId, "requestReconcile");
  if (row.subjectId !== reconcileKey(input.workspaceId, input.resourceId)) {
    throw new Error("requestReconcile: the row's key must name the resource");
  }
  const [queued] = await runBatch(db, [dedupedOutboxInsert(db, row), ...auditInserts(db, audit)]);
  return { outboxId: queued === 1 ? row.id : null };
}

// ---------------------------------------------------------------------------------------------
// Sweep

/**
 * Queues a `reconcile_resource` (built by `makeOutboxRow`) for up to `limit` resources, in any
 * workspace, and returns how many it queued. For the per-minute cron sweep, alongside
 * `claimDueEvaluations`, with the same race safety. Two kinds, due ones first:
 *
 * - **Due:** `next_reconcile_at` is at or before `now`. Each gets a pair of statements: an UPDATE
 *   clearing `next_reconcile_at` only if it still holds the value this sweep read, then the
 *   outbox insert `WHERE changes() = 1` (and nothing with its key is pending). A concurrent sweep
 *   that claimed it first, or a run that rescheduled it, makes the UPDATE match nothing.
 * - **Repair:** `next_reconcile_at` is null, no lease is live, nothing with its key is pending,
 *   and the resource has a live entitlement or a grant that is not `absent`. A run that failed
 *   for good after the sweep cleared its schedule never releases its lease with a new one; this
 *   picks the resource up again once its row failed. The insert re-checks "not pending", so
 *   concurrent sweeps queue it at most once.
 *
 * Clearing the schedule is bookkeeping, like the outbox, so it carries no audit event.
 */
export async function claimDueReconciles(
  db: Db,
  input: {
    now: Instant;
    limit: number;
    makeOutboxRow: (resource: { workspaceId: string; id: string }) => NewOutboxRow;
  },
): Promise<number> {
  const key = { workspaceId: resources.workspaceId, id: resources.id };
  const due = await db
    .select({ ...key, nextReconcileAt: resources.nextReconcileAt })
    .from(resources)
    .where(and(isNotNull(resources.nextReconcileAt), lte(resources.nextReconcileAt, input.now)))
    .orderBy(asc(resources.nextReconcileAt), asc(resources.id))
    .limit(input.limit);
  const liveEntitlement = sql`EXISTS (SELECT 1 FROM ${entitlements} WHERE ${entitlements.workspaceId} = ${resources.workspaceId} AND ${entitlements.resourceId} = ${resources.id} AND ${entitlements.state} = 'active')`;
  const presentGrant = sql`EXISTS (SELECT 1 FROM ${grants} WHERE ${grants.workspaceId} = ${resources.workspaceId} AND ${grants.resourceId} = ${resources.id} AND ${grants.state} <> 'absent')`;
  const repair =
    due.length < input.limit
      ? await db
          .select(key)
          .from(resources)
          .where(
            and(
              isNull(resources.nextReconcileAt),
              or(
                isNull(resources.reconcileLeaseUntil),
                lte(resources.reconcileLeaseUntil, input.now),
              ),
              sql`NOT ${pendingOutbox(OutboxKind.ReconcileResource, reconcileKeyOfRow)}`,
              or(liveEntitlement, presentGrant),
            ),
          )
          .orderBy(asc(resources.id))
          .limit(input.limit - due.length)
      : [];
  if (due.length + repair.length === 0) return 0;
  const changes = await runBatch(db, [
    ...due.flatMap((resource) => [
      db
        .update(resources)
        .set({ nextReconcileAt: null })
        .where(
          and(
            ofResource(resource.workspaceId, resource.id),
            eq(resources.nextReconcileAt, resource.nextReconcileAt as Instant),
          ),
        ),
      dedupedOutboxInsert(
        db,
        input.makeOutboxRow({ workspaceId: resource.workspaceId, id: resource.id }),
        sql`changes() = 1`,
      ),
    ]),
    ...repair.map((resource) => dedupedOutboxInsert(db, input.makeOutboxRow(resource))),
  ]);
  const queuedDue = changes.slice(0, 2 * due.length).filter((_, index) => index % 2 === 1);
  return [...queuedDue, ...changes.slice(2 * due.length)].reduce((sum, n) => sum + n, 0);
}
