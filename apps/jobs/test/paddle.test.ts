import { env } from "cloudflare:workers";
import { encodeClaimRequestKey, encodePaddleConnectionKey } from "@sharerepo/application";
import { enqueueOutbox } from "@sharerepo/db";
import type { OutboxKind } from "@sharerepo/domain";
import { captureLogs, changedTables, type LogCapture, snapshotTables } from "@sharerepo/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRONS } from "../src/handlers.ts";
import worker from "../src/index.ts";
import { subscriptionVersion } from "./support/commerce.ts";
import { clock, count, db, envWithGitHub, PRODUCTION } from "./support/github.ts";
import {
  claimRequested,
  connectionOf,
  directPurchase,
  envWithMail,
  foreignClaimKey,
  type PaddleShop,
  paddleShop,
  paddleWorker,
  queued,
  received,
} from "./support/paddle.ts";
import { deliver, outboxRow, runCron, sentAt } from "./support/worker.ts";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});
const logged = () => logs.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
const retried = () => logged().filter((line) => line.msg === "job will be retried");

/** An outbox row for a job, as a service would queue it; returns the queue message. */
async function job(kind: OutboxKind, subjectId: string) {
  const outboxId = `row-${crypto.randomUUID()}`;
  await enqueueOutbox(db, {
    id: outboxId,
    kind,
    subjectId,
    createdAt: clock.now(),
    availableAt: clock.now(),
  });
  return { kind, subjectId, outboxId };
}

const connectionKey = (s: PaddleShop) =>
  encodePaddleConnectionKey({ workspaceId: s.workspaceId, connectionId: s.connectionId });
const refreshKey = (s: PaddleShop, subscriptionId: string) =>
  `${s.workspaceId}:paddle:${subscriptionId}`;

/** Delivers a signed `subscription.created` for the subscription and its processing job. */
async function webhookFor(s: PaddleShop, subscriptionId: string) {
  const destination = (await connectionOf(s)).destinationId as string;
  const delivery = await s.paddle.emitSubscriptionEvent(
    destination,
    "subscription.created",
    subscriptionId,
  );
  const { eventId, outboxId } = await received(s, delivery);
  return { kind: "process_external_event", subjectId: eventId, outboxId } as const;
}

/** A purchase through a shared link, stored by ShareRepo through the webhook and its refresh. */
async function storedPurchase(s: PaddleShop, email?: string) {
  const purchase = directPurchase(s, email);
  await deliver(paddleWorker(s), [await webhookFor(s, purchase.subscription.id)]);
  const subjectId = refreshKey(s, purchase.subscription.id);
  const [outboxId] = await queued("refresh_subscription", subjectId);
  await deliver(paddleWorker(s), [{ kind: "refresh_subscription", subjectId, outboxId }]);
  return purchase;
}

const paddleSource = async (s: PaddleShop, subscriptionId: string) =>
  env.DB.prepare(
    "SELECT source FROM subscriptions WHERE workspace_id = ? AND external_subscription_id = ?",
  )
    .bind(s.workspaceId, subscriptionId)
    .first<{ source: string }>();

