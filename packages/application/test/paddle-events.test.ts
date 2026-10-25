import { env } from "cloudflare:workers";
import { getExternalEvent, getSubscriptionByExternal, recordExternalEvent } from "@sharerepo/db";
import { dailyOffsetMs } from "@sharerepo/domain";
import { describe, expect, it } from "vitest";
import {
  decodePaddleConnectionKey,
  decodeRefreshKey,
  disconnectPaddle,
  ingestPaddleWebhook,
  PaddleUnavailableError,
  type PaddleWebhookResult,
  paddleEntitlementSource,
  processPaddleEvent,
  queueDueEvaluations,
  queuePaddleSweeps,
  refreshSubscription,
  sweepPaddleSubscriptions,
} from "../src/index.ts";
import { entitlementsOf, live } from "./support/commerce.ts";
import { clock, db, serviceContext } from "./support/context.ts";
import {
  auditOf,
  buyer,
  connectionOf,
  deliverSubscription,
  directSubscription,
  drainPaddle,
  type PaddleShop,
  paddleCustomer,
  paddleShop,
  post,
  purchase,
  ROTATED,
  settingOf,
} from "./support/paddle.ts";

const DAY = 86_400_000;

async function pendingOf(kind: string, subjectId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM outbox WHERE kind = ? AND subject_id = ? AND sent_at IS NULL",
  )
    .bind(kind, subjectId)
    .all();
  return results.length;
}

const refreshKey = (s: PaddleShop, subscriptionId: string) =>
  `${s.workspaceId}:paddle:${subscriptionId}`;

function accepted(result: PaddleWebhookResult) {
  if (result.status !== "accepted") throw new Error(`expected accepted, got ${result.status}`);
  return result;
}

