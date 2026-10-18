import type { ConnectionStatus, Instant, ResourceSelection } from "@sharerepo/domain";
import { and, asc, eq } from "drizzle-orm";
import { type AuditEvents, auditInserts } from "./audit-repository.ts";
import type { Db } from "./client.ts";
import { isUniqueViolation } from "./errors.ts";
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
  inserts: readonly Resource[];
  updates: readonly { id: string; set: ResourceChanges }[];
  /** Connection facts observed during the resync; `last_synced_at` is always set to `now`. */
  connection: { status?: ConnectionStatus; permissions?: string; accountLoginSnapshot?: string };
}

export type ApplyResourceSyncResult =
  | { ok: true }
  /** A concurrent resync inserted the same resource first. Nothing was written; resync again. */
  | { ok: false; reason: "resource_conflict" };

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
 * Applies one resync of a connection in one atomic batch: new resources, changes to existing ones
 * (each scoped to this workspace and connection), the connection's observed facts with
 * `last_synced_at`, and the audit events describing them.
 */
export async function applyResourceSync(
  db: Db,
  sync: ResourceSync,
  audit: AuditEvents,
): Promise<ApplyResourceSyncResult> {
  const { workspaceId, connectionId, now } = sync;
  const inConnection = (id: string) =>
    and(
      eq(resources.workspaceId, workspaceId),
      eq(resources.connectionId, connectionId),
      eq(resources.id, id),
    );
  try {
    await db.batch([
      db
        .update(connections)
        .set({ ...sync.connection, lastSyncedAt: now, updatedAt: now })
        .where(and(eq(connections.workspaceId, workspaceId), eq(connections.id, connectionId))),
      ...sync.inserts.map((resource) => db.insert(resources).values(resource)),
      ...sync.updates.map(({ id, set }) =>
        db
          .update(resources)
          .set({ ...set, updatedAt: now })
          .where(inConnection(id)),
      ),
      ...auditInserts(db, audit),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, ["resources.connection_id", "resources.external_id"])) {
      return { ok: false, reason: "resource_conflict" };
    }
    throw error;
  }
  return { ok: true };
}
