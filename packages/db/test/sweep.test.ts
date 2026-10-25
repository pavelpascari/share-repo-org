import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimDueReconciles,
  claimSweepLagAlert,
  deferConnectionReconciles,
  enqueueOutbox,
  enqueueOutboxOnce,
  readSweepBacklog,
  SWEEP_LAG_ALERT_STATE_KEY,
} from "../src/index.ts";
import { commerceWorkspace, outboxRow, subscribedWorkspace } from "./support/commerce.ts";
import { count, db } from "./support/connections.ts";
import { reconcileRow } from "./support/reconcile.ts";
import { T0 } from "./support/rows.ts";

// Partitioned reconcile claims, rate-limit deferral and sweep health (phase-6 plan, T2).

const NOW = T0 + 10 * 365 * 86_400_000;
const MINUTE = 60_000;

// Storage is shared within the file, and these reads span every workspace: each test starts
// from nothing due.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("UPDATE resources SET next_reconcile_at = NULL"),
    env.DB.prepare("UPDATE subscriptions SET next_evaluation_at = NULL"),
    env.DB.prepare("DELETE FROM system_state"),
  ]);
});

/** A workspace whose connection has `n` repositories due at `NOW - n + i` (oldest first). */
async function dueWorkspace(n: number, dueAt = (i: number) => NOW - n + i) {
  const ws = await commerceWorkspace(n);
  for (const [i, resource] of ws.resources.entries()) {
    await env.DB.prepare("UPDATE resources SET next_reconcile_at = ? WHERE id = ?")
      .bind(dueAt(i), resource.id)
      .run();
  }
  return ws;
}

const makeOutboxRow = (resource: { workspaceId: string; id: string }) =>
  reconcileRow(resource.workspaceId, resource.id);

const queuedFor = (workspaceId: string) =>
  count("outbox", "kind = 'reconcile_resource' AND subject_id LIKE ?", `${workspaceId}:%`);

const claim = (input: { now?: number; limit?: number; perConnection?: number } = {}) =>
  claimDueReconciles(db, {
    now: input.now ?? NOW,
    limit: input.limit ?? 100,
    perConnection: input.perConnection ?? 10,
    makeOutboxRow,
  });

describe("claimDueReconciles partitioning", () => {
  it("partition/one-installation-cannot-starve-others: claims at most 10 per connection, oldest first", async () => {
    const large = await dueWorkspace(15);
    const small = await dueWorkspace(2, (i) => NOW - i);

    await expect(claim()).resolves.toBe(12);
    expect(await queuedFor(large.workspaceId)).toBe(10);
    expect(await queuedFor(small.workspaceId)).toBe(2);
    // The large connection's oldest ten went first; its newest five are still due.
    const left = await env.DB.prepare(
      "SELECT next_reconcile_at AS n FROM resources WHERE workspace_id = ? AND next_reconcile_at IS NOT NULL ORDER BY n",
    )
      .bind(large.workspaceId)
      .all<{ n: number }>();
    expect(left.results.map((row) => row.n)).toEqual([NOW - 5, NOW - 4, NOW - 3, NOW - 2, NOW - 1]);

    // The next tick takes the rest.
    await expect(claim()).resolves.toBe(5);
    expect(await queuedFor(large.workspaceId)).toBe(15);
  });

  it("still caps the total, oldest first across connections", async () => {
    const a = await dueWorkspace(3, (i) => NOW - 10 + i);
    const b = await dueWorkspace(3, (i) => NOW - 20 + i);
    await expect(claim({ limit: 4 })).resolves.toBe(4);
    expect(await queuedFor(b.workspaceId)).toBe(3);
    expect(await queuedFor(a.workspaceId)).toBe(1);
  });

  it("defers a rate-limited connection's due and repair reconciles until its reset", async () => {
    const limited = await dueWorkspace(2);
    const other = await dueWorkspace(1);
    // Due by schedule, and (the second) the repair path: nothing scheduled, with a live lease
    // long gone and a reconcile request newer than its last run.
    const [, repair] = limited.resources;
    await env.DB.prepare(
      "UPDATE resources SET next_reconcile_at = NULL, reconcile_requested_at = ? WHERE id = ?",
    )
      .bind(NOW - MINUTE, repair?.id)
      .run();
    await deferConnectionReconciles(db, {
      workspaceId: limited.workspaceId,
      connectionId: limited.connection.id,
      until: NOW + MINUTE,
    });

    await expect(claim()).resolves.toBe(1);
    expect(await queuedFor(limited.workspaceId)).toBe(0);
    expect(await queuedFor(other.workspaceId)).toBe(1);

    // At the reset both are claimed.
    await expect(claim({ now: NOW + MINUTE })).resolves.toBe(2);
    expect(await queuedFor(limited.workspaceId)).toBe(2);
  });
});

