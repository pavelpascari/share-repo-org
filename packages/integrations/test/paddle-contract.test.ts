import { FakeClock } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  createPaddleClient,
  isDestinationLimitError,
  normalizePaddleSubscription,
  PADDLE_SIGNATURE_MAX_AGE_MS,
  PADDLE_SIGNATURE_MAX_FUTURE_MS,
  PaddleApiError,
  PaddleErrorCode,
  type PaddlePort,
  parsePaddleEnvelope,
  verifyPaddleSignature,
} from "../src/index.ts";
import {
  createFakePaddle,
  type FakePaddleOperation,
  signPaddleWebhook,
} from "../src/testing/index.ts";
import apiRoot from "./fixtures/paddle/api-root.json";
import customer from "./fixtures/paddle/customer.json";
import customers from "./fixtures/paddle/customers.json";
import paymentLinkError from "./fixtures/paddle/error-default-payment-link.json";
import limitError from "./fixtures/paddle/error-destination-limit.json";
import forbidden from "./fixtures/paddle/error-forbidden.json";
import notFound from "./fixtures/paddle/error-not-found.json";
import tooMany from "./fixtures/paddle/error-too-many-requests.json";
import settingCreated from "./fixtures/paddle/notification-setting-created.json";
import settingsList from "./fixtures/paddle/notification-settings.json";
import prices1 from "./fixtures/paddle/prices-page-1.json";
import prices2 from "./fixtures/paddle/prices-page-2.json";
import subscription from "./fixtures/paddle/subscription.json";
import subscriptions from "./fixtures/paddle/subscriptions-page-1.json";
import checkoutTransaction from "./fixtures/paddle/transaction.json";
import transaction from "./fixtures/paddle/transaction-created.json";
import webhookBody from "./fixtures/paddle/webhook-subscription-updated.json";
import {
  CLAIM_REFERENCE,
  CUSTOMER_JO,
  CUSTOMER_SAM,
  NOW,
  PADDLE_API,
  PADDLE_KEY,
  PAYMENT_LINK,
  PERMISSIONS,
  PRICE_MONTHLY,
  PRICE_YEARLY,
  PRICES,
  SELLER,
  SUB_JO,
  SUB_SAM,
  T0,
  T1,
  UNKNOWN_CUSTOMER,
  UNKNOWN_SETTING,
  UNKNOWN_SUB,
  UNKNOWN_TRANSACTION,
} from "./support/paddle.ts";
import { jsonResponse, on, stubFetch } from "./support/stub-fetch.ts";

// One contract for PaddlePort, run against the in-memory fake and against the real client
// replaying documented Paddle responses (fixtures/paddle). If the fake drifts, its run fails.

const DESTINATION = settingCreated.data.destination;
const EVENTS = settingCreated.data.subscribed_events.map((event) => event.name);
const PERIOD_END = Date.parse("2026-11-01T09:00:00Z");

interface Subject {
  readonly port: PaddlePort;
  /** The transaction of Jo's checkout, which created `SUB_JO`. */
  readonly checkoutTransactionId: string;
  /** The key is revoked or expired: Paddle answers 403. */
  revokeKey(): void;
  /** The next call of `operation` is rate limited, with `Retry-After: 30`. */
  rateLimitNext(operation: FakePaddleOperation): void;
  /** Other apps already hold every active destination. */
  fillDestinations(): void;
  removePaymentLink(): void;
}

/** The fake, driven through the lifecycle that yields the fixtures' state. */
async function seededFake() {
  const clock = new FakeClock(T0);
  const fake = createFakePaddle({
    clock,
    seller: SELLER,
    environment: "sandbox",
    permissions: PERMISSIONS,
    defaultPaymentLink: PAYMENT_LINK,
  });
  for (const price of PRICES) fake.addPrice(price);
  fake.addCustomer(CUSTOMER_JO);
  fake.addCustomer(CUSTOMER_SAM);
  // Paddle's email filter matches exactly; a differently-cased address is another customer.
  fake.addCustomer({ email: "Jo@Example.com" });
  const { id } = await fake.createTransaction({
    priceId: PRICE_MONTHLY,
    customData: { sharerepo_claim: CLAIM_REFERENCE },
  });
  fake.completeCheckout(id, { customerId: CUSTOMER_JO.id, subscriptionId: SUB_JO });
  fake.createSubscription({ id: SUB_SAM, customerId: CUSTOMER_SAM.id, priceIds: [PRICE_YEARLY] });
  clock.set(T1);
  fake.scheduleCancel(SUB_JO);
  clock.set(NOW);
  fake.markPastDue(SUB_SAM);
  return { fake, clock, checkoutTransactionId: id };
}

