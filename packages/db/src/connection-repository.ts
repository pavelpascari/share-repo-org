import type { ConnectionStatus, Instant } from "@sharerepo/domain";
import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { type AuditEvents, auditInserts, conditionalAuditInserts } from "./audit-repository.ts";
import type { Db } from "./client.ts";
import { isUniqueViolation } from "./errors.ts";
import { conditionalOutboxInsert, type NewOutboxRow } from "./outbox-repository.ts";
import { connectionIntents, connections } from "./schema/index.ts";

export type ConnectionIntent = typeof connectionIntents.$inferSelect;
export type Connection = typeof connections.$inferSelect;

export type CreateConnectionFromIntentResult =
  | { ok: true; connection: Connection }
  /** The intent does not exist, has expired, or was already used. Nothing was written. */
  | { ok: false; reason: "intent_unavailable" }
  /** The installation is already attached to a workspace. Nothing, not even the intent, changed. */
  | { ok: false; reason: "installation_taken" };

export type UpdateConnectionResult = { ok: true } | { ok: false; reason: "not_found" };

/** Records a pending "Connect GitHub" with its audit events, in one batch. */
export async function createConnectionIntent(
  db: Db,
  intent: Omit<ConnectionIntent, "consumedAt">,
  audit: AuditEvents,
): Promise<ConnectionIntent> {
  const row: ConnectionIntent = { ...intent, consumedAt: null };
  await db.batch([db.insert(connectionIntents).values(row), ...auditInserts(db, audit)]);
  return row;
}

export async function findConnectionIntentByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<ConnectionIntent | null> {
  const rows = await db
    .select()
    .from(connectionIntents)
    .where(eq(connectionIntents.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Consumes an intent and creates the connection it authorised, in one atomic batch:
 *
 * 1. mark the intent consumed, only if it is unconsumed and unexpired at `now`;
 * 2. insert the connection only if statement 1 changed a row (`changes() = 1`);
 * 3. insert audit events and outbox rows only if *this* connection row now exists.
 *
 * `changes()` refers to the previous statement in the same transaction, so a concurrent caller
 * with the same intent and the same `now` cannot pass step 2: its step 1 changes nothing. (A
 * predicate such as "the intent was consumed at `now`" would let it through.) Step 3 keys on the
 * new connection's own ID, which only this call writes. A taken installation fails the UNIQUE
 * constraint and rolls the whole batch back, leaving the intent unconsumed.
 */
export async function createConnectionFromIntent(
  db: Db,
  input: {
    intentId: string;
    now: Instant;
    connection: Connection;
    outbox?: readonly NewOutboxRow[];
  },
  audit: AuditEvents,
): Promise<CreateConnectionFromIntentResult> {
  const { connection, now } = input;
  const consume = db
    .update(connectionIntents)
    .set({ consumedAt: now })
    .where(
      and(
        eq(connectionIntents.id, input.intentId),
        sql`${connectionIntents.consumedAt} IS NULL`,
        sql`${connectionIntents.expiresAt} > ${now}`,
      ),
    );
  const values = Object.keys(getTableColumns(connections)).map(
    (key) => sql`${connection[key as keyof Connection]}`,
  );
  const insert = db
    .insert(connections)
    .select(sql`SELECT ${sql.join(values, sql`, `)} WHERE changes() = 1`);
  const created = sql`EXISTS (SELECT 1 FROM ${connections} WHERE ${connections.id} = ${connection.id})`;

  let consumed: number;
  try {
    const [update] = await db.batch([
      consume,
      insert,
      ...conditionalAuditInserts(db, audit, created),
      ...(input.outbox ?? []).map((row) => conditionalOutboxInsert(db, row, created)),
    ]);
    consumed = update.meta.changes;
  } catch (error) {
    if (isUniqueViolation(error, ["connections.installation_id"])) {
      return { ok: false, reason: "installation_taken" };
    }
    throw error;
  }
  return consumed > 0 ? { ok: true, connection } : { ok: false, reason: "intent_unavailable" };
}

/** System use (webhooks): the connection for a GitHub installation, in any workspace. */
export async function findConnectionByInstallationId(
  db: Db,
  installationId: string,
): Promise<Connection | null> {
  const rows = await db
    .select()
    .from(connections)
    .where(eq(connections.installationId, installationId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listConnectionsForWorkspace(
  db: Db,
  workspaceId: string,
): Promise<Connection[]> {
  return db
    .select()
    .from(connections)
    .where(eq(connections.workspaceId, workspaceId))
    .orderBy(asc(connections.createdAt), asc(connections.id));
}

export async function getConnection(
  db: Db,
  key: { workspaceId: string; connectionId: string },
): Promise<Connection | null> {
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.workspaceId, key.workspaceId), eq(connections.id, key.connectionId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Connections the daily resync visits: every one that is not deleted. */
export async function listActiveConnectionIds(
  db: Db,
): Promise<{ workspaceId: string; id: string; installationId: string }[]> {
  return db
    .select({
      workspaceId: connections.workspaceId,
      id: connections.id,
      installationId: connections.installationId,
    })
    .from(connections)
    .where(inArray(connections.status, ["active", "suspended"] satisfies ConnectionStatus[]))
    .orderBy(asc(connections.id));
}

/**
 * Updates a connection in its workspace, with its audit events in the same batch. The audit
 * inserts share the update's predicate, so a connection that does not exist in this workspace
 * leaves no audit row.
 */
export async function updateConnection(
  db: Db,
  input: {
    workspaceId: string;
    connectionId: string;
    now: Instant;
    status?: ConnectionStatus;
    permissions?: string;
    accountLoginSnapshot?: string;
    lastSyncedAt?: Instant;
  },
  audit: AuditEvents,
): Promise<UpdateConnectionResult> {
  const { workspaceId, connectionId, now, ...changes } = input;
  const scoped = and(eq(connections.workspaceId, workspaceId), eq(connections.id, connectionId));
  const [update] = await db.batch([
    db
      .update(connections)
      .set({ ...changes, updatedAt: now })
      .where(scoped),
    ...conditionalAuditInserts(
      db,
      audit,
      sql`EXISTS (SELECT 1 FROM ${connections} WHERE ${scoped})`,
    ),
  ]);
  return update.meta.changes > 0 ? { ok: true } : { ok: false, reason: "not_found" };
}
