import type { ExternalEventState, Instant } from "@sharerepo/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { conditionalOutboxInsert, type NewOutboxRow } from "./outbox-repository.ts";
import { externalEvents } from "./schema/index.ts";

/** Domain `ExternalEvent`: the receipt of a provider webhook. Metadata and a digest only. */
export type ExternalEvent = typeof externalEvents.$inferSelect;
export type NewExternalEvent = Omit<
  ExternalEvent,
  "processingState" | "attempts" | "lastErrorCode" | "processedAt"
>;

export type RecordExternalEventResult =
  | { inserted: true; eventId: string }
  /** A redelivery: the event was already recorded under `eventId`. Nothing was written. */
  | { inserted: false; eventId: string };

/**
 * Records a received event and the work it causes, in one atomic batch. A redelivery (same
 * provider and delivery ID) inserts nothing, and its outbox rows are skipped because each outbox
 * insert requires *this* event row to exist.
 */
export async function recordExternalEvent(
  db: Db,
  event: NewExternalEvent,
  outbox: readonly NewOutboxRow[],
): Promise<RecordExternalEventResult> {
  const thisEvent = sql`EXISTS (SELECT 1 FROM ${externalEvents} WHERE ${externalEvents.id} = ${event.id})`;
  const [insert] = await db.batch([
    db
      .insert(externalEvents)
      .values({
        ...event,
        processingState: "pending",
        attempts: 0,
        lastErrorCode: null,
        processedAt: null,
      })
      .onConflictDoNothing({ target: [externalEvents.provider, externalEvents.externalEventId] }),
    ...outbox.map((row) => conditionalOutboxInsert(db, row, thisEvent)),
  ]);
  if (insert.meta.changes > 0) return { inserted: true, eventId: event.id };
  const rows = await db
    .select({ id: externalEvents.id })
    .from(externalEvents)
    .where(
      and(
        eq(externalEvents.provider, event.provider),
        eq(externalEvents.externalEventId, event.externalEventId),
      ),
    )
    .limit(1);
  // The insert was skipped only because this row exists, so it is present.
  return { inserted: false, eventId: (rows[0] as { id: string }).id };
}

export async function getExternalEvent(db: Db, id: string): Promise<ExternalEvent | null> {
  const rows = await db.select().from(externalEvents).where(eq(externalEvents.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Records a processing outcome. `processed` and `ignored` are final and stamp `processed_at`;
 * `failed` counts an attempt and keeps a classified error code (never a message).
 */
export async function markExternalEvent(
  db: Db,
  input: { id: string; state: ExternalEventState; now: Instant; errorCode?: string },
): Promise<void> {
  const final = input.state === "processed" || input.state === "ignored";
  await db
    .update(externalEvents)
    .set({
      processingState: input.state,
      processedAt: final ? input.now : null,
      lastErrorCode: input.errorCode ?? null,
      ...(input.state === "failed" ? { attempts: sql`${externalEvents.attempts} + 1` } : {}),
    })
    .where(eq(externalEvents.id, input.id));
}

export async function listExternalEventsByState(
  db: Db,
  state: ExternalEventState,
  limit: number,
): Promise<ExternalEvent[]> {
  return db
    .select()
    .from(externalEvents)
    .where(eq(externalEvents.processingState, state))
    .orderBy(asc(externalEvents.receivedAt), asc(externalEvents.id))
    .limit(limit);
}
