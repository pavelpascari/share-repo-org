import type { Instant } from "@sharerepo/domain";
import { z } from "zod";
import type { RawBody } from "../github/webhooks.ts";
import { InvalidPaddleWebhookError } from "./errors.ts";

// Paddle webhook deliveries: `Paddle-Signature: ts=<unix seconds>;h1=<hex HMAC-SHA256>`, the MAC
// over `${ts}:${rawBody}` keyed with the destination's secret (research § 3, decision 0011).
// https://developer.paddle.com/webhooks/about/signature-verification

/** A delivery may be signed at most this far ahead of our clock (skew). */
export const PADDLE_SIGNATURE_MAX_FUTURE_MS = 5 * 60 * 1000;
/** …and at most this long ago: live retries span about 2 days (decision 0011). */
export const PADDLE_SIGNATURE_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const MAX_HEADER_LENGTH = 2048;

export type PaddleSignatureFailure =
  | "missing_header"
  | "malformed_header"
  | "timestamp_too_old"
  | "timestamp_in_future"
  | "signature_mismatch";

export type PaddleSignatureResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PaddleSignatureFailure };

export interface VerifyPaddleSignatureInput {
  /** The `Paddle-Signature` header, or null when absent. */
  readonly header: string | null;
  /** The body exactly as received, before any parsing. */
  readonly rawBody: RawBody;
  /** Every secret currently accepted for the connection (more than one during rotation). */
  readonly secrets: readonly string[];
  readonly now: Instant;
}

/**
 * Verifies a delivery before anything is parsed or persisted. The delivery is accepted when any
 * `h1` matches under any secret; each comparison uses `crypto.subtle.verify`, which is constant
 * time. The timestamp window is checked first, so stale or future deliveries cost no MACs.
 */
export async function verifyPaddleSignature(
  input: VerifyPaddleSignatureInput,
): Promise<PaddleSignatureResult> {
  if (input.header === null || input.header === "") return failed("missing_header");
  const parsed = parseSignatureHeader(input.header);
  if (parsed === null) return failed("malformed_header");
  const signedAt = parsed.ts * 1000;
  if (signedAt > input.now + PADDLE_SIGNATURE_MAX_FUTURE_MS) return failed("timestamp_in_future");
  if (signedAt < input.now - PADDLE_SIGNATURE_MAX_AGE_MS) return failed("timestamp_too_old");

  const signed = signedPayload(parsed.ts, input.rawBody);
  for (const secret of input.secrets) {
    const key = await hmacKey(secret, "verify");
    for (const mac of parsed.h1) {
      if (await crypto.subtle.verify("HMAC", key, mac, signed)) return { ok: true };
    }
  }
  return failed("signature_mismatch");
}

const failed = (reason: PaddleSignatureFailure): PaddleSignatureResult => ({ ok: false, reason });

/**
 * `ts=…;h1=…[;h1=…]`: exactly one `ts` and at least one `h1` (64 lower-case hex). Unknown keys,
 * such as a future scheme, are ignored; a malformed known field rejects the header.
 */
function parseSignatureHeader(
  header: string,
): { ts: number; h1: Uint8Array<ArrayBuffer>[] } | null {
  if (header.length > MAX_HEADER_LENGTH) return null;
  let ts: number | null = null;
  const h1: Uint8Array<ArrayBuffer>[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) return null;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === "ts") {
      if (ts !== null || !/^\d{1,12}$/.test(value)) return null;
      ts = Number(value);
    } else if (name === "h1") {
      if (!/^[0-9a-f]{64}$/.test(value)) return null;
      h1.push(hexBytes(value));
    }
  }
  return ts === null || h1.length === 0 ? null : { ts, h1 };
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** What Paddle signs: `${ts}:` followed by the raw body bytes. */
export function signedPayload(ts: number, rawBody: RawBody): Uint8Array<ArrayBuffer> {
  const body = bytes(rawBody);
  const prefix = new TextEncoder().encode(`${ts}:`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  return signed;
}

function bytes(body: RawBody): Uint8Array<ArrayBuffer> {
  if (typeof body === "string") return Uint8Array.from(new TextEncoder().encode(body));
  return Uint8Array.from(body instanceof Uint8Array ? body : new Uint8Array(body));
}

export function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** The fields ShareRepo keeps from a delivery; the payload itself is never stored. */
export interface PaddleEnvelope {
  /** `evt_…`: the dedupe key, scoped to the connection. A replay keeps it. */
  readonly eventId: string;
  /** `entity.action`, such as `subscription.updated`. */
  readonly eventType: string;
  readonly occurredAt: Instant;
  /** `ntf_…`: differs per destination and per replay. */
  readonly notificationId: string;
  /** The entity's ID (`sub_…`, `txn_…`, `ctm_…`, `apikey_…`). */
  readonly entityId: string;
  /** Set on transaction events once Paddle created the subscription. */
  readonly subscriptionId: string | null;
  readonly customerId: string | null;
}

const paddleId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z\\d]{26}$`));
const envelopeSchema = z.object({
  event_id: paddleId("evt"),
  event_type: z.string().regex(/^[a-z_]{1,64}\.[a-z_]{1,64}$/),
  occurred_at: z.iso.datetime({ offset: true }).transform((value) => Date.parse(value)),
  notification_id: paddleId("ntf"),
  data: z.object({
    id: z.string().regex(/^[a-z]{2,10}_[a-z\d]{26}$/),
    subscription_id: paddleId("sub").nullish(),
    customer_id: paddleId("ctm").nullish(),
  }),
});

/** The delivery's identity and routing fields. Throws `InvalidPaddleWebhookError` otherwise. */
export function parsePaddleEnvelope(payload: unknown): PaddleEnvelope {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) throw new InvalidPaddleWebhookError();
  const { data } = parsed.data;
  return {
    eventId: parsed.data.event_id,
    eventType: parsed.data.event_type,
    occurredAt: parsed.data.occurred_at,
    notificationId: parsed.data.notification_id,
    entityId: data.id,
    subscriptionId: data.subscription_id ?? null,
    customerId: data.customer_id ?? null,
  };
}
