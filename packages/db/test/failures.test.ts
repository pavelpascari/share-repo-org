import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  dismissOutboxFailure,
  enqueueOutbox,
  failOutboxRow,
  getFailedOutboxRow,
  getOutboxRow,
  listFailingResources,
  listOpenOutboxFailures,
  listUnhealthyConnections,
  markOutboxSent,
  offerAccessNames,
  readSweepHealth,
  retryOutboxFailure,
  SWEEP_HEARTBEAT_KEY,
  schema,
  subscriptionAccessNames,
} from "../src/index.ts";
import { auditCount, workspaceEvent } from "./support/audit.ts";
import {
  commerceWorkspace,
  customerRow,
  outboxRow,
  seedOffer,
  subscribedWorkspace,
  subscriptionRow,
} from "./support/commerce.ts";
import { connectedWorkspace, db, resourceRow, workspaceWithOwner } from "./support/connections.ts";
import { seedPaddleConnection } from "./support/paddle.ts";
import { T0, uniqueId } from "./support/rows.ts";

// Failure records (decision 0014): written with their audit events, always addressed by their
// workspace (null: system-wide) as well as their ID.

/** A queued row of the workspace (null: system-wide), failed for good with its audit event. */
async function failedRow(workspaceId: string | null, at = T0 + 10) {
  const row = outboxRow("resync_connection", uniqueId("con"), workspaceId);
  await enqueueOutbox(db, row);
  const event = workspaceId === null ? workspaceEvent(uniqueId("ws")) : workspaceEvent(workspaceId);
  const audit =
    workspaceId === null ? { ...event, scope: "account" as const, workspaceId: null } : event;
  expect(await failOutboxRow(db, { id: row.id, now: at, errorCode: "rejected" }, [audit])).toBe(
    true,
  );
  return { row, audit };
}

const stored = (id: string) =>
  env.DB.prepare(
    "SELECT failed_at, last_error_code, attempts, available_at, dismissed_at, dismissed_by, dismiss_reason FROM outbox WHERE id = ?",
  )
    .bind(id)
    .first();

describe("failOutboxRow", () => {
  it("marks an unsent, unfailed row once, with its audit event", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const { row, audit } = await failedRow(workspaceId);
    expect(await stored(row.id)).toMatchObject({ failed_at: T0 + 10, last_error_code: "rejected" });
    expect(await auditCount(env.DB, audit.correlationId)).toBe(1);
    // Again: already failed, so nothing changes and no second event is written.
    const again = workspaceEvent(workspaceId);
    expect(await failOutboxRow(db, { id: row.id, now: T0 + 20, errorCode: "late" }, [again])).toBe(
      false,
    );
    expect(await stored(row.id)).toMatchObject({ failed_at: T0 + 10, last_error_code: "rejected" });
    expect(await auditCount(env.DB, again.correlationId)).toBe(0);
  });

  it("never fails a sent row", async () => {
    const row = outboxRow("resync_connection", uniqueId("con"));
    await enqueueOutbox(db, row);
    await markOutboxSent(db, [row.id], T0);
    const { workspaceId } = await workspaceWithOwner();
    const event = workspaceEvent(workspaceId);
    expect(await failOutboxRow(db, { id: row.id, now: T0, errorCode: "x" }, [event])).toBe(false);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });
});

describe("getOutboxRow and getFailedOutboxRow", () => {
  it("read by ID, and a failure only within its own workspace", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const other = await workspaceWithOwner();
    const { row } = await failedRow(workspaceId);
    const { row: system } = await failedRow(null);
    expect((await getOutboxRow(db, row.id))?.workspaceId).toBe(workspaceId);
    expect(await getOutboxRow(db, uniqueId("nope"))).toBeNull();

    expect((await getFailedOutboxRow(db, { id: row.id, workspaceId }))?.id).toBe(row.id);
    expect(await getFailedOutboxRow(db, { id: row.id, workspaceId: other.workspaceId })).toBeNull();
    expect(await getFailedOutboxRow(db, { id: row.id, workspaceId: null })).toBeNull();
    expect((await getFailedOutboxRow(db, { id: system.id, workspaceId: null }))?.id).toBe(
      system.id,
    );
    expect(await getFailedOutboxRow(db, { id: system.id, workspaceId })).toBeNull();
    // A pending row is not a failure.
    const pending = outboxRow("resync_connection", uniqueId("con"), workspaceId);
    await enqueueOutbox(db, pending);
    expect(await getFailedOutboxRow(db, { id: pending.id, workspaceId })).toBeNull();
  });
});

