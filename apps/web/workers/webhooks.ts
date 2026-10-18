import { ingestGitHubWebhook, type ServiceContext } from "@sharerepo/application";
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
  const result = await ingestGitHubWebhook(services, { secret, rawBody, headers: request.headers });
  if (result.status === "rejected") {
    deps.logger.warn("webhook rejected", { provider: "github" });
    return text(401, "Invalid signature.");
  }
  if (result.status === "duplicate") return text(200, "Already received.");

  const message: JobMessage = {
    kind: "process_external_event",
    subjectId: result.eventId,
    outboxId: result.outboxId,
  };
  ctx.waitUntil(
    env.EVENTS.send(message).catch(() =>
      deps.logger.warn("queue send failed; the outbox drain will deliver", {
        outboxId: result.outboxId,
      }),
    ),
  );
  return text(202, "Accepted.");
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