async function fakePort(): Promise<Subject> {
  const { fake, checkoutTransactionId } = await seededFake();
  return {
    port: fake,
    checkoutTransactionId,
    revokeKey: () => fake.revokeKey(),
    rateLimitNext: (operation) =>
      fake.failNext(operation, "rate_limited", { retryAfterMs: 30_000 }),
    fillDestinations: () => fake.addForeignDestinations(10),
    removePaymentLink: () => fake.setDefaultPaymentLink(null),
  };
}

function realPort(): Subject {
  let revoked = false;
  let limited = false;
  let full = false;
  let paymentLink = true;
  const settings = new Set<string>();
  const { fetch } = stubFetch([
    () => (revoked ? jsonResponse(403, forbidden) : undefined),
    () => {
      if (!limited) return undefined;
      limited = false;
      return jsonResponse(429, tooMany, { "retry-after": "30" });
    },
    on("GET", "/", () => jsonResponse(200, apiRoot)),
    ({ method, url }) => {
      if (method !== "GET" || url.pathname !== "/prices") return undefined;
      expect(url.searchParams.get("include")).toBe("product");
      return jsonResponse(200, url.searchParams.has("after") ? prices2 : prices1);
    },
    on("GET", `/subscriptions/${SUB_JO}`, () => jsonResponse(200, subscription)),
    ({ method, url }) => {
      // Paddle's `customer_id` filter over the documented list.
      const customerId = url.searchParams.get("customer_id");
      if (method !== "GET" || url.pathname !== "/subscriptions" || customerId === null) {
        return undefined;
      }
      expect(url.searchParams.get("per_page")).toBe("200");
      const statuses = url.searchParams.get("status")?.split(",") ?? [];
      expect([...statuses].sort()).toEqual([
        "active",
        "canceled",
        "past_due",
        "paused",
        "trialing",
      ]);
      const data = subscriptions.data.filter(
        (sub) => sub.customer_id === customerId && statuses.includes(sub.status),
      );
      return jsonResponse(200, {
        ...subscriptions,
        meta: {
          ...subscriptions.meta,
          pagination: { ...subscriptions.meta.pagination, has_more: false },
        },
        data,
      });
    },
    on("GET", "/subscriptions", () => jsonResponse(200, subscriptions)),
    ({ method, url }) => {
      if (method !== "GET" || url.pathname !== "/customers") return undefined;
      return url.searchParams.get("email") === CUSTOMER_JO.email
        ? jsonResponse(200, customers)
        : jsonResponse(200, { ...customers, data: [] });
    },
    on("GET", `/customers/${CUSTOMER_JO.id}`, () => jsonResponse(200, customer)),
    on("GET", `/transactions/${checkoutTransaction.data.id}`, () =>
      jsonResponse(200, checkoutTransaction),
    ),
    on("POST", "/transactions", () =>
      paymentLink ? jsonResponse(201, transaction) : jsonResponse(400, paymentLinkError),
    ),
    ({ method, url }) => {
      if (method !== "GET" || url.pathname !== "/notification-settings") return undefined;
      expect(url.searchParams.get("per_page")).toBe("200");
      // Paddle lists every setting, another app's too; the deleted ones are gone.
      const data = settingsList.data.filter(
        (setting) => setting.description !== "ShareRepo" || settings.has(setting.id),
      );
      return jsonResponse(200, { ...settingsList, data });
    },
    on("POST", "/notification-settings", () => {
      if (full) return jsonResponse(400, limitError);
      settings.add(settingCreated.data.id);
      return jsonResponse(201, settingCreated);
    }),
    ({ method, url }) => {
      const match = /^\/notification-settings\/(ntfset_\w+)$/.exec(url.pathname);
      if (match === null || !settings.has(match[1] as string)) return undefined;
      if (method === "GET") return jsonResponse(200, settingCreated);
      settings.delete(match[1] as string);
      return new Response(null, { status: 204 });
    },
    () => jsonResponse(404, notFound),
  ]);
  return {
    port: createPaddleClient({
      apiKey: PADDLE_KEY,
      apiBaseUrl: PADDLE_API,
      fetch,
      clock: new FakeClock(NOW),
    }),
    checkoutTransactionId: checkoutTransaction.data.id,
    revokeKey: () => {
      revoked = true;
    },
    rateLimitNext: () => {
      limited = true;
    },
    fillDestinations: () => {
      full = true;
    },
    removePaymentLink: () => {
      paymentLink = false;
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<PaddleApiError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PaddleApiError);
  return error as PaddleApiError;
}

describe.each([
  ["fake", fakePort],
  ["real client with documented responses", async () => realPort()],
])("PaddlePort contract: %s", (_, make) => {
  it("identifies the seller, environment and key permissions", async () => {
    const { port } = await make();
    await expect(port.getApiRoot()).resolves.toEqual({
      sellerId: SELLER.id,
      sellerName: SELLER.name,
      environment: "sandbox",
      authType: "api_key",
      permissions: PERMISSIONS,
    });
  });

  it("lists active and archived prices with their products, across pages", async () => {
    const { port } = await make();
    await expect(port.listPrices()).resolves.toEqual(PRICES);
  });

  it("reads a subscription and normalizes it, claim reference included", async () => {
    const { port } = await make();
    const read = await port.getSubscription(SUB_JO);
    expect(read).toEqual({
      id: SUB_JO,
      customerId: CUSTOMER_JO.id,
      status: "active",
      items: [{ priceId: PRICE_MONTHLY, status: "active" }],
      currentBillingPeriod: { startsAt: Date.parse(T0), endsAt: PERIOD_END },
      scheduledChange: { action: "cancel", effectiveAt: PERIOD_END },
      canceledAt: null,
      updatedAt: Date.parse(T1),
      customData: { sharerepo_claim: CLAIM_REFERENCE },
    });
    expect(normalizePaddleSubscription(read)).toEqual({
      snapshot: {
        externalSubscriptionId: SUB_JO,
        externalCustomerId: CUSTOMER_JO.id,
        items: [PRICE_MONTHLY],
        state: "active",
        providerState: "active",
        currentPeriodStart: Date.parse(T0),
        currentPeriodEnd: PERIOD_END,
        cancelAt: PERIOD_END,
        endedAt: null,
        pastDueSince: null,
        sourceUpdatedAt: Date.parse(T1),
      },
      claimReference: CLAIM_REFERENCE,
    });
  });

  it("reports an unknown subscription or customer as not_found", async () => {
    const { port } = await make();
    expect(await failure(port.getSubscription(UNKNOWN_SUB))).toMatchObject({
      kind: "not_found",
      status: 404,
    });
    expect(await failure(port.getCustomer(UNKNOWN_CUSTOMER))).toMatchObject({ kind: "not_found" });
  });

  it("refuses invalid IDs and emails as rejected, without echoing them", async () => {
    const { port } = await make();
    const calls = [
      port.getSubscription("../sub"),
      port.getCustomer("ctm_UPPER"),
      port.getTransaction("txn_../x"),
      port.getNotificationSetting("ntfset_1"),
      port.deleteNotificationSetting("../x"),
      port.createTransaction({ priceId: "pri_x", customData: { a: "b" } }),
      port.createTransaction({ priceId: PRICE_MONTHLY, customData: {} }),
      port.listCustomersByEmail("jo@example.com,sam@example.com"),
      port.listCustomersByEmail("not an email"),
    ];
    for (const call of calls) {
      const error = await failure(call);
      expect(error.kind).toBe("rejected");
      expect(error.message).not.toMatch(/example\.com|\.\.\/|UPPER/);
    }
  });

  it("lists every subscription newest first, for the sweep", async () => {
    const { port } = await make();
    await expect(port.listSubscriptions()).resolves.toEqual({
      subscriptions: [
        { id: SUB_SAM, status: "past_due", updatedAt: Date.parse(NOW) },
        { id: SUB_JO, status: "active", updatedAt: Date.parse(T1) },
      ],
      truncated: false,
    });
  });

  it("lists one customer's subscriptions with the claim reference each carries", async () => {
    const { port } = await make();
    await expect(port.listCustomerSubscriptions(CUSTOMER_JO.id)).resolves.toEqual({
      subscriptions: [{ id: SUB_JO, customerId: CUSTOMER_JO.id, claimReference: CLAIM_REFERENCE }],
      truncated: false,
    });
    await expect(port.listCustomerSubscriptions(CUSTOMER_SAM.id)).resolves.toEqual({
      subscriptions: [{ id: SUB_SAM, customerId: CUSTOMER_SAM.id, claimReference: null }],
      truncated: false,
    });
    await expect(port.listCustomerSubscriptions(UNKNOWN_CUSTOMER)).resolves.toEqual({
      subscriptions: [],
      truncated: false,
    });
    expect(await failure(port.listCustomerSubscriptions("ctm_nope"))).toMatchObject({
      kind: "rejected",
    });
  });

  it("finds customers by exact email and reads one by ID", async () => {
    const { port } = await make();
    await expect(port.listCustomersByEmail(CUSTOMER_JO.email)).resolves.toEqual([CUSTOMER_JO]);
    await expect(port.listCustomersByEmail("nobody@example.com")).resolves.toEqual([]);
    await expect(port.getCustomer(CUSTOMER_JO.id)).resolves.toEqual(CUSTOMER_JO);
  });

  it("reads a checkout's transaction, naming the subscription it created", async () => {
    const { port, checkoutTransactionId } = await make();
    await expect(port.getTransaction(checkoutTransactionId)).resolves.toEqual({
      id: checkoutTransactionId,
      subscriptionId: SUB_JO,
    });
    expect(await failure(port.getTransaction(UNKNOWN_TRANSACTION))).toMatchObject({
      kind: "not_found",
      status: 404,
    });
  });

  it("creates a transaction whose checkout opens on the default payment link", async () => {
    const { port } = await make();
    const created = await port.createTransaction({
      priceId: PRICE_MONTHLY,
      customData: { sharerepo_claim: CLAIM_REFERENCE },
    });
    expect(created.id).toMatch(/^txn_[a-z\d]{26}$/);
    expect(created.checkoutUrl).toBe(`${PAYMENT_LINK}?_ptxn=${created.id}`);
  });

  it("refuses a transaction when the seller has no default payment link", async () => {
    const { port, removePaymentLink } = await make();
    removePaymentLink();
    const error = await failure(
      port.createTransaction({ priceId: PRICE_MONTHLY, customData: { a: "b" } }),
    );
    expect(error).toMatchObject({
      kind: "rejected",
      status: 400,
      paddleCode: PaddleErrorCode.DefaultPaymentLinkNotSet,
    });
  });

  it("creates, reads and deletes the webhook destination", async () => {
    const { port } = await make();
    const created = await port.createNotificationSetting({
      description: "ShareRepo",
      destination: DESTINATION,
      events: EVENTS,
    });
    expect(created.id).toMatch(/^ntfset_[a-z\d]{26}$/);
    expect(created.secret).toMatch(/^pdl_ntfset_[a-zA-Z\d]{26}_[a-zA-Z\d]{32}$/);
    await expect(port.getNotificationSetting(created.id)).resolves.toEqual({
      id: created.id,
      description: "ShareRepo",
      destination: DESTINATION,
      active: true,
      events: EVENTS,
    });
    await expect(port.deleteNotificationSetting(created.id)).resolves.toBe("deleted");
    await expect(port.deleteNotificationSetting(created.id)).resolves.toBe("not_found");
    expect(await failure(port.getNotificationSetting(created.id))).toMatchObject({
      kind: "not_found",
    });
    await expect(port.deleteNotificationSetting(UNKNOWN_SETTING)).resolves.toBe("not_found");
  });

  it("lists every destination with its description, and none once deleted", async () => {
    const { port } = await make();
    const created = await port.createNotificationSetting({
      description: "ShareRepo",
      destination: DESTINATION,
      events: EVENTS,
    });
    const own = {
      id: created.id,
      description: "ShareRepo",
      destination: DESTINATION,
      active: true,
      events: EVENTS,
    };
    expect(await port.listNotificationSettings()).toContainEqual(own);
    // The secret Paddle returns with each setting is never passed on.
    for (const setting of await port.listNotificationSettings()) {
      expect(Object.keys(setting).sort()).toEqual([
        "active",
        "description",
        "destination",
        "events",
        "id",
      ]);
    }
    await port.deleteNotificationSetting(created.id);
    expect(await port.listNotificationSettings()).not.toContainEqual(own);
  });

  it("refuses a destination when 10 are already active", async () => {
    const { port, fillDestinations } = await make();
    fillDestinations();
    const error = await failure(
      port.createNotificationSetting({
        description: "ShareRepo",
        destination: DESTINATION,
        events: EVENTS,
      }),
    );
    expect(error).toMatchObject({
      kind: "rejected",
      paddleCode: PaddleErrorCode.DestinationLimitReached,
    });
    expect(isDestinationLimitError(error)).toBe(true);
  });

  it("reports a revoked or expired key as unauthorized on every call", async () => {
    const { port, revokeKey } = await make();
    revokeKey();
    for (const call of [port.getApiRoot(), port.getSubscription(SUB_JO), port.listPrices()]) {
      expect(await failure(call)).toMatchObject({ kind: "unauthorized", status: 403 });
    }
  });

  it.each([
    "getApiRoot",
    "listPrices",
    "getSubscription",
    "listSubscriptions",
    "listCustomerSubscriptions",
    "getTransaction",
    "createNotificationSetting",
    "listNotificationSettings",
  ] as const)("reports a rate limit on %s with the delay before retrying", async (operation) => {
    const { port, rateLimitNext } = await make();
    rateLimitNext(operation);
    const call = {
      getApiRoot: () => port.getApiRoot(),
      listPrices: () => port.listPrices(),
      getSubscription: () => port.getSubscription(SUB_JO),
      listSubscriptions: () => port.listSubscriptions(),
      listCustomerSubscriptions: () => port.listCustomerSubscriptions(CUSTOMER_JO.id),
      getTransaction: () => port.getTransaction(UNKNOWN_TRANSACTION),
      listNotificationSettings: () => port.listNotificationSettings(),
      createNotificationSetting: () =>
        port.createNotificationSetting({
          description: "ShareRepo",
          destination: DESTINATION,
          events: EVENTS,
        }),
    }[operation];
    expect(await failure(call())).toMatchObject({ kind: "rate_limited", retryAfterMs: 30_000 });
  });
});

// Deliveries: one emitted and signed by the fake, one from the documented body signed here.

interface Delivery {
  readonly rawBody: string;
  readonly signature: string;
  readonly secret: string;
  readonly now: number;
}

async function fakeDelivery(): Promise<Delivery> {
  const { fake, clock } = await seededFake();
  const { id } = await fake.createNotificationSetting({
    description: "ShareRepo",
    destination: DESTINATION,
    events: EVENTS,
  });
  clock.set(T1);
  const delivery = await fake.emitSubscriptionEvent(id, "subscription.updated", SUB_JO);
  return {
    rawBody: delivery.rawBody,
    signature: delivery.signature,
    secret: fake.secretOf(id),
    now: clock.now(),
  };
}

async function documentedDelivery(): Promise<Delivery> {
  const rawBody = JSON.stringify(webhookBody);
  const secret = settingCreated.data.endpoint_secret_key;
  const now = Date.parse(T1);
  return { rawBody, secret, now, signature: await signPaddleWebhook(secret, rawBody, now / 1000) };
}

describe.each([
  ["fake", fakeDelivery],
  ["documented body", documentedDelivery],
])("webhook/invalid-signature-rejected-before-persist: %s", (_, make) => {
  const verify = (
    d: Delivery,
    header: string | null,
    overrides: Partial<{ secrets: string[]; rawBody: string; now: number }> = {},
  ) =>
    verifyPaddleSignature({
      header,
      rawBody: overrides.rawBody ?? d.rawBody,
      secrets: overrides.secrets ?? [d.secret],
      now: overrides.now ?? d.now,
    });
  const at = (now: number, offset: number) => Math.floor((now + offset) / 1000);

  it("accepts the signed delivery and parses its envelope", async () => {
    const d = await make();
    await expect(verify(d, d.signature)).resolves.toEqual({ ok: true });
    expect(parsePaddleEnvelope(JSON.parse(d.rawBody))).toMatchObject({
      eventId: expect.stringMatching(/^evt_[a-z\d]{26}$/),
      eventType: "subscription.updated",
      occurredAt: expect.any(Number),
      notificationId: expect.stringMatching(/^ntf_[a-z\d]{26}$/),
      entityId: SUB_JO,
      subscriptionId: null,
      customerId: CUSTOMER_JO.id,
    });
  });

  it("rejects a bad h1", async () => {
    const d = await make();
    const header = d.signature.replace(/h1=(.)/, (_m, c: string) => `h1=${c === "0" ? "1" : "0"}`);
    await expect(verify(d, header)).resolves.toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a tampered body", async () => {
    const d = await make();
    await expect(verify(d, d.signature, { rawBody: `${d.rawBody} ` })).resolves.toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects the wrong connection's secret", async () => {
    const d = await make();
    await expect(verify(d, d.signature, { secrets: ["pdl_ntfset_other"] })).resolves.toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
    await expect(verify(d, d.signature, { secrets: [] })).resolves.toMatchObject({ ok: false });
  });

  it("rejects a stale ts, older than 72 hours", async () => {
    const d = await make();
    const old = await signPaddleWebhook(
      d.secret,
      d.rawBody,
      at(d.now, -PADDLE_SIGNATURE_MAX_AGE_MS - 1000),
    );
    await expect(verify(d, old)).resolves.toEqual({ ok: false, reason: "timestamp_too_old" });
    const edge = await signPaddleWebhook(
      d.secret,
      d.rawBody,
      at(d.now, -PADDLE_SIGNATURE_MAX_AGE_MS),
    );
    await expect(verify(d, edge)).resolves.toEqual({ ok: true });
  });

  it("rejects a future ts, more than 5 minutes ahead", async () => {
    const d = await make();
    const ahead = await signPaddleWebhook(
      d.secret,
      d.rawBody,
      at(d.now, PADDLE_SIGNATURE_MAX_FUTURE_MS + 1000),
    );
    await expect(verify(d, ahead)).resolves.toEqual({ ok: false, reason: "timestamp_in_future" });
    const edge = await signPaddleWebhook(
      d.secret,
      d.rawBody,
      at(d.now, PADDLE_SIGNATURE_MAX_FUTURE_MS),
    );
    await expect(verify(d, edge)).resolves.toEqual({ ok: true });
  });

  it("accepts multiple h1 values when one is valid, and several secrets", async () => {
    const d = await make();
    const ts = at(d.now, 0);
    const both = await signPaddleWebhook(["pdl_ntfset_old", d.secret], d.rawBody, ts);
    expect(both.match(/h1=/g)).toHaveLength(2);
    await expect(verify(d, both)).resolves.toEqual({ ok: true });
    await expect(
      verify(d, d.signature, { secrets: ["pdl_ntfset_old", d.secret] }),
    ).resolves.toEqual({ ok: true });
    const neither = await signPaddleWebhook(["pdl_ntfset_a", "pdl_ntfset_b"], d.rawBody, ts);
    await expect(verify(d, neither)).resolves.toEqual({ ok: false, reason: "signature_mismatch" });
  });
});