describe("dismissOutboxFailure and retryOutboxFailure", () => {
  it("dismiss once within the workspace; retry clears the failure and the dismissal", async () => {
    const { workspaceId, userId } = await workspaceWithOwner();
    const other = await workspaceWithOwner();
    const { row } = await failedRow(workspaceId);
    const dismiss = (key: string | null) =>
      dismissOutboxFailure(
        db,
        { id: row.id, workspaceId: key, now: T0 + 30, by: userId, reason: "known outage" },
        [workspaceEvent(workspaceId)],
      );
    expect(await dismiss(other.workspaceId)).toBe(false);
    expect(await dismiss(null)).toBe(false);
    expect(await dismiss(workspaceId)).toBe(true);
    expect(await stored(row.id)).toMatchObject({
      dismissed_at: T0 + 30,
      dismissed_by: userId,
      dismiss_reason: "known outage",
    });
    // Already dismissed.
    expect(await dismiss(workspaceId)).toBe(false);

    const retry = (key: string | null) =>
      retryOutboxFailure(db, { id: row.id, workspaceId: key, now: T0 + 40 }, [
        workspaceEvent(workspaceId),
      ]);
    expect(await retry(other.workspaceId)).toBe(false);
    expect(await retry(workspaceId)).toBe(true);
    expect(await stored(row.id)).toEqual({
      failed_at: null,
      last_error_code: null,
      attempts: 0,
      available_at: T0 + 40,
      dismissed_at: null,
      dismissed_by: null,
      dismiss_reason: null,
    });
    // No longer a failure.
    expect(await retry(workspaceId)).toBe(false);
  });
});

describe("listOpenOutboxFailures", () => {
  it("lists a workspace's open failures oldest first, or every one for operators", async () => {
    const { workspaceId, userId } = await workspaceWithOwner();
    const other = await workspaceWithOwner();
    const newer = await failedRow(workspaceId, T0 + 200);
    const older = await failedRow(workspaceId, T0 + 100);
    const theirs = await failedRow(other.workspaceId, T0 + 150);
    const system = await failedRow(null, T0 + 50);
    const dismissed = await failedRow(workspaceId, T0 + 120);
    await dismissOutboxFailure(
      db,
      { id: dismissed.row.id, workspaceId, now: T0, by: userId, reason: "noise" },
      [workspaceEvent(workspaceId)],
    );

    const own = await listOpenOutboxFailures(db, { workspaceId, limit: 10 });
    expect(own.map((row) => row.id)).toEqual([older.row.id, newer.row.id]);
    expect(own[0]).toMatchObject({ workspaceSlug: expect.any(String), workspaceName: "Acme" });

    const all = (await listOpenOutboxFailures(db, { all: true, limit: 1000 })).map((r) => r.id);
    expect(all).toEqual(
      expect.arrayContaining([older.row.id, newer.row.id, theirs.row.id, system.row.id]),
    );
    expect(all).not.toContain(dismissed.row.id);
    const ordered = [system, older, theirs, newer].map(({ row }) => all.indexOf(row.id));
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    const systemRow = (await listOpenOutboxFailures(db, { all: true, limit: 1000 })).find(
      (row) => row.id === system.row.id,
    );
    expect(systemRow).toMatchObject({
      workspaceId: null,
      workspaceSlug: null,
      workspaceName: null,
    });
    expect(await listOpenOutboxFailures(db, { all: true, limit: 1 })).toHaveLength(1);
  });
});

describe("listFailingResources", () => {
  it("lists selected repositories at the threshold, most failures first", async () => {
    const ws = await connectedWorkspace();
    const other = await connectedWorkspace();
    const rows = [
      resourceRow(ws.workspaceId, ws.connection.id, { reconcileFailures: 3, nameSnapshot: "a" }),
      resourceRow(ws.workspaceId, ws.connection.id, { reconcileFailures: 5, nameSnapshot: "b" }),
      resourceRow(ws.workspaceId, ws.connection.id, { reconcileFailures: 2 }),
      resourceRow(ws.workspaceId, ws.connection.id, {
        reconcileFailures: 9,
        selection: "removed",
      }),
      resourceRow(other.workspaceId, other.connection.id, { reconcileFailures: 4 }),
    ];
    for (const row of rows) await db.insert(schema.resources).values(row);

    const own = await listFailingResources(db, {
      workspaceId: ws.workspaceId,
      minFailures: 3,
      limit: 10,
    });
    expect(own.map((r) => [r.name, r.reconcileFailures])).toEqual([
      ["b", 5],
      ["a", 3],
    ]);
    const all = await listFailingResources(db, { all: true, minFailures: 3, limit: 1000 });
    expect(all.map((r) => r.resourceId)).toEqual(
      expect.arrayContaining([rows[0]?.id, rows[1]?.id, rows[4]?.id]),
    );
    expect(all.map((r) => r.resourceId)).not.toContain(rows[3]?.id);
  });
});

