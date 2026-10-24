import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { disconnectPaddle } from "@sharerepo/application";
import { randomIds, systemClock } from "@sharerepo/domain";
import { signPaddleWebhook } from "@sharerepo/integrations/testing";
import { createLogger } from "@sharerepo/platform";
import { describe, expect, it } from "vitest";
import { parseWebEnv } from "../workers/env.ts";
import { createFetchHandler } from "../workers/handler.ts";
import { handlePaddleWebhook, MAX_WEBHOOK_BYTES } from "../workers/webhooks.ts";
import { type PaddleShop, paddleShop, settingOf } from "./support/paddle.ts";
import { services } from "./support/shop.ts";

// `POST /webhooks/paddle/:connectionId` (decision 0011), against local D1 and FakePaddle's
// signed deliveries.

function harness(options: { configured?: boolean; sendFails?: boolean } = {}) {
  const sent: unknown[] = [];
  const lines: string[] = [];
  const record = (line: string) => {
    lines.push(line);
  };
  const raw: Record<string, unknown> = {
    ...env,
    EVENTS: {
      send: async (message: unknown) => {
        if (options.sendFails) throw new Error("queue unavailable");
        sent.push(message);
      },
    },
  };
  if (options.configured === false) {
    delete raw.CREDENTIAL_KEYS;
    delete raw.CLAIM_SIGNING_KEY;
  }
  const webEnv = parseWebEnv(raw);
  const logger = createLogger(
    { correlationId: `corr-${crypto.randomUUID()}` },
    { sink: { debug: record, info: record, warn: record, error: record } },
  );
  const call = async (connectionId: string, request: Request) => {
    const ctx = createExecutionContext();
    const response = await handlePaddleWebhook(request, connectionId, webEnv, ctx, {
      ids: randomIds,
      clock: systemClock,
      correlationId: "corr-webhook",
      logger,
    });
    await waitOnExecutionContext(ctx);
    return response;
  };
  return { call, sent, lines };
}

function request(body: string, signature: string | null, headers: Record<string, string> = {}) {
  return new Request("https://sharerepo.test/webhooks/paddle/x", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature === null ? {} : { "paddle-signature": signature }),
      ...headers,
    },
    body,
  });
}

async function delivery(s: PaddleShop) {
  const customer = s.paddle.addCustomer({ email: `buyer-${crypto.randomUUID()}@example.com` });
  const subscription = s.paddle.createSubscription({
    customerId: customer.id,
    priceIds: [s.price.id],
  });
  return s.paddle.emitSubscriptionEvent(
    await settingOf(s),
    "subscription.created",
    subscription.id,
  );
}

