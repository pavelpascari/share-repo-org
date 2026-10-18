import { describe, expect, it } from "vitest";
import {
  InvalidWebhookError,
  parseWebhookEnvelope,
  payloadDigest,
  verifyWebhookSignature,
} from "../src/index.ts";
import { signWebhook } from "../src/testing/index.ts";

const SECRET = "webhook-secret-for-tests";
const BODY = JSON.stringify({ action: "created", installation: { id: 42 } });

describe("webhook/invalid-signature-rejected-before-persist", () => {
  it("accepts GitHub's signature over the exact raw body, in every body form", async () => {
    const header = await signWebhook(SECRET, BODY);
    const bytes = new TextEncoder().encode(BODY);
    await expect(verifyWebhookSignature(SECRET, BODY, header)).resolves.toBe(true);
    await expect(verifyWebhookSignature(SECRET, bytes, header)).resolves.toBe(true);
    await expect(verifyWebhookSignature(SECRET, bytes.buffer as ArrayBuffer, header)).resolves.toBe(
      true,
    );
    expect(await signWebhook(SECRET, bytes)).toBe(header);
  });

  it.each([
    ["a wrong secret", async () => signWebhook("another-secret", BODY), BODY],
    ["a tampered body", async () => signWebhook(SECRET, BODY), `${BODY} `],
    ["a missing header", async () => null, BODY],
    ["a sha1 header", async () => `sha1=${"a".repeat(40)}`, BODY],
    ["malformed hex", async () => `sha256=${"z".repeat(64)}`, BODY],
    ["upper-case hex", async () => (await signWebhook(SECRET, BODY)).toUpperCase(), BODY],
    ["a short digest", async () => (await signWebhook(SECRET, BODY)).slice(0, 40), BODY],
  ])("rejects %s", async (_, header, body) => {
    await expect(verifyWebhookSignature(SECRET, body, await header())).resolves.toBe(false);
  });
});

describe("payloadDigest", () => {
  it("is the hex SHA-256 of the raw body", async () => {
    await expect(payloadDigest("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("parseWebhookEnvelope", () => {
  const headers = (event = "installation", delivery = "72d3162e-cc78-11e3-81ab-4c9367dc0958") =>
    new Headers({ "x-github-event": event, "x-github-delivery": delivery });

  it("reads delivery ID, event, action and installation ID", () => {
    expect(parseWebhookEnvelope(headers(), JSON.parse(BODY))).toEqual({
      deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      event: "installation",
      action: "created",
      installationId: "42",
    });
  });

  it("allows events without an action or installation", () => {
    expect(parseWebhookEnvelope(headers("ping"), { zen: "Keep it simple." })).toMatchObject({
      action: null,
      installationId: null,
    });
  });

  it.each([
    ["no event header", new Headers({ "x-github-delivery": "abc" }), {}],
    ["no delivery header", new Headers({ "x-github-event": "ping" }), {}],
    ["an odd event name", headers("Ping!"), {}],
    ["an odd delivery ID", headers("ping", "../etc"), {}],
    ["a non-object payload", headers(), "text"],
    ["a non-numeric installation", headers(), { installation: { id: "42" } }],
  ])("rejects %s", (_, h, payload) => {
    expect(() => parseWebhookEnvelope(h, payload)).toThrow(InvalidWebhookError);
  });
});
