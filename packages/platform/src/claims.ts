// Purchase-claim cryptography (decision 0012): the signed checkout reference that travels through
// Paddle, the keyed email and IP hashes that feed rate limits, and single-use claim tokens.
// WebCrypto only. Every MAC is keyed with `CLAIM_SIGNING_KEY`; each use has its own message
// prefix, so a value computed for one purpose never equals a value for another.

const encoder = new TextEncoder();

/** Claim references are at most this long (Paddle's custom data is bounded; decision 0012). */
export const CLAIM_REFERENCE_MAX_LENGTH = 256;

const REFERENCE_VERSION = "v1";
// `v1.<checkoutClaimId>.<mac>`: the ID is an opaque identifier without dots; the MAC is 32 bytes
// as unpadded base64url (43 characters, the last carrying 4 bits, so only one spelling decodes to
// a given MAC).
const REFERENCE = /^v1\.([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;
const SIGNED_PART = /^[A-Za-z0-9_-]{1,128}$/;

/** A claim token: 32 random bytes as unpadded base64url. */
const CLAIM_TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const standard = text.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(standard), (char) => char.charCodeAt(0));
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hmacKey(key: Uint8Array, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

async function hmacHex(key: Uint8Array, message: string): Promise<string> {
  return toHex(
    await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), encoder.encode(message)),
  );
}

/** What a checkout reference is bound to. */
export interface ClaimReferenceBinding {
  workspaceId: string;
  checkoutClaimId: string;
  userId: string;
  offerId: string;
}

/**
 * `v1|workspaceId|checkoutClaimId|userId|offerId`. Parts are identifiers; one that could contain
 * the separator would make two bindings share a message, so it is refused.
 */
function referenceMessage(binding: ClaimReferenceBinding): string {
  const parts = [binding.workspaceId, binding.checkoutClaimId, binding.userId, binding.offerId];
  if (!parts.every((part) => SIGNED_PART.test(part))) {
    throw new Error("Claim reference parts must be identifiers");
  }
  return [REFERENCE_VERSION, ...parts].join("|");
}

/**
 * The checkout reference `v1.<checkoutClaimId>.<mac>`, where the MAC is HMAC-SHA256 over
 * `v1|workspaceId|checkoutClaimId|userId|offerId` as unpadded base64url.
 */
export async function signClaimReference(
  input: ClaimReferenceBinding & { key: Uint8Array },
): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(input.key, "sign"),
    encoder.encode(referenceMessage(input)),
  );
  return `${REFERENCE_VERSION}.${input.checkoutClaimId}.${toBase64Url(new Uint8Array(mac))}`;
}

export type ParsedClaimReference =
  | { ok: true; checkoutClaimId: string; mac: string }
  | { ok: false };

/**
 * Reads the checkout claim ID out of a reference without verifying it, so the caller can load
 * the claim whose workspace, user and offer the MAC must then match. Strict: anything that is not
 * exactly `v1.<id>.<43 base64url characters>`, at most 256 characters, is invalid.
 */
export function parseClaimReference(reference: unknown): ParsedClaimReference {
  if (typeof reference !== "string" || reference.length > CLAIM_REFERENCE_MAX_LENGTH) {
    return { ok: false };
  }
  const match = REFERENCE.exec(reference);
  return match === null
    ? { ok: false }
    : { ok: true, checkoutClaimId: match[1] as string, mac: match[2] as string };
}

/**
 * True when `reference` is the reference for exactly this workspace, checkout claim, user and
 * offer. The MAC comparison is WebCrypto's HMAC verify, which is constant time.
 */
export async function verifyClaimReference(input: {
  key: Uint8Array;
  reference: unknown;
  workspaceId: string;
  userId: string;
  offerId: string;
}): Promise<boolean> {
  const parsed = parseClaimReference(input.reference);
  if (!parsed.ok) return false;
  const { workspaceId, userId, offerId } = input;
  if (![workspaceId, userId, offerId].every((part) => SIGNED_PART.test(part))) return false;
  const message = referenceMessage({
    workspaceId,
    checkoutClaimId: parsed.checkoutClaimId,
    userId,
    offerId,
  });
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(input.key, "verify"),
    fromBase64Url(parsed.mac),
    encoder.encode(message),
  );
}

/**
 * The keyed hash of an email for rate-limit buckets: HMAC-SHA256 of the trimmed, lower-cased
 * address (with a purpose prefix), as 64 lowercase hex characters. Never displayed.
 */
export function hashClaimEmail(key: Uint8Array, email: string): Promise<string> {
  return hmacHex(key, `email|${email.trim().toLowerCase()}`);
}

/** The keyed hash of a client IP for rate-limit buckets, as 64 lowercase hex characters. */
export function hashIp(key: Uint8Array, ip: string): Promise<string> {
  return hmacHex(key, `ip|${ip.trim().toLowerCase()}`);
}

/** SHA-256 of a claim token, as 64 lowercase hex characters: the only form that is stored. */
export async function hashClaimToken(token: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

/** True when `value` has the shape of a claim token (a route parameter is checked before use). */
export function isClaimToken(value: unknown): value is string {
  return typeof value === "string" && CLAIM_TOKEN.test(value);
}

/** A new claim token (256 random bits, base64url) and the hash to store. */
export async function newClaimToken(): Promise<{ token: string; hash: string }> {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { token, hash: await hashClaimToken(token) };
}