async function receipts(connectionId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM external_events WHERE connection_id = ?",
  )
    .bind(connectionId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("POST /webhooks/paddle/:connectionId", () => {
  it("accepts a signed delivery with 200 and hands it to the jobs queue", async () => {
    const s = await paddleShop();
    const { call, sent } = harness();
    const d = await delivery(s);
    const response = await call(s.connectionId, request(d.rawBody, d.signature));
    expect(response.status).toBe(200);
    expect(sent).toEqual([
      {
        kind: "process_external_event",
        subjectId: expect.any(String),
        outboxId: expect.any(String),
      },
    ]);
    expect(await receipts(s.connectionId)).toBe(1);
  });

  it("answers a duplicate (a retry or a replay) with 200 and enqueues nothing more", async () => {
    const s = await paddleShop();
    const { call, sent } = harness();
    const d = await delivery(s);
    await call(s.connectionId, request(d.rawBody, d.signature));
    const again = await call(s.connectionId, request(d.rawBody, d.signature));
    expect(again.status).toBe(200);
    const replay = await s.paddle.replay(d);
    expect((await call(s.connectionId, request(replay.rawBody, replay.signature))).status).toBe(
      200,
    );
    expect(sent).toHaveLength(1);
    expect(await receipts(s.connectionId)).toBe(1);
  });

  it("webhook/invalid-signature-rejected-before-persist: 401 and nothing stored or logged", async () => {
    const s = await paddleShop();
    const other = await paddleShop();
    const { call, sent, lines } = harness();
    const d = await delivery(s);
    // Signed by another connection's secret, tampered, or unsigned.
    const foreign = await delivery(other);
    expect((await call(s.connectionId, request(foreign.rawBody, foreign.signature))).status).toBe(
      401,
    );
    expect((await call(s.connectionId, request(`${d.rawBody} `, d.signature))).status).toBe(401);
    expect((await call(s.connectionId, request(d.rawBody, null))).status).toBe(401);
    expect(sent).toEqual([]);
    expect(await receipts(s.connectionId)).toBe(0);
    const logged = lines.join("\n");
    expect(logged).toContain("webhook rejected");
    expect(logged).not.toContain(d.rawBody.slice(0, 40));
    expect(logged).not.toContain("paddle-signature");
    expect(logged).not.toContain(d.signature);
  });

  it("answers 400 to a signed body that is not a Paddle event, storing nothing", async () => {
    const s = await paddleShop();
    const { call } = harness();
    // A body that is not an envelope, signed with the destination's secret.
    const body = JSON.stringify({ hello: "world" });
    const signature = await signPaddleWebhook(
      s.paddle.secretOf(await settingOf(s)),
      body,
      Math.floor(Date.now() / 1000),
    );
    expect((await call(s.connectionId, request(body, signature))).status).toBe(400);
    expect(await receipts(s.connectionId)).toBe(0);
  });

  it("answers 404 for an unknown, malformed or disconnected connection", async () => {
    const s = await paddleShop();
    const { call } = harness();
    const d = await delivery(s);
    expect((await call(crypto.randomUUID(), request(d.rawBody, d.signature))).status).toBe(404);
    expect((await call("../etc", request(d.rawBody, d.signature))).status).toBe(404);
    await disconnectPaddle(services(), s.owner, s.slug, s.deps);
    expect((await call(s.connectionId, request(d.rawBody, d.signature))).status).toBe(404);
    expect(await receipts(s.connectionId)).toBe(0);
  });

  it("refuses bodies over 1 MB, declared or actual, before reading the connection", async () => {
    const { call } = harness();
    const declared = request("{}", "ts=1;h1=x", {
      "content-length": String(MAX_WEBHOOK_BYTES + 1),
    });
    expect((await call(crypto.randomUUID(), declared)).status).toBe(413);
    const big = request("x".repeat(MAX_WEBHOOK_BYTES + 1), "ts=1;h1=x");
    expect((await call(crypto.randomUUID(), big)).status).toBe(413);
  });

  it("answers 503 when Paddle is not configured", async () => {
    const { call } = harness({ configured: false });
    expect((await call(crypto.randomUUID(), request("{}", null))).status).toBe(503);
  });

  it("still answers 200 when the queue send fails: the outbox drain delivers", async () => {
    const s = await paddleShop();
    const { call, lines } = harness({ sendFails: true });
    const d = await delivery(s);
    expect((await call(s.connectionId, request(d.rawBody, d.signature))).status).toBe(200);
    expect(lines.join("\n")).toContain("queue send failed");
  });

  it("is routed before React Router, POST only", async () => {
    const s = await paddleShop();
    const handler = createFetchHandler({
      renderApp: () => Promise.reject(new Error("must not render")),
    });
    const ctx = createExecutionContext();
    const d = await delivery(s);
    const url = `https://sharerepo.test/webhooks/paddle/${s.connectionId}`;
    const response = await handler(
      new Request(url, {
        method: "POST",
        headers: { "paddle-signature": d.signature },
        body: d.rawBody,
      }),
      { ...env, EVENTS: { send: async () => {} } },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const get = await handler(new Request(url), env, ctx);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });
});
