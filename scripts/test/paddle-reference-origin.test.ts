import { describe, expect, it } from "vitest";
import {
  customData,
  main,
  parseArguments,
  summarizeEvents,
  summarizeSubscription,
  summarizeTransaction,
} from "../spikes/paddle-reference-origin.ts";

// The Paddle reference-origin spike prints an allow-list only: no key, email, name, address or
// custom data value can reach its output (docs/research/paddle-reference-origin-spike.md).

const KEY = "pdl_sdbx_apikey_01hsecretsecretsecretsecret";
const REFERENCE = "v1.cc_secretclaim.c2VjcmV0bWFj";
const PII = ["buyer@example.com", "Jane Buyer", "1 Main Street", "Springfield", "+1 555 0100"];

const subscription = {
  id: "sub_01abc",
  status: "active",
  customer_id: "ctm_01abc",
  address_id: "add_01abc",
  custom_data: { sharerepo_claim: REFERENCE, "note with spaces!": "x", email: "buyer@example.com" },
  created_at: "2026-10-26T10:00:00.000Z",
  updated_at: "2026-10-26T10:05:00.000Z",
  started_at: "2026-10-26T10:00:00Z",
  first_billed_at: "not a time",
  billing_details: { additional_information: "Jane Buyer, 1 Main Street" },
  customer: { email: "buyer@example.com", name: "Jane Buyer" },
};
const transaction = {
  id: "txn_01abc",
  status: "completed",
  origin: "web",
  subscription_id: "sub_01abc",
  customer_id: "ctm_01abc",
  custom_data: { sharerepo_claim: REFERENCE },
  created_at: "2026-10-26T09:59:00Z",
  updated_at: "2026-10-26T10:00:00Z",
  billed_at: "2026-10-26T10:00:00Z",
  address: { first_line: "1 Main Street", city: "Springfield" },
  customer: { email: "buyer@example.com", name: "Jane Buyer", phone: "+1 555 0100" },
};
const events = [
  {
    event_id: "evt_02",
    event_type: "subscription.updated",
    occurred_at: "2026-10-26T10:05:00Z",
    data: { id: "sub_01abc", custom_data: { sharerepo_claim: REFERENCE }, email: PII[0] },
  },
  {
    event_id: "evt_01",
    event_type: "subscription.created",
    occurred_at: "2026-10-26T10:00:00Z",
    data: { id: "sub_01abc", transaction_id: "txn_01abc" },
  },
  {
    event_id: "evt_00",
    event_type: "transaction.completed",
    occurred_at: "2026-10-26T10:00:00Z",
    data: { id: "txn_01abc", subscription_id: "sub_01abc", origin: "web" },
  },
  {
    event_id: "evt_09",
    event_type: "customer.updated",
    occurred_at: "2026-10-26T10:01:00Z",
    data: { id: "ctm_01abc", email: "buyer@example.com", name: "Jane Buyer" },
  },
  { event_id: "evt_10", event_type: "subscription.created", data: { id: "sub_other" } },
];

