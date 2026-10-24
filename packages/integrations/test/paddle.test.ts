import { describe, expect, it } from "vitest";
import {
  CLAIM_REFERENCE_MAX_LENGTH,
  InvalidPaddleWebhookError,
  normalizePaddleSubscription,
  PaddleApiError,
  type PaddleSubscription,
  parsePaddleApiKey,
  parsePaddleEnvelope,
  verifyPaddleSignature,
} from "../src/index.ts";
import { signPaddleWebhook } from "../src/testing/index.ts";
import webhookBody from "./fixtures/paddle/webhook-subscription-updated.json";
import { PADDLE_KEY } from "./support/paddle.ts";

describe("parsePaddleApiKey", () => {
  it("accepts a sandbox or live key and derives the environment", () => {
    expect(parsePaddleApiKey(PADDLE_KEY)).toEqual({
      ok: true,
      value: { key: PADDLE_KEY, environment: "sandbox" },
    });
    const live = PADDLE_KEY.replace("pdl_sdbx_", "pdl_live_");
    expect(parsePaddleApiKey(` ${live}\n`)).toEqual({
      ok: true,
      value: { key: live, environment: "live" },
    });
  });

  it("refuses a legacy 50-character key", () => {
    expect(parsePaddleApiKey(`${"a1B2".repeat(12)}c3`)).toEqual({
      ok: false,
      error: "api_key_legacy",
    });
  });

  it.each([
    ["a client-side token", `test_${"a".repeat(27)}`],
    ["a wrong prefix", PADDLE_KEY.replace("pdl_sdbx_", "pdl_test_")],
    ["upper case in the first part", PADDLE_KEY.replace("a1a1", "A1a1")],
    ["a short key", PADDLE_KEY.slice(0, -1)],
    ["an empty string", ""],
    ["a number", 42],
    ["null", null],
  ])("refuses %s, without echoing it", (_, value) => {
    const result = parsePaddleApiKey(value);
    expect(result).toEqual({ ok: false, error: "api_key_invalid" });
  });
});

const SECRET = "pdl_ntfset_test";
const BODY = JSON.stringify(webhookBody);
const NOW = Date.parse("2026-10-05T12:00:00Z");
const TS = NOW / 1000;

describe("verifyPaddleSignature header parsing", () => {
  const verify = (header: string | null) =>
    verifyPaddleSignature({ header, rawBody: BODY, secrets: [SECRET], now: NOW });

  it("accepts every raw body form and ignores unknown fields", async () => {
    const header = await signPaddleWebhook(SECRET, BODY, TS);
    const bytes = new TextEncoder().encode(BODY);
    for (const rawBody of [BODY, bytes, bytes.buffer as ArrayBuffer]) {
      await expect(
        verifyPaddleSignature({ header, rawBody, secrets: [SECRET], now: NOW }),
      ).resolves.toEqual({ ok: true });
    }
    await expect(verify(`${header};h2=abc`)).resolves.toEqual({ ok: true });
    await expect(verify(header.replace(";", " ; "))).resolves.toEqual({ ok: true });
  });

  it.each([
    ["no header", null, "missing_header"],
    ["an empty header", "", "missing_header"],
    ["no h1", `ts=${TS}`, "malformed_header"],
    ["no ts", `h1=${"a".repeat(64)}`, "malformed_header"],
    ["two ts", `ts=${TS};ts=${TS};h1=${"a".repeat(64)}`, "malformed_header"],
    ["a non-numeric ts", `ts=soon;h1=${"a".repeat(64)}`, "malformed_header"],
    ["upper-case hex", `ts=${TS};h1=${"A".repeat(64)}`, "malformed_header"],
    ["a short h1", `ts=${TS};h1=${"a".repeat(63)}`, "malformed_header"],
    ["a part without =", `ts=${TS};h1`, "malformed_header"],
    [
      "an oversized header",
      `ts=${TS};${"x=1;".repeat(600)}h1=${"a".repeat(64)}`,
      "malformed_header",
    ],
  ])("rejects %s", async (_, header, reason) => {
    await expect(verify(header)).resolves.toEqual({ ok: false, reason });
  });
});

