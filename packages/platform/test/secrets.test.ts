import { describe, expect, it } from "vitest";
import {
  CLAIM_SIGNING_KEY_MIN_BYTES,
  ConfigurationError,
  createLogger,
  parseCommerceSecrets,
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