describe("listUnhealthyConnections", () => {
  it("lists suspended and deleted installations and unauthorized Paddle connections", async () => {
    const suspended = await connectedWorkspace({ status: "suspended", updatedAt: T0 + 5 });
    const deleted = await connectedWorkspace({ status: "deleted", updatedAt: T0 + 3 });
    const active = await connectedWorkspace();
    const refused = await seedPaddleConnection(active.workspaceId, {
      status: "unauthorized",
      sellerName: null,
      updatedAt: T0 + 4,
    });
    const healthy = await workspaceWithOwner();
    await seedPaddleConnection(healthy.workspaceId);

    const listed = await listUnhealthyConnections(db, { limit: 1000 });
    const ids = listed.map((c) => c.connectionId);
    expect(ids).not.toContain(active.connection.id);
    const mine = listed.filter((c) =>
      [suspended.connection.id, deleted.connection.id, refused.id].includes(c.connectionId),
    );
    expect(mine).toEqual([
      expect.objectContaining({ provider: "github", status: "deleted", since: T0 + 3 }),
      expect.objectContaining({ provider: "paddle", status: "unauthorized", name: "slr_01" }),
      expect.objectContaining({
        provider: "github",
        status: "suspended",
        name: "octocat",
        workspaceId: suspended.workspaceId,
      }),
    ]);
    expect(listed.filter((c) => c.workspaceId === healthy.workspaceId)).toEqual([]);
  });
});

describe("readSweepHealth", () => {
  it("reports the oldest due row of each sweep and the stored heartbeat", async () => {
    // Before anything is due, and before any heartbeat is stored.
    expect(await readSweepHealth(db, 0)).toEqual({
      oldestDueEvaluationAt: null,
      oldestDueReconcileAt: null,
      oldestDueOutboxAt: null,
      lastHeartbeatAt: null,
    });
    const ws = await commerceWorkspace();
    await db
      .update(schema.resources)
      .set({ nextReconcileAt: 7 })
      .where(eq(schema.resources.id, ws.resources[0]?.id as string));
    const customer = customerRow(ws.workspaceId);
    await db.insert(schema.customers).values(customer);
    await db
      .insert(schema.subscriptions)
      .values(subscriptionRow(ws.workspaceId, customer.id, { nextEvaluationAt: 5 }));
    await enqueueOutbox(db, { ...outboxRow("resync_connection", "x"), availableAt: 9 });
    await db.insert(schema.systemState).values({
      key: SWEEP_HEARTBEAT_KEY,
      value: JSON.stringify({ at: 11 }),
      updatedAt: 11,
    });
    expect(await readSweepHealth(db, 10)).toEqual({
      oldestDueEvaluationAt: 5,
      oldestDueReconcileAt: 7,
      oldestDueOutboxAt: 9,
      lastHeartbeatAt: 11,
    });
  });
});

describe("access names", () => {
  it("names a subscription's subscriber, offers and repositories in its workspace only", async () => {
    const ws = await subscribedWorkspace();
    const key = {
      workspaceId: ws.workspaceId,
      source: ws.subscription.source,
      externalSubscriptionId: ws.subscription.externalSubscriptionId,
    };
    expect(await subscriptionAccessNames(db, key)).toEqual({
      repositories: [ws.resource.nameSnapshot],
      subscribers: ["monalisa"],
      offers: [ws.offer.offer.name],
    });
    const other = await workspaceWithOwner();
    expect(await subscriptionAccessNames(db, { ...key, workspaceId: other.workspaceId })).toEqual({
      repositories: [],
      subscribers: [],
      offers: [],
    });
  });

  it("names nothing for a subscription without a subscriber or entitlements", async () => {
    const ws = await commerceWorkspace();
    const customer = customerRow(ws.workspaceId);
    await db.insert(schema.customers).values(customer);
    const subscription = subscriptionRow(ws.workspaceId, customer.id);
    await db.insert(schema.subscriptions).values(subscription);
    expect(
      await subscriptionAccessNames(db, {
        workspaceId: ws.workspaceId,
        source: subscription.source,
        externalSubscriptionId: subscription.externalSubscriptionId,
      }),
    ).toEqual({ repositories: [], subscribers: [], offers: [] });
  });

  it("names an offer and its repositories in its workspace only", async () => {
    const ws = await commerceWorkspace(2);
    const offer = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: ws.resources.map((r) => r.id),
    });
    const key = { workspaceId: ws.workspaceId, offerId: offer.offer.id };
    expect(await offerAccessNames(db, key)).toEqual({
      repositories: ["octocat/repo-0", "octocat/repo-1"],
      subscribers: [],
      offers: [offer.offer.name],
    });
    const other = await workspaceWithOwner();
    expect(await offerAccessNames(db, { ...key, workspaceId: other.workspaceId })).toEqual({
      repositories: [],
      subscribers: [],
      offers: [],
    });
  });
});
