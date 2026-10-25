import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  claimOutbox,
  deferOutboxRow,
  enqueueOutbox,
  enqueueOutboxRows,
  failOutboxRow,
  getExternalEvent,
  listExternalEventsByState,
  markExternalEvent,
  markOutboxSent,
  type NewExternalEvent,
  type NewOutboxRow,
  outboxInsert,
  recordExternalEvent,
} from "../src/index.ts";
import { accountEvent } from "./support/audit.ts";
import { count, db } from "./support/connections.ts";
import { seedPaddleConnection } from "./support/paddle.ts";
import { insertWorkspaceRow, T0, uniqueId } from "./support/rows.ts";

function event(overrides: Partial<NewExternalEvent> = {}): NewExternalEvent {
  return {
    id: uniqueId("evt"),
    provider: "github",
    connectionId: null,
    externalEventId: crypto.randomUUID(),
    eventType: "installation_repositories",
    action: "removed",
    installationId: "42",
    externalSubscriptionId: null,
    payloadDigest: "sha256:abc",
    occurredAt: null,
    receivedAt: T0,
    ...overrides,
  };
}

function work(subjectId: string, overrides: Partial<NewOutboxRow> = {}): NewOutboxRow {
  return {
    id: uniqueId("out"),
    kind: "process_external_event",
    subjectId,
    createdAt: T0,
    availableAt: T0,
    // Processing an event finds its workspace later, if it has one.
    workspaceId: null,
    ...overrides,
  };
}

describe("recordExternalEvent", () => {
  it("records a new event and its outbox row in one batch", async () => {
    const received = event();
    const job = work(received.id);
    await expect(recordExternalEvent(db, received, [job])).resolves.toEqual({
      inserted: true,
      eventId: received.id,
    });
    expect(await getExternalEvent(db, received.id)).toEqual({
      ...received,
      processingState: "pending",
      attempts: 0,
      lastErrorCode: null,
      processedAt: null,
    });
    expect(await count("outbox", "id = ?", job.id)).toBe(1);
  });

  it("webhook/duplicate-delivery-is-noop: a redelivery writes nothing", async () => {
    const first = event();
    await recordExternalEvent(db, first, [work(first.id)]);
    const before = [await count("external_events"), await count("outbox")];

    const redelivery = event({ externalEventId: first.externalEventId });
    await expect(recordExternalEvent(db, redelivery, [work(redelivery.id)])).resolves.toEqual({
      inserted: false,
      eventId: first.id,
    });
    expect([await count("external_events"), await count("outbox")]).toEqual(before);
  });

  it("webhook/duplicate-delivery-is-noop: dedupes Paddle events within their connection", async () => {
    const seed = async () => {
      const workspaceId = uniqueId("ws");
      await insertWorkspaceRow({ id: workspaceId });
      return seedPaddleConnection(workspaceId);
    };
    const a = await seed();
    const b = await seed();
    const paddle = (connectionId: string) =>
      event({
        provider: "paddle",
        connectionId,
        externalEventId: "evt_01h",
        eventType: "subscription.updated",
        action: null,
        installationId: null,
        occurredAt: T0 - 1,
      });

    const first = paddle(a.id);
    await expect(recordExternalEvent(db, first, [])).resolves.toEqual({
      inserted: true,
      eventId: first.id,
    });
    await expect(recordExternalEvent(db, paddle(a.id), [])).resolves.toEqual({
      inserted: false,
      eventId: first.id,
    });
    // The same event ID signed for another connection is that connection's own event.
    await expect(recordExternalEvent(db, paddle(b.id), [])).resolves.toMatchObject({
      inserted: true,
    });
  });

  it("treats the same delivery ID from another provider position as distinct per provider", async () => {
    // Uniqueness is (provider, delivery ID); only GitHub exists today, so this pins the key shape.
    const a = event();
    const b = event();
    await recordExternalEvent(db, a, []);
    await expect(recordExternalEvent(db, b, [])).resolves.toMatchObject({ inserted: true });
  });

  it("rejects an unknown processing state on write", async () => {
    const received = event();
    await recordExternalEvent(db, received, []);
    await expect(
      markExternalEvent(db, { id: received.id, state: "lost" as "failed", now: T0 }),
    ).rejects.toThrow();
  });
});

