import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createConnectionFromIntent,
  createConnectionIntent,
  findConnectionByInstallationId,
  findConnectionIntentByTokenHash,
  getConnection,
  listActiveConnectionIds,
  listConnectionsForWorkspace,
  updateConnection,
} from "../src/index.ts";
import { auditCount, workspaceEvent } from "./support/audit.ts";
import {
  connectedWorkspace,
  connectionRow,
  count,
  db,
  intentRow,
  workspaceWithOwner,
} from "./support/connections.ts";
import { insertUserRow, T0, uniqueId } from "./support/rows.ts";

const NOW = T0 + 1;

async function pendingIntent(overrides = {}) {
  const { workspaceId, userId } = await workspaceWithOwner();
  const event = workspaceEvent(workspaceId);
  const intent = await createConnectionIntent(db, intentRow(workspaceId, userId, overrides), [
    event,
  ]);
  return { workspaceId, userId, intent, event };
}

describe("connection intents", () => {
  it("records an intent with its audit event and finds it by token hash", async () => {
    const { intent, event } = await pendingIntent();
    expect(intent.consumedAt).toBeNull();
    expect(await findConnectionIntentByTokenHash(db, intent.tokenHash)).toEqual(intent);
    expect(await findConnectionIntentByTokenHash(db, "no-such-hash")).toBeNull();
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });

  it("can only be held by a member of the workspace", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const outsider = uniqueId("usr");
    await insertUserRow(outsider);
    await expect(
      createConnectionIntent(db, intentRow(workspaceId, outsider), [workspaceEvent(workspaceId)]),
    ).rejects.toThrow();
    expect(await count("connection_intents", "user_id = ?", outsider)).toBe(0);
  });

  it("must expire after it is created", async () => {
    const { workspaceId, userId } = await workspaceWithOwner();
    await expect(
      createConnectionIntent(db, intentRow(workspaceId, userId, { expiresAt: T0 }), [
        workspaceEvent(workspaceId),
      ]),
    ).rejects.toThrow();
  });
});

