import { env } from "cloudflare:workers";
import {
  archiveOffer,
  type EntitlementSourcePort,
  simulatedEntitlementSource,
} from "@sharerepo/application";
import { type Db, enqueueOutbox } from "@sharerepo/db";
import { createFakeGitHubApp } from "@sharerepo/integrations/testing";
import { captureLogs, changedTables, type LogCapture, snapshotTables } from "@sharerepo/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CRONS } from "../src/handlers.ts";
import {
  act,
  DAY,
  entitlementsOf,
  recomputeOutboxId,
  refreshKey,
  type Shop,
  shop,
  subscribe,
  subscriptionVersion,
} from "./support/commerce.ts";
import { clock, count, db, envWithGitHub, serviceContext } from "./support/github.ts";
import { deliver, jobsWorker, outboxRow, runCron, sentAt } from "./support/worker.ts";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});
const logged = () => logs.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
const live = (rows: readonly { state: string }[]) => rows.filter((row) => row.state === "active");
const refresh = (s: Shop, id: string, outboxId: string) => ({
  kind: "refresh_subscription",
  subjectId: refreshKey(s, id),
  outboxId,
});

/**
 * The simulated source, with a concurrent writer that bumps the stored subscription's version
 * after every read, so each refresh attempt's conditional write is stale.
 */
const contendedSource =
  (s: Shop, id: string) =>
  (database: Db): EntitlementSourcePort => {
    const real = simulatedEntitlementSource(database);
    return {
      source: "simulated",
      async refreshSubscription(ref) {
        await env.DB.prepare(
          "UPDATE subscriptions SET version = version + 1 WHERE workspace_id = ? AND external_subscription_id = ?",
        )
          .bind(s.workspaceId, id)
          .run();
        return real.refreshSubscription(ref);
      },
    };
  };

async function queuedRow(subjectId: string, kind: "refresh_subscription" | "recompute_offer") {
  const id = `row-${crypto.randomUUID()}`;
  await enqueueOutbox(db, {
    id,
    kind,
    subjectId,
    createdAt: clock.now(),
    availableAt: clock.now(),
  });
  return id;
}