describe("markExternalEvent", () => {
  it("stamps final states and counts failed attempts with a code", async () => {
    const received = event();
    await recordExternalEvent(db, received, []);

    await markExternalEvent(db, {
      id: received.id,
      state: "failed",
      now: T0 + 1,
      errorCode: "transient",
    });
    await markExternalEvent(db, {
      id: received.id,
      state: "failed",
      now: T0 + 2,
      errorCode: "transient",
    });
    expect(await getExternalEvent(db, received.id)).toMatchObject({
      processingState: "failed",
      attempts: 2,
      lastErrorCode: "transient",
      processedAt: null,
    });

    await markExternalEvent(db, { id: received.id, state: "processed", now: T0 + 3 });
    expect(await getExternalEvent(db, received.id)).toMatchObject({
      processingState: "processed",
      attempts: 2,
      lastErrorCode: null,
      processedAt: T0 + 3,
    });

    await markExternalEvent(db, { id: received.id, state: "ignored", now: T0 + 4 });
    expect((await getExternalEvent(db, received.id))?.processedAt).toBe(T0 + 4);
  });

  it("lists events by state, oldest first", async () => {
    const state = "pending";
    const older = event({ receivedAt: T0 - 10_000 });
    const newer = event({ receivedAt: T0 - 5_000 });
    await recordExternalEvent(db, newer, []);
    await recordExternalEvent(db, older, []);
    const ids = (await listExternalEventsByState(db, state, 1000)).map((e) => e.id);
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
    expect(await listExternalEventsByState(db, state, 1)).toHaveLength(1);
    expect(await getExternalEvent(db, "no-such-event")).toBeNull();
  });
});

describe("deferOutboxRow", () => {
  const availableAt = async (id: string) =>
    (
      await env.DB.prepare("SELECT available_at AS at FROM outbox WHERE id = ?")
        .bind(id)
        .first<{ at: number }>()
    )?.at;

  it("pushes an open row later, never earlier, and only the row its kind and subject name", async () => {
    const at = T0 + 5_000_000;
    const row = work(uniqueId("defer"), { availableAt: at });
    await enqueueOutbox(db, row);
    const key = { id: row.id, kind: row.kind, subjectId: row.subjectId };
    expect(await deferOutboxRow(db, { ...key, availableAt: at + 60_000 })).toBe(true);
    expect(await availableAt(row.id)).toBe(at + 60_000);
    // Never brought forward.
    expect(await deferOutboxRow(db, { ...key, availableAt: at })).toBe(true);
    expect(await availableAt(row.id)).toBe(at + 60_000);
    // Another subject or kind does not match.
    expect(
      await deferOutboxRow(db, { ...key, subjectId: "other", availableAt: at + 120_000 }),
    ).toBe(false);
    expect(
      await deferOutboxRow(db, { ...key, kind: "recompute_offer", availableAt: at + 120_000 }),
    ).toBe(false);
    expect(await availableAt(row.id)).toBe(at + 60_000);
  });

  it("leaves a sent or failed row alone", async () => {
    const at = T0 + 6_000_000;
    const sent = work(uniqueId("sent"), { availableAt: at });
    const failed = work(uniqueId("failed"), { availableAt: at });
    await enqueueOutbox(db, sent);
    await enqueueOutbox(db, failed);
    await markOutboxSent(db, [sent.id], at);
    await failOutboxRow(db, { id: failed.id, now: at, errorCode: "rejected" }, []);
    for (const row of [sent, failed]) {
      expect(
        await deferOutboxRow(db, {
          id: row.id,
          kind: row.kind,
          subjectId: row.subjectId,
          availableAt: at + 60_000,
        }),
      ).toBe(false);
      expect(await availableAt(row.id)).toBe(at);
    }
  });
});