describe("ingestPaddleWebhook", () => {
  it("records a verified delivery's metadata and its processing intent, never the payload", async () => {
    const s = await paddleShop();
    const customer = paddleCustomer(s);
    const sub = directSubscription(s, customer.id);
    clock.advance(1_000);
    const delivery = await s.paddle.emitSubscriptionEvent(
      await settingOf(s),
      "subscription.created",
      sub.id,
    );
    const result = accepted(await post(s, delivery));
    const event = await getExternalEvent(db, result.eventId);
    expect(event).toMatchObject({
      provider: "paddle",
      connectionId: s.connectionId,
      externalEventId: delivery.eventId,
      eventType: "subscription.created",
      externalSubscriptionId: sub.id,
      processingState: "pending",
      receivedAt: clock.now(),
    });
    expect(JSON.stringify(event)).not.toContain(customer.email);
    expect(await pendingOf("process_external_event", result.eventId)).toBe(1);
    expect((await connectionOf(s)).lastEventAt).toBe(clock.now());
  });

  it("webhook/duplicate-delivery-is-noop: the same evt_ twice, and a replay", async () => {
    const s = await paddleShop();
    const sub = directSubscription(s, paddleCustomer(s).id);
    const delivery = await s.paddle.emitSubscriptionEvent(
      await settingOf(s),
      "subscription.created",
      sub.id,
    );
    const first = accepted(await post(s, delivery));
    expect(await post(s, delivery)).toEqual({ status: "duplicate", eventId: first.eventId });
    clock.advance(60_000);
    const replay = await s.paddle.replay(delivery);
    expect(replay.notificationId).not.toBe(delivery.notificationId);
    expect(await post(s, replay)).toEqual({ status: "duplicate", eventId: first.eventId });
    const { results } = await env.DB.prepare(
      "SELECT id FROM external_events WHERE connection_id = ?",
    )
      .bind(s.connectionId)
      .all();
    expect(results).toHaveLength(1);
    expect(await pendingOf("process_external_event", first.eventId)).toBe(1);
    // Processing twice queues the refresh once.
    expect(await processPaddleEvent(serviceContext(), first.eventId)).toBe("processed");
    expect(await processPaddleEvent(serviceContext(), first.eventId)).toBe("already_done");
    expect(await pendingOf("refresh_subscription", refreshKey(s, sub.id))).toBe(1);
  });

  it("webhook/invalid-signature-rejected-before-persist: tampered, stale, or another connection's secret", async () => {
    const s = await paddleShop();
    const other = await paddleShop();
    const sub = directSubscription(s, paddleCustomer(s).id);
    const setting = await settingOf(s);
    const delivery = await s.paddle.emitSubscriptionEvent(setting, "subscription.created", sub.id);
    const tampered = { ...delivery, rawBody: delivery.rawBody.replace("active", "paused") };
    const stale = await s.paddle.emit({
      settingId: setting,
      eventType: "subscription.updated",
      data: { id: sub.id },
      signedAt: clock.now() - 73 * 3_600_000,
    });
    const foreign = await other.paddle.emitSubscriptionEvent(
      await settingOf(other),
      "subscription.created",
      directSubscription(other, paddleCustomer(other).id).id,
    );
    for (const bad of [tampered, stale, foreign, { ...delivery, signature: "" }]) {
      expect(await post(s, bad)).toEqual({ status: "invalid_signature" });
    }
    const { results } = await env.DB.prepare(
      "SELECT id FROM external_events WHERE connection_id = ?",
    )
      .bind(s.connectionId)
      .all();
    expect(results).toEqual([]);
  });

  it("refuses an unknown or disconnected connection, and a signed body that is not an event", async () => {
    const s = await paddleShop();
    const setting = await settingOf(s);
    const odd = await s.paddle.emit({ settingId: setting, eventType: "Not An Event", data: {} });
    expect(await post(s, odd)).toEqual({ status: "malformed" });
    const delivery = await s.paddle.emit({
      settingId: setting,
      eventType: "customer.updated",
      data: { id: paddleCustomer(s).id },
    });
    expect(
      await ingestPaddleWebhook(
        serviceContext(),
        { connectionId: "missing", rawBody: new ArrayBuffer(0), signatureHeader: null },
        s.deps,
      ),
    ).toEqual({ status: "not_found" });
    await disconnectPaddle(serviceContext(), s, s.slug, s.deps);
    expect(await post(s, delivery)).toEqual({ status: "not_found" });
  });

  it("re-wraps the webhook secret under a rotated master key", async () => {
    const s = await paddleShop({ deps: {} });
    const rotated = { ...s, deps: { ...s.deps, credentialKeys: ROTATED } };
    const delivery = await s.paddle.emit({
      settingId: await settingOf(s),
      eventType: "customer.updated",
      data: { id: paddleCustomer(s).id },
    });
    accepted(await post(rotated, delivery));
    expect(JSON.parse((await connectionOf(s)).webhookSecretEnvelope as string).kid).toBe("k2");
    expect(await auditOf(s.workspaceId, "paddle.credentials_rewrapped")).toEqual([
      expect.objectContaining({ details: { field: "webhook_secret" } }),
    ]);
  });
});