describe("Paddle events and refreshes", () => {
  it("routes a Paddle event to Paddle processing, then refreshes from Paddle", async () => {
    const s = await paddleShop();
    const githubCalls = s.github.calls.length;
    const { subscription } = directPurchase(s);
    const message = await webhookFor(s, subscription.id);

    const processed = await deliver(paddleWorker(s), [message]);
    expect(processed.explicitAcks).toHaveLength(1);
    expect(await sentAt(message.outboxId)).toBe(clock.now());
    const subjectId = refreshKey(s, subscription.id);
    const [refreshId] = await queued("refresh_subscription", subjectId);
    expect(refreshId).toBeDefined();
    // Never treated as a GitHub event.
    expect(s.github.calls.length).toBe(githubCalls);

    const refresh = { kind: "refresh_subscription", subjectId, outboxId: refreshId };
    const refreshed = await deliver(paddleWorker(s), [refresh]);
    expect(refreshed.explicitAcks).toHaveLength(1);
    expect(await paddleSource(s, subscription.id)).toEqual({ source: "paddle" });
    expect(s.paddle.calls).toContain("getSubscription");
  });

  it("queue/redelivery-is-idempotent for Paddle events and refreshes", async () => {
    const s = await paddleShop();
    const { subscription } = directPurchase(s);
    const message = await webhookFor(s, subscription.id);
    await deliver(paddleWorker(s), [message, message]);
    const subjectId = refreshKey(s, subscription.id);
    const refreshes = await queued("refresh_subscription", subjectId);
    expect(refreshes).toHaveLength(1);
    const refresh = { kind: "refresh_subscription", subjectId, outboxId: refreshes[0] };
    await deliver(paddleWorker(s), [refresh, refresh]);
    const version = await subscriptionVersion(s, subscription.id);

    const before = await snapshotTables(env.DB);
    const again = await deliver(paddleWorker(s), [message, refresh]);
    expect(again.explicitAcks).toHaveLength(2);
    expect(changedTables(before, await snapshotTables(env.DB))).toEqual([]);
    expect(await subscriptionVersion(s, subscription.id)).toBe(version);
  });

  it("refreshes from Paddle in production too", async () => {
    const s = await paddleShop();
    const { subscription } = directPurchase(s);
    const refresh = await job("refresh_subscription", refreshKey(s, subscription.id));
    const result = await deliver(paddleWorker(s), [refresh], {
      bindings: { ...envWithGitHub, ...PRODUCTION } as Env,
    });
    expect(result.explicitAcks).toHaveLength(1);
    expect(await paddleSource(s, subscription.id)).toEqual({ source: "paddle" });
  });

  it("retries a Paddle outage with a growing delay, writing nothing", async () => {
    const s = await paddleShop();
    const { subscription } = directPurchase(s);
    const refresh = await job("refresh_subscription", refreshKey(s, subscription.id));
    s.paddle.failNext("getSubscription", "transient");
    const result = await deliver(paddleWorker(s), [refresh], { attempts: 2 });
    expect(result.retryMessages).toHaveLength(1);
    expect(retried()).toMatchObject([
      { delaySeconds: 60, errorName: "PaddleApiError", errorKind: "transient" },
    ]);
    expect(await sentAt(refresh.outboxId)).toBeNull();
    expect(await paddleSource(s, subscription.id)).toBeNull();
  });

  it("retries a Paddle rate limit after its Retry-After", async () => {
    const s = await paddleShop();
    const { subscription } = directPurchase(s);
    const refresh = await job("refresh_subscription", refreshKey(s, subscription.id));
    s.paddle.failNext("getSubscription", "rate_limited", { retryAfterMs: 90_500 });
    const result = await deliver(paddleWorker(s), [refresh]);
    expect(result.retryMessages).toHaveLength(1);
    expect(retried()).toMatchObject([{ delaySeconds: 91, errorKind: "rate_limited" }]);
  });

  it("fails a malformed Paddle answer once, with its classification", async () => {
    const s = await paddleShop();
    const { subscription } = directPurchase(s);
    const refresh = await job("refresh_subscription", refreshKey(s, subscription.id));
    s.paddle.failNext("getSubscription", "malformed");
    const result = await deliver(paddleWorker(s), [refresh]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(await outboxRow(refresh.outboxId)).toMatchObject({ last_error_code: "malformed" });
  });

  it("retries every Paddle job while commerce is not configured, without stopping the batch", async () => {
    const s = await paddleShop();
    const { CREDENTIAL_KEYS: _keys, CLAIM_SIGNING_KEY: _signing, ...unconfigured } = envWithGitHub;
    const messages = [
      await job("refresh_subscription", refreshKey(s, "sub_01")),
      await job("check_paddle_connection", connectionKey(s)),
      await job("sweep_paddle_subscriptions", connectionKey(s)),
      await job(
        "send_claim_email",
        encodeClaimRequestKey({ workspaceId: s.workspaceId, claimRequestId: "cr-1" }),
      ),
    ];
    const result = await deliver(paddleWorker(s), [...messages, "poison"], {
      bindings: unconfigured as Env,
    });
    expect(result.retryMessages).toHaveLength(4);
    expect(result.explicitAcks).toHaveLength(1);
    expect(retried().map((line) => line.errorCode)).toEqual(Array(4).fill("source_unavailable"));
    expect(s.paddle.calls).not.toContain("getSubscription");
  });
});

describe("check_paddle_connection", () => {
  it("marks a refused key unauthorized, once", async () => {
    const s = await paddleShop();
    s.paddle.revokeKey();
    const check = await job("check_paddle_connection", connectionKey(s));
    const result = await deliver(paddleWorker(s), [check, check]);
    expect(result.explicitAcks).toHaveLength(2);
    expect((await connectionOf(s)).status).toBe("unauthorized");
    const changes = () =>
      count(
        "SELECT count(*) AS n FROM audit_events WHERE action = 'paddle.status_changed' AND target_id = ?",
        s.connectionId,
      );
    expect(await changes()).toBe(1);
    await deliver(paddleWorker(s), [check]);
    expect(await changes()).toBe(1);

    s.paddle.restoreKey();
    await deliver(paddleWorker(s), [await job("check_paddle_connection", connectionKey(s))]);
    expect((await connectionOf(s)).status).toBe("active");
  });

  it("retries when Paddle is unavailable, leaving the status as it was", async () => {
    const s = await paddleShop();
    s.paddle.failNext("getApiRoot", "transient");
    const check = await job("check_paddle_connection", connectionKey(s));
    const result = await deliver(paddleWorker(s), [check]);
    expect(result.retryMessages).toHaveLength(1);
    expect((await connectionOf(s)).status).toBe("active");
  });
});

describe("sweep_paddle_subscriptions", () => {
  it("queues a refresh for each subscription ShareRepo missed, once", async () => {
    const s = await paddleShop();
    const stored = await storedPurchase(s);
    const missed = [directPurchase(s), directPurchase(s)];
    const sweep = await job("sweep_paddle_subscriptions", connectionKey(s));
    const result = await deliver(paddleWorker(s), [sweep, sweep]);
    expect(result.explicitAcks).toHaveLength(2);
    for (const { subscription } of missed) {
      expect(await queued("refresh_subscription", refreshKey(s, subscription.id))).toHaveLength(1);
    }
    expect(
      await queued("refresh_subscription", refreshKey(s, stored.subscription.id)),
    ).toHaveLength(0);
  });

  it("does nothing for a connection that is no longer active", async () => {
    const s = await paddleShop();
    s.paddle.revokeKey();
    await deliver(paddleWorker(s), [await job("check_paddle_connection", connectionKey(s))]);
    const calls = s.paddle.calls.length;
    const result = await deliver(paddleWorker(s), [
      await job("sweep_paddle_subscriptions", connectionKey(s)),
    ]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(s.paddle.calls.length).toBe(calls);
  });

  it("warns when the sweep stopped at Paddle's page limit", async () => {
    const s = await paddleShop();
    const listSubscriptions = s.paddle.listSubscriptions.bind(s.paddle);
    const truncated = {
      ...s,
      accounts: {
        resolve: () => ({
          ...s.paddle,
          listSubscriptions: async () => ({ ...(await listSubscriptions()), truncated: true }),
        }),
      },
    } as unknown as PaddleShop;
    const sweep = await job("sweep_paddle_subscriptions", connectionKey(s));
    const result = await deliver(paddleWorker(truncated), [sweep]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(logged().map((line) => line.msg)).toContain("job covered only part of its subject");
  });

  it("runs in the outbox drain, whose next run does the refreshes it queued", async () => {
    const s = await paddleShop();
    const { subscription } = directPurchase(s);
    const sweep = await job("sweep_paddle_subscriptions", connectionKey(s));
    await runCron(paddleWorker(s), CRONS.drainOutbox);
    expect(await sentAt(sweep.outboxId)).toBe(clock.now());
    await runCron(paddleWorker(s), CRONS.drainOutbox);
    expect(await paddleSource(s, subscription.id)).toEqual({ source: "paddle" });
  });
});

describe("send_claim_email", () => {
  it("emails a claim link to the address Paddle holds, once, logging no email or token", async () => {
    const s = await paddleShop();
    const email = `claimant-${crypto.randomUUID()}@example.com`;
    await storedPurchase(s, email);
    const send = await claimRequested(s, email);
    const message = { kind: "send_claim_email", ...send };

    const result = await deliver(paddleWorker(s), [message, message], { bindings: envWithMail });
    expect(result.explicitAcks).toHaveLength(2);
    expect(s.mail.sent.map((sent) => sent.to)).toEqual([email]);
    const link = s.mail.sent[0]?.text.match(/(\S+\/claim\/[A-Za-z0-9_-]+)/)?.[1] as string;
    expect(link.startsWith(`${env.PUBLIC_BASE_URL}/claim/`)).toBe(true);

    await deliver(paddleWorker(s), [message], { bindings: envWithMail });
    expect(s.mail.sent).toHaveLength(1);
    const text = logs.text();
    for (const secret of [email, link, link.split("/claim/")[1] as string, s.key]) {
      expect(text).not.toContain(secret);
    }
  });

  it("finishes without sending when no mail transport is configured", async () => {
    const s = await paddleShop();
    const email = `claimant-${crypto.randomUUID()}@example.com`;
    await storedPurchase(s, email);
    const send = await claimRequested(s, email);
    const result = await deliver(paddleWorker(s), [{ kind: "send_claim_email", ...send }]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(s.mail.sent).toEqual([]);
    expect(
      await count(
        "SELECT count(*) AS n FROM claim_requests WHERE workspace_id = ? AND processed_at IS NOT NULL AND email_envelope IS NULL",
        s.workspaceId,
      ),
    ).toBe(1);
  });
});

describe("Paddle job scope", () => {
  it("isolation/job-without-workspace-scope-rejected", async () => {
    const a = await paddleShop();
    const b = await paddleShop();
    const email = `claimant-${crypto.randomUUID()}@example.com`;
    await storedPurchase(a, email);
    directPurchase(a);
    const send = await claimRequested(a, email);
    // Each key names workspace B with A's connection or claim request.
    const foreign = encodePaddleConnectionKey({
      workspaceId: b.workspaceId,
      connectionId: a.connectionId,
    });
    a.paddle.revokeKey();
    const calls = [a.paddle.calls.length, b.paddle.calls.length];
    const before = await snapshotTables(env.DB);

    const result = await deliver(
      paddleWorker(a),
      [
        await job("check_paddle_connection", foreign),
        await job("sweep_paddle_subscriptions", foreign),
        await job("send_claim_email", foreignClaimKey(send.subjectId, b.workspaceId)),
      ],
      { bindings: envWithMail },
    );
    expect(result.explicitAcks).toHaveLength(3);
    expect(changedTables(before, await snapshotTables(env.DB))).toEqual([]);
    expect([a.paddle.calls.length, b.paddle.calls.length]).toEqual(calls);
    expect(a.mail.sent).toEqual([]);
    expect(logged().filter((line) => line.msg === "job has no workspace scope")).toHaveLength(1);
    expect((await connectionOf(a)).status).toBe("active");
  });

  it.each(["send_claim_email", "check_paddle_connection", "sweep_paddle_subscriptions"] as const)(
    "rejects a %s key that does not decode, once",
    async (kind) => {
      const message = await job(kind, "not-a-key");
      const result = await deliver(paddleWorker(await paddleShop()), [message]);
      expect(result.explicitAcks).toHaveLength(1);
      expect(await outboxRow(message.outboxId)).toMatchObject({ last_error_code: "key_invalid" });
      expect(logs.text()).not.toContain("not-a-key");
    },
  );
});

describe("the daily cron", () => {
  it("queues one Paddle sweep per active connection", async () => {
    const s = await paddleShop();
    await runCron(paddleWorker(s), CRONS.dailyResync);
    await runCron(paddleWorker(s), CRONS.dailyResync);
    expect(await queued("sweep_paddle_subscriptions", connectionKey(s))).toHaveLength(1);
    expect(logged().map((line) => line.msg)).toContain("paddle sweeps queued");
  });

  it("logs a failure to queue sweeps by classification and still queues the resyncs", async () => {
    const s = await paddleShop();
    const failing = {
      ...envWithGitHub,
      DB: new Proxy(env.DB, {
        get(target, property) {
          if (property === "prepare") {
            return (query: string) => {
              if (query.includes("paddle_connections")) throw new Error("paddle_connections down");
              return target.prepare(query);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as Env;
    await runCron(paddleWorker(s), CRONS.dailyResync, failing);
    expect(logged()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ msg: "paddle sweep queueing failed", errorName: "Error" }),
        expect.objectContaining({ msg: "daily resync queued" }),
      ]),
    );
    expect(logs.text()).not.toContain("paddle_connections down");
  });
});

describe("the default export", () => {
  it("builds the real Paddle client and mail port from the env", async () => {
    const s = await paddleShop();
    // Paddle's sandbox answers 503, without touching the network: a transient failure.
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("unavailable", { status: 503 }));
    try {
      const check = await job("check_paddle_connection", connectionKey(s));
      const result = await deliver(worker, [check], { bindings: envWithMail });
      expect(result.retryMessages).toHaveLength(1);
      expect(retried()).toMatchObject([{ errorName: "PaddleApiError", errorKind: "transient" }]);
      expect(String(fetch.mock.calls[0]?.[0])).toBe("https://sandbox-api.paddle.com/");
      expect(logs.text()).not.toContain(s.key);
    } finally {
      fetch.mockRestore();
    }
  });
});
