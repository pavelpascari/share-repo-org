import { env } from "cloudflare:workers";
import { resyncConnection } from "@sharerepo/application";
import { GitHubApiError } from "@sharerepo/integrations";
import { createFakeGitHubApp, type FakeGitHubApp } from "@sharerepo/integrations/testing";
import { captureLogs, changedTables, type LogCapture, snapshotTables } from "@sharerepo/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CRONS } from "../src/handlers.ts";
import {
  act,
  DAY,
  entitlementsOf,
  refreshKey,
  type Shop,
  shop,
  subscribe,
} from "./support/commerce.ts";
import { clock, count, envWithGitHub, serviceContext } from "./support/github.ts";
import { jobsWorker, runCron } from "./support/worker.ts";

// The per-minute sweep's replay safety, health line and partitioning, and the daily jobs'
// spreading, at the cron entry point (phase-6 plan, T2).

const MINUTE = 60_000;
/** Each test drives several cron ticks through the Worker; slow under a loaded machine. */
const ENTRY_POINT_TIMEOUT = 30_000;

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});
const logged = () => logs.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
const heartbeats = () => logged().filter((line) => line.msg === "sweep.heartbeat");
const alerts = () => logged().filter((line) => line.alert === "sweep_lagging");

const tick = (s: Shop, bindings: Env = envWithGitHub) =>
  runCron(jobsWorker(s.github), CRONS.drainOutbox, bindings);

/** The test DB, failing the first statement whose SQL contains each fragment, once each. */
function failing(...fragments: string[]): D1Database {
  const left = new Set(fragments);
  return new Proxy(env.DB, {
    get: (target, property, receiver) => {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const fragment = [...left].find((f) => String(args[0]).includes(f));
        if (property === "prepare" && fragment !== undefined) {
          left.delete(fragment);
          throw new Error("d1 unavailable (test)");
        }
        return value.apply(target, args);
      };
    },
  });
}

describe("sweep replay", () => {
  it(
    "timing/sweep-replay-is-idempotent: the same tick, run twice at once and again, changes nothing more",
    async () => {
      const s = await shop(createFakeGitHubApp({ clock }), { gracePeriodDays: 7 });
      const sub = await subscribe(s);
      await tick(s);
      const pastDue = await act(s, sub.id, "mark_past_due");
      await tick(s);
      const since = pastDue.subscription.pastDueSince as number;

      // The boundary's tick, delivered twice at once (the same scheduled time).
      clock.set(since + 7 * DAY + 30_000);
      await Promise.all([tick(s), tick(s)]);
      expect(await entitlementsOf(s)).toMatchObject([
        { state: "expired", decisionReason: "grace_expired" },
      ]);
      const ended = () =>
        count(
          "SELECT count(*) AS n FROM audit_events WHERE action = 'entitlement.ended' AND workspace_id = ?",
          s.workspaceId,
        );
      expect(await ended()).toBe(1);
      expect(
        await count(
          "SELECT count(*) AS n FROM outbox WHERE kind = 'refresh_subscription' AND subject_id = ? AND created_at = ?",
          refreshKey(s, sub.id),
          String(clock.now()),
        ),
      ).toBe(1);

      // Its follow-up work runs: the reconcile the refresh queued, then the check of a request
      // stamped at the run's own instant.
      await tick(s);
      clock.advance(1_000);
      await tick(s);
      // Replayed once more, a little later as a redelivered event would be: nothing changes but
      // the tick's own heartbeat.
      clock.advance(1_000);
      const before = await snapshotTables(env.DB, {});
      const calls = s.github.calls.length;
      await tick(s);
      expect(changedTables(before, await snapshotTables(env.DB, {}))).toEqual(["system_state"]);
      expect(s.github.calls.length).toBe(calls);
      expect(await ended()).toBe(1);
      // Every run still reports its health.
      expect(heartbeats().length).toBeGreaterThanOrEqual(4);
    },
    ENTRY_POINT_TIMEOUT,
  );
});