describe("createConnectionFromIntent", () => {
  it("consumes the intent and creates the connection with audit and outbox in one batch", async () => {
    const { workspaceId, userId, intent } = await pendingIntent();
    const connection = connectionRow(workspaceId, userId);
    const event = workspaceEvent(workspaceId);
    const result = await createConnectionFromIntent(
      db,
      {
        intentId: intent.id,
        now: NOW,
        connection,
        outbox: [
          {
            id: uniqueId("out"),
            kind: "resync_connection",
            subjectId: connection.id,
            createdAt: NOW,
            availableAt: NOW,
          },
        ],
      },
      [event],
    );
    expect(result).toEqual({ ok: true, connection });
    expect(await getConnection(db, { workspaceId, connectionId: connection.id })).toEqual(
      connection,
    );
    expect((await findConnectionIntentByTokenHash(db, intent.tokenHash))?.consumedAt).toBe(NOW);
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
    expect(await count("outbox", "subject_id = ?", connection.id)).toBe(1);
  });

  it("refuses a used intent, even with the same `now`, and writes nothing", async () => {
    const { workspaceId, userId, intent } = await pendingIntent();
    const first = connectionRow(workspaceId, userId);
    await createConnectionFromIntent(db, { intentId: intent.id, now: NOW, connection: first }, [
      workspaceEvent(workspaceId),
    ]);

    const second = connectionRow(workspaceId, userId);
    const event = workspaceEvent(workspaceId);
    const outboxId = uniqueId("out");
    await expect(
      createConnectionFromIntent(
        db,
        {
          intentId: intent.id,
          now: NOW,
          connection: second,
          outbox: [
            {
              id: outboxId,
              kind: "resync_connection",
              subjectId: second.id,
              createdAt: NOW,
              availableAt: NOW,
            },
          ],
        },
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "intent_unavailable" });
    expect(await count("connections", "id = ?", second.id)).toBe(0);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
    expect(await count("outbox", "id = ?", outboxId)).toBe(0);
  });

  it("lets exactly one of two concurrent completions win", async () => {
    const { workspaceId, userId, intent } = await pendingIntent();
    const attempts = [connectionRow(workspaceId, userId), connectionRow(workspaceId, userId)];
    const results = await Promise.all(
      attempts.map((connection) =>
        createConnectionFromIntent(db, { intentId: intent.id, now: NOW, connection }, [
          workspaceEvent(workspaceId),
        ]),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await count("connections", "workspace_id = ?", workspaceId)).toBe(1);
  });

  it.each([
    ["expired", { expiresAt: NOW }],
    ["unknown", null],
  ])("refuses an %s intent", async (_, overrides) => {
    const { workspaceId, userId, intent } = await pendingIntent(overrides ?? {});
    const connection = connectionRow(workspaceId, userId);
    const intentId = overrides === null ? "no-such-intent" : intent.id;
    await expect(
      createConnectionFromIntent(db, { intentId, now: NOW, connection }, [
        workspaceEvent(workspaceId),
      ]),
    ).resolves.toEqual({ ok: false, reason: "intent_unavailable" });
  });

  it("reports a taken installation and leaves the intent unconsumed", async () => {
    const { connection: existing } = await connectedWorkspace();
    const { workspaceId, userId, intent } = await pendingIntent();
    const event = workspaceEvent(workspaceId);
    const result = await createConnectionFromIntent(
      db,
      {
        intentId: intent.id,
        now: NOW,
        connection: connectionRow(workspaceId, userId, {
          installationId: existing.installationId,
        }),
      },
      [event],
    );
    expect(result).toEqual({ ok: false, reason: "installation_taken" });
    expect((await findConnectionIntentByTokenHash(db, intent.tokenHash))?.consumedAt).toBeNull();
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("propagates other constraint failures", async () => {
    const { workspaceId, userId, intent } = await pendingIntent();
    await expect(
      createConnectionFromIntent(
        db,
        {
          intentId: intent.id,
          now: NOW,
          connection: connectionRow(workspaceId, userId, { status: "bogus" as "active" }),
        },
        [workspaceEvent(workspaceId)],
      ),
    ).rejects.toThrow();
  });
});

describe("connection lookups", () => {
  it("finds by installation globally and lists per workspace only", async () => {
    const a = await connectedWorkspace();
    const b = await connectedWorkspace();
    expect(await findConnectionByInstallationId(db, a.connection.installationId)).toEqual(
      a.connection,
    );
    expect(await findConnectionByInstallationId(db, "no-such-installation")).toBeNull();
    expect(await listConnectionsForWorkspace(db, a.workspaceId)).toEqual([a.connection]);
    expect(
      await getConnection(db, { workspaceId: a.workspaceId, connectionId: b.connection.id }),
    ).toBeNull();
  });

  it("lists active and suspended connections for the daily resync, not deleted ones", async () => {
    const active = await connectedWorkspace();
    const suspended = await connectedWorkspace({ status: "suspended" });
    const deleted = await connectedWorkspace({ status: "deleted" });
    const ids = (await listActiveConnectionIds(db)).map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([active.connection.id, suspended.connection.id]));
    expect(ids).not.toContain(deleted.connection.id);
    expect(await listActiveConnectionIds(db)).toContainEqual({
      workspaceId: active.workspaceId,
      id: active.connection.id,
      installationId: active.connection.installationId,
    });
  });
});

describe("updateConnection", () => {
  it("updates the connection in its workspace with the audit event", async () => {
    const { workspaceId, connection } = await connectedWorkspace();
    const event = workspaceEvent(workspaceId);
    await expect(
      updateConnection(
        db,
        { workspaceId, connectionId: connection.id, now: T0 + 9, status: "suspended" },
        [event],
      ),
    ).resolves.toEqual({ ok: true });
    expect(await getConnection(db, { workspaceId, connectionId: connection.id })).toMatchObject({
      status: "suspended",
      updatedAt: T0 + 9,
      accountLoginSnapshot: connection.accountLoginSnapshot,
    });
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });

  it("changes nothing, audit included, for a connection in another workspace", async () => {
    const theirs = await connectedWorkspace();
    const mine = await workspaceWithOwner();
    const event = workspaceEvent(mine.workspaceId);
    await expect(
      updateConnection(
        db,
        {
          workspaceId: mine.workspaceId,
          connectionId: theirs.connection.id,
          now: T0 + 9,
          status: "deleted",
        },
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(
      (
        await getConnection(db, {
          workspaceId: theirs.workspaceId,
          connectionId: theirs.connection.id,
        })
      )?.status,
    ).toBe("active");
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });
});

describe("connection constraints", () => {
  it.each([
    ["an organization account", { accountType: "organization" }],
    ["an unknown status", { status: "paused" }],
    ["permissions that are not a JSON object", { permissions: "[]" }],
    ["an update before creation", { updatedAt: T0 }],
  ])("rejects %s", async (_, overrides) => {
    const { workspaceId, userId, intent } = await pendingIntent();
    await expect(
      createConnectionFromIntent(
        db,
        {
          intentId: intent.id,
          now: NOW,
          connection: connectionRow(workspaceId, userId, overrides as object),
        },
        [workspaceEvent(workspaceId)],
      ),
    ).rejects.toThrow();
  });
});
