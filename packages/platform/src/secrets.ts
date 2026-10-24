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

/** ShareRepo-owned secrets for Paddle connections and purchase claims (decisions 0011, 0012). */
export interface CommerceSecrets {
  /** From `CREDENTIAL_KEYS`: `{"current": "k2", "keys": {"k1": "<base64>", "k2": "<base64>"}}`. */
  readonly credentialKeys: CredentialKeyring;
  /** From `CLAIM_SIGNING_KEY`: the HMAC key for claim references and email hashes. */
  readonly claimSigningKey: Uint8Array;
}

export const CLAIM_SIGNING_KEY_MIN_BYTES = 32;

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

const signingKey = z
  .string()
  .transform((raw) => new TextEncoder().encode(raw))
  .refine((bytes) => bytes.length >= CLAIM_SIGNING_KEY_MIN_BYTES);

const presenceSchema = z.object({
  ENVIRONMENT: z.enum(["development", "e2e", "production"]),
  CREDENTIAL_KEYS: z.unknown().optional(),
  CLAIM_SIGNING_KEY: z.unknown().optional(),
});

const secretsSchema = z.object({ CREDENTIAL_KEYS: keyring, CLAIM_SIGNING_KEY: signingKey });

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
  return { credentialKeys: secrets.CREDENTIAL_KEYS, claimSigningKey: secrets.CLAIM_SIGNING_KEY };
}
