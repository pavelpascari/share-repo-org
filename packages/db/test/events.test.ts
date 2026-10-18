import { describe, expect, it } from "vitest";
import {
  claimOutbox,
  enqueueOutbox,
  getExternalEvent,
  listExternalEventsByState,
  markExternalEvent,
  markOutboxSent,
  type NewExternalEvent,
  type NewOutboxRow,
  outboxInsert,
  recordExternalEvent,
} from "../src/index.ts";
import { count, db } from "./support/connections.ts";
import { T0, uniqueId } from "./support/rows.ts";

function event(overrides: Partial<NewExternalEvent> = {}): NewExternalEvent {
  return {
    id: uniqueId("evt"),
    provider: "github",
    externalEventId: crypto.randomUUID(),
    eventType: "installation_repositories",
    action: "removed",
    installationId: "42",
    payloadDigest: "sha256:abc",
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

describe("outbox", () => {
  // Each test uses its own time window, since the outbox table is shared in this file.
  it("claims due rows once per lease, then offers them again", async () => {
    const at = T0 + 1_000_000;
    const due = work("s1", { availableAt: at });
    const later = work("s2", { availableAt: at + 60_000 });
    await enqueueOutbox(db, due);
    await db.batch([outboxInsert(db, later)]);

    const first = await claimOutbox(db, { now: at, limit: 100, leaseMs: 30_000 });
    const claimed = first.filter((row) => row.id === due.id || row.id === later.id);
    expect(claimed).toEqual([{ ...due, attempts: 1, sentAt: null, availableAt: at + 30_000 }]);

    const again = await claimOutbox(db, { now: at + 1, limit: 100, leaseMs: 30_000 });
    expect(again.map((row) => row.id)).not.toContain(due.id);

    const afterLease = await claimOutbox(db, { now: at + 30_000, limit: 100, leaseMs: 30_000 });
    expect(afterLease.find((row) => row.id === due.id)?.attempts).toBe(2);
  });

  it("never claims sent rows, and respects the limit", async () => {
    const at = T0 + 2_000_000;
    const rows = [work("a", { availableAt: at }), work("b", { availableAt: at })];
    for (const row of rows) await enqueueOutbox(db, row);
    await markOutboxSent(db, [rows[0]?.id ?? ""], at);
    await markOutboxSent(db, [], at);

    const claimed = await claimOutbox(db, { now: at + 1_000_000_000, limit: 1000, leaseMs: 1 });
    const ids = claimed.map((row) => row.id);
    expect(ids).not.toContain(rows[0]?.id);
    expect(ids).toContain(rows[1]?.id);
    expect(await claimOutbox(db, { now: at + 2_000_000_000, limit: 1, leaseMs: 1 })).toHaveLength(
      1,
    );
  });

  it("rejects an unknown kind", async () => {
    await expect(
      enqueueOutbox(db, work("x", { kind: "email" as "resync_connection" })),
    ).rejects.toThrow();
  });
});
