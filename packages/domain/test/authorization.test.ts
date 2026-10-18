import { describe, expect, it } from "vitest";
import {
  authorizeMembership,
  roleAllows,
  WORKSPACE_PERMISSIONS,
  WORKSPACE_ROLES,
  type WorkspaceMembership,
  type WorkspacePermission,
  type WorkspaceRole,
} from "../src/index.ts";

// The complete policy, spelled out so any change to it is a deliberate test change.
const POLICY: Record<WorkspaceRole, Record<WorkspacePermission, boolean>> = {
  owner: { "workspace.read": true, "workspace.manage": true },
  member: { "workspace.read": true, "workspace.manage": false },
};

const cases = WORKSPACE_ROLES.flatMap((role) =>
  WORKSPACE_PERMISSIONS.map((permission) => [role, permission, POLICY[role][permission]] as const),
);

describe("workspace authorization policy", () => {
  it("defines the permissions", () => {
    expect(WORKSPACE_PERMISSIONS).toEqual(["workspace.read", "workspace.manage"]);
  });

  it.each(cases)("%s may %s: %s", (role, permission, allowed) => {
    expect(roleAllows(role, permission)).toBe(allowed);
  });
});

describe("authorizeMembership", () => {
  const membership = (role: WorkspaceRole): WorkspaceMembership => ({
    workspaceId: "w1",
    userId: "u1",
    role,
  });

  it.each(cases)("%s requesting %s gets a scope: %s", (role, permission, allowed) => {
    expect(authorizeMembership(membership(role), permission)).toEqual(
      allowed ? { workspaceId: "w1", userId: "u1", role } : null,
    );
  });

  it.each(WORKSPACE_PERMISSIONS)("no membership gets no scope for %s", (permission) => {
    expect(authorizeMembership(null, permission)).toBeNull();
  });

  it("copies only the scope fields", () => {
    const withExtra = { ...membership("owner"), extra: "ignored" };
    expect(authorizeMembership(withExtra, "workspace.read")).toStrictEqual({
      workspaceId: "w1",
      userId: "u1",
      role: "owner",
    });
  });
});