describe("deferConnectionReconciles", () => {
  const until = async (connectionId: string) =>
    (
      await env.DB.prepare("SELECT rate_limited_until AS u FROM connections WHERE id = ?")
        .bind(connectionId)
        .first<{ u: number | null }>()
    )?.u;

  it("only moves the reset later, within the named workspace", async () => {
    const ws = await commerceWorkspace();
    const other = await commerceWorkspace();
    const key = { workspaceId: ws.workspaceId, connectionId: ws.connection.id };
    await deferConnectionReconciles(db, { ...key, until: NOW + 2 * MINUTE });
    await deferConnectionReconciles(db, { ...key, until: NOW + MINUTE });
    expect(await until(ws.connection.id)).toBe(NOW + 2 * MINUTE);
    await deferConnectionReconciles(db, { ...key, until: NOW + 3 * MINUTE });
    expect(await until(ws.connection.id)).toBe(NOW + 3 * MINUTE);

    // Another workspace's connection ID changes nothing.
    await deferConnectionReconciles(db, {
      workspaceId: other.workspaceId,
      connectionId: ws.connection.id,
      until: NOW + 9 * MINUTE,
    });
    expect(await until(ws.connection.id)).toBe(NOW + 3 * MINUTE);
    expect(await until(other.connection.id)).toBeNull();
  });
});

describe("readSweepBacklog", () => {
  const read = (now = NOW) => readSweepBacklog(db, { now, maxAttempts: 10 });

  it("reports nothing when nothing is due", async () => {
    await dueWorkspace(1, () => NOW + 1);
    await enqueueOutbox(db, { ...outboxRow("recompute_offer", "x"), availableAt: NOW + 1 });
    await expect(read()).resolves.toEqual({
      evaluationDueAt: null,
      reconcileDueAt: null,
      outboxDueAt: null,
    });
  });

  it("reports the oldest due instant of each kind", async () => {
    const ws = await dueWorkspace(2, (i) => NOW - 5 * MINUTE + i);
    await subscribedWorkspace({ subscription: { nextEvaluationAt: NOW - 7 * MINUTE } });
    await subscribedWorkspace({ subscription: { nextEvaluationAt: NOW - 6 * MINUTE } });
    // Pending rows count; sent, failed and exhausted ones do not.
    await enqueueOutbox(db, { ...outboxRow("recompute_offer", "a"), availableAt: NOW - MINUTE });
    for (const [column, value] of [
      ["sent_at", NOW],
      ["failed_at", NOW],
      ["attempts", 10],
    ] as const) {
      const row = { ...outboxRow("recompute_offer", column), availableAt: NOW - 9 * MINUTE };
      await enqueueOutbox(db, row);
      if (column === "failed_at") {
        await env.DB.prepare("UPDATE outbox SET failed_at = ?, last_error_code = 'x' WHERE id = ?")
          .bind(value, row.id)
          .run();
      } else {
        await env.DB.prepare(`UPDATE outbox SET ${column} = ? WHERE id = ?`)
          .bind(value, row.id)
          .run();
      }
    }
    await enqueueOutbox(db, {
      ...outboxRow("recompute_offer", "b"),
      availableAt: NOW - 2 * MINUTE,
    });
    const backlog = await read();
    expect(backlog.reconcileDueAt).toBe(NOW - 5 * MINUTE);
    expect(backlog.outboxDueAt).toBe(NOW - 2 * MINUTE);
    expect(backlog.evaluationDueAt).toBe(NOW - 7 * MINUTE);

    // A rate-limited connection's repositories wait on purpose: they are not lag.
    await deferConnectionReconciles(db, {
      workspaceId: ws.workspaceId,
      connectionId: ws.connection.id,
      until: NOW + MINUTE,
    });
    expect((await read()).reconcileDueAt).toBeNull();
    expect((await read(NOW + MINUTE)).reconcileDueAt).toBe(NOW - 5 * MINUTE);
  });
});

