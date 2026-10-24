import { FakeClock } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  createPaddleClient,
  isDestinationLimitError,
  PADDLE_PAGE_LIMIT,
  PADDLE_REQUEST_TIMEOUT_MS,
  PaddleApiError,
} from "../src/index.ts";
import { nextPage, retryAfter } from "../src/paddle/client.ts";
import apiRoot from "./fixtures/paddle/api-root.json";
import unauthenticated from "./fixtures/paddle/api-root-unauthenticated.json";
import paymentLinkError from "./fixtures/paddle/error-default-payment-link.json";
import internal from "./fixtures/paddle/error-internal.json";
import invalidField from "./fixtures/paddle/error-invalid-field.json";
import invalidToken from "./fixtures/paddle/error-invalid-token.json";
import notFound from "./fixtures/paddle/error-not-found.json";
import tooMany from "./fixtures/paddle/error-too-many-requests.json";
import settingCreated from "./fixtures/paddle/notification-setting-created.json";
import subscription from "./fixtures/paddle/subscription.json";
import subscriptions from "./fixtures/paddle/subscriptions-page-1.json";
import transaction from "./fixtures/paddle/transaction-created.json";
import { NOW, PADDLE_API, PADDLE_KEY, PRICE_MONTHLY, SUB_JO } from "./support/paddle.ts";
import { jsonResponse, on, type StubRoute, stubFetch } from "./support/stub-fetch.ts";

function client(routes: StubRoute[], clock = new FakeClock(NOW)) {
  const stub = stubFetch(routes);
  const port = createPaddleClient({
    apiKey: PADDLE_KEY,
    apiBaseUrl: PADDLE_API,
    fetch: stub.fetch,
    clock,
  });
  return { port, calls: stub.calls };
}

async function failure(promise: Promise<unknown>): Promise<PaddleApiError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PaddleApiError);
  return error as PaddleApiError;
}

const SECRET = settingCreated.data.endpoint_secret_key;

describe("Paddle requests", () => {
  it("sends the bearer key, Paddle-Version 1 and a timeout signal", async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const port = createPaddleClient({
      apiKey: PADDLE_KEY,
      apiBaseUrl: PADDLE_API,
      clock: new FakeClock(NOW),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = { url: String(input), init };
        return jsonResponse(200, apiRoot);
      }) as typeof fetch,
    });
    await port.getApiRoot();
    expect(seen?.url).toBe(`${PADDLE_API}/`);
    expect(Object.fromEntries(new Headers(seen?.init?.headers).entries())).toEqual({
      accept: "application/json",
      authorization: `Bearer ${PADDLE_KEY}`,
      "paddle-version": "1",
      "user-agent": "ShareRepo",
    });
    expect(seen?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(PADDLE_REQUEST_TIMEOUT_MS).toBe(20_000);
  });

  it("maps Paddle's production environment to live", async () => {
    const live = { ...apiRoot, data: { ...apiRoot.data, api: { environment: "production" } } };
    const { port } = client([on("GET", "/", () => jsonResponse(200, live))]);
    await expect(port.getApiRoot()).resolves.toMatchObject({ environment: "live" });
  });

  it("treats an API root without a seller account as unauthorized", async () => {
    const { port } = client([on("GET", "/", () => jsonResponse(200, unauthenticated))]);
    expect(await failure(port.getApiRoot())).toMatchObject({ kind: "unauthorized" });
  });

  it("sends the transaction and destination bodies Paddle documents", async () => {
    const { port, calls } = client([
      on("POST", "/transactions", () => jsonResponse(201, transaction)),
      on("POST", "/notification-settings", () => jsonResponse(201, settingCreated)),
    ]);
    await port.createTransaction({ priceId: PRICE_MONTHLY, customData: { sharerepo_claim: "r" } });
    const created = await port.createNotificationSetting({
      destination: "https://sharerepo.test/webhooks/paddle/c1",
      events: ["subscription.updated"],
    });
    expect(created).toEqual({ id: settingCreated.data.id, secret: SECRET });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      items: [{ price_id: PRICE_MONTHLY, quantity: 1 }],
      custom_data: { sharerepo_claim: "r" },
    });
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({
      description: "ShareRepo",
      type: "url",
      api_version: 1,
      include_sensitive_fields: false,
      traffic_source: "platform",
      destination: "https://sharerepo.test/webhooks/paddle/c1",
      subscribed_events: ["subscription.updated"],
    });
  });

  it("returns a null checkout URL when Paddle sends none", async () => {
    const { port } = client([
      on("POST", "/transactions", () =>
        jsonResponse(201, { data: { ...transaction.data, checkout: null } }),
      ),
    ]);
    await expect(
      port.createTransaction({ priceId: PRICE_MONTHLY, customData: { a: "b" } }),
    ).resolves.toEqual({ id: transaction.data.id, checkoutUrl: null });
  });

  it("asks for customers by one exact email, URL-encoded", async () => {
    const { port, calls } = client([
      on("GET", "/customers", () =>
        jsonResponse(200, { data: [], meta: { pagination: { next: null, has_more: false } } }),
      ),
    ]);
    await port.listCustomersByEmail("jo+paddle@example.com");
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("email")).toBe("jo+paddle@example.com");
    expect(url.searchParams.get("per_page")).toBe("200");
    expect(await failure(port.listCustomersByEmail(`${"a".repeat(250)}@x.io`))).toMatchObject({
      kind: "rejected",
    });
  });
});

