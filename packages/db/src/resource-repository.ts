import type { ConnectionStatus, Instant, ResourceSelection } from "@sharerepo/domain";
import { and, asc, eq, getTableColumns, ne, sql } from "drizzle-orm";
import { type AuditEvents, conditionalAuditInserts } from "./audit-repository.ts";
import type { Db } from "./client.ts";
import { connections, resources } from "./schema/index.ts";

/** Domain `Resource`: keyed by the provider's immutable ID within its connection. */
export type Resource = typeof resources.$inferSelect;

/** Fields a resync may change on an existing resource. */
export type ResourceChanges = Partial<
  Pick<Resource, "nameSnapshot" | "ownerExternalId" | "private" | "archived" | "capabilities"> & {
    selection: ResourceSelection;
  }
>;

export interface ResourceSync {
  workspaceId: string;
  connectionId: string;
  now: Instant;
  /** The connection's `sync_version` when this resync read it; the write fails if it changed. */
  expectedVersion: number;
  /** Unique per resync: marks this resync's write so the batch's other statements can see it. */
  syncToken: string;
  inserts: readonly Resource[];
  updates: readonly { id: string; set: ResourceChanges }[];
  /** Connection facts observed during the resync; `last_synced_at` is always set to `now`. */
  connection: { status?: ConnectionStatus; permissions?: string; accountLoginSnapshot?: string };
}

export type ApplyResourceSyncResult =
  | { ok: true }
  /**
   * Another resync wrote first (or the connection is deleted): nothing was written. Read again
   * and resync with fresh provider state.
   */
  | { ok: false; reason: "stale" };

export async function listResourcesForConnection(
  db: Db,
  key: { workspaceId: string; connectionId: string },
): Promise<Resource[]> {
  return db
    .select()
    .from(resources)
    .where(
      and(eq(resources.workspaceId, key.workspaceId), eq(resources.connectionId, key.connectionId)),
    )
    .orderBy(asc(resources.nameSnapshot), asc(resources.id));
}

export async function listResourcesForWorkspace(db: Db, workspaceId: string): Promise<Resource[]> {
  return db
    .select()
    .from(resources)
    .where(eq(resources.workspaceId, workspaceId))
    .orderBy(asc(resources.nameSnapshot), asc(resources.id));
}

export async function getResource(
  db: Db,
  key: { workspaceId: string; resourceId: string },
): Promise<Resource | null> {
  const rows = await db
    .select()
    .from(resources)
    .where(and(eq(resources.workspaceId, key.workspaceId), eq(resources.id, key.resourceId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Applies one resync of a connection in one atomic batch, with optimistic concurrency. The
 * connection update succeeds only if its `sync_version` is still the one this resync read and it
 * is not deleted; it then bumps the version and stamps `sync_token`. Every other statement (new
 * resources, changes, audit events) runs only if the connection carries this resync's token, so a
 * stale resync writes nothing and cannot overwrite newer state, nor revive a deleted connection.
 */
export async function applyResourceSync(
  db: Db,
  sync: ResourceSync,
  audit: AuditEvents,
): Promise<ApplyResourceSyncResult> {
  const { workspaceId, connectionId, now } = sync;
  const ours = sql`EXISTS (SELECT 1 FROM ${connections} WHERE ${connections.id} = ${connectionId} AND ${connections.syncToken} = ${sync.syncToken})`;
  const inConnection = (id: string) =>
    and(
      eq(resources.workspaceId, workspaceId),
      eq(resources.connectionId, connectionId),
      eq(resources.id, id),
      ours,
    );
  const columns = Object.keys(getTableColumns(resources)) as (keyof Resource)[];
  const [update] = await db.batch([
    db
      .update(connections)
      .set({
        ...sync.connection,
        lastSyncedAt: now,
        updatedAt: now,
        syncVersion: sync.expectedVersion + 1,
        syncToken: sync.syncToken,
      })
      .where(
        and(
          eq(connections.workspaceId, workspaceId),
          eq(connections.id, connectionId),
          eq(connections.syncVersion, sync.expectedVersion),
          ne(connections.status, "deleted"),
        ),
      ),
    ...sync.inserts.map((resource) =>
      db.insert(resources).select(
        sql`SELECT ${sql.join(
          columns.map((column) => sql`${resource[column]}`),
          sql`, `,
        )} WHERE ${ours}`,
      ),
    ),
    ...sync.updates.map(({ id, set }) =>
      db
        .update(resources)
        .set({ ...set, updatedAt: now })
        .where(inConnection(id)),
    ),
    ...conditionalAuditInserts(db, audit, ours),
  ]);
  return update.meta.changes > 0 ? { ok: true } : { ok: false, reason: "stale" };
}
