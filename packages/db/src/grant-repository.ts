import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { grants } from "./schema/index.ts";

/** Domain `Grant`: observed provider access. */
export type Grant = typeof grants.$inferSelect;

export async function listGrantsForWorkspace(db: Db, workspaceId: string): Promise<Grant[]> {
  return db
    .select()
    .from(grants)
    .where(eq(grants.workspaceId, workspaceId))
    .orderBy(asc(grants.createdAt), asc(grants.id));
}

/** One grant of the workspace, or null when the workspace has no grant with this ID. */
export async function getGrant(
  db: Db,
  key: { workspaceId: string; grantId: string },
): Promise<Grant | null> {
  const rows = await db
    .select()
    .from(grants)
    .where(and(eq(grants.workspaceId, key.workspaceId), eq(grants.id, key.grantId)))
    .limit(1);
  return rows[0] ?? null;
}
