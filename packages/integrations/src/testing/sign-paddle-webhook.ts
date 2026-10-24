import type { RawBody } from "../github/webhooks.ts";
import { hmacKey, signedPayload } from "../paddle/webhooks.ts";

/**
 * The `Paddle-Signature` value Paddle would send for this body, signed at `ts` (Unix seconds),
 * for tests. Several secrets produce several `h1` values, as Paddle promises during rotation.
 */
export async function signPaddleWebhook(
  secrets: string | readonly string[],
  rawBody: RawBody,
  ts: number,
): Promise<string> {
  const signed = signedPayload(ts, rawBody);
  const parts = [`ts=${ts}`];
  for (const secret of typeof secrets === "string" ? [secrets] : secrets) {
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), signed),
    );
    parts.push(`h1=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`);
  }
  return parts.join(";");
}
