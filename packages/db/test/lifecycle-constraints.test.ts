import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { appendAuditEvents } from "../src/index.ts";
import { accountEvent, auditCount, workspaceEvent } from "./support/audit.ts";
import { subscribedWorkspace } from "./support/commerce.ts";
import { count, db, workspaceWithOwner } from "./support/connections.ts";
import { seedPaddleConnection } from "./support/paddle.ts";
import {
  grantRow,
  leasedWorkspace,
  mutationRow,
  seedGrant,
  seedMutation,
} from "./support/reconcile.ts";
import { T0, uniqueId } from "./support/rows.ts";

// Migration 0009: workspace deletion, failure records and system state (decisions 0014, 0015).

const DAY = 86_400_000;

const run = (statement: string, ...params: unknown[]) =>
  env.DB.prepare(statement)
    .bind(...params)
    .run();

/**
 * Moves a workspace to a status, with the deletion columns that status requires. `purging`
 * goes through `deleting`, its only way in.
 */
async function setStatus(workspaceId: string, status: string) {
  const deleting = status === "deleting" || status === "purging";
  if (status === "purging") await enterDeleting(workspaceId);
  return run(
    "UPDATE workspaces SET status = ?, delete_after = ?, deletion_requested_by = ? WHERE id = ?",
    status,
    deleting ? T0 + 30 * DAY : null,
    deleting ? "usr_requester" : null,
    workspaceId,
  );
}

/** `deleting`, unless the workspace is already being deleted. */
const enterDeleting = (workspaceId: string) =>
  run(
    `UPDATE workspaces SET status = 'deleting', delete_after = ?, deletion_requested_by = ?
       WHERE id = ? AND status NOT IN ('deleting', 'purging')`,
    T0 + 30 * DAY,
    "usr_requester",
    workspaceId,
  );