describe("parsePaddleEnvelope", () => {
  it("reads the identity and routing fields, keeping milliseconds", () => {
    expect(parsePaddleEnvelope(webhookBody)).toEqual({
      eventId: webhookBody.event_id,
      eventType: "subscription.updated",
      occurredAt: Date.parse("2026-10-05T12:00:00.123Z"),
      notificationId: webhookBody.notification_id,
      entityId: webhookBody.data.id,
      subscriptionId: null,
      customerId: webhookBody.data.customer_id,
    });
  });

  it("reads a transaction's subscription and an event without customer", () => {
    const transaction = {
      ...webhookBody,
      event_type: "transaction.completed",
      data: {
        id: "txn_01jcheckout000000000000001",
        subscription_id: webhookBody.data.id,
        customer_id: null,
      },
    };
    expect(parsePaddleEnvelope(transaction)).toMatchObject({
      entityId: "txn_01jcheckout000000000000001",
      subscriptionId: webhookBody.data.id,
      customerId: null,
    });
    const apiKey = {
      ...webhookBody,
      event_type: "api_key.revoked",
      data: { id: "apikey_01jkey00000000000000000001" },
    };
    expect(parsePaddleEnvelope(apiKey)).toMatchObject({ eventType: "api_key.revoked" });
  });

  it.each([
    ["no object", null],
    ["a bad event ID", { ...webhookBody, event_id: "evt_1" }],
    ["a bad event type", { ...webhookBody, event_type: "Subscription Updated" }],
    ["a bad time", { ...webhookBody, occurred_at: "yesterday" }],
    ["no notification ID", { ...webhookBody, notification_id: undefined }],
    ["no data ID", { ...webhookBody, data: { customer_id: webhookBody.data.customer_id } }],
    ["a bad subscription ID", { ...webhookBody, data: { id: "txn_x", subscription_id: "sub_1" } }],
  ])("refuses %s", (_, payload) => {
    expect(() => parsePaddleEnvelope(payload)).toThrow(InvalidPaddleWebhookError);
  });
});

const START = Date.parse("2026-10-01T09:00:00Z");
const END = Date.parse("2026-11-01T09:00:00Z");
const UPDATED = Date.parse("2026-10-05T12:00:00Z");
const BASE: PaddleSubscription = {
  id: "sub_01jcourse00000000000000001",
  customerId: "ctm_01jjo000000000000000000001",
  status: "active",
  items: [
    { priceId: "pri_a", status: "active" },
    { priceId: "pri_b", status: "trialing" },
    { priceId: "pri_c", status: "inactive" },
    { priceId: "pri_a", status: "active" },
  ],
  currentBillingPeriod: { startsAt: START, endsAt: END },
  scheduledChange: null,
  canceledAt: null,
  updatedAt: UPDATED,
  customData: null,
};

describe("normalizePaddleSubscription", () => {
  it("keeps active and trialing items once, and the period and update time", () => {
    expect(normalizePaddleSubscription(BASE)).toEqual({
      snapshot: {
        externalSubscriptionId: BASE.id,
        externalCustomerId: BASE.customerId,
        items: ["pri_a", "pri_b"],
        state: "active",
        providerState: "active",
        currentPeriodStart: START,
        currentPeriodEnd: END,
        cancelAt: null,
        endedAt: null,
        pastDueSince: null,
        sourceUpdatedAt: UPDATED,
      },
      claimReference: null,
    });
  });

  it.each([
    ["trialing", {}, {}],
    ["past_due", {}, { pastDueSince: UPDATED }],
    [
      "paused",
      { currentBillingPeriod: null },
      { currentPeriodStart: null, currentPeriodEnd: null },
    ],
    [
      "canceled",
      { currentBillingPeriod: null, canceledAt: END },
      { currentPeriodStart: null, currentPeriodEnd: null, endedAt: END },
    ],
  ] as const)("maps status %s", (status, input, expected) => {
    const { snapshot } = normalizePaddleSubscription({ ...BASE, status, ...input });
    expect(snapshot).toMatchObject({ state: status, providerState: status, ...expected });
    if (status !== "past_due") expect(snapshot.pastDueSince).toBeNull();
  });

  it.each([
    ["cancel", END],
    ["pause", null],
    ["resume", null],
  ] as const)("maps a scheduled %s", (action, cancelAt) => {
    const { snapshot } = normalizePaddleSubscription({
      ...BASE,
      scheduledChange: { action, effectiveAt: END },
    });
    expect(snapshot.cancelAt).toBe(cancelAt);
  });

  it("throws malformed when the facts break the snapshot invariants", () => {
    for (const broken of [
      { ...BASE, status: "canceled" as const, canceledAt: null },
      { ...BASE, currentBillingPeriod: { startsAt: END, endsAt: START } },
    ]) {
      expect(() => normalizePaddleSubscription(broken)).toThrow(PaddleApiError);
    }
  });

  it.each([
    ["a reference", { sharerepo_claim: "v1.abc.def" }, "v1.abc.def"],
    [
      "the longest reference",
      { sharerepo_claim: "r".repeat(CLAIM_REFERENCE_MAX_LENGTH) },
      "r".repeat(256),
    ],
    ["a too-long value", { sharerepo_claim: "r".repeat(CLAIM_REFERENCE_MAX_LENGTH + 1) }, null],
    ["an empty value", { sharerepo_claim: "" }, null],
    ["a non-string value", { sharerepo_claim: { v: 1 } }, null],
    ["other custom data", { other: "x" }, null],
  ])("reads the claim reference from %s", (_, customData, expected) => {
    expect(normalizePaddleSubscription({ ...BASE, customData }).claimReference).toBe(expected);
  });
});
