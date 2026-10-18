import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyResourceSync,
  getConnection,
  getResource,
  listResourcesForConnection,
  listResourcesForWorkspace,
} from "../src/index.ts";
import { auditCount, workspaceEvent } from "./support/audit.ts";
import { connectedWorkspace, count, db, resourceRow } from "./support/connections.ts";
import { T0 } from "./support/rows.ts";

const NOW = T0 + 100;

/** The optimistic-concurrency fields for a resync starting now: the current version, a new token. */
async function guard(connectionId: string) {
  const row = await env.DB.prepare("SELECT sync_version AS v FROM connections WHERE id = ?")
    .bind(connectionId)
    .first<{ v: number }>();
  return { expectedVersion: Number(row?.v), syncToken: `sync-${crypto.randomUUID()}` };
}

async function synced(names: string[]) {
  const ws = await connectedWorkspace();
  const rows = names.map((nameSnapshot) =>
    resourceRow(ws.workspaceId, ws.connection.id, { nameSnapshot }),
  );
  const result = await applyResourceSync(
    db,
    {
      workspaceId: ws.workspaceId,
      connectionId: ws.connection.id,
      ...(await guard(ws.connection.id)),
      now: NOW,
      inserts: rows,
      updates: [],
      connection: {},
    },
    [workspaceEvent(ws.workspaceId)],
  );
  if (!result.ok) throw new Error(result.reason);
  return { ...ws, rows };
}

