import type { Instant } from "@sharerepo/domain";
import { and, asc, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { outbox } from "./schema/index.ts";

/** A transactional outbox row (decision 0003). Carries IDs only, never authoritative state. */
export type OutboxRow = typeof outbox.$inferSelect;
export type NewOutboxRow = Pick<
  OutboxRow,
  "id" | "kind" | "subjectId" | "createdAt" | "availableAt"
>;

const fresh = (row: NewOutboxRow): OutboxRow => ({ ...row, attempts: 0, sentAt: null });

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
      sql`SELECT ${r.id}, ${r.kind}, ${r.subjectId}, ${r.createdAt}, ${r.availableAt}, ${r.attempts}, ${r.sentAt} WHERE ${condition}`,
    );
}

/** Adds work on its own, outside any other change. */
export async function enqueueOutbox(db: Db, row: NewOutboxRow): Promise<void> {
  await outboxInsert(db, row);
}

/**
 * Claims up to `limit` due, unsent rows for one drainer: each claimed row becomes unavailable
 * until `now + leaseMs`, so a concurrent drainer does not take it, and is offered again after the
 * lease if the claimer never marks it sent. One statement, so the claim is atomic.
 */
export async function claimOutbox(
  db: Db,
  input: { now: Instant; limit: number; leaseMs: number },
): Promise<OutboxRow[]> {
  const due = db
    .select({ id: outbox.id })
    .from(outbox)
    .where(and(isNull(outbox.sentAt), lte(outbox.availableAt, input.now)))
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
