import { describe, expect, it } from "vitest";
import { isSensitiveKey, REDACTED, redactString } from "../src/redact.ts";

function timed(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("redactString", () => {
  it("scrubs a private key whose END marker is missing (truncated logs)", () => {
    const out = redactString(
      "dump: -----BEGIN RSA PRIVATE KEY-----\nMIIEow-secret-material-cut-off-here",
    );
    expect(out).toBe(`dump: ${REDACTED}`);
  });

  it("scrubs only the key=value pair whose key is sensitive", () => {
    expect(redactString("user=alice webhook_secret=abc123 page=2")).toBe(
      `user=alice webhook_secret=${REDACTED} page=2`,
    );
  });

  it("scrubs sensitive keys regardless of how long the surrounding key name is", () => {
    const prefix = "x".repeat(200);
    expect(redactString(`${prefix}_token=abc`)).toBe(`${prefix}_token=${REDACTED}`);
    expect(redactString(`token_${prefix}: abc`)).toBe(`token_${prefix}: ${REDACTED}`);
  });

  it("scrubs sensitive query parameters inside URLs", () => {
    expect(redactString("GET https://x.test/a?page=1&access_token=abc")).toBe(
      `GET https://x.test/a?page=1&access_token=${REDACTED}`,
    );
  });

  it("scrubs a bearer scheme value after a sensitive key", () => {
    expect(redactString("authorization: Bearer abc.def")).toBe(`authorization: ${REDACTED}`);
  });

  it.each([
    ["newline after the separator", "password:\n  hunter2", `password:\n  ${REDACTED}`],
    ["newline before the separator", "secret\n= hunter2", `secret\n= ${REDACTED}`],
    ["CRLF and tabs", "token:\r\n\thunter2", `token:\r\n\t${REDACTED}`],
    ["scheme split across lines", "authorization:\nBearer\nabc", `authorization:\n${REDACTED}`],
  ])("scrubs values separated by any whitespace: %s", (_name, input, expected) => {
    expect(redactString(input)).toBe(expected);
  });

  // Found by differential fuzzing against the original implementation: token-shaped patterns
  // must not consume a sensitive key name before its value is redacted.
  it.each([
    ["Paddle key glued to the key name", "pdl_bbbbbbbbbbbbclient_secret=hunter2"],
    ["GitHub token glued to the key name", `ghp_${"A".repeat(22)}xsecret= hunter2`],
    ["auth scheme before the key name", "basic SESSIONx:hunter2"],
  ])("scrubs the value when %s", (_name, input) => {
    expect(redactString(input)).not.toContain("hunter2");
  });

  it("leaves a sensitive key with an empty value unchanged and keeps scanning", () => {
    expect(redactString("token=; secret=abc")).toBe(`token=; secret=${REDACTED}`);
  });

  it("truncates very long strings before scanning them", () => {
    const out = redactString("x".repeat(100_000));
    expect(out.length).toBeLessThan(20_000);
    expect(out.endsWith("[Truncated]")).toBe(true);
  });

  it.each([
    ["long key-like run with no separator", "a".repeat(15_000)],
    ["repeated sensitive words with no separator", "token".repeat(3_000)],
    ["many BEGIN markers without END", "-----BEGIN RSA PRIVATE KEY-----".repeat(500)],
    ["many separators without values", "secret=".repeat(2_000)],
  ])("stays fast on adversarial input: %s", (_name, input) => {
    expect(timed(() => redactString(input))).toBeLessThan(100);
  });
});

describe("isSensitiveKey", () => {
  it.each(["jwt", "idToken", "encryptionKey", "master_key", "signingKey", "pem", "accessKeyId"])(
    "treats %s as sensitive",
    (key) => {
      expect(isSensitiveKey(key)).toBe(true);
    },
  );

  // Phase 5 secrets (decisions 0011 and 0012): the env names and the fields that carry them.
  it.each([
    "CREDENTIAL_KEYS",
    "CLAIM_SIGNING_KEY",
    "PADDLE_API_KEY",
    "apiKeyEnvelope",
    "webhookSecretEnvelope",
    "email_envelope",
    "credentialKeyring",
    "dataKey",
    "claimReference",
    "sharerepo_claim_reference",
    "email",
    "emailHash",
  ])("treats %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(["workspaceId", "correlationId", "repository", "keyboard"])(
    "does not treat %s as sensitive",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});
