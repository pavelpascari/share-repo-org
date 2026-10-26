import {
  ingestGitHubWebhook,
  ingestPaddleWebhook,
  type ServiceContext,
} from "@sharerepo/application";
import { createDb } from "@sharerepo/db";
import type { Clock, IdGenerator, OutboxKind } from "@sharerepo/domain";
import type { Logger } from "@sharerepo/platform";
import type { WebEnv } from "./env.ts";

/** GitHub caps webhook payloads at 25 MB; ours (installation and repository events) are small. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;

/** The message the jobs Worker consumes (apps/jobs/src/messages.ts has the same shape). */
export interface JobMessage {
  readonly kind: OutboxKind;
  readonly subjectId: string;
  readonly outboxId: string;
}

export interface WebhookDeps {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly correlationId: string;
  readonly logger: Logger;
}

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * `POST /webhooks/github`, before React Router: no session, the raw body as GitHub signed it.
 * Signature first (401), then a durable receipt (202, or 200 for a redelivery), then a
 * best-effort queue send; the jobs Worker's outbox drain covers a failed send.
 */
export async function handleGitHubWebhook(
  request: Request,
  env: WebEnv,
  ctx: ExecutionContext,
  deps: WebhookDeps,
): Promise<Response> {
  const secret = env.github?.webhookSecret;
  if (secret === undefined) return text(503, "GitHub is not configured.");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_WEBHOOK_BYTES) return text(413, "Payload too large.");
  const rawBody = await readBounded(request, MAX_WEBHOOK_BYTES);
  if (rawBody === null) return text(413, "Payload too large.");

  const services: ServiceContext = {
    db: createDb(env.DB),
    ids: deps.ids,
    clock: deps.clock,
    correlationId: deps.correlationId,
  };
  // While a rotation is under way, the previous secret is accepted too (Phase 6, secret rotation).
  const previous = env.github?.webhookSecretPrevious;
  const secrets = previous === undefined ? [secret] : [secret, previous];
  const result = await ingestGitHubWebhook(services, {
    secrets,
    rawBody,
    headers: request.headers,
  });
  if (result.status === "rejected") {
    deps.logger.warn("webhook rejected", { provider: "github" });
    return text(401, "Invalid signature.");
  }
  if (result.status === "duplicate") return text(200, "Already received.");

  sendBestEffort(env, ctx, deps.logger, {
    kind: "process_external_event",
    subjectId: result.eventId,
    outboxId: result.outboxId,
  });
  return text(202, "Accepted.");
}

/** Connection IDs are ours; anything else is not one, and is answered without a lookup. */
const CONNECTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `POST /webhooks/paddle/:connectionId`, before React Router (decision 0011). The connection in
 * the URL selects the secret; the signature is verified on the raw body before anything is
 * stored. Unknown or disconnected connection 404, bad signature 401, signed but unreadable 400,
 * recorded or already recorded 200 (Paddle retries anything else). Then a best-effort queue send.
 * Bodies and headers are never logged.
 */
export async function handlePaddleWebhook(
  request: Request,
  connectionId: string,
  env: WebEnv,
  ctx: ExecutionContext,
  deps: WebhookDeps,
): Promise<Response> {
  if (env.commerce === null) return text(503, "Paddle is not configured.");
  if (!CONNECTION_ID.test(connectionId)) return text(404, "Not found.");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_WEBHOOK_BYTES) return text(413, "Payload too large.");
  const rawBody = await readBounded(request, MAX_WEBHOOK_BYTES);
  if (rawBody === null) return text(413, "Payload too large.");

  const services: ServiceContext = {
    db: createDb(env.DB),
    ids: deps.ids,
    clock: deps.clock,
    correlationId: deps.correlationId,
  };
  const result = await ingestPaddleWebhook(
    services,
    { connectionId, rawBody, signatureHeader: request.headers.get("paddle-signature") },
    { credentialKeys: env.commerce.credentialKeys },
  );
  switch (result.status) {
    case "not_found":
      return text(404, "Not found.");
    case "invalid_signature":
      deps.logger.warn("webhook rejected", { provider: "paddle" });
      return text(401, "Invalid signature.");
    case "malformed":
      deps.logger.warn("webhook malformed", { provider: "paddle" });
      return text(400, "Malformed event.");
    case "duplicate":
      return text(200, "Already received.");
    case "accepted":
      sendBestEffort(env, ctx, deps.logger, {
        kind: "process_external_event",
        subjectId: result.eventId,
        outboxId: result.outboxId,
      });
      return text(200, "Accepted.");
  }
}

function sendBestEffort(env: WebEnv, ctx: ExecutionContext, logger: Logger, message: JobMessage) {
  ctx.waitUntil(
    env.EVENTS.send(message).catch(() =>
      logger.warn("queue send failed; the outbox drain will deliver", {
        outboxId: message.outboxId,
      }),
    ),
  );
}

/**
 * Reads the body, stopping as soon as it exceeds `limit`: a chunked request without a
 * Content-Length must not be buffered whole before the size check. Null means too large.
 */
export async function readBounded(request: Request, limit: number): Promise<ArrayBuffer | null> {
  if (request.body === null) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}
