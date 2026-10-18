import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  appendAuditEvents,
  createDb,
  listAuditEventsByCorrelationId,
  listAuditEventsForWorkspace,
} from "../src/index.ts";
import { accountEvent, auditCount, workspaceEvent } from "./support/audit.ts";
import { insertWorkspaceRow, T0, uniqueId } from "./support/rows.ts";

const db = createDb(env.DB);

async function newWorkspaceId() {
  const id = uniqueId("ws");
  await insertWorkspaceRow({ id });
  return id;
}

interface RawAudit {
  id?: string;
  scope?: string;
  workspace_id?: string | null;
  actor_type?: string;
  actor_id?: string | null;
  details?: string;
}

function insertRaw(row: RawAudit) {
  const r = {
    id: uniqueId("aud"),
    scope: "account",
    workspace_id: null,
    actor_type: "user",
    actor_id: "usr_1",
    details: "{}",
    ...row,
  };
  return env.DB.prepare(
    `INSERT INTO audit_events (id, scope, workspace_id, actor_type, actor_id, action, target_type,
       target_id, reason, correlation_id, occurred_at, details)
     VALUES (?, ?, ?, ?, ?, 'test.raw', 'user', 'usr_1', NULL, 'corr_raw', ?, ?)`,
  )
    .bind(r.id, r.scope, r.workspace_id, r.actor_type, r.actor_id, T0, r.details)
    .run();
}

describe("appendAuditEvents and the read helpers", () => {
  it("round-trips events, including details and nullable fields", async () => {
    const workspaceId = await newWorkspaceId();
    const correlationId = uniqueId("corr");
    const account = accountEvent({
      correlationId,
      actor: { type: "system", id: null },
      reason: "repair",
      details: { provider: "github", nested: { count: 2 }, list: ["a"] },
    });
    const workspace = workspaceEvent(workspaceId, { correlationId, occurredAt: T0 + 1 });

    await appendAuditEvents(db, [account, workspace]);

    await expect(listAuditEventsByCorrelationId(db, correlationId)).resolves.toEqual([
      account,
      workspace,
    ]);
    await expect(listAuditEventsForWorkspace(db, workspaceId)).resolves.toEqual([workspace]);
  });

  it("orders by time, then by insertion order for events at the same instant", async () => {
    const correlationId = uniqueId("corr");
    const late = accountEvent({ correlationId, id: "aud_a_late", occurredAt: T0 + 10 });
    const first = accountEvent({ correlationId, id: "aud_z_first", occurredAt: T0 });
    const second = accountEvent({ correlationId, id: "aud_a_second", occurredAt: T0 });

    await appendAuditEvents(db, [late, first, second]);

    const ids = (await listAuditEventsByCorrelationId(db, correlationId)).map((e) => e.id);
    expect(ids).toEqual(["aud_z_first", "aud_a_second", "aud_a_late"]);
  });

  it("returns only the workspace's own events", async () => {
    const workspaceA = await newWorkspaceId();
    const workspaceB = await newWorkspaceId();
    const eventA = workspaceEvent(workspaceA);
    await appendAuditEvents(db, [eventA, workspaceEvent(workspaceB), accountEvent()]);

    await expect(listAuditEventsForWorkspace(db, workspaceA)).resolves.toEqual([eventA]);
  });

  it("writes nothing when one event in the batch is invalid", async () => {
    const correlationId = uniqueId("corr");
    const valid = accountEvent({ correlationId });
    const invalid = accountEvent({ correlationId, workspaceId: uniqueId("ws") });

    await expect(appendAuditEvents(db, [valid, invalid])).rejects.toThrow(/CHECK constraint/);
    expect(await auditCount(env.DB, correlationId)).toBe(0);
  });
});

describe("audit_events is append-only", () => {
  it("rejects UPDATE", async () => {
    const event = accountEvent();
    await appendAuditEvents(db, [event]);
    await expect(
      env.DB.prepare("UPDATE audit_events SET reason = 'edited' WHERE id = ?").bind(event.id).run(),
    ).rejects.toThrow(/audit_events is append-only/);
  });

  it("rejects DELETE", async () => {
    const event = accountEvent();
    await appendAuditEvents(db, [event]);
    await expect(
      env.DB.prepare("DELETE FROM audit_events WHERE id = ?").bind(event.id).run(),
    ).rejects.toThrow(/audit_events is append-only/);
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });
});

describe("audit_events constraints", () => {
  it("accepts a valid account event and a valid workspace event", async () => {
    await expect(insertRaw({})).resolves.toBeDefined();
    await expect(
      insertRaw({ scope: "workspace", workspace_id: await newWorkspaceId() }),
    ).resolves.toBeDefined();
  });

  it("requires workspace_id for workspace scope", async () => {
    await expect(insertRaw({ scope: "workspace" })).rejects.toThrow(/audit_events_scope_workspace/);
  });

  it("forbids workspace_id for account scope", async () => {
    await expect(insertRaw({ workspace_id: await newWorkspaceId() })).rejects.toThrow(
      /audit_events_scope_workspace/,
    );
  });

  it("rejects an unknown scope", async () => {
    await expect(insertRaw({ scope: "global" })).rejects.toThrow(/audit_events_scope_valid/);
  });

  it("rejects an unknown actor type", async () => {
    await expect(insertRaw({ actor_type: "robot" })).rejects.toThrow(
      /audit_events_actor_type_valid/,
    );
  });

  it("requires an actor id for every actor type except system", async () => {
    for (const actor_type of ["user", "operator", "provider"]) {
      await expect(insertRaw({ actor_type, actor_id: null })).rejects.toThrow(
        /audit_events_actor_id_present/,
      );
    }
    await expect(insertRaw({ actor_type: "system", actor_id: null })).resolves.toBeDefined();
  });

  it("requires details to be a JSON object", async () => {
    for (const details of ["not json", "[1, 2]", "42", '"text"', "null"]) {
      await expect(insertRaw({ details })).rejects.toThrow(/audit_events_details_json/);
    }
  });

  it("rejects a workspace that does not exist", async () => {
    await expect(
      insertRaw({ scope: "workspace", workspace_id: uniqueId("missing") }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});