describe("claimSweepLagAlert", () => {
  const stored = () =>
    env.DB.prepare("SELECT value, updated_at AS at FROM system_state WHERE key = ?")
      .bind(SWEEP_LAG_ALERT_STATE_KEY)
      .first<{ value: string; at: number }>();

  it("timing/sweep-lag-alerts: raises at most once per interval, even when replayed", async () => {
    const interval = 15 * MINUTE;
    const take = (now: number) => claimSweepLagAlert(db, { now, intervalMs: interval });
    await expect(take(NOW)).resolves.toBe(true);
    expect(await stored()).toEqual({ value: JSON.stringify({ at: NOW }), at: NOW });
    await expect(take(NOW)).resolves.toBe(false);
    await expect(take(NOW + interval - 1)).resolves.toBe(false);
    expect((await stored())?.at).toBe(NOW);
    await expect(take(NOW + interval)).resolves.toBe(true);
    expect(await stored()).toEqual({
      value: JSON.stringify({ at: NOW + interval }),
      at: NOW + interval,
    });
  });
});

describe("enqueueOutboxOnce and delayed rows", () => {
  const availableAt = async (id: string) =>
    (
      await env.DB.prepare("SELECT available_at AS a FROM outbox WHERE id = ?")
        .bind(id)
        .first<{ a: number }>()
    )?.a;

  it("brings a delayed, never-claimed row forward instead of queueing a second", async () => {
    const later = { ...outboxRow("resync_connection", "conn-x"), availableAt: NOW + 20 * MINUTE };
    await expect(enqueueOutboxOnce(db, later)).resolves.toBe(true);
    // A later delay does not push it back.
    await expect(
      enqueueOutboxOnce(db, {
        ...outboxRow("resync_connection", "conn-x"),
        availableAt: NOW + 30 * MINUTE,
      }),
    ).resolves.toBe(false);
    expect(await availableAt(later.id)).toBe(NOW + 20 * MINUTE);
    // Work wanted now brings it forward.
    await expect(
      enqueueOutboxOnce(db, { ...outboxRow("resync_connection", "conn-x"), availableAt: NOW }),
    ).resolves.toBe(false);
    expect(await availableAt(later.id)).toBe(NOW);
    expect(await count("outbox", "subject_id = 'conn-x'")).toBe(1);
  });

  it("leaves a claimed row's lease alone", async () => {
    const leased = { ...outboxRow("resync_connection", "conn-y"), availableAt: NOW + MINUTE };
    await enqueueOutbox(db, leased);
    await env.DB.prepare("UPDATE outbox SET attempts = 1 WHERE id = ?").bind(leased.id).run();
    await expect(
      enqueueOutboxOnce(db, { ...outboxRow("resync_connection", "conn-y"), availableAt: NOW }),
    ).resolves.toBe(false);
    expect(await availableAt(leased.id)).toBe(NOW + MINUTE);
  });
});
