import { FakeClock } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  isDestinationLimitError,
  normalizePaddleSubscription,
  PaddleApiError,
  PaddleErrorCode,
  parsePaddleEnvelope,
  verifyPaddleSignature,
} from "../src/index.ts";
import { addBillingCycle, createFakePaddle } from "../src/testing/index.ts";

const T0 = "2026-10-01T09:00:00Z";
const SUB_X = `sub_${"0".repeat(25)}9`;

function world() {
  const clock = new FakeClock(T0);
  const fake = createFakePaddle({ clock });
  const price = fake.addPrice();
  const customer = fake.addCustomer({ email: "jo@example.com" });
  return { clock, fake, price, customer };
}

async function failure(promise: Promise<unknown>): Promise<PaddleApiError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PaddleApiError);
  return error as PaddleApiError;
}

async function checkout(w: ReturnType<typeof world>, claim = "v1.ref") {
  const { id } = await w.fake.createTransaction({
    priceId: w.price.id,
    customData: { sharerepo_claim: claim },
  });
  return { transactionId: id, sub: w.fake.completeCheckout(id, { customerId: w.customer.id }) };
}

describe("fake Paddle defaults", () => {
  it("has a seller, all permissions, a payment link and the system clock", async () => {
    const fake = createFakePaddle();
    await expect(fake.getApiRoot()).resolves.toMatchObject({
      sellerId: expect.stringMatching(/^slr_[a-z\d]{26}$/),
      environment: "sandbox",
      authType: "api_key",
      permissions: expect.arrayContaining(["transaction.write"]),
    });
    const price = fake.addPrice();
    expect(price).toMatchObject({
      id: expect.stringMatching(/^pri_[a-z\d]{26}$/),
      productId: expect.stringMatching(/^pro_[a-z\d]{26}$/),
      billingCycle: { interval: "month", frequency: 1 },
      status: "active",
    });
    const before = Date.now();
    const { id } = await fake.createTransaction({ priceId: price.id, customData: { a: "b" } });
    expect(fake.transaction(id).checkoutUrl).toBe(`https://seller.example/pay?_ptxn=${id}`);
    const customer = fake.addCustomer({ email: "x@example.com" });
    const sub = fake.completeCheckout(id, { customerId: customer.id });
    expect(sub.updatedAt).toBeGreaterThanOrEqual(before);
    expect(fake.calls).toEqual(["getApiRoot", "createTransaction"]);
  });

  it("starts every generated ID with the ID seed, so several fakes never collide", () => {
    const fake = createFakePaddle({ idSeed: "e2e7" });
    expect(fake.addPrice().id).toBe(`pri_e2e7${"0".repeat(21)}1`);
    expect(fake.addCustomer({ email: "x@example.com" }).id).toMatch(/^ctm_e2e70{21}1$/);
    expect(() => createFakePaddle({ idSeed: "Upper" })).toThrow("idSeed");
    expect(() => createFakePaddle({ idSeed: "a".repeat(17) })).toThrow("idSeed");
  });

  it("returns copies, so callers cannot change its state", async () => {
    const { fake, price } = world();
    const listed = await fake.listPrices();
    (listed[0] as { productName: string }).productName = "changed";
    await expect(fake.listPrices()).resolves.toEqual([price]);
  });
});

describe("fake Paddle key and permissions", () => {
  it("refuses every call with a revoked key until it is restored", async () => {
    const { fake } = world();
    fake.revokeKey();
    expect(await failure(fake.getApiRoot())).toMatchObject({
      kind: "unauthorized",
      status: 403,
      paddleCode: "forbidden",
    });
    fake.restoreKey();
    await expect(fake.getApiRoot()).resolves.toBeDefined();
  });

  it("needs each operation's permission, write including read", async () => {
    const { fake } = world();
    fake.setPermissions(["notification_setting.write"]);
    await expect(fake.listPrices()).rejects.toMatchObject({ kind: "unauthorized" });
    const { id } = await fake.createNotificationSetting({
      description: "ShareRepo",
      destination: "https://a.test/",
      events: [],
    });
    await expect(fake.getNotificationSetting(id)).resolves.toMatchObject({ id });
    await expect(fake.getApiRoot()).resolves.toMatchObject({
      permissions: ["notification_setting.write"],
    });
  });
});