describe("processPaddleEvent", () => {
  it("queues a refresh for subscription and transaction events, a probe for key events, and ignores the rest", async () => {
    const s = await paddleShop();
    const setting = await settingOf(s);
    const customer = paddleCustomer(s);
    const sub = directSubscription(s, customer.id);
    const run = async (delivery: Awaited<ReturnType<typeof s.paddle.emit>>) =>
      processPaddleEvent(serviceContext(), accepted(await post(s, delivery)).eventId);

    expect(
      await run(await s.paddle.emitSubscriptionEvent(setting, "subscription.updated", sub.id)),
    ).toBe("processed");
    const paid = await s.paddle.emit({
      settingId: setting,
      eventType: "transaction.payment_failed",
      data: { id: `txn_${"0".repeat(25)}a`, subscription_id: sub.id },
    });
    expect(await run(paid)).toBe("processed");
    expect(await pendingOf("refresh_subscription", refreshKey(s, sub.id))).toBe(1);

    const draft = await s.paddle.emit({
      settingId: setting,
      eventType: "transaction.paid",
      data: { id: `txn_${"0".repeat(25)}b` },
    });
    expect(await run(draft)).toBe("ignored");
    const revoked = await s.paddle.emit({
      settingId: setting,
      eventType: "api_key.revoked",
      data: { id: `apikey_${"0".repeat(25)}a` },
    });
    expect(await run(revoked)).toBe("processed");
    expect(await pendingOf("check_paddle_connection", `${s.workspaceId}:${s.connectionId}`)).toBe(
      1,
    );
    const updated = await s.paddle.emit({
      settingId: setting,
      eventType: "customer.updated",
      data: { id: customer.id },
    });
    expect(await run(updated)).toBe("ignored");
    expect(await processPaddleEvent(serviceContext(), "no-such-event")).toBe("already_done");
  });

  it("ignores events of a disconnected connection, and GitHub events", async () => {
    const s = await paddleShop();
    const sub = directSubscription(s, paddleCustomer(s).id);
    const delivery = await s.paddle.emitSubscriptionEvent(
      await settingOf(s),
      "subscription.created",
      sub.id,
    );
    const { eventId } = accepted(await post(s, delivery));
    await disconnectPaddle(serviceContext(), s, s.slug, s.deps);
    expect(await processPaddleEvent(serviceContext(), eventId)).toBe("ignored");
    expect((await getExternalEvent(db, eventId))?.processingState).toBe("ignored");

    const github = await recordExternalEvent(
      db,
      {
        id: `gh-${crypto.randomUUID()}`,
        provider: "github",
        connectionId: null,
        externalEventId: crypto.randomUUID(),
        eventType: "installation",
        action: "created",
        installationId: "1",
        externalSubscriptionId: null,
        payloadDigest: "x",
        occurredAt: null,
        receivedAt: clock.now(),
      },
      [],
    );
    expect(await processPaddleEvent(serviceContext(), github.eventId)).toBe("ignored");
  });

  it("webhook/out-of-order-does-not-regress: subscription.updated before subscription.created", async () => {
    const s = await paddleShop();
    const setting = await settingOf(s);
    const sub = directSubscription(s, paddleCustomer(s).id);
    const created = await s.paddle.emitSubscriptionEvent(setting, "subscription.created", sub.id);
    clock.advance(DAY);
    s.paddle.scheduleCancel(sub.id);
    const updated = await s.paddle.emitSubscriptionEvent(setting, "subscription.updated", sub.id);
    accepted(await post(s, updated));
    await drainPaddle(s);
    const ref = {
      workspaceId: s.workspaceId,
      source: "paddle" as const,
      externalSubscriptionId: sub.id,
    };
    const after = await getSubscriptionByExternal(db, ref);
    expect(after?.cancelAt).toBe(s.paddle.subscription(sub.id).scheduledChange?.effectiveAt);
    accepted(await post(s, created));
    await drainPaddle(s);
    // The late event re-read Paddle's current state, which is not newer: nothing changed.
    expect(await getSubscriptionByExternal(db, ref)).toEqual(after);
  });
});

describe("paddleEntitlementSource", () => {
  it("reads and normalizes the subscription with its claim reference", async () => {
    const s = await paddleShop();
    const sub = s.paddle.createSubscription({
      customerId: paddleCustomer(s).id,
      priceIds: [s.price.id],
      customData: { sharerepo_claim: "v1.x.y" },
    });
    const port = paddleEntitlementSource(serviceContext(), s.deps);
    expect(port.source).toBe("paddle");
    const read = await port.refreshSubscription({
      workspaceId: s.workspaceId,
      externalSubscriptionId: sub.id,
    });
    expect(read).toMatchObject({
      found: true,
      customerLink: null,
      claimReference: "v1.x.y",
      snapshot: { externalSubscriptionId: sub.id, state: "active", items: [s.price.id] },
    });
    expect(
      await port.refreshSubscription({
        workspaceId: s.workspaceId,
        externalSubscriptionId: "sub_01h00000000000000000000zzz",
      }),
    ).toEqual({ found: false });
    s.paddle.failNext("getSubscription", "transient");
    await expect(
      port.refreshSubscription({ workspaceId: s.workspaceId, externalSubscriptionId: sub.id }),
    ).rejects.toMatchObject({ kind: "transient" });
  });

  it("is unavailable without an active connection", async () => {
    const s = await paddleShop();
    await disconnectPaddle(serviceContext(), s, s.slug, s.deps);
    await expect(
      paddleEntitlementSource(serviceContext(), s.deps).refreshSubscription({
        workspaceId: s.workspaceId,
        externalSubscriptionId: "sub_01h00000000000000000000000",
      }),
    ).rejects.toBeInstanceOf(PaddleUnavailableError);
  });

  it("connection/revoked-key-keeps-last-facts", async () => {
    const s = await paddleShop();
    const { subscription } = await purchase(s, await buyer());
    const before = live(await entitlementsOf(s.workspaceId, subscription.id));
    expect(before).toHaveLength(1);
    const stored = await getSubscriptionByExternal(db, {
      workspaceId: s.workspaceId,
      source: "paddle",
      externalSubscriptionId: subscription.id,
    });

    s.paddle.revokeKey();
    s.paddle.cancelNow(subscription.id);
    const ref = decodeRefreshKey(refreshKey(s, subscription.id));
    if (!ref.ok) throw new Error("key");
    await expect(
      refreshSubscription(
        serviceContext(),
        ref.value,
        paddleEntitlementSource(serviceContext(), s.deps),
      ),
    ).rejects.toBeInstanceOf(PaddleUnavailableError);
    expect(await connectionOf(s)).toMatchObject({
      status: "unauthorized",
      statusReason: "key_refused",
    });
    expect(await auditOf(s.workspaceId, "paddle.status_changed")).toEqual([
      expect.objectContaining({ details: { previousStatus: "active", status: "unauthorized" } }),
    ]);
    // The last known facts stand: no revocation while ShareRepo cannot read Paddle.
    expect(live(await entitlementsOf(s.workspaceId, subscription.id))).toEqual(before);
    expect(
      await getSubscriptionByExternal(db, {
        workspaceId: s.workspaceId,
        source: "paddle",
        externalSubscriptionId: subscription.id,
      }),
    ).toEqual(stored);
    // Still unavailable while unauthorized, without asking Paddle again.
    await expect(
      refreshSubscription(
        serviceContext(),
        ref.value,
        paddleEntitlementSource(serviceContext(), s.deps),
      ),
    ).rejects.toMatchObject({ code: "source_unavailable" });
  });
});

