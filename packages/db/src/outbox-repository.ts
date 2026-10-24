import { type Instant, OutboxKind } from "@sharerepo/domain";
import { and, asc, eq, gte, inArray, isNull, lt, lte, type SQL, sql } from "drizzle-orm";
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

/**
 * "An unsent, unfailed outbox row of this kind and key exists": the work is already queued.
 * `subjectId` is SQL so a sweep can match the key of each row it scans.
 */
export function pendingOutbox(kind: NewOutboxRow["kind"], subjectId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM ${outbox} WHERE ${outbox.kind} = ${kind} AND ${outbox.subjectId} = ${subjectId} AND ${outbox.sentAt} IS NULL AND ${outbox.failedAt} IS NULL)`;
}

/**
 * An outbox insert that writes only if no row of the same kind and key is pending (and
 * `condition`, when given, holds), so work that is already queued is not queued twice. Rows that
 * were sent or failed for good do not count: the work is queued again.
 */
export function dedupedOutboxInsert(db: Db, row: NewOutboxRow, condition?: SQL) {
  const absent = sql`NOT ${pendingOutbox(row.kind, sql`${row.subjectId}`)}`;
  return conditionalOutboxInsert(
    db,
    row,
    condition === undefined ? absent : sql`${condition} AND ${absent}`,
  );
}

/**
 * Throws unless every row is a `reconcile_resource` keyed in `workspaceId` (`<workspaceId>:…`):
 * a write must never queue work for another workspace.
 */
export function assertReconcileRows(
  rows: readonly NewOutboxRow[],
  workspaceId: string,
  operation: string,
): void {
  const scoped = rows.every(
    (row) =>
      row.kind === OutboxKind.ReconcileResource && row.subjectId.startsWith(`${workspaceId}:`),
  );
  if (!scoped) {
    throw new Error(`${operation}: expected reconcile_resource rows of the workspace`);
  }
}

/**
 * Adds work on its own unless the same work (kind and key) is already pending. Returns whether
 * the row was queued, so the caller knows whether to hand its ID to the queue.
 */
export async function enqueueOutboxOnce(db: Db, row: NewOutboxRow): Promise<boolean> {
  const [queued] = await runBatch(db, [dedupedOutboxInsert(db, row)]);
  return queued === 1;
}

/**
 * The ID of the unsent, unfailed row of this kind and key, or null when none is pending. An
 * owner's "Check now" hands it to the queue when the same work was already queued, rather than
 * leaving it for the outbox drain.
 */
export async function pendingOutboxId(
  db: Db,
  kind: NewOutboxRow["kind"],
  subjectId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: outbox.id })
    .from(outbox)
    .where(
      and(
        eq(outbox.kind, kind),
        eq(outbox.subjectId, subjectId),
        isNull(outbox.sentAt),
        isNull(outbox.failedAt),
      ),
    )
    .orderBy(asc(outbox.createdAt), asc(outbox.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * A pending row's queue message fields (kind and subject), or null when the row is unknown, sent
 * or failed: lets a caller that only kept the ID hand the row to the queue.
 */
export async function pendingOutboxMessage(
  db: Db,
  id: string,
): Promise<Pick<OutboxRow, "kind" | "subjectId"> | null> {
  const [row] = await db
    .select({ kind: outbox.kind, subjectId: outbox.subjectId })
    .from(outbox)
    .where(and(eq(outbox.id, id), isNull(outbox.sentAt), isNull(outbox.failedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Pending, due rows of these kinds created at or after `since`, oldest first, at most `limit`;
 * with `subjectPrefix`, only rows whose subject starts with it (a workspace's keys start with its
 * ID). Lets a step that just queued work hand it to the queue rather than leave it for the drain.
 */
export async function pendingOutboxSince(
  db: Db,
  input: {
    kinds: readonly NewOutboxRow["kind"][];
    since: Instant;
    now: Instant;
    limit: number;
    subjectPrefix?: string;
  },
): Promise<Pick<OutboxRow, "id" | "kind" | "subjectId">[]> {
  const prefix = input.subjectPrefix;
  return db
    .select({ id: outbox.id, kind: outbox.kind, subjectId: outbox.subjectId })
    .from(outbox)
    .where(
      and(
        inArray(outbox.kind, [...input.kinds]),
        isNull(outbox.sentAt),
        isNull(outbox.failedAt),
        gte(outbox.createdAt, input.since),
        lte(outbox.availableAt, input.now),
        prefix === undefined
          ? undefined
          : sql`substr(${outbox.subjectId}, 1, ${prefix.length}) = ${prefix}`,
      ),
    )
    .orderBy(asc(outbox.createdAt), asc(outbox.id))
    .limit(input.limit);
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
