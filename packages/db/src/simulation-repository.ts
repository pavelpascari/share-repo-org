import type { Instant } from "@sharerepo/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { type AuditEvents, auditInserts, conditionalAuditInserts } from "./audit-repository.ts";
import { runBatch } from "./batch.ts";
import type { Db } from "./client.ts";
import { conditionalOutboxInsert, type NewOutboxRow, outboxInsert } from "./outbox-repository.ts";
import { simulatedSubscriptions } from "./schema/index.ts";

/** The simulated entitlement source's own record of a subscription (decision 0009). */
export type SimulatedSubscription = typeof simulatedSubscriptions.$inferSelect;

/** Fields a simulator action changes. `updatedAt` is required and must move forward. */
export type SimulatedSubscriptionChanges = Partial<
  Omit<SimulatedSubscription, "id" | "workspaceId" | "createdAt" | "updatedAt">
> & { updatedAt: Instant };

export type UpdateSimulatedSubscriptionResult =
  | { ok: true }
  /** Another action changed the subscription since it was read (or it does not exist). */
  | { ok: false; reason: "stale" };

/**
 * Creates a simulated subscription with its outbox rows (`refresh_subscription`, the way a
 * webhook receipt would) and audit events, in one batch.
 */
export async function createSimulatedSubscription(
  db: Db,
  row: SimulatedSubscription,
  work: { outbox: readonly NewOutboxRow[] },
  audit: AuditEvents,
): Promise<void> {
  await runBatch(db, [
    db.insert(simulatedSubscriptions).values(row),
    ...work.outbox.map((outboxRow) => outboxInsert(db, outboxRow)),
    ...auditInserts(db, audit),
  ]);
}

export async function getSimulatedSubscription(
  db: Db,
  key: { workspaceId: string; id: string },
): Promise<SimulatedSubscription | null> {
  const rows = await db
    .select()
    .from(simulatedSubscriptions)
    .where(
      and(
        eq(simulatedSubscriptions.workspaceId, key.workspaceId),
        eq(simulatedSubscriptions.id, key.id),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listSimulatedSubscriptions(
  db: Db,
  workspaceId: string,
): Promise<SimulatedSubscription[]> {
  return db
    .select()
    .from(simulatedSubscriptions)
    .where(eq(simulatedSubscriptions.workspaceId, workspaceId))
    .orderBy(asc(simulatedSubscriptions.createdAt), asc(simulatedSubscriptions.id));
}

/**
 * Applies one simulator action in one atomic batch, with optimistic concurrency on `updated_at`.
 * The outbox and audit inserts are guarded by "the row is still at `expectedUpdatedAt`" and the
 * guarded UPDATE runs last, so a batch (one transaction) writes everything or, when another action
 * wrote first, nothing. `set.updatedAt` must be later than `expectedUpdatedAt`: an action that
 * kept the timestamp would leave the guard true for a concurrent action that read the same row.
 */
export async function updateSimulatedSubscription(
  db: Db,
  input: {
    workspaceId: string;
    id: string;
    expectedUpdatedAt: Instant;
    set: SimulatedSubscriptionChanges;
  },
  work: { outbox: readonly NewOutboxRow[] },
  audit: AuditEvents,
): Promise<UpdateSimulatedSubscriptionResult> {
  if (!(input.set.updatedAt > input.expectedUpdatedAt)) {
    throw new Error("updateSimulatedSubscription: set.updatedAt must be after expectedUpdatedAt");
  }
  const current = and(
    eq(simulatedSubscriptions.workspaceId, input.workspaceId),
    eq(simulatedSubscriptions.id, input.id),
    eq(simulatedSubscriptions.updatedAt, input.expectedUpdatedAt),
  );
  const guard = sql`EXISTS (SELECT 1 FROM ${simulatedSubscriptions} WHERE ${current})`;
  const changes = await runBatch(db, [
    ...work.outbox.map((row) => conditionalOutboxInsert(db, row, guard)),
    ...conditionalAuditInserts(db, audit, guard),
    // Last: once it runs, the guard above no longer holds.
    db.update(simulatedSubscriptions).set(input.set).where(current),
  ]);
  return changes.at(-1) === 1 ? { ok: true } : { ok: false, reason: "stale" };
}