describe("sweep health", () => {
  it(
    "logs a heartbeat with what each tick claimed and what is still due",
    async () => {
      const s = await shop(createFakeGitHubApp({ clock }));
      await subscribe(s);
      await tick(s);
      // Storage is shared within the file, so other tests' work may be claimed too.
      const [line] = heartbeats();
      expect(line).toMatchObject({
        level: "info",
        evaluationsQueued: expect.any(Number),
        reconcilesQueued: expect.any(Number),
        oldestEvaluationDueAt: null,
        oldestReconcileDueAt: null,
        // The reconcile the refresh queued is due now, for the next tick: no lag.
        oldestOutboxDueAt: clock.now(),
        lagMs: 0,
      });
      // The subscriber's refresh was claimed and sent.
      expect(line?.outboxClaimed).toBeGreaterThanOrEqual(1);
      expect(line?.outboxSent).toBeGreaterThanOrEqual(1);
      expect(heartbeats()).toHaveLength(1);
      expect(alerts()).toEqual([]);
    },
    ENTRY_POINT_TIMEOUT,
  );

  it(
    "still logs the heartbeat when the drain fails, and survives a failing health check",
    async () => {
      const s = await shop(createFakeGitHubApp({ clock }));
      await subscribe(s);
      // The drain's claim fails: the tick fails, after logging what it claimed.
      const drainDown = { ...envWithGitHub, DB: failing('"attempts" + 1') } as Env;
      await expect(tick(s, drainDown)).rejects.toThrow("d1 unavailable (test)");
      expect(heartbeats().at(-1)).toMatchObject({ outboxClaimed: null, outboxSent: null });
      // The health check's own read fails: classified, no heartbeat, the tick still completes.
      const before = heartbeats().length;
      const healthDown = { ...envWithGitHub, DB: failing("min(") } as Env;
      await tick(s, healthDown);
      expect(heartbeats()).toHaveLength(before);
      expect(logged().at(-1)).toMatchObject({
        level: "error",
        msg: "sweep health check failed",
        errorName: "Error",
      });
      expect(logs.text()).not.toContain("d1 unavailable");
    },
    ENTRY_POINT_TIMEOUT,
  );

  it(
    "timing/sweep-lag-alerts: alerts once per 15 minutes while the oldest due row is more than 15 minutes late",
    async () => {
      const s = await shop(createFakeGitHubApp({ clock }));
      const sub = await subscribe(s);
      await tick(s);
      // A boundary passed 20 minutes ago, and the evaluation sweep keeps failing (a D1 outage).
      const dueAt = clock.now() - 20 * MINUTE;
      await env.DB.prepare(
        "UPDATE subscriptions SET next_evaluation_at = ? WHERE workspace_id = ? AND external_subscription_id = ?",
      )
        .bind(dueAt, s.workspaceId, sub.id)
        .run();
      const broken = () =>
        ({ ...envWithGitHub, DB: failing('"next_evaluation_at" is not null') }) as Env;

      await tick(s, broken());
      expect(heartbeats().at(-1)).toMatchObject({
        evaluationsQueued: null,
        oldestEvaluationDueAt: dueAt,
        lagMs: 20 * MINUTE,
      });
      expect(alerts()).toEqual([
        expect.objectContaining({
          level: "warn",
          msg: "alert: sweep_lagging",
          alert: "sweep_lagging",
          oldestEvaluationDueAt: dueAt,
          lagMs: 20 * MINUTE,
        }),
      ]);

      // Still lagging: the same tick replayed, and the next 14 minutes, do not alert again.
      await tick(s, broken());
      clock.advance(14 * MINUTE);
      await tick(s, broken());
      expect(alerts()).toHaveLength(1);
      // 15 minutes after the alert it is raised again.
      clock.advance(MINUTE);
      await tick(s, broken());
      expect(alerts()).toHaveLength(2);
      expect(alerts().at(-1)).toMatchObject({ lagMs: 35 * MINUTE });

      // The sweep recovers: the backlog drains and the lag is gone.
      clock.advance(MINUTE);
      await tick(s);
      expect(heartbeats().at(-1)).toMatchObject({ evaluationsQueued: 1, lagMs: 0 });
      expect(alerts()).toHaveLength(2);
      // The alert line names instants and counts only.
      for (const line of alerts()) {
        expect(Object.keys(line).sort()).toEqual(
          [
            "alert",
            "correlationId",
            "cron",
            "lagMs",
            "level",
            "msg",
            "oldestEvaluationDueAt",
            "oldestOutboxDueAt",
            "oldestReconcileDueAt",
            "ts",
            "worker",
          ].sort(),
        );
      }
    },
    ENTRY_POINT_TIMEOUT,
  );
});

