import type { Instant } from "@sharerepo/domain";
import { and, asc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { runBatch } from "./batch.ts";
import { chunked } from "./chunks.ts";
import type { Db } from "./client.ts";
import { outbox } from "./schema/index.ts";

/** A transactional outbox row (decision 0003). Carries IDs only, never authoritative state. */
export type OutboxRow = typeof outbox.$inferSelect;
export type NewOutboxRow = Pick<
  OutboxRow,
  "id" | "kind" | "subjectId" | "createdAt" | "availableAt"
>;

const fresh = (row: NewOutboxRow): OutboxRow => ({
  ...row,
  attempts: 0,
  sentAt: null,
  failedAt: null,
  lastErrorCode: null,
});

/** An outbox insert to put in the same `db.batch()` as the change that causes the work. */
export function outboxInsert(db: Db, row: NewOutboxRow) {
  return db.insert(outbox).values(fresh(row));
}

/**
 * An outbox insert that writes only if `condition` holds when it runs, for batches whose earlier
 * statements may be no-ops (the same pattern as conditional audit inserts).
 */
export function conditionalOutboxInsert(
  db: Db,
  row: NewOutboxRow,
  condition: ReturnType<typeof sql>,
) {
  const r = fresh(row);
  return db
    .insert(outbox)
    .select(
      sql`SELECT ${r.id}, ${r.kind}, ${r.subjectId}, ${r.createdAt}, ${r.availableAt}, ${r.attempts}, ${r.sentAt}, ${r.failedAt}, ${r.lastErrorCode} WHERE ${condition}`,
    );
}

/** Adds work on its own, outside any other change. */
export async function enqueueOutbox(db: Db, row: NewOutboxRow): Promise<void> {
  await outboxInsert(db, row);
}

/** Outbox inserts per batch when queueing many rows at once. */
export const OUTBOX_INSERT_BATCH = 50;

/**
 * Adds many rows of work on their own, in batches of at most {@link OUTBOX_INSERT_BATCH} inserts,
 * so a fan-out costs a few D1 calls instead of one per row. A failure part-way leaves the earlier
 * batches queued; the caller's work is idempotent and is retried as a whole.
 */
export async function enqueueOutboxRows(db: Db, rows: readonly NewOutboxRow[]): Promise<void> {
  for (const batch of chunked(rows, OUTBOX_INSERT_BATCH)) {
    await runBatch(
      db,
      batch.map((row) => outboxInsert(db, row)),
    );
  }
}

/**
 * Claims up to `limit` due, unsent rows for one drainer: each claimed row becomes unavailable
 * until `now + leaseMs`, so a concurrent drainer does not take it, and is offered again after the
 * lease if the claimer never marks it sent, until it has used `maxAttempts`. One statement, so
 * the claim is atomic.
 */
export async function claimOutbox(
  db: Db,
  input: { now: Instant; limit: number; leaseMs: number; maxAttempts: number },
): Promise<OutboxRow[]> {
  const due = db
    .select({ id: outbox.id })
    .from(outbox)
    .where(
      and(
        isNull(outbox.sentAt),
        isNull(outbox.failedAt),
        lte(outbox.availableAt, input.now),
        // Rows that used every attempt are never claimed again; markOutboxFailed records them.
        lt(outbox.attempts, input.maxAttempts),
      ),
    )
    .orderBy(asc(outbox.availableAt))
    .limit(input.limit);
  return db
    .update(outbox)
    .set({ availableAt: input.now + input.leaseMs, attempts: sql`${outbox.attempts} + 1` })
    .where(inArray(outbox.id, due))
    .returning();
}

/** Marks rows delivered; they are never claimed again. */
export async function markOutboxSent(db: Db, ids: readonly string[], now: Instant): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(outbox)
    .set({ sentAt: now })
    .where(and(inArray(outbox.id, [...ids]), isNull(outbox.sentAt)));
}

/**
 * Marks a row as failed for good (a non-retryable error, or out of attempts) with a classified
 * error code, never a message. It is never claimed again and stays for the operator to inspect.
 */
export async function markOutboxFailed(
  db: Db,
  input: { id: string; now: Instant; errorCode: string },
): Promise<void> {
  await db
    .update(outbox)
    .set({ failedAt: input.now, lastErrorCode: input.errorCode })
    .where(and(eq(outbox.id, input.id), isNull(outbox.sentAt)));
}
