import { z } from "zod";
import { InvalidWebhookError } from "./errors.ts";

// GitHub webhook deliveries: `X-Hub-Signature-256: sha256=<hex HMAC of the raw body>`.
// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries

export type RawBody = ArrayBuffer | Uint8Array | string;

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

function bytes(body: RawBody): Uint8Array<ArrayBuffer> {
  if (typeof body === "string") return Uint8Array.from(new TextEncoder().encode(body));
  return Uint8Array.from(body instanceof Uint8Array ? body : new Uint8Array(body));
}

/**
 * Verifies the delivery's signature over the exact raw body. Uses `crypto.subtle.verify`, which
 * compares in constant time. Anything but a well-formed `sha256=` header is rejected.
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: RawBody,
  header: string | null,
): Promise<boolean> {
  const match = header === null ? null : SIGNATURE.exec(header);
  if (match === null) return false;
  const signature = new Uint8Array(32);
  const hex = match[1] as string;
  for (let i = 0; i < 32; i += 1) signature[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, bytes(rawBody));
}

/** Hex SHA-256 of the raw body: what ShareRepo stores instead of the payload. */
export async function payloadDigest(rawBody: RawBody): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes(rawBody));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface WebhookEnvelope {
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string | null;
  readonly installationId: string | null;
}

const headersSchema = z.object({
  deliveryId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9-]+$/),
  event: z.string().regex(/^[a-z_]{1,64}$/),
});
const payloadSchema = z
  .object({
    action: z.string().min(1).max(64).optional(),
    installation: z
      .object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
      .loose()
      .optional(),
  })
  .loose();

/** The delivery's identity and routing fields. Throws `InvalidWebhookError` otherwise. */
export function parseWebhookEnvelope(headers: Headers, payload: unknown): WebhookEnvelope {
  const head = headersSchema.safeParse({
    deliveryId: headers.get("x-github-delivery"),
    event: headers.get("x-github-event"),
  });
  const body = payloadSchema.safeParse(payload);
  if (!head.success || !body.success) throw new InvalidWebhookError();
  return {
    deliveryId: head.data.deliveryId,
    event: head.data.event,
    action: body.data.action ?? null,
    installationId: body.data.installation === undefined ? null : String(body.data.installation.id),
  };
}