describe("fake Paddle catalog, customers and checkout", () => {
  it("archives prices, refusing checkout for them", async () => {
    const { fake, price } = world();
    fake.archivePrice(price.id);
    await expect(fake.listPrices()).resolves.toEqual([{ ...price, status: "archived" }]);
    const error = await failure(
      fake.createTransaction({ priceId: price.id, customData: { a: "b" } }),
    );
    expect(error).toMatchObject({ kind: "rejected", paddleCode: "invalid_field" });
    expect(() => fake.archivePrice("pri_nope")).toThrow(/unknown price/);
  });

  it("refuses checkout without a default payment link", async () => {
    const { fake, price } = world();
    fake.setDefaultPaymentLink(null);
    expect(
      await failure(fake.createTransaction({ priceId: price.id, customData: { a: "b" } })),
    ).toMatchObject({ paddleCode: PaddleErrorCode.DefaultPaymentLinkNotSet });
    expect(createFakePaddle({ defaultPaymentLink: null })).toBeDefined();
  });

  it("changes a customer's email, matched exactly", async () => {
    const { fake, customer } = world();
    fake.setCustomerEmail(customer.id, "new@example.com");
    await expect(fake.getCustomer(customer.id)).resolves.toEqual({
      id: customer.id,
      email: "new@example.com",
      createdAt: Date.parse(T0),
    });
    await expect(fake.listCustomersByEmail("NEW@example.com")).resolves.toEqual([]);
    expect(() => fake.setCustomerEmail("ctm_nope", "x@example.com")).toThrow(/unknown customer/);
  });

  it("creates customers at the clock's time, or at the time given", async () => {
    const { clock, fake, customer } = world();
    expect(customer.createdAt).toBe(Date.parse(T0));
    const earlier = fake.addCustomer({ email: "old@example.com", createdAt: Date.parse(T0) - 1 });
    clock.advance(5_000);
    await expect(fake.getCustomer(earlier.id)).resolves.toMatchObject({
      createdAt: Date.parse(T0) - 1,
    });
  });

  it("a checkout by email reuses the customer with that email, or creates one then", async () => {
    const w = world();
    const pay = async (email: string) => {
      const { id } = await w.fake.createTransaction({
        priceId: w.price.id,
        customData: { sharerepo_claim: "v1.ref" },
      });
      return w.fake.completeCheckout(id, { email });
    };
    w.clock.advance(60_000);
    expect((await pay("jo@example.com")).customerId).toBe(w.customer.id);
    const created = await pay("new@example.com");
    expect(created.customerId).not.toBe(w.customer.id);
    await expect(w.fake.getCustomer(created.customerId)).resolves.toEqual({
      id: created.customerId,
      email: "new@example.com",
      createdAt: Date.parse(T0) + 60_000,
    });
    expect((await pay("new@example.com")).customerId).toBe(created.customerId);
  });

  it("creates the subscription from the transaction, copying its custom data", async () => {
    const w = world();
    const { transactionId, sub } = await checkout(w);
    expect(w.fake.transaction(transactionId).subscriptionId).toBe(sub.id);
    expect(sub).toMatchObject({
      status: "active",
      customerId: w.customer.id,
      items: [{ priceId: w.price.id, status: "active" }],
      currentBillingPeriod: {
        startsAt: Date.parse(T0),
        endsAt: Date.parse("2026-11-01T09:00:00Z"),
      },
      customData: { sharerepo_claim: "v1.ref" },
    });
    expect(normalizePaddleSubscription(sub).claimReference).toBe("v1.ref");
    expect(() => w.fake.completeCheckout(transactionId, { customerId: w.customer.id })).toThrow(
      /already completed/,
    );
    expect(() => w.fake.transaction("txn_nope")).toThrow(/unknown transaction/);
  });

  it("refuses subscriptions it cannot create", () => {
    const { fake, price, customer } = world();
    const oneTime = fake.addPrice({ billingCycle: null });
    fake.createSubscription({ id: SUB_X, customerId: customer.id, priceIds: [price.id] });
    expect(() =>
      fake.createSubscription({ id: SUB_X, customerId: customer.id, priceIds: [price.id] }),
    ).toThrow(/exists/);
    expect(() => fake.createSubscription({ customerId: "ctm_nope", priceIds: [price.id] })).toThrow(
      /unknown customer/,
    );
    expect(() =>
      fake.createSubscription({ customerId: customer.id, priceIds: [oneTime.id] }),
    ).toThrow(/not a recurring price/);
    expect(() => fake.createSubscription({ customerId: customer.id, priceIds: ["pri_x"] })).toThrow(
      /not a recurring price/,
    );
    expect(() => fake.createSubscription({ customerId: customer.id, priceIds: [] })).toThrow(
      /needs a price/,
    );
    expect(() => fake.subscription("sub_nope")).toThrow(/unknown subscription/);
  });
});