describe("applyResourceSync", () => {
  it("inserts resources, stamps the connection, and audits in one batch", async () => {
    const ws = await connectedWorkspace();
    const resource = resourceRow(ws.workspaceId, ws.connection.id);
    const event = workspaceEvent(ws.workspaceId);
    await expect(
      applyResourceSync(
        db,
        {
          workspaceId: ws.workspaceId,
          connectionId: ws.connection.id,
          ...(await guard(ws.connection.id)),
          now: NOW,
          inserts: [resource],
          updates: [],
          connection: { accountLoginSnapshot: "renamed-owner" },
        },
        [event],
      ),
    ).resolves.toEqual({ ok: true });
    expect(await getResource(db, { workspaceId: ws.workspaceId, resourceId: resource.id })).toEqual(
      resource,
    );
    expect(
      await getConnection(db, { workspaceId: ws.workspaceId, connectionId: ws.connection.id }),
    ).toMatchObject({ lastSyncedAt: NOW, updatedAt: NOW, accountLoginSnapshot: "renamed-owner" });
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });

  it("updates existing resources in place, keeping their ID", async () => {
    const { workspaceId, connection, rows } = await synced(["octocat/before"]);
    const [resource] = rows;
    if (resource === undefined) throw new Error("setup");
    await applyResourceSync(
      db,
      {
        workspaceId,
        connectionId: connection.id,
        ...(await guard(connection.id)),
        now: NOW + 1,
        inserts: [],
        updates: [
          { id: resource.id, set: { nameSnapshot: "octocat/after", selection: "removed" } },
        ],
        connection: { status: "suspended" },
      },
      [workspaceEvent(workspaceId)],
    );
    expect(await getResource(db, { workspaceId, resourceId: resource.id })).toEqual({
      ...resource,
      nameSnapshot: "octocat/after",
      selection: "removed",
      updatedAt: NOW + 1,
    });
  });

  it("never updates a resource of another connection or workspace", async () => {
    const theirs = await synced(["their/repo"]);
    const mine = await connectedWorkspace();
    const [target] = theirs.rows;
    if (target === undefined) throw new Error("setup");
    await applyResourceSync(
      db,
      {
        workspaceId: mine.workspaceId,
        connectionId: mine.connection.id,
        ...(await guard(mine.connection.id)),
        now: NOW + 1,
        inserts: [],
        updates: [{ id: target.id, set: { selection: "removed" } }],
        connection: {},
      },
      [workspaceEvent(mine.workspaceId)],
    );
    expect(
      (await getResource(db, { workspaceId: theirs.workspaceId, resourceId: target.id }))
        ?.selection,
    ).toBe("selected");
  });

  it("writes nothing when another resync wrote since this one read (stale)", async () => {
    const { workspaceId, connection } = await synced(["octocat/hello"]);
    const stale = await guard(connection.id);
    const fresh = await guard(connection.id);
    const first = workspaceEvent(workspaceId);
    await expect(
      applyResourceSync(
        db,
        {
          workspaceId,
          connectionId: connection.id,
          ...fresh,
          now: NOW + 1,
          inserts: [],
          updates: [],
          connection: { status: "deleted" },
        },
        [first],
      ),
    ).resolves.toEqual({ ok: true });

    const event = workspaceEvent(workspaceId);
    const resource = resourceRow(workspaceId, connection.id);
    await expect(
      applyResourceSync(
        db,
        {
          workspaceId,
          connectionId: connection.id,
          ...stale,
          now: NOW + 2,
          inserts: [resource],
          updates: [],
          connection: { status: "active" },
        },
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
    expect(await count("resources", "id = ?", resource.id)).toBe(0);
    expect((await getConnection(db, { workspaceId, connectionId: connection.id }))?.status).toBe(
      "deleted",
    );
  });

  it("never revives a deleted connection, even with the current version", async () => {
    const { workspaceId, connection } = await synced([]);
    await applyResourceSync(
      db,
      {
        workspaceId,
        connectionId: connection.id,
        ...(await guard(connection.id)),
        now: NOW + 1,
        inserts: [],
        updates: [],
        connection: { status: "deleted" },
      },
      [workspaceEvent(workspaceId)],
    );
    await expect(
      applyResourceSync(
        db,
        {
          workspaceId,
          connectionId: connection.id,
          ...(await guard(connection.id)),
          now: NOW + 2,
          inserts: [],
          updates: [],
          connection: { status: "active" },
        },
        [workspaceEvent(workspaceId)],
      ),
    ).resolves.toEqual({ ok: false, reason: "stale" });
  });

  it("propagates other failures, such as a resource in another workspace's connection", async () => {
    const theirs = await connectedWorkspace();
    const mine = await connectedWorkspace();
    // Composite FK: a resource cannot point at a connection of another workspace.
    await expect(
      applyResourceSync(
        db,
        {
          workspaceId: mine.workspaceId,
          connectionId: mine.connection.id,
          ...(await guard(mine.connection.id)),
          now: NOW,
          inserts: [resourceRow(mine.workspaceId, theirs.connection.id)],
          updates: [],
          connection: {},
        },
        [workspaceEvent(mine.workspaceId)],
      ),
    ).rejects.toThrow();
    expect(await count("resources", "workspace_id = ?", mine.workspaceId)).toBe(0);
  });
});

describe("resource reads", () => {
  it("lists by name, scoped to the connection or workspace", async () => {
    const ws = await synced(["zeta/repo", "alpha/repo"]);
    const other = await synced(["other/repo"]);
    const names = (rows: { nameSnapshot: string }[]) => rows.map((r) => r.nameSnapshot);
    expect(names(await listResourcesForWorkspace(db, ws.workspaceId))).toEqual([
      "alpha/repo",
      "zeta/repo",
    ]);
    expect(
      names(
        await listResourcesForConnection(db, {
          workspaceId: ws.workspaceId,
          connectionId: ws.connection.id,
          ...(await guard(ws.connection.id)),
        }),
      ),
    ).toEqual(["alpha/repo", "zeta/repo"]);
    expect(
      await listResourcesForConnection(db, {
        workspaceId: ws.workspaceId,
        connectionId: other.connection.id,
        ...(await guard(other.connection.id)),
      }),
    ).toEqual([]);
    const [foreign] = other.rows;
    expect(
      await getResource(db, { workspaceId: ws.workspaceId, resourceId: foreign?.id ?? "" }),
    ).toBeNull();
  });
});

describe("resource constraints", () => {
  it.each([
    ["an unknown type", { type: "gist" }],
    ["an unknown selection", { selection: "maybe" }],
    ["capabilities that are not a JSON object", { capabilities: "true" }],
    ["an update before discovery", { updatedAt: T0 - 1 }],
  ])("rejects %s", async (_, overrides) => {
    const ws = await connectedWorkspace();
    await expect(
      applyResourceSync(
        db,
        {
          workspaceId: ws.workspaceId,
          connectionId: ws.connection.id,
          ...(await guard(ws.connection.id)),
          now: NOW,
          inserts: [resourceRow(ws.workspaceId, ws.connection.id, overrides as object)],
          updates: [],
          connection: {},
        },
        [workspaceEvent(ws.workspaceId)],
      ),
    ).rejects.toThrow();
  });
});
