import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createSimulatedSubscription,
  getSimulatedSubscription,
  listSimulatedSubscriptions,
  updateSimulatedSubscription,
} from "../src/index.ts";
import { auditCount, workspaceEvent } from "./support/audit.ts";
import { outboxRow, simulatedRow } from "./support/commerce.ts";
import { count, db, workspaceWithOwner } from "./support/connections.ts";
import { T0 } from "./support/rows.ts";

async function seeded(overrides: Parameters<typeof simulatedRow>[1] = {}) {
  const { workspaceId } = await workspaceWithOwner();
  const row = simulatedRow(workspaceId, overrides);
  const outbox = outboxRow("refresh_subscription", row.id);
  const event = workspaceEvent(workspaceId);
  await createSimulatedSubscription(db, row, { outbox: [outbox] }, [event]);
  return { workspaceId, row, outbox, event };
}

describe("createSimulatedSubscription", () => {
  it("writes the row, its outbox rows and audit together", async () => {
    const { workspaceId, row, outbox, event } = await seeded();
    expect(await getSimulatedSubscription(db, { workspaceId, id: row.id })).toEqual(row);
    expect(await count("outbox", "id = ?", outbox.id)).toBe(1);
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });

  it("writes nothing when the row is invalid", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const row = simulatedRow(workspaceId, { items: "not json" });
    const outbox = outboxRow("refresh_subscription", row.id);
    const event = workspaceEvent(workspaceId);
    await expect(
      createSimulatedSubscription(db, row, { outbox: [outbox] }, [event]),
    ).rejects.toThrow();
    expect(await count("outbox", "id = ?", outbox.id)).toBe(0);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });
});

describe("simulated subscription reads", () => {
  it("lists by creation then ID, scoped to the workspace", async () => {
    const { workspaceId, row: first } = await seeded();
    const later = simulatedRow(workspaceId, { createdAt: T0 + 5, updatedAt: T0 + 5 });
    const early = simulatedRow(workspaceId, { createdAt: T0 - 5 });
    for (const row of [later, early]) {
      await createSimulatedSubscription(db, row, { outbox: [] }, [workspaceEvent(workspaceId)]);
    }
    await seeded();
    expect((await listSimulatedSubscriptions(db, workspaceId)).map((r) => r.id)).toEqual([
      early.id,
      first.id,
      later.id,
    ]);
    const other = await workspaceWithOwner();
    expect(
      await getSimulatedSubscription(db, { workspaceId: other.workspaceId, id: first.id }),
    ).toBeNull();
    expect(await listSimulatedSubscriptions(db, other.workspaceId)).toEqual([]);
  });
});

describe("updateSimulatedSubscription", () => {
  it("applies the change with its outbox rows and audit", async () => {
    const { workspaceId, row } = await seeded();
    const outbox = outboxRow("refresh_subscription", row.id);
    const event = workspaceEvent(workspaceId);
    await expect(
      updateSimulatedSubscription(
        db,
        {
          workspaceId,
          id: row.id,
          expectedUpdatedAt: T0,
          set: { state: "past_due", pastDueSince: T0 + 1, updatedAt: T0 + 1 },
        },
        { outbox: [outbox] },
        [event],
      ),
    ).resolves.toEqual({ ok: true });
    expect(await getSimulatedSubscription(db, { workspaceId, id: row.id })).toEqual({
      ...row,
      state: "past_due",
      pastDueSince: T0 + 1,
      updatedAt: T0 + 1,
    });
    expect(await count("outbox", "id = ?", outbox.id)).toBe(1);
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });

  it("writes nothing when another action changed it first (stale)", async () => {
    const { workspaceId, row } = await seeded();
    const input = { workspaceId, id: row.id, expectedUpdatedAt: T0 };
    await updateSimulatedSubscription(
      db,
      { ...input, set: { state: "active", updatedAt: T0 + 1 } },
      { outbox: [] },
      [workspaceEvent(workspaceId)],
    );
    const outbox = outboxRow("refresh_subscription", row.id);
    const event = workspaceEvent(workspaceId);
    // Same expected and same new timestamp as the winner: still stale.
    await expect(
      updateSimulatedSubscription(
        db,
        { ...input, set: { state: "paused", updatedAt: T0 + 1 } },
        { outbox: [outbox] },
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    expect((await getSimulatedSubscription(db, { workspaceId, id: row.id }))?.state).toBe("active");
    expect(await count("outbox", "id = ?", outbox.id)).toBe(0);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("never writes through another workspace's key", async () => {
    const { workspaceId, row } = await seeded();
    const other = await workspaceWithOwner();
    const event = workspaceEvent(other.workspaceId);
    await expect(
      updateSimulatedSubscription(
        db,
        {
          workspaceId: other.workspaceId,
          id: row.id,
          expectedUpdatedAt: T0,
          set: { state: "expired", endedAt: T0 + 1, updatedAt: T0 + 1 },
        },
        { outbox: [] },
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    expect((await getSimulatedSubscription(db, { workspaceId, id: row.id }))?.state).toBe(
      "trialing",
    );
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it.each([T0, T0 - 1])("rejects a new updatedAt of %d that does not move forward", async (at) => {
    const { workspaceId, row } = await seeded();
    await expect(
      updateSimulatedSubscription(
        db,
        { workspaceId, id: row.id, expectedUpdatedAt: T0, set: { updatedAt: at } },
        { outbox: [] },
        [workspaceEvent(workspaceId)],
      ),
    ).rejects.toThrow(/must be after expectedUpdatedAt/);
  });
});