/** A fake sandbox: answers by path, and records the requests. */
function sandbox(overrides: Record<string, Response> = {}) {
  const requests: { url: string; authorization: string | undefined }[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    requests.push({ url, authorization: init.headers.authorization });
    const path = new URL(url).pathname;
    if (overrides[path] !== undefined) return overrides[path];
    const data =
      path === "/subscriptions/sub_01abc"
        ? subscription
        : path === "/transactions/txn_01abc"
          ? transaction
          : path === "/transactions"
            ? [transaction]
            : events;
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  return { fetch, requests };
}

describe("field filtering", () => {
  it("keeps custom data keys and a digest of the reference, never values", () => {
    expect(customData(subscription.custom_data)).toEqual({
      keys: ["email", "sharerepo_claim"],
      referenceDigest: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
    expect(customData(null)).toEqual({ keys: [], referenceDigest: null });
    expect(customData(["sharerepo_claim"])).toEqual({ keys: [], referenceDigest: null });
    expect(customData({ sharerepo_claim: 5 })).toEqual({
      keys: ["sharerepo_claim"],
      referenceDigest: null,
    });
  });

  it("summarizes a subscription with allow-listed fields only", () => {
    expect(summarizeSubscription(subscription)).toEqual({
      id: "sub_01abc",
      status: "active",
      customerId: "ctm_01abc",
      customData: { keys: ["email", "sharerepo_claim"], referenceDigest: expect.any(String) },
      createdAt: "2026-10-26T10:00:00.000Z",
      updatedAt: "2026-10-26T10:05:00.000Z",
      startedAt: "2026-10-26T10:00:00Z",
      firstBilledAt: null,
    });
    expect(summarizeSubscription({ id: "Jane Buyer", status: "Jane Buyer" })).toMatchObject({
      id: null,
      status: null,
    });
  });

  it("summarizes a transaction, with its origin and subscription", () => {
    expect(summarizeTransaction(transaction)).toEqual({
      id: "txn_01abc",
      status: "completed",
      origin: "web",
      subscriptionId: "sub_01abc",
      customerId: "ctm_01abc",
      customData: { keys: ["sharerepo_claim"], referenceDigest: expect.any(String) },
      createdAt: "2026-10-26T09:59:00Z",
      updatedAt: "2026-10-26T10:00:00Z",
      billedAt: "2026-10-26T10:00:00Z",
    });
  });

  it("keeps the subscription's own events and its transactions', oldest first", () => {
    expect(summarizeEvents(events, "sub_01abc").map((e) => e.eventId)).toEqual([
      "evt_01",
      "evt_00",
      "evt_02",
    ]);
    expect(summarizeEvents(events, "sub_01abc")[0]).toEqual({
      eventId: "evt_01",
      eventType: "subscription.created",
      occurredAt: "2026-10-26T10:00:00Z",
      entityId: "sub_01abc",
      transactionId: "txn_01abc",
      origin: null,
      referenceDigest: null,
    });
    expect(summarizeEvents({ not: "a list" }, "sub_01abc")).toEqual([]);
    expect(summarizeEvents([events[4], events[4]], "sub_other")).toHaveLength(2);
  });

  it("digests the same reference the same way, so two can be compared", () => {
    const [first] = summarizeEvents(events.slice(0, 1), "sub_01abc");
    expect(first?.referenceDigest).toBe(
      summarizeTransaction(transaction).customData.referenceDigest,
    );
  });
});

describe("arguments", () => {
  it.each([
    [["--subscription", "sub_01abc"], { subscriptionId: "sub_01abc", transactionId: null }],
    [
      ["--subscription", "sub_01abc", "--transaction", "txn_01abc"],
      { subscriptionId: "sub_01abc", transactionId: "txn_01abc" },
    ],
    [[], null],
    [["--subscription", "sub 01"], null],
    [["--subscription", "sub_01abc", "--transaction"], null],
  ])("%j", (argv, result) => {
    expect(parseArguments(argv)).toEqual(result);
  });
});

describe("main", () => {
  it("prints the report and nothing personal, the key, or a reference", async () => {
    const lines: string[] = [];
    const { fetch, requests } = sandbox();
    const code = await main(
      ["--subscription", "sub_01abc", "--transaction", "txn_01abc"],
      { PADDLE_SANDBOX_API_KEY: KEY },
      fetch,
      (line) => lines.push(line),
    );
    expect(code).toBe(0);
    const output = lines.join("\n");
    for (const secret of [KEY, REFERENCE, ...PII]) expect(output).not.toContain(secret);
    const report = JSON.parse(output);
    expect(report.checkoutTransaction.subscriptionId).toBe("sub_01abc");
    expect(report.subscriptionTransactions).toHaveLength(1);
    expect(report.eventsTruncated).toBe(false);
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/subscriptions/sub_01abc",
      "/transactions/txn_01abc",
      "/transactions",
      "/events",
    ]);
    expect(requests.every((r) => r.authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it("skips the checkout transaction when none is named, and flags a full events page", async () => {
    const lines: string[] = [];
    const full = Array.from({ length: 200 }, () => events[4]);
    const { fetch } = sandbox({
      "/events": new Response(JSON.stringify({ data: full }), { status: 200 }),
      "/transactions": new Response(JSON.stringify({ data: null }), { status: 200 }),
    });
    expect(
      await main(["--subscription", "sub_01abc"], { PADDLE_SANDBOX_API_KEY: KEY }, fetch, (l) =>
        lines.push(l),
      ),
    ).toBe(0);
    const report = JSON.parse(lines.join("\n"));
    expect(report.checkoutTransaction).toBeNull();
    expect(report.subscriptionTransactions).toEqual([]);
    expect(report.eventsTruncated).toBe(true);
  });

  it.each([
    [["--subscription", "sub_01abc"], {}],
    [["--subscription", "sub_01abc"], { PADDLE_SANDBOX_API_KEY: "pdl_live_apikey_01live" }],
    [[], { PADDLE_SANDBOX_API_KEY: KEY }],
  ])("refuses %j without a sandbox key or a subscription", async (argv, env) => {
    const lines: string[] = [];
    expect(await main(argv, env, sandbox().fetch, (l) => lines.push(l))).toBe(2);
    expect(lines.join("\n")).toContain("Usage:");
    expect(lines.join("\n")).not.toContain("pdl_live_apikey_01live");
  });

  it("reports a failed request by endpoint and status only, never its body", async () => {
    const lines: string[] = [];
    const { fetch } = sandbox({
      "/subscriptions/sub_01abc": new Response(JSON.stringify({ error: PII[0] }), { status: 403 }),
    });
    expect(
      await main(["--subscription", "sub_01abc"], { PADDLE_SANDBOX_API_KEY: KEY }, fetch, (l) =>
        lines.push(l),
      ),
    ).toBe(1);
    expect(lines).toEqual(["Failed: /subscriptions/sub_01abc answered 403"]);
  });

  it("reports a non-Error failure without details", async () => {
    const lines: string[] = [];
    const fetch = () => Promise.reject("boom");
    expect(
      await main(["--subscription", "sub_01abc"], { PADDLE_SANDBOX_API_KEY: KEY }, fetch, (l) =>
        lines.push(l),
      ),
    ).toBe(1);
    expect(lines).toEqual(["Failed: unknown error"]);
  });
});