describe("Paddle error classification", () => {
  it.each([
    [401, invalidToken, {}, "unauthorized", "invalid_token"],
    [403, invalidToken, {}, "unauthorized", "invalid_token"],
    [404, notFound, {}, "not_found", "not_found"],
    [429, tooMany, { "retry-after": "17" }, "rate_limited", "too_many_requests"],
    [500, internal, {}, "transient", "internal_error"],
    [503, undefined, {}, "transient", undefined],
    [400, invalidField, {}, "rejected", "invalid_field"],
    [400, paymentLinkError, {}, "rejected", "transaction_default_checkout_url_not_set"],
    [409, { error: { code: "Not A Code" } }, {}, "rejected", undefined],
  ] as const)("status %i is %s", async (status, body, headers, kind, paddleCode) => {
    const { port } = client([() => jsonResponse(status, body, headers)]);
    const error = await failure(port.getSubscription(SUB_JO));
    expect(error).toMatchObject({ kind, status, paddleCode });
    if (kind === "rate_limited") expect(error.retryAfterMs).toBe(17_000);
    // Never Paddle's detail, which may echo input such as an email.
    expect(error.message).toBe(`Paddle get subscription failed with status ${status}`);
    expect(JSON.stringify(error)).not.toContain("example.com");
    expect(isDestinationLimitError(error)).toBe(false);
  });

  it("is transient on a network failure or timeout, without the key", async () => {
    const port = createPaddleClient({
      apiKey: PADDLE_KEY,
      apiBaseUrl: PADDLE_API,
      clock: new FakeClock(NOW),
      fetch: (async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as typeof fetch,
    });
    const error = await failure(port.getApiRoot());
    expect(error).toMatchObject({ kind: "transient", status: undefined });
    expect(error.message).not.toContain(PADDLE_KEY);
  });

  it("is malformed when a 2xx body does not match", async () => {
    const { port } = client([
      on("GET", `/subscriptions/${SUB_JO}`, () =>
        jsonResponse(200, { data: { ...subscription.data, status: "expired" } }),
      ),
      on("GET", "/", () => new Response("not json", { status: 200 })),
    ]);
    expect(await failure(port.getSubscription(SUB_JO))).toMatchObject({ kind: "malformed" });
    expect(await failure(port.getApiRoot())).toMatchObject({ kind: "malformed" });
  });

  it("propagates other failures when deleting a destination", async () => {
    const { port } = client([() => jsonResponse(403, invalidToken)]);
    expect(await failure(port.deleteNotificationSetting(settingCreated.data.id))).toMatchObject({
      kind: "unauthorized",
    });
  });

  it("never puts the destination secret in an error", async () => {
    const { port } = client([
      on("POST", "/notification-settings", () =>
        jsonResponse(201, {
          data: { ...settingCreated.data, endpoint_secret_key: `${SECRET}x` },
        }),
      ),
    ]);
    const error = await failure(
      port.createNotificationSetting({ destination: "https://x.test/", events: [] }),
    );
    expect(error.kind).toBe("malformed");
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(SECRET);
  });
});

describe("retryAfter", () => {
  const clock = new FakeClock(NOW);
  it.each([
    [null, 60_000],
    ["30", 30_000],
    [" 5 ", 5_000],
    [new Date(Date.parse(NOW) + 12_000).toUTCString(), 12_000],
    [new Date(Date.parse(NOW) - 12_000).toUTCString(), 0],
    ["soon", 60_000],
  ])("reads %s as %i ms", (header, ms) => {
    expect(retryAfter(header, clock)).toBe(ms);
  });
});

describe("Paddle pagination", () => {
  const listPage = (index: number, hasMore: boolean) => ({
    ...subscriptions,
    data: [{ ...subscriptions.data[0], id: `sub_${String(index).padStart(26, "0")}` }],
    meta: {
      pagination: {
        per_page: 1,
        next: `${PADDLE_API}/subscriptions?after=${index}&per_page=200`,
        has_more: hasMore,
      },
    },
  });

  function paged(pages: number) {
    return client([
      ({ url }) => {
        const index = Number(url.searchParams.get("after") ?? "0") + 1;
        return jsonResponse(200, listPage(index, index < pages));
      },
    ]);
  }

  it("follows meta.pagination.next while has_more", async () => {
    const { port, calls } = paged(3);
    const list = await port.listSubscriptions();
    expect(list.subscriptions.map((s) => s.id.slice(-1))).toEqual(["1", "2", "3"]);
    expect(list.truncated).toBe(false);
    expect(calls.map((call) => call.url)).toEqual([
      `${PADDLE_API}/subscriptions?per_page=200`,
      `${PADDLE_API}/subscriptions?after=1&per_page=200`,
      `${PADDLE_API}/subscriptions?after=2&per_page=200`,
    ]);
  });

  it("lists a customer's subscriptions by customer_id, truncating at the cap", async () => {
    const { port, calls } = paged(PADDLE_PAGE_LIMIT + 5);
    const customerId = `ctm_${"1".repeat(26)}`;
    const list = await port.listCustomerSubscriptions(customerId);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("customer_id")).toBe(customerId);
    expect(calls).toHaveLength(PADDLE_PAGE_LIMIT);
    expect(list.truncated).toBe(true);
    expect(list.subscriptions[0]).toEqual({
      id: `sub_${"1".padStart(26, "0")}`,
      claimReference: null,
    });
  });

  it("stops the sweep list at the 30-page cap and says it was truncated", async () => {
    const { port, calls } = paged(PADDLE_PAGE_LIMIT + 5);
    const list = await port.listSubscriptions();
    expect(calls).toHaveLength(PADDLE_PAGE_LIMIT);
    expect(list).toMatchObject({ truncated: true });
    expect(list.subscriptions).toHaveLength(PADDLE_PAGE_LIMIT);
  });

  it("refuses a catalog longer than the cap rather than truncating it", async () => {
    const page = (n: number) => ({
      data: [],
      meta: { pagination: { next: `${PADDLE_API}/prices?after=${n}`, has_more: true } },
    });
    const { port, calls } = client([
      ({ url }) => jsonResponse(200, page(Number(url.searchParams.get("after") ?? "0") + 1)),
    ]);
    expect(await failure(port.listPrices())).toMatchObject({ kind: "malformed" });
    expect(calls).toHaveLength(PADDLE_PAGE_LIMIT);
  });

  it("never sends the key to a next link outside the API", async () => {
    const { port, calls } = client([
      () =>
        jsonResponse(200, {
          data: [],
          meta: { pagination: { next: "https://evil.test/subscriptions", has_more: true } },
        }),
    ]);
    expect(await failure(port.listSubscriptions())).toMatchObject({ kind: "malformed" });
    expect(calls).toHaveLength(1);
    expect(() => nextPage(null, PADDLE_API)).toThrow(PaddleApiError);
    expect(() => nextPage(`${PADDLE_API}.evil.test/x`, PADDLE_API)).toThrow(PaddleApiError);
    expect(nextPage(`${PADDLE_API}/prices?after=1`, PADDLE_API)).toBe(
      `${PADDLE_API}/prices?after=1`,
    );
  });
});
