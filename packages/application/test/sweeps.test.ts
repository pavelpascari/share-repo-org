import { env } from "cloudflare:workers";
import { dailyOffsetMs } from "@sharerepo/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { checkSweepHealth, queueDailyResyncs } from "../src/index.ts";
import { shop } from "./support/commerce.ts";
import { clock, serviceContext } from "./support/context.ts";

// The sweep's health check and the daily resync's spreading (phase-6 plan, T2).

const MINUTE = 60_000;

/** Nothing due anywhere: storage is shared within the file, and these services span it all. */
async function settle() {
  await env.DB.batch([
    env.DB.prepare("UPDATE outbox SET sent_at = ? WHERE sent_at IS NULL").bind(clock.now()),
    env.DB.prepare("UPDATE resources SET next_reconcile_at = NULL"),
    env.DB.prepare("UPDATE subscriptions SET next_evaluation_at = NULL"),
    env.DB.prepare("DELETE FROM system_state"),
  ]);
}
beforeEach(settle);

const health = () => checkSweepHealth(serviceContext(), { maxAttempts: 10 });

describe("checkSweepHealth", () => {
  it("reports nothing due and raises nothing", async () => {
    await expect(health()).resolves.toEqual({
      evaluationDueAt: null,
      reconcileDueAt: null,
      outboxDueAt: null,
      lagMs: 0,
      lagging: false,
      alert: false,
    });
  });

  it("stores each tick's heartbeat for the operator page", async () => {
    const heartbeat = () =>
      env.DB.prepare(
        "SELECT updated_at AS at FROM system_state WHERE key = 'sweep.heartbeat'",
      ).first<{ at: number }>();
    await health();
    expect(await heartbeat()).toEqual({ at: clock.now() });
    clock.advance(MINUTE);
    await health();
    expect(await heartbeat()).toEqual({ at: clock.now() });
  });

  it("timing/sweep-lag-alerts: raises the alert once per 15 minutes while the oldest due row is late", async () => {
    const s = await shop();
    await settle();
    const dueAt = clock.now() - 16 * MINUTE;
    await env.DB.prepare("UPDATE resources SET next_reconcile_at = ? WHERE workspace_id = ?")
      .bind(dueAt, s.workspaceId)
      .run();
    await expect(health()).resolves.toEqual({
      evaluationDueAt: null,
      reconcileDueAt: dueAt,
      outboxDueAt: null,
      lagMs: 16 * MINUTE,
      lagging: true,
      alert: true,
    });
    await expect(health()).resolves.toMatchObject({ lagging: true, alert: false });
    clock.advance(15 * MINUTE);
    await expect(health()).resolves.toMatchObject({ lagMs: 31 * MINUTE, alert: true });

    // Late, but not more than 15 minutes: no alert.
    await env.DB.prepare("UPDATE resources SET next_reconcile_at = ? WHERE workspace_id = ?")
      .bind(clock.now() - 15 * MINUTE, s.workspaceId)
      .run();
    clock.advance(15 * MINUTE);
    await env.DB.prepare("UPDATE resources SET next_reconcile_at = ? WHERE workspace_id = ?")
      .bind(clock.now() - 15 * MINUTE, s.workspaceId)
      .run();
    await expect(health()).resolves.toMatchObject({
      lagMs: 15 * MINUTE,
      lagging: false,
      alert: false,
    });
  });
});

describe("queueDailyResyncs", () => {
  it("queues each active connection's resync once, at its own offset into the day", async () => {
    const s = await shop();
    await settle();
    const at = clock.now();
    expect(await queueDailyResyncs(serviceContext())).toBeGreaterThanOrEqual(1);
    const row = await env.DB.prepare(
      "SELECT available_at AS a, workspace_id AS w FROM outbox WHERE kind = 'resync_connection' AND subject_id = ? AND sent_at IS NULL",
    )
      .bind(s.connection.id)
      .first<{ a: number; w: string }>();
    expect(row).toEqual({
      a: at + dailyOffsetMs("resync_connection", s.connection.id),
      w: s.workspaceId,
    });
    // Still pending: not queued again.
    await queueDailyResyncs(serviceContext());
    const pending = await env.DB.prepare(
      "SELECT count(*) AS n FROM outbox WHERE kind = 'resync_connection' AND subject_id = ? AND sent_at IS NULL",
    )
      .bind(s.connection.id)
      .first<{ n: number }>();
    expect(pending?.n).toBe(1);
  });
});
