import { env } from "cloudflare:workers";
import { excusedReconcileDueAt, sweepLag } from "@sharerepo/domain";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimDueReconciles,
  claimSweepLagAlert,
  deferConnectionReconciles,
  enqueueOutbox,
  enqueueOutboxOnce,
  readSweepBacklog,
  readSweepHealth,
  recordSweepHeartbeat,
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

    // A rate-limited connection's repositories wait on purpose: until the reset they are not late.
    await deferConnectionReconciles(db, {
      workspaceId: ws.workspaceId,
      connectionId: ws.connection.id,
      until: NOW + MINUTE,
    });
    expect((await read()).reconcileDueAt).toBeNull();
    // From the reset on, they are late from the reset, not from their old schedule.
    expect((await read(NOW + MINUTE)).reconcileDueAt).toBe(NOW + MINUTE);
  });
});

// Decision 0014, amended: a GitHub rate limit excuses a reconcile from lag for at most an hour.
describe("readSweepBacklog and GitHub rate limits", () => {
  const HOUR = 60 * MINUTE;
  const lagAt = async (now: number) => {
    const { reconcileDueAt } = await readSweepBacklog(db, { now, maxAttempts: 10 });
    return sweepLag([reconcileDueAt], now);
  };
  const rateLimit = (ws: { workspaceId: string; connection: { id: string } }, until: number) =>
    deferConnectionReconciles(db, {
      workspaceId: ws.workspaceId,
      connectionId: ws.connection.id,
      until,
    });

  it("timing/sweep-lag-excuses-rate-limits: a rate limit within the hour is not lag, nor just after its reset", async () => {
    const ws = await dueWorkspace(1, () => NOW);
    await rateLimit(ws, NOW + 40 * MINUTE);
    // Waiting for the reset, however long past its schedule.
    expect(await lagAt(NOW + 39 * MINUTE)).toEqual({ lagMs: 0, lagging: false });
    // Just after the reset, the sweep gets the alert's 15 minutes to work through it.
    expect(
      (await readSweepBacklog(db, { now: NOW + 41 * MINUTE, maxAttempts: 10 })).reconcileDueAt,
    ).toBe(NOW + 40 * MINUTE);
    expect(await lagAt(NOW + 41 * MINUTE)).toEqual({ lagMs: MINUTE, lagging: false });
    expect((await lagAt(NOW + 55 * MINUTE)).lagging).toBe(false);
    // Still unprocessed more than 15 minutes after its excused time: lag.
    expect(await lagAt(NOW + 55 * MINUTE + 1)).toEqual({ lagMs: 15 * MINUTE + 1, lagging: true });
  });

  it("timing/sweep-lag-excuses-rate-limits: a connection rate-limited past the hour is lag", async () => {
    const ws = await dueWorkspace(1, () => NOW);
    await rateLimit(ws, NOW + 3 * HOUR);
    expect((await lagAt(NOW + HOUR)).lagging).toBe(false);
    expect(await lagAt(NOW + HOUR + 15 * MINUTE + 1)).toEqual({
      lagMs: 15 * MINUTE + 1,
      lagging: true,
    });
    // GitHub keeps pushing the reset later: still lag, measured from the end of the excuse.
    await rateLimit(ws, NOW + 9 * HOUR);
    expect(await lagAt(NOW + 2 * HOUR)).toEqual({ lagMs: HOUR, lagging: true });
  });

  it("ignores a stale rate limit, which is never cleared, for a later schedule", async () => {
    const ws = await dueWorkspace(1, () => NOW - 20 * MINUTE);
    // Rate-limited until an hour ago; the repository was rescheduled since.
    await rateLimit(ws, NOW - HOUR);
    expect((await readSweepBacklog(db, { now: NOW, maxAttempts: 10 })).reconcileDueAt).toBe(
      NOW - 20 * MINUTE,
    );
    expect(await lagAt(NOW)).toEqual({ lagMs: 20 * MINUTE, lagging: true });
  });

  it("matches the domain's excused due instant", async () => {
    const cases: [number, number | null][] = [
      [NOW - HOUR, null],
      [NOW - HOUR, NOW - 2 * HOUR],
      [NOW - HOUR, NOW - 30 * MINUTE],
      [NOW - 2 * HOUR, NOW + HOUR],
      [NOW - HOUR, NOW - HOUR],
    ];
    for (const [next, until] of cases) {
      await env.DB.prepare("UPDATE resources SET next_reconcile_at = NULL").run();
      const ws = await dueWorkspace(1, () => next);
      if (until !== null) await rateLimit(ws, until);
      const expected = excusedReconcileDueAt(next, until);
      const { reconcileDueAt } = await readSweepBacklog(db, { now: NOW, maxAttempts: 10 });
      expect(reconcileDueAt).toBe(expected <= NOW ? expected : null);
    }
  });

  it("is scoped to the repository's own connection and workspace", async () => {
    const limited = await dueWorkspace(1, () => NOW - 20 * MINUTE);
    const other = await dueWorkspace(1, () => NOW - 30 * MINUTE);
    await rateLimit(limited, NOW + 30 * MINUTE);
    // Naming the limited connection's ID under the other workspace changes nothing there.
    await deferConnectionReconciles(db, {
      workspaceId: other.workspaceId,
      connectionId: limited.connection.id,
      until: NOW + 30 * MINUTE,
    });
    // One workspace's rate limit does not excuse another workspace's repository.
    expect((await readSweepBacklog(db, { now: NOW, maxAttempts: 10 })).reconcileDueAt).toBe(
      NOW - 30 * MINUTE,
    );
  });
});

describe("readSweepHealth and GitHub rate limits", () => {
  it("shows the alert's oldest late reconcile, and those waiting on a rate limit apart", async () => {
    const limited = await dueWorkspace(2, (i) => NOW - 50 * MINUTE + i);
    const stuck = await dueWorkspace(1, () => NOW - 3 * 60 * MINUTE);
    // Not rate-limited: due, and not counted as waiting.
    await dueWorkspace(1, () => NOW - 5 * MINUTE);
    await deferConnectionReconciles(db, {
      workspaceId: limited.workspaceId,
      connectionId: limited.connection.id,
      until: NOW + 5 * MINUTE,
    });
    await deferConnectionReconciles(db, {
      workspaceId: stuck.workspaceId,
      connectionId: stuck.connection.id,
      until: NOW + 60 * MINUTE,
    });
    const health = await readSweepHealth(db, NOW);
    const backlog = await readSweepBacklog(db, { now: NOW, maxAttempts: 10 });
    // The stuck connection's excuse ended two hours after its schedule.
    expect(health.oldestDueReconcileAt).toBe(NOW - 2 * 60 * MINUTE);
    expect(health.oldestDueReconcileAt).toBe(backlog.reconcileDueAt);
    expect(health.rateLimitedReconciles).toBe(3);

    // Once every limit resets, nothing waits; the limited ones are late from their reset.
    const later = await readSweepHealth(db, NOW + 60 * MINUTE);
    expect(later.rateLimitedReconciles).toBe(0);
    expect(later.oldestDueReconcileAt).toBe(NOW - 2 * 60 * MINUTE);
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

describe("recordSweepHeartbeat", () => {
  it("stores the latest tick, which the operator page reads as the last heartbeat", async () => {
    await recordSweepHeartbeat(db, NOW);
    expect((await readSweepHealth(db, NOW)).lastHeartbeatAt).toBe(NOW);
    await recordSweepHeartbeat(db, NOW + MINUTE);
    expect((await readSweepHealth(db, NOW + MINUTE)).lastHeartbeatAt).toBe(NOW + MINUTE);
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