describe("partitioned reconciliation", () => {
  /** A shop whose installation has `extra` more repositories, all synced and sold. */
  async function largeShop(fake: FakeGitHubApp, extra: number) {
    const s = await shop(fake);
    const [own] = await s.github.listInstallationRepositories(s.installationId);
    if (own === undefined) throw new Error("no repository");
    s.github.setRepositories(s.installationId, [
      own,
      ...Array.from({ length: extra }, (_, i) => ({
        ...own,
        externalId: `${own.externalId}${i}`,
        name: `${own.name}-${i}`,
      })),
    ]);
    await resyncConnection(serviceContext(), s.connection, s.github, "test setup");
    return s;
  }

  /** Makes every repository of the workspace due `ago` before now, with no work pending. */
  async function allDue(s: Shop, ago = MINUTE) {
    await env.DB.prepare(
      "UPDATE resources SET next_reconcile_at = ?, reconcile_lease_until = NULL WHERE workspace_id = ?",
    )
      .bind(clock.now() - ago, s.workspaceId)
      .run();
    await env.DB.prepare("UPDATE outbox SET sent_at = ? WHERE sent_at IS NULL")
      .bind(clock.now())
      .run();
  }

  const queuedSince = (s: Shop, since: number) =>
    count(
      "SELECT count(*) AS n FROM outbox WHERE kind = 'reconcile_resource' AND subject_id LIKE ? AND created_at >= ?",
      `${s.workspaceId}:%`,
      String(since),
    );

  it(
    "partition/one-installation-cannot-starve-others: a tick queues at most 10 repositories per installation",
    async () => {
      // One GitHub App, two installations: one with 15 repositories, one with one.
      const fake = createFakeGitHubApp({ clock });
      const large = await largeShop(fake, 14);
      const small = await shop(fake);
      clock.advance(MINUTE);
      // The large installation's repositories are all older than the small one's.
      await allDue(large, 2 * MINUTE);
      await allDue(small);

      const first = clock.now();
      await tick(large);
      expect(await queuedSince(large, first)).toBe(10);
      expect(await queuedSince(small, first)).toBe(1);

      // The next tick takes the large installation's other five.
      clock.advance(MINUTE);
      const second = clock.now();
      await tick(large);
      expect(await queuedSince(large, second)).toBe(5);
      expect(await queuedSince(small, second)).toBe(0);
    },
    ENTRY_POINT_TIMEOUT,
  );

  it(
    "timing/sweep-lag-excuses-rate-limits: defers an installation GitHub rate-limited until its reset, without a lag alert after it",
    async () => {
      const fake = createFakeGitHubApp({ clock });
      const limited = await largeShop(fake, 14);
      const other = await shop(fake);
      clock.advance(MINUTE);
      // The limited installation's repositories run first, and the first observation is refused.
      await allDue(limited, 2 * MINUTE);
      await allDue(other);
      fake.failNext(
        "listInvitations",
        new GitHubApiError("rate_limited", "rate limited (test)", { retryAfterMs: 30 * MINUTE }),
      );
      const at = clock.now();
      await tick(limited);
      const until = await env.DB.prepare(
        "SELECT rate_limited_until AS u FROM connections WHERE id = ?",
      )
        .bind(limited.connection.id)
        .first<{ u: number }>();
      expect(until?.u).toBe(at + 30 * MINUTE);

      // Its other repositories wait for the reset; the other installation does not.
      await allDue(limited);
      await allDue(other);
      clock.advance(MINUTE);
      const waiting = clock.now();
      await tick(limited);
      expect(await queuedSince(limited, waiting)).toBe(0);
      expect(await queuedSince(other, waiting)).toBe(1);
      // A rate-limited installation's repositories are not lag.
      expect(heartbeats().at(-1)).toMatchObject({ oldestReconcileDueAt: null });

      // At the reset the sweep takes ten. The other five, due half an hour ago, are late from
      // the reset, not from their schedule: no sweep_lagging while the sweep works through them.
      clock.set(at + 30 * MINUTE);
      const reset = clock.now();
      await tick(limited);
      expect(await queuedSince(limited, reset)).toBe(10);
      expect(heartbeats().at(-1)).toMatchObject({ oldestReconcileDueAt: reset, lagMs: 0 });
      clock.advance(MINUTE);
      await tick(limited);
      expect(await queuedSince(limited, reset)).toBe(15);
      expect(alerts()).toEqual([]);
    },
    ENTRY_POINT_TIMEOUT,
  );
});

describe("daily jobs", () => {
  it(
    "spreads each connection's daily resync over the day",
    async () => {
      const s = await shop(createFakeGitHubApp({ clock }));
      const at = clock.now();
      await runCron(jobsWorker(s.github), CRONS.dailyResync);
      const row = await env.DB.prepare(
        "SELECT available_at AS a FROM outbox WHERE kind = 'resync_connection' AND subject_id = ? AND created_at = ?",
      )
        .bind(s.connection.id, at)
        .first<{ a: number }>();
      const offset = (row?.a as number) - at;
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(DAY);
      // Queued once: the next day's run finds it still pending only if it never ran.
      await runCron(jobsWorker(s.github), CRONS.dailyResync);
      expect(
        await count(
          "SELECT count(*) AS n FROM outbox WHERE kind = 'resync_connection' AND subject_id = ? AND sent_at IS NULL",
          s.connection.id,
        ),
      ).toBe(1);
      expect(
        logged()
          .filter((line) => line.msg === "daily resync queued")
          .at(-1),
      ).toMatchObject({
        queued: 0,
      });
    },
    ENTRY_POINT_TIMEOUT,
  );
});
