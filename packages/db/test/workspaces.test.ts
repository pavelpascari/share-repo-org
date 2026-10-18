import { env } from "cloudflare:workers";
import {
  parseWorkspaceName,
  parseWorkspaceSlug,
  type WorkspaceName,
  type WorkspaceSlug,
} from "@sharerepo/domain";
import { describe, expect, it } from "vitest";
import {
  createDb,
  createUser,
  createWorkspace,
  getWorkspaceForMember,
  ping,
} from "../src/index.ts";
import { insertMembershipRow, T0, uniqueId, uniqueSlug } from "./support/rows.ts";

const db = createDb(env.DB);

function slug(value = uniqueSlug()): WorkspaceSlug {
  const parsed = parseWorkspaceSlug(value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function name(value = "Acme"): WorkspaceName {
  const parsed = parseWorkspaceName(value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

async function newUser(now = T0) {
  const id = uniqueId("usr");
  await createUser(db, { id, now });
  return id;
}

async function newWorkspace(ownerUserId: string, now = T0) {
  const id = uniqueId("ws");
  const workspace = await createWorkspace(db, {
    id,
    ownerUserId,
    slug: slug(),
    name: name(),
    now,
  });
  return workspace;
}

async function countRows(table: string, column: string, value: string) {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`)
    .bind(value)
    .first<{ n: number }>();
  return row?.n;
}

describe("ping", () => {
  it("resolves when D1 answers SELECT 1", async () => {
    await expect(ping(db)).resolves.toBeUndefined();
  });

  it("rejects when D1 is unavailable", async () => {
    const broken = {
      prepare() {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database;
    const error = await ping(createDb(broken)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toEqual(new Error("D1 unavailable"));
  });
});

describe("createUser", () => {
  it("stores the injected id and time", async () => {
    const id = uniqueId("usr");
    await expect(createUser(db, { id, now: T0 + 5 })).resolves.toEqual({
      id,
      createdAt: T0 + 5,
      updatedAt: T0 + 5,
    });
    const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    expect(row).toEqual({ id, created_at: T0 + 5, updated_at: T0 + 5 });
  });

  it("rejects a duplicate id with the constraint error as the cause", async () => {
    const id = uniqueId("usr");
    await createUser(db, { id, now: T0 });
    const error = await createUser(db, { id, now: T0 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).cause)).toMatch(/UNIQUE constraint failed: users.id/);
  });
});

describe("createWorkspace", () => {
  it("inserts an active workspace and the owner membership with the injected time", async () => {
    const ownerUserId = await newUser();
    const id = uniqueId("ws");
    const workspaceSlug = slug();

    const workspace = await createWorkspace(db, {
      id,
      ownerUserId,
      slug: workspaceSlug,
      name: name("Acme Co"),
      now: T0 + 1,
    });

    expect(workspace).toEqual({
      id,
      slug: workspaceSlug,
      name: "Acme Co",
      status: "active",
      createdAt: T0 + 1,
      updatedAt: T0 + 1,
    });
    const membership = await env.DB.prepare(
      "SELECT * FROM workspace_memberships WHERE workspace_id = ?",
    )
      .bind(id)
      .all();
    expect(membership.results).toEqual([
      { workspace_id: id, user_id: ownerUserId, role: "owner", created_at: T0 + 1 },
    ]);
  });

  it("is atomic: when the owner membership fails, the workspace is not created", async () => {
    const id = uniqueId("ws");
    await expect(
      createWorkspace(db, {
        id,
        ownerUserId: uniqueId("missing"),
        slug: slug(),
        name: name(),
        now: T0,
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    expect(await countRows("workspaces", "id", id)).toBe(0);
    expect(await countRows("workspace_memberships", "workspace_id", id)).toBe(0);
  });

  it("rejects a taken slug without creating a membership", async () => {
    const ownerUserId = await newUser();
    const takenSlug = slug();
    await createWorkspace(db, {
      id: uniqueId("ws"),
      ownerUserId,
      slug: takenSlug,
      name: name(),
      now: T0,
    });
    const id = uniqueId("ws");
    await expect(
      createWorkspace(db, { id, ownerUserId, slug: takenSlug, name: name(), now: T0 }),
    ).rejects.toThrow(/UNIQUE constraint failed: workspaces.slug/);
    expect(await countRows("workspace_memberships", "workspace_id", id)).toBe(0);
  });
});

describe("getWorkspaceForMember", () => {
  it("returns the workspace and role to its owner", async () => {
    const ownerUserId = await newUser();
    const workspace = await newWorkspace(ownerUserId);
    await expect(
      getWorkspaceForMember(db, { workspaceId: workspace.id, userId: ownerUserId }),
    ).resolves.toEqual({ workspace, role: "owner" });
  });

  it("returns the member role to a member", async () => {
    const ownerUserId = await newUser();
    const memberUserId = await newUser();
    const workspace = await newWorkspace(ownerUserId);
    await insertMembershipRow(workspace.id, memberUserId, "member");
    await expect(
      getWorkspaceForMember(db, { workspaceId: workspace.id, userId: memberUserId }),
    ).resolves.toEqual({ workspace, role: "member" });
  });

  it("returns null to a user who is not a member", async () => {
    const workspace = await newWorkspace(await newUser());
    const outsider = await newUser();
    await expect(
      getWorkspaceForMember(db, { workspaceId: workspace.id, userId: outsider }),
    ).resolves.toBeNull();
  });

  it("returns null for another workspace id, even when the user is a member elsewhere", async () => {
    const userA = await newUser();
    const userB = await newUser();
    const workspaceA = await newWorkspace(userA);
    const workspaceB = await newWorkspace(userB);
    await expect(
      getWorkspaceForMember(db, { workspaceId: workspaceB.id, userId: userA }),
    ).resolves.toBeNull();
    await expect(
      getWorkspaceForMember(db, { workspaceId: workspaceA.id, userId: userB }),
    ).resolves.toBeNull();
  });

  it("returns null for an unknown workspace or user", async () => {
    const userId = await newUser();
    const workspace = await newWorkspace(userId);
    await expect(
      getWorkspaceForMember(db, { workspaceId: uniqueId("ws"), userId }),
    ).resolves.toBeNull();
    await expect(
      getWorkspaceForMember(db, { workspaceId: workspace.id, userId: uniqueId("usr") }),
    ).resolves.toBeNull();
  });

  it("returns a suspended workspace with its status so the caller can decide", async () => {
    const ownerUserId = await newUser();
    const workspace = await newWorkspace(ownerUserId);
    await env.DB.prepare("UPDATE workspaces SET status = 'suspended' WHERE id = ?")
      .bind(workspace.id)
      .run();
    const result = await getWorkspaceForMember(db, {
      workspaceId: workspace.id,
      userId: ownerUserId,
    });
    expect(result?.workspace.status).toBe("suspended");
  });
});