describe("workspace deletion columns", () => {
  it.each(["deleting", "purging"])("accept %s with a schedule and a requester", async (status) => {
    const { workspaceId } = await workspaceWithOwner();
    await setStatus(workspaceId, status);
    expect(
      await env.DB.prepare(
        "SELECT status, delete_after, deletion_requested_by FROM workspaces WHERE id = ?",
      )
        .bind(workspaceId)
        .first(),
    ).toEqual({ status, delete_after: T0 + 30 * DAY, deletion_requested_by: "usr_requester" });
  });

  it("returns to active once the deletion is cancelled", async () => {
    const { workspaceId } = await workspaceWithOwner();
    await setStatus(workspaceId, "deleting");
    await expect(setStatus(workspaceId, "active")).resolves.toBeDefined();
  });

  it.each([
    ["deleting without delete_after", "deleting", null, "usr_requester"],
    ["purging without delete_after", "purging", null, "usr_requester"],
    ["active with delete_after", "active", T0, "usr_requester"],
    ["suspended with delete_after", "suspended", T0, "usr_requester"],
    ["deleting without a requester", "deleting", T0, null],
    ["deleting with an empty requester", "deleting", T0, ""],
    ["active with a requester", "active", null, "usr_requester"],
    ["an unknown status", "deleted", T0, "usr_requester"],
  ])("CHECK rejects %s", async (_, status, deleteAfter, requester) => {
    const { workspaceId } = await workspaceWithOwner();
    if (status === "purging") await enterDeleting(workspaceId);
    await expect(
      run(
        "UPDATE workspaces SET status = ?, delete_after = ?, deletion_requested_by = ? WHERE id = ?",
        status,
        deleteAfter,
        requester,
        workspaceId,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

// The way into `purging`, which unlocks deleting a workspace's history (operations threat model).
describe("deletion/purging-is-one-way", () => {
  it("enters purging only from deleting", async () => {
    for (const from of ["active", "suspended"]) {
      const { workspaceId } = await workspaceWithOwner();
      await setStatus(workspaceId, from);
      await expect(
        run(
          "UPDATE workspaces SET status = 'purging', delete_after = 1, deletion_requested_by = 'u' WHERE id = ?",
          workspaceId,
        ),
      ).rejects.toThrow(/purging follows deleting and is final/);
    }
    const { workspaceId } = await workspaceWithOwner();
    await setStatus(workspaceId, "deleting");
    await run("UPDATE workspaces SET status = 'purging' WHERE id = ?", workspaceId);
    // Re-stating the status, or touching other columns, is not a transition.
    await setStatus(workspaceId, "purging");
    await run("UPDATE workspaces SET updated_at = updated_at + 1 WHERE id = ?", workspaceId);
  });

  it.each(["active", "suspended", "deleting"])("never leaves purging for %s", async (to) => {
    const { workspaceId } = await workspaceWithOwner();
    await setStatus(workspaceId, "deleting");
    await setStatus(workspaceId, "purging");
    await expect(setStatus(workspaceId, to)).rejects.toThrow(
      /purging follows deleting and is final/,
    );
  });

  it.each(["deleting", "purging"])("never creates a workspace already %s", async (status) => {
    await expect(
      run(
        `INSERT INTO workspaces (id, slug, name, status, created_at, updated_at, delete_after,
           deletion_requested_by) VALUES (?, ?, 'Acme', ?, 1, 1, 2, 'usr_requester')`,
        uniqueId("ws"),
        `ws-${crypto.randomUUID().slice(0, 8)}`,
        status,
      ),
    ).rejects.toThrow(/a new workspace is not being deleted/);
  });
});

// Scenario deletion/audit-delete-only-while-purging (decision 0015).
describe("deletion/audit-delete-only-while-purging", () => {
  async function workspaceWithEvent(status: string) {
    const { workspaceId } = await workspaceWithOwner();
    const event = workspaceEvent(workspaceId);
    await appendAuditEvents(db, [event]);
    await setStatus(workspaceId, status);
    return { workspaceId, event };
  }

  it.each(["active", "suspended", "deleting"])(
    "rejects DELETE of a %s workspace's events",
    async (status) => {
      const { event } = await workspaceWithEvent(status);
      await expect(run("DELETE FROM audit_events WHERE id = ?", event.id)).rejects.toThrow(
        /audit_events is append-only/,
      );
      expect(await auditCount(env.DB, event.correlationId)).toBe(1);
    },
  );

  it("rejects DELETE of account-scoped events, whatever any workspace's status", async () => {
    await workspaceWithEvent("purging");
    const event = accountEvent();
    await appendAuditEvents(db, [event]);
    await expect(run("DELETE FROM audit_events WHERE id = ?", event.id)).rejects.toThrow(
      /audit_events is append-only/,
    );
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });

  it("allows DELETE of a purging workspace's events, and only that workspace's", async () => {
    const purging = await workspaceWithEvent("purging");
    const other = await workspaceWithEvent("active");
    // A delete that reaches another workspace's rows aborts as a whole: nothing is deleted.
    await expect(
      run(
        "DELETE FROM audit_events WHERE workspace_id IN (?, ?)",
        purging.workspaceId,
        other.workspaceId,
      ),
    ).rejects.toThrow(/audit_events is append-only/);
    expect(await auditCount(env.DB, purging.event.correlationId)).toBe(1);
    await run("DELETE FROM audit_events WHERE workspace_id = ?", purging.workspaceId);
    expect(await auditCount(env.DB, purging.event.correlationId)).toBe(0);
    expect(await auditCount(env.DB, other.event.correlationId)).toBe(1);
  });

  it.each(["active", "purging"])("still rejects UPDATE while %s", async (status) => {
    const { event } = await workspaceWithEvent(status);
    await expect(
      run("UPDATE audit_events SET reason = 'edited' WHERE id = ?", event.id),
    ).rejects.toThrow(/audit_events is append-only/);
  });
});

describe("offer_versions while purging", () => {
  it("allows DELETE only while the workspace is purging; UPDATE never", async () => {
    const ws = await subscribedWorkspace();
    const id = ws.offer.version.id;
    await setStatus(ws.workspaceId, "deleting");
    await expect(run("DELETE FROM offer_versions WHERE id = ?", id)).rejects.toThrow(
      /offer_versions is append-only/,
    );
    await setStatus(ws.workspaceId, "purging");
    await expect(run("UPDATE offer_versions SET snapshot = '{}' WHERE id = ?", id)).rejects.toThrow(
      /offer_versions is append-only/,
    );
    // Purge order: the entitlements that reference the version go first.
    await run("DELETE FROM entitlements WHERE workspace_id = ?", ws.workspaceId);
    await run("DELETE FROM offer_versions WHERE id = ?", id);
    expect(await count("offer_versions", "id = ?", id)).toBe(0);
  });
});

describe("provider_mutations deletion", () => {
  async function mutation(status: "started" | "succeeded") {
    const ws = await leasedWorkspace();
    const grant = await seedGrant(grantRow(ws.identity));
    const row =
      status === "started"
        ? mutationRow(grant)
        : mutationRow(grant, { status: "succeeded", finishedAt: T0 + 1 });
    await seedMutation(row);
    return { ws, row };
  }

  it("rejects DELETE of a started mutation outside a purge", async () => {
    const { ws, row } = await mutation("started");
    await setStatus(ws.workspaceId, "deleting");
    await expect(run("DELETE FROM provider_mutations WHERE id = ?", row.id)).rejects.toThrow(
      /provider_mutations is append-only/,
    );
  });

  it("allows DELETE of a started mutation while its workspace is purging", async () => {
    const { ws, row } = await mutation("started");
    await setStatus(ws.workspaceId, "purging");
    await run("DELETE FROM provider_mutations WHERE id = ?", row.id);
    expect(await count("provider_mutations", "id = ?", row.id)).toBe(0);
  });

  it("allows pruning a settled mutation", async () => {
    const { row } = await mutation("succeeded");
    await run("DELETE FROM provider_mutations WHERE id = ?", row.id);
    expect(await count("provider_mutations", "id = ?", row.id)).toBe(0);
  });
});

describe("outbox failure records", () => {
  const insert = (fields: Record<string, unknown>) => {
    const row = {
      id: uniqueId("obx"),
      kind: "reconcile_resource",
      subject_id: "k1",
      created_at: T0,
      available_at: T0,
      attempts: 0,
      ...fields,
    };
    const columns = Object.keys(row);
    return run(
      `INSERT INTO outbox (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ...Object.values(row),
    );
  };
  const dismissal = { dismissed_at: T0 + 2, dismissed_by: "usr_op", dismiss_reason: "duplicate" };

  it("accepts system-wide work, a workspace's work, and a dismissed failure", async () => {
    const { workspaceId } = await workspaceWithOwner();
    await expect(insert({ workspace_id: null })).resolves.toBeDefined();
    await expect(insert({ workspace_id: workspaceId })).resolves.toBeDefined();
    await expect(
      insert({ workspace_id: workspaceId, failed_at: T0 + 1, last_error_code: "x", ...dismissal }),
    ).resolves.toBeDefined();
  });

  it("rejects work for a workspace that does not exist", async () => {
    await expect(insert({ workspace_id: "ws_missing" })).rejects.toThrow(/FOREIGN KEY/);
  });

  it.each(["prune_data", "purge_workspace", "rewrap_credentials"])(
    "accepts kind %s",
    async (kind) => {
      await expect(insert({ kind })).resolves.toBeDefined();
    },
  );

  it.each([
    ["a dismissal of work that did not fail", dismissal],
    ["a dismissal without who", { ...dismissal, failed_at: T0 + 1, dismissed_by: null }],
    ["a dismissal without why", { ...dismissal, failed_at: T0 + 1, dismiss_reason: null }],
    ["a dismissal with an empty reason", { ...dismissal, failed_at: T0 + 1, dismiss_reason: "" }],
    ["who without a dismissal", { failed_at: T0 + 1, dismissed_by: "usr_op" }],
    ["why without a dismissal", { failed_at: T0 + 1, dismiss_reason: "duplicate" }],
  ])("CHECK rejects %s", async (_, fields) => {
    await expect(insert(fields)).rejects.toThrow(/CHECK constraint failed/);
  });

  it("indexes open failures per workspace and pending work per subject", async () => {
    const indexes = await env.DB.prepare(
      `SELECT name, sql FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'outbox' AND sql IS NOT NULL ORDER BY name`,
    ).all<{ name: string; sql: string | null }>();
    expect(indexes.results.map((index) => index.name)).toEqual([
      "outbox_open_failures_idx",
      "outbox_pending_idx",
      "outbox_pending_subject_idx",
    ]);
    expect(indexes.results[0]?.sql).toContain(
      "WHERE failed_at IS NOT NULL AND dismissed_at IS NULL",
    );
    expect(indexes.results[2]?.sql).toContain("WHERE sent_at IS NULL AND failed_at IS NULL");
  });
});

describe("system_state", () => {
  it("stores a JSON value by key", async () => {
    const key = uniqueId("sweep");
    await run(
      "INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)",
      key,
      '{"at":1}',
      T0,
    );
    await expect(
      run("INSERT INTO system_state (key, value, updated_at) VALUES (?, '1', ?)", key, T0),
    ).rejects.toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });

  it.each([
    ["an empty key", "", "{}"],
    ["a value that is not JSON", "k", "not json"],
  ])("CHECK rejects %s", async (_, key, value) => {
    await expect(
      run("INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)", key, value, T0),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe("paddle_connections rotation columns", () => {
  it("hold a second destination and its secret during a rotation", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const row = await seedPaddleConnection(workspaceId, {
      destinationNextId: "ntfset_next",
      webhookSecretNextEnvelope: '{"v":1,"next":1}',
    });
    expect(
      await count("paddle_connections", "id = ? AND destination_next_id = 'ntfset_next'", row.id),
    ).toBe(1);
  });
});

describe("connections.rate_limited_until", () => {
  it("is null until GitHub rate-limits the installation", async () => {
    const ws = await subscribedWorkspace();
    expect(
      await env.DB.prepare("SELECT rate_limited_until FROM connections WHERE id = ?")
        .bind(ws.connection.id)
        .first(),
    ).toEqual({ rate_limited_until: null });
  });
});
