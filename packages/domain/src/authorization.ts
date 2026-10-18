import type { WorkspaceRole } from "./workspace.ts";

export const WORKSPACE_PERMISSIONS = ["workspace.read", "workspace.manage"] as const;
export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Readonly<Record<WorkspaceRole, readonly WorkspacePermission[]>> = {
  owner: ["workspace.read", "workspace.manage"],
  member: ["workspace.read"],
};

export function roleAllows(role: WorkspaceRole, permission: WorkspacePermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export interface WorkspaceMembership {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
}

declare const scopeBrand: unique symbol;

/**
 * Proof that a user may act in a workspace. Only `authorizeMembership` creates one, so code that
 * takes a `WorkspaceScope` cannot be reached without an authorization check.
 */
export type WorkspaceScope = WorkspaceMembership & { readonly [scopeBrand]: true };

/** Returns a scope when the membership exists and its role grants the permission. */
export function authorizeMembership(
  membership: WorkspaceMembership | null,
  permission: WorkspacePermission,
): WorkspaceScope | null {
  if (membership === null || !roleAllows(membership.role, permission)) return null;
  const { workspaceId, userId, role } = membership;
  return { workspaceId, userId, role } as WorkspaceScope;
}