describe("refresh_subscription and recompute_offer on the queue", () => {
  it("queue/redelivery-is-idempotent for a subscription refresh", async () => {
    const s = await shop(createFakeGitHubApp());
    const sub = await subscribe(s);
    const message = refresh(s, sub.id, sub.outboxId);

    // At-least-once delivery: the same refresh twice in one batch, then once more.
    const result = await deliver(jobsWorker(s.github), [message, message]);
    const before = await snapshotTables(env.DB);
    const again = await deliver(jobsWorker(s.github), [message]);

    expect(result.explicitAcks).toHaveLength(2);
    expect(again.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toEqual([]);
    expect(changedTables(before, await snapshotTables(env.DB))).toEqual([]);
    expect(live(await entitlementsOf(s))).toHaveLength(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_events WHERE action = 'entitlement.created' AND workspace_id = ?",
        s.workspaceId,
      ),
    ).toBe(1);
    expect(await sentAt(sub.outboxId)).toBe(clock.now());
  });

  it("retries a refresh whose write kept going stale, which then succeeds", async () => {
    const s = await shop(createFakeGitHubApp());
    const sub = await subscribe(s);
    await deliver(jobsWorker(s.github), [refresh(s, sub.id, sub.outboxId)]);
    const renewed = await act(s, sub.id, "renew");
    const version = await subscriptionVersion(s, sub.id);
    const message = refresh(s, sub.id, renewed.outboxId);

    const contended = jobsWorker(s.github, { simulatedSource: contendedSource(s, sub.id) });
    const result = await deliver(contended, [message]);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toHaveLength(1);
    expect(logged().find((line) => line.msg === "job will be retried")).toMatchObject({
      delaySeconds: 30,
      errorName: "ConflictError",
    });
    expect(await outboxRow(renewed.outboxId)).toMatchObject({ sent_at: null, failed_at: null });

    // Three stale attempts, each a version bump by the concurrent writer and no write of its own.
    expect(await subscriptionVersion(s, sub.id)).toBe((version as number) + 3);
    const retriedOk = await deliver(jobsWorker(s.github), [message], { attempts: 2 });
    expect(retriedOk.explicitAcks).toHaveLength(1);
    expect(await subscriptionVersion(s, sub.id)).toBe((version as number) + 4);
    expect(await sentAt(renewed.outboxId)).toBe(clock.now());
  });

  it("recomputes an offer, queuing a refresh the drain then runs", async () => {
    const s = await shop(createFakeGitHubApp());
    const sub = await subscribe(s);
    await deliver(jobsWorker(s.github), [refresh(s, sub.id, sub.outboxId)]);
    const archived = await archiveOffer(serviceContext(), s, s.slug, s.offerId);
    expect(archived.ok).toBe(true);
    const outboxId = await recomputeOutboxId(s);

    const result = await deliver(jobsWorker(s.github), [
      { kind: "recompute_offer", subjectId: `${s.workspaceId}:${s.offerId}`, outboxId },
    ]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(await sentAt(outboxId)).toBe(clock.now());
    expect(
      await count(
        "SELECT count(*) AS n FROM outbox WHERE kind = 'refresh_subscription' AND subject_id = ? AND sent_at IS NULL",
        refreshKey(s, sub.id),
      ),
    ).toBe(1);

    await runCron(jobsWorker(s.github), CRONS.drainOutbox);
    expect(await entitlementsOf(s)).toMatchObject([
      { state: "revoked", decisionReason: "offer_archived" },
    ]);
  });

  // A key that does not decode names no workspace, so the job has nothing it may act on. It is
  // final at once: retrying cannot make the key valid.
  it.each([
    ["refresh_subscription", ":simulated:sub-1"],
    ["refresh_subscription", "simulated:sub-1"],
    ["recompute_offer", "offer-1"],
    ["recompute_offer", ":offer-1"],
  ])("isolation/job-without-workspace-scope-rejected (%s %s)", async (kind, subjectId) => {
    const github = createFakeGitHubApp();
    const outboxId = await queuedRow(subjectId, kind as "refresh_subscription");
    const before = await snapshotTables(env.DB);
    const result = await deliver(jobsWorker(github), [{ kind, subjectId, outboxId }]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toEqual([]);
    expect(changedTables(before, await snapshotTables(env.DB))).toEqual([]);
    expect(await outboxRow(outboxId)).toMatchObject({
      sent_at: null,
      last_error_code: "key_invalid",
    });
    expect(github.calls).toEqual([]);
    expect(logged().at(-1)).toMatchObject({
      level: "error",
      msg: "job failed",
      errorName: "JobRejectedError",
      errorCode: "key_invalid",
    });
  });

  it("refuses a simulated refresh in production, permanently", async () => {
    const s = await shop(createFakeGitHubApp());
    const sub = await subscribe(s);
    const production = { ...envWithGitHub, ENVIRONMENT: "production" } as Env;
    const result = await deliver(jobsWorker(s.github), [refresh(s, sub.id, sub.outboxId)], {
      bindings: production,
    });
    expect(result.explicitAcks).toHaveLength(1);
    expect(await outboxRow(sub.outboxId)).toMatchObject({
      sent_at: null,
      last_error_code: "source_unavailable",
    });
    expect(await subscriptionVersion(s, sub.id)).toBeUndefined();
    expect(await entitlementsOf(s)).toEqual([]);
  });

  it("refuses a Paddle refresh until Paddle is integrated", async () => {
    const s = await shop(createFakeGitHubApp());
    const subjectId = `${s.workspaceId}:paddle:sub_01`;
    const outboxId = await queuedRow(subjectId, "refresh_subscription");
    const result = await deliver(jobsWorker(s.github), [
      { kind: "refresh_subscription", subjectId, outboxId },
    ]);
    expect(result.explicitAcks).toHaveLength(1);
    expect((await outboxRow(outboxId))?.last_error_code).toBe("source_unavailable");
  });
});

describe("refresh_subscription and recompute_offer in the outbox drain", () => {
  it("marks an invalid key failed at once, logging only its classification", async () => {
    const github = createFakeGitHubApp();
    const subjectId = "not-a-key-secret-looking-value";
    const outboxId = await queuedRow(subjectId, "refresh_subscription");
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    expect(await outboxRow(outboxId)).toMatchObject({
      sent_at: null,
      last_error_code: "key_invalid",
    });
    expect(logged().find((line) => line.outboxId === outboxId)).toMatchObject({
      msg: "outbox job failed",
      kind: "refresh_subscription",
      final: true,
      errorCode: "key_invalid",
    });
    expect(logs.text()).not.toContain(subjectId);
    // Never claimed again.
    clock.advance(10 * 60_000);
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    expect(logged().filter((line) => line.outboxId === outboxId)).toHaveLength(1);
  });

  it("leaves a stale refresh leased for a later attempt", async () => {
    const s = await shop(createFakeGitHubApp());
    const sub = await subscribe(s);
    await runCron(jobsWorker(s.github), CRONS.drainOutbox);
    const renewed = await act(s, sub.id, "renew");
    await runCron(
      jobsWorker(s.github, { simulatedSource: contendedSource(s, sub.id) }),
      CRONS.drainOutbox,
    );
    expect(await outboxRow(renewed.outboxId)).toMatchObject({ sent_at: null, failed_at: null });
    expect(logged().find((line) => line.outboxId === renewed.outboxId)).toMatchObject({
      final: false,
      errorName: "ConflictError",
    });
    // Once the lease expires, the next drain completes it.
    clock.advance(2 * 60_000);
    await runCron(jobsWorker(s.github), CRONS.drainOutbox);
    expect(await sentAt(renewed.outboxId)).toBe(clock.now());
  });
});

describe("an offer with many subscriptions", () => {
  // Over a hundred subscribers set up one by one, which is slow under coverage.
  const SLOW_TIMEOUT = 60_000;

  it(
    "archives and revokes every subscription's entitlement, beyond one batch and 100 rows",
    async () => {
      const s = await shop(createFakeGitHubApp());
      const subscriptions = 105;
      for (let i = 0; i < subscriptions; i += 1) await subscribe(s);
      // One tick records them all: the drain keeps claiming while batches come back full.
      await runCron(jobsWorker(s.github), CRONS.drainOutbox);
      expect(live(await entitlementsOf(s))).toHaveLength(subscriptions);

      const archived = await archiveOffer(serviceContext(), s, s.slug, s.offerId);
      expect(archived.ok).toBe(true);
      // The recompute queues one refresh per subscription; the next tick runs them all.
      await runCron(jobsWorker(s.github), CRONS.drainOutbox);
      await runCron(jobsWorker(s.github), CRONS.drainOutbox);
      const rows = await entitlementsOf(s);
      expect(rows).toHaveLength(subscriptions);
      expect(
        rows.every((e) => e.state === "revoked" && e.decisionReason === "offer_archived"),
      ).toBe(true);
    },
    SLOW_TIMEOUT,
  );
});

describe("the per-minute due-evaluation sweep", () => {
  it("queues and runs a past-due subscription's grace expiry in the same tick", async () => {
    const s = await shop(createFakeGitHubApp(), { gracePeriodDays: 7 });
    const sub = await subscribe(s);
    await runCron(jobsWorker(s.github), CRONS.drainOutbox);
    const pastDue = await act(s, sub.id, "mark_past_due");
    await runCron(jobsWorker(s.github), CRONS.drainOutbox);
    const since = pastDue.subscription.pastDueSince as number;
    expect(live(await entitlementsOf(s))).toMatchObject([
      { validUntil: since + 7 * DAY, decisionReason: "past_due_in_grace" },
    ]);

    // Nothing is due before the grace period ends.
    clock.advance(DAY);
    await runCron(jobsWorker(s.github), CRONS.drainOutbox);
    expect(
      logged()
        .filter((line) => line.msg === "due evaluations queued")
        .at(-1),
    ).toMatchObject({ queued: 0 });
    expect(live(await entitlementsOf(s))).toHaveLength(1);

    clock.advance(6 * DAY + 60_000);
    await runCron(jobsWorker(s.github), CRONS.drainOutbox);
    expect(
      logged()
        .filter((line) => line.msg === "due evaluations queued")
        .at(-1),
    ).toMatchObject({ queued: 1 });
    expect(await entitlementsOf(s)).toMatchObject([{ state: "expired" }]);
    expect(
      await count(
        "SELECT count(*) AS n FROM outbox WHERE kind = 'refresh_subscription' AND subject_id = ? AND sent_at IS NULL",
        refreshKey(s, sub.id),
      ),
    ).toBe(0);
  });

  it("repairs, on a later sweep, an expiry whose refresh failed for good", async () => {
    const s = await shop(createFakeGitHubApp());
    const sub = await subscribe(s);
    await runCron(jobsWorker(s.github), CRONS.drainOutbox);
    const scheduled = await act(s, sub.id, "cancel_at_period_end");
    await runCron(jobsWorker(s.github), CRONS.drainOutbox);
    const effective = scheduled.subscription.cancelAt as number;
    expect(live(await entitlementsOf(s))).toMatchObject([{ validUntil: effective }]);

    // At the effective time the sweep claims the evaluation, and the source fails for good.
    clock.set(effective + 30_000);
    const broken = jobsWorker(s.github, {
      simulatedSource: () => ({
        source: "simulated",
        refreshSubscription: () => Promise.reject(new Error("source bug")),
      }),
    });
    await runCron(broken, CRONS.drainOutbox);
    expect(
      await count(
        "SELECT count(*) AS n FROM outbox WHERE subject_id = ? AND failed_at IS NOT NULL",
        refreshKey(s, sub.id),
      ),
    ).toBe(1);
    expect(live(await entitlementsOf(s))).toHaveLength(1);

    // The cause is gone: the next minute's sweep repairs the lapsed entitlement.
    clock.advance(60_000);
    await runCron(jobsWorker(s.github), CRONS.drainOutbox);
    expect(await entitlementsOf(s)).toMatchObject([
      { state: "expired", decisionReason: "cancellation_effective" },
    ]);
  });
});
