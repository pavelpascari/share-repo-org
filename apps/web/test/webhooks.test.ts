import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { randomIds, systemClock } from "@sharerepo/domain";
import { signWebhook } from "@sharerepo/integrations/testing";
import { createLogger } from "@sharerepo/platform";
import { describe, expect, it } from "vitest";
import { parseWebEnv, type WebEnv } from "../workers/env.ts";
import { handleGitHubWebhook, MAX_WEBHOOK_BYTES } from "../workers/webhooks.ts";

const SECRET = "test-webhook-secret";

async function pkcs8Pem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const base64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
}

async function harness(options: { configured?: boolean; sendFails?: boolean } = {}) {
  const sent: unknown[] = [];
  const lines: string[] = [];
  const record = (line: string) => {
    lines.push(line);
  };
  const raw = {
    ...env,
    EVENTS: {
      send: async (message: unknown) => {
        if (options.sendFails) throw new Error("queue unavailable");
        sent.push(message);
      },
    },
    ...(options.configured === false
      ? {}
      : {
          GITHUB_APP_ID: "1000",
          GITHUB_APP_SLUG: "sharerepo-test",
          GITHUB_APP_PRIVATE_KEY: await pkcs8Pem(),
          GITHUB_WEBHOOK_SECRET: SECRET,
        }),
  };
  const webEnv: WebEnv = parseWebEnv(raw);
  const correlationId = `corr-${crypto.randomUUID()}`;
  const logger = createLogger(
    { correlationId },
    { sink: { debug: record, info: record, warn: record, error: record } },
  );
  const call = async (request: Request) => {
    const ctx = createExecutionContext();
    const response = await handleGitHubWebhook(request, webEnv, ctx, {
      ids: randomIds,
      clock: systemClock,
      correlationId,
      logger,
    });
    await waitOnExecutionContext(ctx);
    return response;
  };
  return { call, sent, lines };
}

async function delivery(body: string, options: { secret?: string; deliveryId?: string } = {}) {
  return new Request("https://sharerepo.test/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-delivery": options.deliveryId ?? crypto.randomUUID(),
      "x-github-event": "installation",
      "x-hub-signature-256": await signWebhook(options.secret ?? SECRET, body),
      "content-type": "application/json",
    },
    body,
  });
}

const BODY = JSON.stringify({ action: "created", installation: { id: 77 } });

describe("POST /webhooks/github", () => {
  it("accepts a signed delivery and hands it to the jobs queue", async () => {
    const { call, sent } = await harness();
    const response = await call(await delivery(BODY));
    expect(response.status).toBe(202);
    expect(sent).toEqual([
      {
        kind: "process_external_event",
        subjectId: expect.any(String),
        outboxId: expect.any(String),
      },
    ]);
  });

  it("answers a redelivery with 200 and enqueues nothing", async () => {
    const { call, sent } = await harness();
    const deliveryId = crypto.randomUUID();
    await call(await delivery(BODY, { deliveryId }));
    const again = await call(await delivery(BODY, { deliveryId }));
    expect(again.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("rejects a bad signature with 401 and logs only a classification", async () => {
    const { call, sent, lines } = await harness();
    const response = await call(await delivery(BODY, { secret: "wrong" }));
    expect(response.status).toBe(401);
    expect(sent).toEqual([]);
    expect(lines.join("\n")).not.toContain("installation");
  });

  it("refuses oversized payloads, declared or actual", async () => {
    const { call } = await harness();
    const declared = await delivery(BODY);
    const big = new Request(declared, {
      headers: {
        ...Object.fromEntries(declared.headers),
        "content-length": String(MAX_WEBHOOK_BYTES + 1),
      },
    });
    expect((await call(big)).status).toBe(413);
    const actual = "x".repeat(MAX_WEBHOOK_BYTES + 1);
    const sneaky = new Request("https://sharerepo.test/webhooks/github", {
      method: "POST",
      body: actual,
    });
    expect((await call(sneaky)).status).toBe(413);
  });

  it("answers 503 when the GitHub App is not configured", async () => {
    const { call } = await harness({ configured: false });
    expect((await call(await delivery(BODY))).status).toBe(503);
  });

  it("still accepts when the queue send fails: the outbox drain delivers", async () => {
    const { call, lines } = await harness({ sendFails: true });
    expect((await call(await delivery(BODY))).status).toBe(202);
    expect(lines.join("\n")).toContain("queue send failed");
  });
});
