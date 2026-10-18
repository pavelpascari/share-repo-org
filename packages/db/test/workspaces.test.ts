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
  findWorkspaceForMemberBySlug,
  getWorkspaceForMember,
  listAuditEventsByCorrelationId,
  listWorkspacesForUser,
  ping,
} from "../src/index.ts";
import { accountEvent, auditCount, workspaceEvent } from "./support/audit.ts";
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
  await createUser(db, { id, now }, [accountEvent()]);
  return id;
}

async function newWorkspace(ownerUserId: string, now = T0, workspaceName = name()) {
  const id = uniqueId("ws");
  const result = await createWorkspace(
    db,
    { id, ownerUserId, slug: slug(), name: workspaceName, now },
    [workspaceEvent(id)],
  );
  if (!result.ok) throw new Error(result.reason);
  return result.workspace;
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
  it("stores the injected id and time with its audit events", async () => {
    const id = uniqueId("usr");
    const event = accountEvent({ action: "user.created", target: { type: "user", id } });
    await expect(createUser(db, { id, now: T0 + 5 }, [event])).resolves.toEqual({
      id,
      createdAt: T0 + 5,
      updatedAt: T0 + 5,
    });
    const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    expect(row).toEqual({ id, created_at: T0 + 5, updated_at: T0 + 5 });
    await expect(listAuditEventsByCorrelationId(db, event.correlationId)).resolves.toEqual([event]);
  });

  it("rejects a duplicate id and writes no audit row", async () => {
    const id = uniqueId("usr");
    await createUser(db, { id, now: T0 }, [accountEvent()]);
    const event = accountEvent();
    await expect(createUser(db, { id, now: T0 }, [event])).rejects.toThrow(
      /UNIQUE constraint failed: users.id/,
    );
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("creates no user when an audit event is invalid", async () => {
    const id = uniqueId("usr");
    await expect(
      createUser(db, { id, now: T0 }, [accountEvent({ workspaceId: uniqueId("ws") })]),
    ).rejects.toThrow(/CHECK constraint/);
    expect(await countRows("users", "id", id)).toBe(0);
  });
});

describe("createWorkspace", () => {
  it("inserts an active workspace, the owner membership and the audit events", async () => {
    const ownerUserId = await newUser();
    const id = uniqueId("ws");
    const workspaceSlug = slug();
    const created = workspaceEvent(id, { action: "workspace.created" });
    const added = workspaceEvent(id, {
      action: "membership.added",
      correlationId: created.correlationId,
    });

    const result = await createWorkspace(
      db,
      { id, ownerUserId, slug: workspaceSlug, name: name("Acme Co"), now: T0 + 1 },
      [created, added],
    );

    expect(result).toEqual({
      ok: true,
      workspace: {
        id,
        slug: workspaceSlug,
        name: "Acme Co",
        status: "active",
        createdAt: T0 + 1,
        updatedAt: T0 + 1,
      },
    });
    const membership = await env.DB.prepare(
      "SELECT * FROM workspace_memberships WHERE workspace_id = ?",
    )
      .bind(id)
      .all();
    expect(membership.results).toEqual([
      { workspace_id: id, user_id: ownerUserId, role: "owner", created_at: T0 + 1 },
    ]);
    await expect(listAuditEventsByCorrelationId(db, created.correlationId)).resolves.toEqual([
      created,
      added,
    ]);
  });

  it("is atomic: when the owner membership fails, nothing is written", async () => {
    const id = uniqueId("ws");
    const event = workspaceEvent(id);
    await expect(
      createWorkspace(
        db,
        { id, ownerUserId: uniqueId("missing"), slug: slug(), name: name(), now: T0 },
        [event],
      ),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    expect(await countRows("workspaces", "id", id)).toBe(0);
    expect(await countRows("workspace_memberships", "workspace_id", id)).toBe(0);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("is atomic: when an audit event is invalid, nothing is written", async () => {
    const ownerUserId = await newUser();
    const id = uniqueId("ws");
    await expect(
      createWorkspace(db, { id, ownerUserId, slug: slug(), name: name(), now: T0 }, [
        workspaceEvent(id, { actor: { type: "user", id: null } }),
      ]),
    ).rejects.toThrow(/CHECK constraint/);
    expect(await countRows("workspaces", "id", id)).toBe(0);
    expect(await countRows("workspace_memberships", "workspace_id", id)).toBe(0);
  });

  it("reports a taken slug as a typed result and writes nothing", async () => {
    const ownerUserId = await newUser();
    const takenSlug = slug();
    const first = uniqueId("ws");
    await createWorkspace(db, { id: first, ownerUserId, slug: takenSlug, name: name(), now: T0 }, [
      workspaceEvent(first),
    ]);
    const id = uniqueId("ws");
    // The event targets the existing workspace, so only the slug can make the batch fail.
    const event = workspaceEvent(first);

    await expect(
      createWorkspace(db, { id, ownerUserId, slug: takenSlug, name: name(), now: T0 }, [event]),
    ).resolves.toEqual({ ok: false, reason: "slug_taken" });
    expect(await countRows("workspaces", "id", id)).toBe(0);
    expect(await countRows("workspace_memberships", "workspace_id", id)).toBe(0);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("propagates other unique failures, such as an id collision", async () => {
    const ownerUserId = await newUser();
    const existing = await newWorkspace(ownerUserId);
    await expect(
      createWorkspace(db, { id: existing.id, ownerUserId, slug: slug(), name: name(), now: T0 }, [
        workspaceEvent(existing.id),
      ]),
    ).rejects.toThrow(/UNIQUE constraint failed: workspaces.id/);
  });
});

describe("listWorkspacesForUser", () => {
  it("returns the user's workspaces with roles, ordered by name then slug", async () => {
    const userId = await newUser();
    const other = await newUser();
    const zeta = await newWorkspace(userId, T0, name("Zeta"));
    const alphaOne = await newWorkspace(userId, T0, name("Alpha"));
    const alphaTwo = await newWorkspace(userId, T0, name("Alpha"));
    const shared = await newWorkspace(other, T0, name("Beta"));
    await insertMembershipRow(shared.id, userId, "member");
    await newWorkspace(other, T0, name("Not mine"));

    const [firstAlpha, secondAlpha] = [alphaOne, alphaTwo].sort((a, b) =>
      a.slug.localeCompare(b.slug),
    );
    await expect(listWorkspacesForUser(db, userId)).resolves.toEqual([
      { workspace: firstAlpha, role: "owner" },
      { workspace: secondAlpha, role: "owner" },
      { workspace: shared, role: "member" },
      { workspace: zeta, role: "owner" },
    ]);
  });

  it("never includes another user's workspaces", async () => {
    const lonely = await newUser();
    await newWorkspace(await newUser());
    await expect(listWorkspacesForUser(db, lonely)).resolves.toEqual([]);
  });
});

describe("findWorkspaceForMemberBySlug", () => {
  it("returns the workspace and role to a member", async () => {
    const ownerUserId = await newUser();
    const memberUserId = await newUser();
    const workspace = await newWorkspace(ownerUserId);
    await insertMembershipRow(workspace.id, memberUserId, "member");
    await expect(
      findWorkspaceForMemberBySlug(db, { slug: workspace.slug, userId: ownerUserId }),
    ).resolves.toEqual({ workspace, role: "owner" });
    await expect(
      findWorkspaceForMemberBySlug(db, { slug: workspace.slug, userId: memberUserId }),
    ).resolves.toEqual({ workspace, role: "member" });
  });

  it("returns null to a non-member and for an unknown slug alike", async () => {
    const workspace = await newWorkspace(await newUser());
    const outsider = await newUser();
    await newWorkspace(outsider);
    await expect(
      findWorkspaceForMemberBySlug(db, { slug: workspace.slug, userId: outsider }),
    ).resolves.toBeNull();
    await expect(
      findWorkspaceForMemberBySlug(db, { slug: "no-such-workspace", userId: outsider }),
    ).resolves.toBeNull();
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
