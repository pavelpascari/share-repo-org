import type { Instant, WorkspaceName, WorkspaceRole, WorkspaceSlug } from "@sharerepo/domain";
import { and, eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { workspaceMemberships, workspaces } from "./schema/index.ts";

export type Workspace = typeof workspaces.$inferSelect;

export interface CreateWorkspaceInput {
  id: string;
  ownerUserId: string;
  slug: WorkspaceSlug;
  name: WorkspaceName;
  now: Instant;
}

/**
 * Creates an active workspace and its owner membership in one atomic D1 batch: if either insert
 * fails (taken slug, unknown owner), neither row exists. Constraint errors propagate.
 */
export async function createWorkspace(db: Db, input: CreateWorkspaceInput): Promise<Workspace> {
  const workspace: Workspace = {
    id: input.id,
    slug: input.slug,
    name: input.name,
    status: "active",
    createdAt: input.now,
    updatedAt: input.now,
  };
  await db.batch([
    db.insert(workspaces).values(workspace),
    db.insert(workspaceMemberships).values({
      workspaceId: input.id,
      userId: input.ownerUserId,
      role: "owner",
      createdAt: input.now,
    }),
  ]);
  return workspace;
}

export interface WorkspaceForMember {
  workspace: Workspace;
  role: WorkspaceRole;
}

/**
 * Returns the workspace and the user's role only when the user is a member of that workspace.
 * Status is returned as-is; deciding what a suspended workspace allows is the caller's policy.
 */
export async function getWorkspaceForMember(
  db: Db,
  input: { workspaceId: string; userId: string },
): Promise<WorkspaceForMember | null> {
  const rows = await db
    .select({ workspace: workspaces, role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        eq(workspaceMemberships.userId, input.userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