describe("outbox", () => {
  // Each test uses its own time window, since the outbox table is shared in this file.
  it("claims due rows once per lease, then offers them again", async () => {
    const at = T0 + 1_000_000;
    const due = work("s1", { availableAt: at });
    const later = work("s2", { availableAt: at + 60_000 });
    await enqueueOutbox(db, due);
    await db.batch([outboxInsert(db, later)]);

    const first = await claimOutbox(db, { now: at, limit: 100, leaseMs: 30_000, maxAttempts: 10 });
    const claimed = first.filter((row) => row.id === due.id || row.id === later.id);
    expect(claimed).toEqual([
      {
        ...due,
        attempts: 1,
        sentAt: null,
        failedAt: null,
        lastErrorCode: null,
        dismissedAt: null,
        dismissedBy: null,
        dismissReason: null,
        availableAt: at + 30_000,
      },
    ]);

    const again = await claimOutbox(db, {
      now: at + 1,
      limit: 100,
      leaseMs: 30_000,
      maxAttempts: 10,
    });
    expect(again.map((row) => row.id)).not.toContain(due.id);

    const afterLease = await claimOutbox(db, {
      now: at + 30_000,
      limit: 100,
      leaseMs: 30_000,
      maxAttempts: 10,
    });
    expect(afterLease.find((row) => row.id === due.id)?.attempts).toBe(2);
  });

  it("never claims sent rows, and respects the limit", async () => {
    const at = T0 + 2_000_000;
    const rows = [work("a", { availableAt: at }), work("b", { availableAt: at })];
    for (const row of rows) await enqueueOutbox(db, row);
    await markOutboxSent(db, [rows[0]?.id ?? ""], at);
    await markOutboxSent(db, [], at);

    const claimed = await claimOutbox(db, {
      now: at + 1_000_000_000,
      limit: 1000,
      leaseMs: 1,
      maxAttempts: 10,
    });
    const ids = claimed.map((row) => row.id);
    expect(ids).not.toContain(rows[0]?.id);
    expect(ids).toContain(rows[1]?.id);
    expect(
      await claimOutbox(db, { now: at + 2_000_000_000, limit: 1, leaseMs: 1, maxAttempts: 10 }),
    ).toHaveLength(1);
  });

  it("stops claiming a row once it used every attempt", async () => {
    const at = T0 + 3_000_000;
    const row = work("exhausted", { availableAt: at });
    await enqueueOutbox(db, row);
    const claim = (now: number) =>
      claimOutbox(db, { now, limit: 1000, leaseMs: 1, maxAttempts: 2 });
    expect((await claim(at)).map((r) => r.id)).toContain(row.id);
    expect((await claim(at + 10)).map((r) => r.id)).toContain(row.id);
    expect((await claim(at + 20)).map((r) => r.id)).not.toContain(row.id);
  });

  it("never claims a row marked failed, and records why", async () => {
    const at = T0 + 4_000_000;
    const row = work("failed", { availableAt: at });
    await enqueueOutbox(db, row);
    await failOutboxRow(db, { id: row.id, now: at, errorCode: "rejected" }, [accountEvent()]);
    const claimed = await claimOutbox(db, {
      now: at + 1,
      limit: 1000,
      leaseMs: 1,
      maxAttempts: 10,
    });
    expect(claimed.map((r) => r.id)).not.toContain(row.id);
    const stored = await env.DB.prepare(
      "SELECT failed_at, last_error_code FROM outbox WHERE id = ?",
    )
      .bind(row.id)
      .first();
    expect(stored).toEqual({ failed_at: at, last_error_code: "rejected" });
    // A row already sent is not marked failed afterwards.
    const sent = work("sent", { availableAt: at });
    await enqueueOutbox(db, sent);
    await markOutboxSent(db, [sent.id], at);
    await failOutboxRow(db, { id: sent.id, now: at, errorCode: "late" }, [accountEvent()]);
    expect(
      await env.DB.prepare("SELECT failed_at FROM outbox WHERE id = ?").bind(sent.id).first(),
    ).toEqual({ failed_at: null });
  });

  it("queues many rows in bounded batches, few D1 calls for a large fan-out", async () => {
    const prefix = uniqueId("fan");
    // Never due, so other tests' claims in this file do not see them.
    const rows = Array.from({ length: 120 }, (_, i) =>
      work(`${prefix}-${i}`, { availableAt: T0 + 1e13 }),
    );
    let batches = 0;
    const counting = new Proxy(db, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (property !== "batch") return value;
        return (statements: unknown[]) => {
          batches += 1;
          expect(statements.length).toBeLessThanOrEqual(50);
          return value.call(target, statements);
        };
      },
    });
    await enqueueOutboxRows(counting, rows);
    expect(batches).toBe(3);
    expect(await count("outbox", "subject_id LIKE ?", `${prefix}-%`)).toBe(120);
    await enqueueOutboxRows(db, []);
  });

  it("rejects an unknown kind", async () => {
    await expect(
      enqueueOutbox(db, work("x", { kind: "email" as "resync_connection" })),
    ).rejects.toThrow();
  });
});
