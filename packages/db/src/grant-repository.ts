import { asc, eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { grants } from "./schema/index.ts";

/** Domain `Grant`: observed provider access. Nothing writes grants until Phase 4. */
export type Grant = typeof grants.$inferSelect;

export async function listGrantsForWorkspace(db: Db, workspaceId: string): Promise<Grant[]> {
  return db
    .select()
    .from(grants)
    .where(eq(grants.workspaceId, workspaceId))
    .orderBy(asc(grants.createdAt), asc(grants.id));
}
