import { z } from "zod";
import { parseEnv } from "./env.ts";

/**
 * Master keys for tenant credential envelopes (decision 0011): `current` seals new envelopes,
 * and every listed key can still open older ones until it is retired.
 */
export interface CredentialKeyring {
  readonly current: string;
  /** AES-256 master keys (32 bytes) by key ID. */
  readonly keys: Readonly<Record<string, Uint8Array>>;
}

/**
 * HMAC keys for claim references and email hashes (decision 0012). `current` signs; while a key
 * is being rotated out, the others still verify what it signed (secret rotation, Phase 6).
 */
export interface ClaimSigningKeyring {
  readonly current: string;
  /** Keys of at least {@link CLAIM_SIGNING_KEY_MIN_BYTES} bytes, by key ID. */
  readonly keys: Readonly<Record<string, Uint8Array>>;
}

/** ShareRepo-owned secrets for Paddle connections and purchase claims (decisions 0011, 0012). */
export interface CommerceSecrets {
  /** From `CREDENTIAL_KEYS`: `{"current": "k2", "keys": {"k1": "<base64>", "k2": "<base64>"}}`. */
  readonly credentialKeys: CredentialKeyring;
  /**
   * From `CLAIM_SIGNING_KEY`: a keyring `{"current": "c2", "keys": {"c1": "<base64>", ...}}`, or
   * a single key as plain text (the Phase 5 format), which becomes the only key, with ID
   * {@link SINGLE_CLAIM_SIGNING_KEY_ID}.
   */
  readonly claimSigningKeys: ClaimSigningKeyring;
  /** The current claim signing key, which signs new references and hashes. */
  readonly claimSigningKey: Uint8Array;
}

export const CLAIM_SIGNING_KEY_MIN_BYTES = 32;

/**
 * The keyring's current key, which signs and hashes, and the other listed keys, which still
 * verify references and count rate limits while a rotation is under way (Phase 6, secret
 * rotation). Removing a key from `CLAIM_SIGNING_KEY` ends both.
 */
export function claimSigningKeysOf(keyring: ClaimSigningKeyring): {
  readonly current: Uint8Array;
  readonly retired: readonly Uint8Array[];
} {
  const retired = Object.entries(keyring.keys)
    .filter(([id]) => id !== keyring.current)
    .map(([, key]) => key);
  return { current: keyring.keys[keyring.current] as Uint8Array, retired };
}
/** The key ID of a `CLAIM_SIGNING_KEY` given as one plain-text key. */
export const SINGLE_CLAIM_SIGNING_KEY_ID = "single";

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
// Standard base64 of exactly 32 bytes: 43 characters and one padding character.
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

const keyringShape = z.strictObject({
  current: z.string().regex(KEY_ID),
  keys: z.record(z.string().regex(KEY_ID), z.string().regex(BASE64_32_BYTES)),
});

/**
 * Decodes a keyring, or returns null. Deliberately reports nothing about *why* it failed: the
 * input is a secret, and Zod issue paths would include key IDs taken from it.
 */
function decodeKeyring(raw: string): CredentialKeyring | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = keyringShape.safeParse(json);
  if (!parsed.success || !Object.hasOwn(parsed.data.keys, parsed.data.current)) return null;
  const keys: Record<string, Uint8Array> = {};
  for (const [id, encoded] of Object.entries(parsed.data.keys)) {
    keys[id] = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  }
  return { current: parsed.data.current, keys };
}

const keyring = z.string().transform((raw, ctx) => {
  const decoded = decodeKeyring(raw);
  if (decoded === null) {
    ctx.addIssue({ code: "custom", message: "invalid keyring" });
    return z.NEVER;
  }
  return decoded;
});

/** Standard base64 with padding; decoded, then re-encoded to refuse non-canonical input. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBase64(encoded: string): Uint8Array | null {
  if (!BASE64.test(encoded)) return null;
  const binary = atob(encoded);
  if (btoa(binary) !== encoded) return null;
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const signingKeyringShape = z.strictObject({
  current: z.string().regex(KEY_ID),
  keys: z.record(z.string().regex(KEY_ID), z.string()),
});

/**
 * Decodes a claim signing keyring (JSON) or a single plain-text key, or returns null. Like
 * {@link decodeKeyring}, it never says why: the input is a secret.
 */
function decodeSigningKeys(raw: string): ClaimSigningKeyring | null {
  if (!raw.trimStart().startsWith("{")) {
    // Whitespace only is a paste mistake, never a key: refuse it however long it is.
    if (!/\S/.test(raw)) return null;
    const key = new TextEncoder().encode(raw);
    if (key.length < CLAIM_SIGNING_KEY_MIN_BYTES) return null;
    return { current: SINGLE_CLAIM_SIGNING_KEY_ID, keys: { [SINGLE_CLAIM_SIGNING_KEY_ID]: key } };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = signingKeyringShape.safeParse(json);
  if (!parsed.success || !Object.hasOwn(parsed.data.keys, parsed.data.current)) return null;
  const keys: Record<string, Uint8Array> = {};
  for (const [id, encoded] of Object.entries(parsed.data.keys)) {
    const key = decodeBase64(encoded);
    if (key === null || key.length < CLAIM_SIGNING_KEY_MIN_BYTES) return null;
    keys[id] = key;
  }
  return { current: parsed.data.current, keys };
}

const signingKeys = z.string().transform((raw, ctx) => {
  const decoded = decodeSigningKeys(raw);
  if (decoded === null) {
    ctx.addIssue({ code: "custom", message: "invalid claim signing key" });
    return z.NEVER;
  }
  return decoded;
});

const presenceSchema = z.object({
  ENVIRONMENT: z.enum(["development", "e2e", "production"]),
  CREDENTIAL_KEYS: z.unknown().optional(),
  CLAIM_SIGNING_KEY: z.unknown().optional(),
});

const secretsSchema = z.object({ CREDENTIAL_KEYS: keyring, CLAIM_SIGNING_KEY: signingKeys });

/**
 * The commerce secrets, or `null` in local development when neither is set (Paddle and claims
 * are then unavailable). Elsewhere, or once either is set, both are required and validated.
 * Errors name keys and issue codes, never values.
 */
export function parseCommerceSecrets(env: unknown): CommerceSecrets | null {
  const presence = parseEnv(presenceSchema, env);
  if (
    presence.ENVIRONMENT === "development" &&
    presence.CREDENTIAL_KEYS === undefined &&
    presence.CLAIM_SIGNING_KEY === undefined
  ) {
    return null;
  }
  const secrets = parseEnv(secretsSchema, env);
  const claimSigningKeys = secrets.CLAIM_SIGNING_KEY;
  return {
    credentialKeys: secrets.CREDENTIAL_KEYS,
    claimSigningKeys,
    claimSigningKey: claimSigningKeys.keys[claimSigningKeys.current] as Uint8Array,
  };
}
