import type { RawBody } from "../github/webhooks.ts";

/** The `X-Hub-Signature-256` value GitHub would send for this body, for tests. */
export async function signWebhook(secret: string, body: RawBody): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
