import { describe, expect, it } from "vitest";
import {
  CLAIM_SIGNING_KEY_MIN_BYTES,
  ConfigurationError,
  claimSigningKeysOf,
  createLogger,
  parseCommerceSecrets,
  SINGLE_CLAIM_SIGNING_KEY_ID,
} from "../src/index.ts";
import { captureConsole } from "./support/capture-console.ts";

const key = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const KEYRING = JSON.stringify({ current: "k2", keys: { k1: key(1), k2: key(2) } });
const SIGNING_KEY = "s".repeat(CLAIM_SIGNING_KEY_MIN_BYTES);
const base = {
  ENVIRONMENT: "production",
  CREDENTIAL_KEYS: KEYRING,
  CLAIM_SIGNING_KEY: SIGNING_KEY,
};

function issuesOf(env: unknown) {
  try {
    parseCommerceSecrets(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return (error as ConfigurationError).issues;
  }
  throw new Error("expected parseCommerceSecrets to throw");
}

describe("parseCommerceSecrets", () => {
  it("decodes the keyring and the signing key", () => {
    const secrets = parseCommerceSecrets(base);
    expect(secrets?.credentialKeys.current).toBe("k2");
    expect(Object.keys(secrets?.credentialKeys.keys ?? {})).toEqual(["k1", "k2"]);
    expect(secrets?.credentialKeys.keys.k2).toEqual(new Uint8Array(32).fill(2));
    expect(secrets?.claimSigningKey).toEqual(new TextEncoder().encode(SIGNING_KEY));
  });

  it("takes a plain-text signing key as a keyring of one", () => {
    const secrets = parseCommerceSecrets(base);
    expect(SINGLE_CLAIM_SIGNING_KEY_ID).toBe("single");
    expect(secrets?.claimSigningKeys).toEqual({
      current: "single",
      keys: { single: new TextEncoder().encode(SIGNING_KEY) },
    });
  });

  it("decodes a signing keyring and signs with its current key", () => {
    const old = new Uint8Array(32).fill(7);
    const next = new Uint8Array(48).fill(8);
    const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const raw = JSON.stringify({ current: "c2", keys: { c1: encode(old), c2: encode(next) } });
    const secrets = parseCommerceSecrets({ ...base, CLAIM_SIGNING_KEY: ` ${raw}` });
    expect(secrets?.claimSigningKeys).toEqual({ current: "c2", keys: { c1: old, c2: next } });
    expect(secrets?.claimSigningKey).toEqual(next);
  });

  it("lists the current claim signing key apart from the others still listed", () => {
    const [a, b, c] = [1, 2, 3].map((fill) => new Uint8Array(32).fill(fill)) as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    expect(claimSigningKeysOf({ current: "b", keys: { a, b, c } })).toEqual({
      current: b,
      retired: [a, c],
    });
    expect(claimSigningKeysOf({ current: "single", keys: { single: a } })).toEqual({
      current: a,
      retired: [],
    });
  });

  it("is absent in local development when neither secret is set", () => {
    expect(parseCommerceSecrets({ ENVIRONMENT: "development" })).toBeNull();
  });

  it("requires both in local development once either is set", () => {
    expect(issuesOf({ ENVIRONMENT: "development", CLAIM_SIGNING_KEY: SIGNING_KEY })).toEqual([
      { path: "CREDENTIAL_KEYS", code: "invalid_type" },
    ]);
    expect(
      parseCommerceSecrets({ ...base, ENVIRONMENT: "development" })?.credentialKeys.current,
    ).toBe("k2");
  });

  it.each(["e2e", "production"])("requires both in %s", (environment) => {
    expect(issuesOf({ ENVIRONMENT: environment })).toEqual([
      { path: "CREDENTIAL_KEYS", code: "invalid_type" },
      { path: "CLAIM_SIGNING_KEY", code: "invalid_type" },
    ]);
  });

  it("rejects an unknown environment", () => {
    expect(issuesOf({ ...base, ENVIRONMENT: "staging" })).toEqual([
      { path: "ENVIRONMENT", code: "invalid_value" },
    ]);
  });

  it.each([
    ["not JSON", "k1:abc"],
    ["not an object", JSON.stringify([key(1)])],
    ["no current key", JSON.stringify({ keys: { k1: key(1) } })],
    ["a current key that is not listed", JSON.stringify({ current: "k3", keys: { k1: key(1) } })],
    ["no keys", JSON.stringify({ current: "k1", keys: {} })],
    ["a short key", JSON.stringify({ current: "k1", keys: { k1: btoa("short") } })],
    ["a long key", JSON.stringify({ current: "k1", keys: { k1: `${key(1)}AAAA` } })],
    ["a key that is not base64", JSON.stringify({ current: "k1", keys: { k1: "!".repeat(44) } })],
    // 44 characters, but its last character carries bits beyond 32 bytes.
    [
      "a non-canonical encoding",
      JSON.stringify({ current: "k1", keys: { k1: `${key(1).slice(0, 42)}B=` } }),
    ],
    ["an invalid key ID", JSON.stringify({ current: "k 1", keys: { "k 1": key(1) } })],
    ["an unknown field", JSON.stringify({ current: "k1", keys: { k1: key(1) }, extra: true })],
  ])("rejects a keyring with %s", (_label, raw) => {
    expect(issuesOf({ ...base, CREDENTIAL_KEYS: raw })).toEqual([
      { path: "CREDENTIAL_KEYS", code: "custom" },
    ]);
  });

  it.each([
    ["not JSON", "{ current"],
    ["keys that are not an object", '{"current": "c1", "keys": []}'],
    ["no current key", JSON.stringify({ keys: { c1: key(1) } })],
    ["a current key that is not listed", JSON.stringify({ current: "c3", keys: { c1: key(1) } })],
    ["no keys", JSON.stringify({ current: "c1", keys: {} })],
    ["a short key", JSON.stringify({ current: "c1", keys: { c1: btoa("s".repeat(31)) } })],
    ["a key that is not base64", JSON.stringify({ current: "c1", keys: { c1: "!".repeat(44) } })],
    ["unpadded base64", JSON.stringify({ current: "c1", keys: { c1: key(1).slice(0, 43) } })],
    [
      "a non-canonical encoding",
      JSON.stringify({ current: "c1", keys: { c1: `${key(1).slice(0, 42)}B=` } }),
    ],
    [
      "one short key among good ones",
      JSON.stringify({ current: "c1", keys: { c1: key(1), c2: btoa("short") } }),
    ],
    ["an invalid key ID", JSON.stringify({ current: "c 1", keys: { "c 1": key(1) } })],
    ["an unknown field", JSON.stringify({ current: "c1", keys: { c1: key(1) }, extra: true })],
    ["a key that is not a string", JSON.stringify({ current: "c1", keys: { c1: 1 } })],
  ])("rejects a signing keyring with %s", (_label, raw) => {
    expect(issuesOf({ ...base, CLAIM_SIGNING_KEY: raw })).toEqual([
      { path: "CLAIM_SIGNING_KEY", code: "custom" },
    ]);
  });

  it("accepts a signing keyring key of exactly 32 bytes", () => {
    const raw = JSON.stringify({ current: "c1", keys: { c1: key(3) } });
    expect(parseCommerceSecrets({ ...base, CLAIM_SIGNING_KEY: raw })?.claimSigningKey).toEqual(
      new Uint8Array(32).fill(3),
    );
  });

  it("rejects a signing key shorter than 32 bytes", () => {
    expect(issuesOf({ ...base, CLAIM_SIGNING_KEY: "s".repeat(31) })).toEqual([
      { path: "CLAIM_SIGNING_KEY", code: "custom" },
    ]);
  });

  it("counts the signing key in bytes, not characters", () => {
    // 16 two-byte characters are 32 bytes.
    expect(parseCommerceSecrets({ ...base, CLAIM_SIGNING_KEY: "é".repeat(16) })).not.toBeNull();
  });

  it("never echoes a secret in the error, even one in a key ID position", () => {
    const canary = `canary-${crypto.randomUUID()}`;
    const capture = captureConsole();
    try {
      const keyring = JSON.stringify({ current: canary, keys: { [canary]: canary } });
      const error = (() => {
        try {
          parseCommerceSecrets({ ...base, CREDENTIAL_KEYS: keyring, CLAIM_SIGNING_KEY: "x" });
        } catch (thrown) {
          return thrown as ConfigurationError;
        }
        throw new Error("expected parseCommerceSecrets to throw");
      })();
      createLogger({ correlationId: "req-00000001" }).error("startup failed", { error });
      expect(JSON.stringify(error.issues)).not.toContain(canary);
      expect(error.message).not.toContain(canary);
      expect(capture.text()).not.toContain(canary);
    } finally {
      capture.restore();
    }
  });
});