describe("timing scenarios with the Paddle source", () => {
  it("timing/cancellation-revokes-at-effective-time", async () => {
    const s = await paddleShop();
    const { subscription } = await purchase(s, await buyer());
    clock.advance(DAY);
    const scheduled = s.paddle.scheduleCancel(subscription.id);
    const effectiveAt = scheduled.scheduledChange?.effectiveAt as number;
    await deliverSubscription(s, "subscription.updated", subscription.id);
    const [entitlement] = live(await entitlementsOf(s.workspaceId, subscription.id));
    expect(entitlement?.validUntil).toBe(effectiveAt);

    clock.set(effectiveAt - 1);
    await queueDueEvaluations(serviceContext(), { limit: 1000 });
    await drainPaddle(s);
    expect(live(await entitlementsOf(s.workspaceId, subscription.id))).toHaveLength(1);
    // At the effective time access ends from the stored facts, before Paddle's own event.
    clock.set(effectiveAt);
    await queueDueEvaluations(serviceContext(), { limit: 1000 });
    await drainPaddle(s);
    expect(live(await entitlementsOf(s.workspaceId, subscription.id))).toEqual([]);
    s.paddle.cancelNow(subscription.id);
    await deliverSubscription(s, "subscription.canceled", subscription.id);
    expect(live(await entitlementsOf(s.workspaceId, subscription.id))).toEqual([]);
  });

  it("timing/renewal-during-scheduled-revocation", async () => {
    const s = await paddleShop();
    const { subscription } = await purchase(s, await buyer());
    const effectiveAt = s.paddle.scheduleCancel(subscription.id).scheduledChange
      ?.effectiveAt as number;
    await deliverSubscription(s, "subscription.updated", subscription.id);
    clock.set(effectiveAt - DAY);
    s.paddle.removeScheduledChange(subscription.id);
    await deliverSubscription(s, "subscription.updated", subscription.id);
    clock.set(effectiveAt);
    s.paddle.renew(subscription.id);
    await deliverSubscription(s, "subscription.updated", subscription.id);
    await queueDueEvaluations(serviceContext(), { limit: 1000 });
    await drainPaddle(s);
    const [entitlement] = live(await entitlementsOf(s.workspaceId, subscription.id));
    expect(entitlement?.validUntil).toBeNull();
  });

  it("timing/past-due-within-grace-keeps-access", async () => {
    const s = await paddleShop({ gracePeriodDays: 3 });
    const { subscription } = await purchase(s, await buyer());
    clock.advance(DAY);
    const pastDueSince = clock.now();
    s.paddle.markPastDue(subscription.id);
    await deliverSubscription(s, "subscription.past_due", subscription.id);
    const [entitlement] = live(await entitlementsOf(s.workspaceId, subscription.id));
    expect(entitlement?.validUntil).toBe(pastDueSince + 3 * DAY);

    // Paddle updates the subscription again while it stays past due (a retried payment fails):
    // its `updated_at` moves, but the grace period does not.
    clock.advance(DAY);
    s.paddle.updateCustomData(subscription.id, { note: "retry" });
    await deliverSubscription(s, "transaction.payment_failed", subscription.id);
    const stored = await getSubscriptionByExternal(db, {
      workspaceId: s.workspaceId,
      source: "paddle",
      externalSubscriptionId: subscription.id,
    });
    expect(stored?.pastDueSince).toBe(pastDueSince);
    expect(live(await entitlementsOf(s.workspaceId, subscription.id))[0]?.validUntil).toBe(
      pastDueSince + 3 * DAY,
    );
    clock.set(pastDueSince + 3 * DAY);
    await queueDueEvaluations(serviceContext(), { limit: 1000 });
    await drainPaddle(s);
    expect(live(await entitlementsOf(s.workspaceId, subscription.id))).toEqual([]);
  });
});

