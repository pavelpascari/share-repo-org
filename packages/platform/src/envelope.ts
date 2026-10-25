import { z } from "zod";
import { AppError } from "./errors.ts";
import type { CredentialKeyring } from "./secrets.ts";

// Tenant credential envelopes (decision 0011). WebCrypto only, so the same code runs in Workers
// and in Node. A fresh 256-bit data key encrypts the secret with AES-256-GCM; the data key is
// wrapped with AES-256-GCM under the keyring's current master key. Both encryptions authenticate
// the caller's additional data (`workspaceId:rowId:purpose`), so an envelope copied to another
// row, tenant or purpose does not open. The wrap also authenticates the master-key ID.

export const ENVELOPE_VERSION = 1;

/** What a sealed secret is for; part of its additional authenticated data. */
export type EnvelopePurpose = "api_key" | "webhook_secret" | "email";

/** Why an envelope could not be sealed or opened. Never carries secret material. */
export type CredentialEnvelopeFailure =
  /** The stored text is not an envelope of a known format. */
  | "malformed"
  /** The envelope names a master key that is not in the keyring (retired or misconfigured). */
  | "unknown_key"
  /** Authentication failed: wrong row or purpose, a tampered field, or the wrong master key. */
  | "decrypt_failed"
  /** The keyring's current key is unusable, or an AAD part is malformed. */
  | "invalid_input";

/** A credential envelope could not be sealed or opened. Its message names the failure only. */
export class CredentialEnvelopeError extends AppError {
  readonly reason: CredentialEnvelopeFailure;

  constructor(reason: CredentialEnvelopeFailure) {
    super(`Credential envelope failure: ${reason}`, {
      httpStatus: 500,
      code: "credential_unreadable",
    });
    this.reason = reason;
  }
}

const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
// Standard base64 with padding; lengths are checked after decoding.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Secrets ShareRepo seals are short (keys, secrets, emails); this bounds a stored envelope. */
const MAX_CIPHERTEXT_BASE64 = 8192;

const base64 = (max: number) => z.string().max(max).regex(BASE64);

const envelopeSchema = z.strictObject({
  v: z.literal(ENVELOPE_VERSION),
  kid: z.string().regex(KEY_ID),
  iv: base64(16),
  ct: base64(MAX_CIPHERTEXT_BASE64),
  wiv: base64(16),
  wk: base64(64),
});

type Envelope = z.infer<typeof envelopeSchema>;

const AAD_PART = /^[^:\s]{1,128}$/;

/**
 * The additional authenticated data that binds an envelope to its row and purpose:
 * `workspaceId:rowId:purpose`. The parts must not contain `:` or whitespace.
 */
export function envelopeAad(input: {
  workspaceId: string;
  rowId: string;
  purpose: EnvelopePurpose;
}): string {
  if (!AAD_PART.test(input.workspaceId) || !AAD_PART.test(input.rowId)) {
    throw new CredentialEnvelopeError("invalid_input");
  }
  return `${input.workspaceId}:${input.rowId}:${input.purpose}`;
}

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

const dataAad = (aad: string) => encoder.encode(`sharerepo-envelope/v1|data|${aad}`);
const wrapAad = (kid: string, aad: string) =>
  encoder.encode(`sharerepo-envelope/v1|wrap|${kid}|${aad}`);

function aesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function masterKey(keyring: CredentialKeyring, kid: string): Uint8Array<ArrayBuffer> | null {
  if (!Object.hasOwn(keyring.keys, kid)) return null;
  const key = keyring.keys[kid] as Uint8Array;
  return key.length === KEY_BYTES ? new Uint8Array(key) : null;
}

/**
 * Seals `plaintext` under the keyring's current master key, bound to `aad` (see `envelopeAad`),
 * and returns the envelope as JSON text for storage.
 */
export async function sealSecret(input: {
  keyring: CredentialKeyring;
  plaintext: string;
  aad: string;
}): Promise<string> {
  const kid = input.keyring.current;
  const master = masterKey(input.keyring, kid);
  if (master === null || !KEY_ID.test(kid)) throw new CredentialEnvelopeError("invalid_input");
  const dataKeyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wiv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  try {
    const dataKey = await aesKey(dataKeyBytes);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: dataAad(input.aad) },
      dataKey,
      encoder.encode(input.plaintext),
    );
    const wk = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: wiv, additionalData: wrapAad(kid, input.aad) },
      await aesKey(master),
      dataKeyBytes,
    );
    const envelope: Envelope = {
      v: ENVELOPE_VERSION,
      kid,
      iv: toBase64(iv),
      ct: toBase64(new Uint8Array(ct)),
      wiv: toBase64(wiv),
      wk: toBase64(new Uint8Array(wk)),
    };
    return JSON.stringify(envelope);
  } finally {
    dataKeyBytes.fill(0);
    master.fill(0);
  }
}

function parseEnvelope(text: string): Envelope {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CredentialEnvelopeError("malformed");
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) throw new CredentialEnvelopeError("malformed");
  const envelope = parsed.data;
  const sized =
    fromBase64(envelope.iv).length === IV_BYTES &&
    fromBase64(envelope.wiv).length === IV_BYTES &&
    fromBase64(envelope.wk).length === KEY_BYTES + TAG_BYTES &&
    fromBase64(envelope.ct).length >= TAG_BYTES;
  if (!sized) throw new CredentialEnvelopeError("malformed");
  return envelope;
}

/**
 * Opens an envelope sealed for `aad`. `needsRewrap` is true when it was sealed under a master key
 * that is no longer current: the caller re-seals the plaintext with `sealSecret` and stores the
 * new envelope, guarded on the old one (decision 0011, key rotation).
 */
export async function openSecret(input: {
  keyring: CredentialKeyring;
  envelope: string;
  aad: string;
}): Promise<{ plaintext: string; needsRewrap: boolean }> {
  const envelope = parseEnvelope(input.envelope);
  const master = masterKey(input.keyring, envelope.kid);
  if (master === null) throw new CredentialEnvelopeError("unknown_key");
  let dataKeyBytes: Uint8Array | null = null;
  try {
    dataKeyBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64(envelope.wiv),
          additionalData: wrapAad(envelope.kid, input.aad),
        },
        await aesKey(master),
        fromBase64(envelope.wk),
      ),
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.iv), additionalData: dataAad(input.aad) },
      await aesKey(new Uint8Array(dataKeyBytes)),
      fromBase64(envelope.ct),
    );
    return {
      plaintext: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plaintext),
      needsRewrap: envelope.kid !== input.keyring.current,
    };
  } catch {
    // WebCrypto's OperationError says nothing useful and nothing secret; report the class only.
    throw new CredentialEnvelopeError("decrypt_failed");
  } finally {
    dataKeyBytes?.fill(0);
    master.fill(0);
  }
}
