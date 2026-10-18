import type { AuditEvent } from "@sharerepo/domain";
import { asc, eq, getTableColumns, type SQL, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { auditEvents } from "./schema/index.ts";

/**
 * At least one event: a state change without its audit event is a defect (decision 0007), so
 * every write that changes state requires a non-empty list.
 */
export type AuditEvents = readonly [AuditEvent, ...AuditEvent[]];

type AuditRow = typeof auditEvents.$inferSelect;

function toRow(event: AuditEvent): AuditRow {
  return {
    id: event.id,
    scope: event.scope,
    workspaceId: event.workspaceId,
    actorType: event.actor.type,
    actorId: event.actor.id,
    action: event.action,
    targetType: event.target.type,
    targetId: event.target.id,
    reason: event.reason,
    correlationId: event.correlationId,
    occurredAt: event.occurredAt,
    details: JSON.stringify(event.details),
  };
}

function fromRow(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    scope: row.scope,
    workspaceId: row.workspaceId,
    actor: { type: row.actorType, id: row.actorId },
    action: row.action,
    target: { type: row.targetType, id: row.targetId },
    reason: row.reason,
    correlationId: row.correlationId,
    occurredAt: row.occurredAt,
    details: JSON.parse(row.details) as Record<string, unknown>,
  };
}

/** Inserts to put in the same `db.batch()` as the state change the events describe. */
export function auditInserts(db: Db, events: AuditEvents) {
  return events.map((event) => db.insert(auditEvents).values(toRow(event)));
}

/**
 * Inserts that write only if `condition` holds when they run. Placed after a guarded UPDATE in
 * the same batch, with the same predicate, so an update that matched no row leaves no audit row.
 */
export function conditionalAuditInserts(db: Db, events: AuditEvents, condition: SQL) {
  return events.map((event) => {
    const row = toRow(event);
    // Drizzle lists every column in table order for INSERT … SELECT; select the values in that order.
    const values = Object.keys(getTableColumns(auditEvents)).map(
      (key) => sql`${row[key as keyof AuditRow]}`,
    );
    return db
      .insert(auditEvents)
      .select(sql`SELECT ${sql.join(values, sql`, `)} WHERE ${condition}`);
  });
}

/** Writes events that have no accompanying state change in D1, such as a sign-out. */
export async function appendAuditEvents(db: Db, events: AuditEvents): Promise<void> {
  const [first, ...rest] = auditInserts(db, events);
  // `map` loses the non-empty tuple type that `batch` requires; `events` is non-empty.
  await db.batch([first as NonNullable<typeof first>, ...rest]);
}

// Insertion order breaks ties between events that share an instant.
const chronological = [asc(auditEvents.occurredAt), sql`rowid`] as const;

export async function listAuditEventsByCorrelationId(
  db: Db,
  correlationId: string,
): Promise<AuditEvent[]> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.correlationId, correlationId))
    .orderBy(...chronological);
  return rows.map(fromRow);
}

export async function listAuditEventsForWorkspace(
  db: Db,
  workspaceId: string,
): Promise<AuditEvent[]> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(...chronological);
  return rows.map(fromRow);
}