describe("fake Paddle subscription lifecycle", () => {
  it("trials, then activates with a new period", () => {
    const { fake, clock, price, customer } = world();
    const trial = fake.createSubscription({
      customerId: customer.id,
      priceIds: [price.id],
      status: "trialing",
      customData: { other: "x" },
    });
    expect(trial).toMatchObject({
      status: "trialing",
      items: [{ status: "trialing" }],
      currentBillingPeriod: { endsAt: Date.parse("2026-10-15T09:00:00Z") },
    });
    expect(normalizePaddleSubscription(trial).snapshot.items).toEqual([price.id]);
    clock.set("2026-10-15T09:00:00Z");
    expect(fake.activate(trial.id)).toMatchObject({
      status: "active",
      items: [{ status: "active" }],
      currentBillingPeriod: { startsAt: Date.parse("2026-10-15T09:00:00Z") },
    });
  });

  it("goes past due and recovers on renewal", async () => {
    const w = world();
    const { sub } = await checkout(w);
    const pastDue = w.fake.markPastDue(sub.id);
    expect(normalizePaddleSubscription(pastDue).snapshot).toMatchObject({
      state: "past_due",
      pastDueSince: pastDue.updatedAt,
    });
    const renewed = w.fake.renew(sub.id);
    expect(renewed).toMatchObject({
      status: "active",
      currentBillingPeriod: {
        startsAt: Date.parse("2026-11-01T09:00:00Z"),
        endsAt: Date.parse("2026-12-01T09:00:00Z"),
      },
    });
  });

  it("schedules a cancellation at period end, removes it, then cancels now", async () => {
    const w = world();
    const { sub } = await checkout(w);
    const end = Date.parse("2026-11-01T09:00:00Z");
    expect(w.fake.scheduleCancel(sub.id).scheduledChange).toEqual({
      action: "cancel",
      effectiveAt: end,
    });
    expect(w.fake.removeScheduledChange(sub.id).scheduledChange).toBeNull();
    expect(w.fake.scheduleCancel(sub.id, end - 1000).scheduledChange?.effectiveAt).toBe(end - 1000);
    w.clock.set(end);
    const canceled = w.fake.cancelNow(sub.id);
    expect(canceled).toMatchObject({
      status: "canceled",
      canceledAt: end,
      currentBillingPeriod: null,
      scheduledChange: null,
    });
    expect(normalizePaddleSubscription(canceled).snapshot.endedAt).toBe(end);
    expect(() => w.fake.scheduleCancel(sub.id)).toThrow(/no current period/);
    expect(w.fake.renew(sub.id).currentBillingPeriod?.startsAt).toBe(end);
  });

  it("schedules a pause, pauses and resumes with a new period", async () => {
    const w = world();
    const { sub } = await checkout(w);
    expect(w.fake.schedulePause(sub.id).scheduledChange?.action).toBe("pause");
    const paused = w.fake.pause(sub.id);
    expect(paused).toMatchObject({
      status: "paused",
      currentBillingPeriod: null,
      scheduledChange: null,
    });
    expect(w.fake.removeScheduledChange(sub.id).scheduledChange).toBeNull();
    w.clock.set("2026-10-20T00:00:00Z");
    expect(w.fake.resume(sub.id)).toMatchObject({
      status: "active",
      currentBillingPeriod: { startsAt: Date.parse("2026-10-20T00:00:00Z") },
    });
    expect(
      w.fake.schedulePause(sub.id, Date.parse("2026-10-25T00:00:00Z")).scheduledChange,
    ).toEqual({
      action: "pause",
      effectiveAt: Date.parse("2026-10-25T00:00:00Z"),
    });
  });

  it("updates custom data, and bumps updated_at even when the clock stands still", async () => {
    const w = world();
    const { sub } = await checkout(w);
    const first = w.fake.updateCustomData(sub.id, { sharerepo_claim: "v1.other" });
    const second = w.fake.updateCustomData(sub.id, null);
    expect(first.customData).toEqual({ sharerepo_claim: "v1.other" });
    expect(second.customData).toBeNull();
    expect(first.updatedAt).toBeGreaterThan(sub.updatedAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    await expect(w.fake.getSubscription(sub.id)).resolves.toEqual(w.fake.subscription(sub.id));
  });
});

describe("addBillingCycle", () => {
  it.each([
    ["day", 3, "2026-01-31T00:00:00.000Z", "2026-02-03T00:00:00.000Z"],
    ["week", 2, "2026-01-31T00:00:00.000Z", "2026-02-14T00:00:00.000Z"],
    ["month", 1, "2026-03-15T00:00:00.000Z", "2026-04-15T00:00:00.000Z"],
    ["year", 1, "2026-03-15T00:00:00.000Z", "2027-03-15T00:00:00.000Z"],
  ] as const)("adds %s × %i", (interval, frequency, from, to) => {
    expect(new Date(addBillingCycle(Date.parse(from), { interval, frequency })).toISOString()).toBe(
      to,
    );
  });
});

describe("fake Paddle notification settings", () => {
  const destination = (n: number) => `https://sharerepo.test/webhooks/paddle/c${n}`;

  it("enforces the fake's 10-destination limit, counting other apps' destinations", async () => {
    const { fake } = world();
    fake.addForeignDestinations(8);
    const first = await fake.createNotificationSetting({
      description: "ShareRepo",
      destination: destination(1),
      events: [],
    });
    await fake.createNotificationSetting({
      description: "ShareRepo",
      destination: destination(2),
      events: [],
    });
    const error = await failure(
      fake.createNotificationSetting({
        description: "ShareRepo",
        destination: destination(3),
        events: [],
      }),
    );
    expect(error).toMatchObject({
      kind: "rejected",
      status: 400,
      paddleCode: PaddleErrorCode.DestinationLimitReached,
    });
    expect(isDestinationLimitError(error)).toBe(true);
    fake.deactivateNotificationSetting(first.id);
    await expect(
      fake.createNotificationSetting({
        description: "ShareRepo",
        destination: destination(3),
        events: [],
      }),
    ).resolves.toMatchObject({ id: expect.any(String) });
    expect(fake.notificationSettings().map((setting) => setting.active)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("refuses a duplicate destination", async () => {
    const { fake } = world();
    await fake.createNotificationSetting({
      description: "ShareRepo",
      destination: destination(1),
      events: [],
    });
    expect(
      await failure(
        fake.createNotificationSetting({
          description: "ShareRepo",
          destination: destination(1),
          events: [],
        }),
      ),
    ).toMatchObject({ paddleCode: "notification_setting_cannot_be_duplicate" });
  });

  it("refuses controls on unknown destinations", () => {
    const { fake } = world();
    expect(() => fake.secretOf("ntfset_nope")).toThrow(/unknown notification setting/);
    expect(() => fake.deactivateNotificationSetting("ntfset_nope")).toThrow(/unknown/);
  });
});

describe("fake Paddle signed events", () => {
  async function connected() {
    const w = world();
    const setting = await w.fake.createNotificationSetting({
      description: "ShareRepo",
      destination: "https://sharerepo.test/webhooks/paddle/c1",
      events: ["subscription.updated"],
    });
    const verify = (delivery: { rawBody: string; signature: string }, secret = setting.secret) =>
      verifyPaddleSignature({
        header: delivery.signature,
        rawBody: delivery.rawBody,
        secrets: [secret],
        now: w.clock.now(),
      });
    return { ...w, setting, verify };
  }

  it("signs subscription events with the destination's secret", async () => {
    const c = await connected();
    const { sub } = await checkout(c);
    const delivery = await c.fake.emitSubscriptionEvent(
      c.setting.id,
      "subscription.created",
      sub.id,
    );
    expect(c.fake.secretOf(c.setting.id)).toBe(c.setting.secret);
    expect(delivery).toMatchObject({
      destination: "https://sharerepo.test/webhooks/paddle/c1",
      settingId: c.setting.id,
      eventType: "subscription.created",
    });
    await expect(c.verify(delivery)).resolves.toEqual({ ok: true });
    await expect(c.verify(delivery, "pdl_ntfset_other")).resolves.toMatchObject({ ok: false });
    expect(parsePaddleEnvelope(JSON.parse(delivery.rawBody))).toMatchObject({
      eventId: delivery.eventId,
      notificationId: delivery.notificationId,
      entityId: sub.id,
      customerId: c.customer.id,
    });
  });

  it("emits transaction events before and after the subscription exists", async () => {
    const c = await connected();
    const { id } = await c.fake.createTransaction({ priceId: c.price.id, customData: { a: "b" } });
    const paid = await c.fake.emitTransactionEvent(c.setting.id, "transaction.paid", id);
    expect(parsePaddleEnvelope(JSON.parse(paid.rawBody))).toMatchObject({
      entityId: id,
      subscriptionId: null,
      customerId: null,
    });
    const sub = c.fake.completeCheckout(id, { customerId: c.customer.id });
    const completed = await c.fake.emitTransactionEvent(c.setting.id, "transaction.completed", id);
    expect(parsePaddleEnvelope(JSON.parse(completed.rawBody))).toMatchObject({
      subscriptionId: sub.id,
      customerId: c.customer.id,
    });
  });

  it("replays with a new notification ID and the same event ID, signed now", async () => {
    const c = await connected();
    const { sub } = await checkout(c);
    const original = await c.fake.emitSubscriptionEvent(
      c.setting.id,
      "subscription.updated",
      sub.id,
    );
    c.clock.set("2026-10-04T09:00:00Z");
    const replayed = await c.fake.replay(original);
    expect(replayed.eventId).toBe(original.eventId);
    expect(replayed.notificationId).not.toBe(original.notificationId);
    await expect(c.verify(replayed)).resolves.toEqual({ ok: true });
    expect(JSON.parse(replayed.rawBody).occurred_at).toBe(JSON.parse(original.rawBody).occurred_at);
  });

  it("delivers one event to every active destination, each signed with its own secret", async () => {
    const c = await connected();
    const second = await c.fake.createNotificationSetting({
      description: "ShareRepo",
      destination: "https://sharerepo.test/webhooks/paddle/c1?v=2",
      events: ["subscription.updated"],
    });
    const inactive = await c.fake.createNotificationSetting({
      description: "ShareRepo",
      destination: "https://sharerepo.test/webhooks/paddle/c1?v=3",
      events: [],
    });
    c.fake.deactivateNotificationSetting(inactive.id);
    const at = c.clock.now() - 60_000;
    const deliveries = await c.fake.emitToAll({
      eventType: "api_key.revoked",
      data: { id: "apikey_01jkey00000000000000000001" },
      occurredAt: at,
      signedAt: at,
    });
    expect(deliveries.map((d) => d.settingId)).toEqual([c.setting.id, second.id]);
    expect(deliveries[1]?.destination).toBe("https://sharerepo.test/webhooks/paddle/c1?v=2");
    const [first, other] = deliveries as [(typeof deliveries)[number], (typeof deliveries)[number]];
    expect(first.eventId).toBe(other.eventId);
    expect(first.notificationId).not.toBe(other.notificationId);
    expect(JSON.parse(first.rawBody).occurred_at).toBe(new Date(at).toISOString());
    await expect(c.verify(first)).resolves.toEqual({ ok: true });
    await expect(c.verify(other)).resolves.toMatchObject({ ok: false });
    await expect(c.verify(other, second.secret)).resolves.toEqual({ ok: true });
    // Defaults to now.
    const [now] = await c.fake.emitToAll({ eventType: "api_key.revoked", data: { id: "x" } });
    expect(JSON.parse(now?.rawBody ?? "").occurred_at).toBe(new Date(c.clock.now()).toISOString());
    expect(now?.signature).toMatch(new RegExp(`^ts=${Math.floor(c.clock.now() / 1000)};`));
  });

  it("emits any event, signed at a chosen time", async () => {
    const c = await connected();
    const at = c.clock.now() - 73 * 60 * 60 * 1000;
    const stale = await c.fake.emit({
      settingId: c.setting.id,
      eventType: "api_key.revoked",
      data: { id: "apikey_01jkey00000000000000000001" },
      occurredAt: at,
      signedAt: at,
    });
    await expect(c.verify(stale)).resolves.toEqual({ ok: false, reason: "timestamp_too_old" });
  });
});

describe("fake Paddle fault injection", () => {
  it.each([
    ["unauthorized", 403],
    ["not_found", 404],
    ["rate_limited", 429],
    ["transient", 503],
    ["rejected", 400],
    ["malformed", 200],
  ] as const)("fails the next call once with %s", async (kind, status) => {
    const { fake } = world();
    fake.failNext("getApiRoot", kind);
    const error = await failure(fake.getApiRoot());
    expect(error).toMatchObject({ kind, status });
    if (kind === "rate_limited") expect(error.retryAfterMs).toBe(60_000);
    await expect(fake.getApiRoot()).resolves.toBeDefined();
  });

  it("loses a mutation's response after doing the work", async () => {
    const { fake, price } = world();
    fake.loseNextResponse("createTransaction");
    expect(
      await failure(fake.createTransaction({ priceId: price.id, customData: { a: "b" } })),
    ).toMatchObject({ kind: "transient" });
    fake.loseNextResponse("createNotificationSetting");
    await failure(
      fake.createNotificationSetting({
        description: "ShareRepo",
        destination: "https://a.test/",
        events: [],
      }),
    );
    const [setting] = fake.notificationSettings();
    expect(setting).toBeDefined();
    fake.loseNextResponse("deleteNotificationSetting");
    await failure(fake.deleteNotificationSetting(setting?.id ?? ""));
    expect(fake.notificationSettings()).toEqual([]);
    await expect(fake.deleteNotificationSetting(setting?.id ?? "")).resolves.toBe("not_found");
  });
});
