import type { Instant, WorkspaceName, WorkspaceRole, WorkspaceSlug } from "@sharerepo/domain";
import { and, asc, eq } from "drizzle-orm";
import { type AuditEvents, auditInserts } from "./audit-repository.ts";
import type { Db } from "./client.ts";
import { isUniqueViolation } from "./errors.ts";
import { workspaceMemberships, workspaces } from "./schema/index.ts";

export type Workspace = typeof workspaces.$inferSelect;

export interface CreateWorkspaceInput {
  id: string;
  ownerUserId: string;
  slug: WorkspaceSlug;
  name: WorkspaceName;
  now: Instant;
}

export type CreateWorkspaceResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; reason: "slug_taken" };

export interface WorkspaceForMember {
  workspace: Workspace;
  role: WorkspaceRole;
}

/**
 * Creates an active workspace, its owner membership and the audit events in one atomic D1 batch:
 * if any insert fails, nothing is written. A taken slug is a typed result; other constraint
 * errors (an unknown owner) propagate.
 */
export async function createWorkspace(
  db: Db,
  input: CreateWorkspaceInput,
  audit: AuditEvents,
): Promise<CreateWorkspaceResult> {
  const workspace: Workspace = {
    id: input.id,
    slug: input.slug,
    name: input.name,
    status: "active",
    createdAt: input.now,
    updatedAt: input.now,
  };
  try {
    await db.batch([
      db.insert(workspaces).values(workspace),
      db.insert(workspaceMemberships).values({
        workspaceId: input.id,
        userId: input.ownerUserId,
        role: "owner",
        createdAt: input.now,
      }),
      ...auditInserts(db, audit),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, ["workspaces.slug"])) return { ok: false, reason: "slug_taken" };
    throw error;
  }
  return { ok: true, workspace };
}

const memberWorkspace = (db: Db) =>
  db
    .select({ workspace: workspaces, role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId));

/**
 * Returns the workspace and the user's role only when the user is a member of that workspace.
 * Status is returned as-is; deciding what a suspended workspace allows is the caller's policy.
 */
export async function getWorkspaceForMember(
  db: Db,
  input: { workspaceId: string; userId: string },
): Promise<WorkspaceForMember | null> {
  const rows = await memberWorkspace(db)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        eq(workspaceMemberships.userId, input.userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Same as `getWorkspaceForMember`, by slug: null for a non-member and for an unknown slug alike. */
export async function findWorkspaceForMemberBySlug(
  db: Db,
  input: { slug: string; userId: string },
): Promise<WorkspaceForMember | null> {
  const rows = await memberWorkspace(db)
    .where(and(eq(workspaces.slug, input.slug), eq(workspaceMemberships.userId, input.userId)))
    .limit(1);
  return rows[0] ?? null;
}

/** The workspaces the user is a member of, with their role, ordered by name then slug. */
export async function listWorkspacesForUser(db: Db, userId: string): Promise<WorkspaceForMember[]> {
  return memberWorkspace(db)
    .where(eq(workspaceMemberships.userId, userId))
    .orderBy(asc(workspaces.name), asc(workspaces.slug));
}