describe("sweepPaddleSubscriptions and queuePaddleSweeps", () => {
  it("queues refreshes for unknown and newer subscriptions only, once", async () => {
    const s = await paddleShop();
    const { subscription: known } = await purchase(s, await buyer());
    const unknown = directSubscription(s, paddleCustomer(s).id);
    const ref = { workspaceId: s.workspaceId, connectionId: s.connectionId };
    expect(await sweepPaddleSubscriptions(serviceContext(), ref, s.deps)).toEqual({
      queued: 1,
      truncated: false,
    });
    expect(await pendingOf("refresh_subscription", refreshKey(s, unknown.id))).toBe(1);
    expect(await sweepPaddleSubscriptions(serviceContext(), ref, s.deps)).toEqual({
      queued: 0,
      truncated: false,
    });
    await drainPaddle(s);
    clock.advance(1_000);
    s.paddle.markPastDue(known.id);
    expect(await sweepPaddleSubscriptions(serviceContext(), ref, s.deps)).toEqual({
      queued: 1,
      truncated: false,
    });
    expect(await pendingOf("refresh_subscription", refreshKey(s, known.id))).toBe(1);
  });

  it("skips a connection that is not active, or not the workspace's", async () => {
    const s = await paddleShop();
    const ref = { workspaceId: s.workspaceId, connectionId: s.connectionId };
    expect(
      await sweepPaddleSubscriptions(serviceContext(), { ...ref, connectionId: "other" }, s.deps),
    ).toBeNull();
    s.paddle.revokeKey();
    await expect(sweepPaddleSubscriptions(serviceContext(), ref, s.deps)).rejects.toBeInstanceOf(
      PaddleUnavailableError,
    );
    expect(await sweepPaddleSubscriptions(serviceContext(), ref, s.deps)).toBeNull();
  });

  it("queues one sweep per active connection, once", async () => {
    const s = await paddleShop();
    const key = `${s.workspaceId}:${s.connectionId}`;
    expect(await queuePaddleSweeps(serviceContext())).toBeGreaterThanOrEqual(1);
    expect(await pendingOf("sweep_paddle_subscriptions", key)).toBe(1);
    await queuePaddleSweeps(serviceContext());
    expect(await pendingOf("sweep_paddle_subscriptions", key)).toBe(1);
    // Spread over the day by its connection's own offset (phase-6 plan § Partitioning).
    const row = await env.DB.prepare(
      "SELECT created_at AS c, available_at AS a FROM outbox WHERE kind = 'sweep_paddle_subscriptions' AND subject_id = ?",
    )
      .bind(key)
      .first<{ c: number; a: number }>();
    expect((row?.a as number) - (row?.c as number)).toBe(
      dailyOffsetMs("sweep_paddle_subscriptions", s.connectionId),
    );
    const decoded = decodePaddleConnectionKey(key);
    expect(decoded).toEqual({
      ok: true,
      value: { workspaceId: s.workspaceId, connectionId: s.connectionId },
    });
  });
});
