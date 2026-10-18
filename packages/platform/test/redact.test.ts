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

  it.each(["workspaceId", "correlationId", "repository", "keyboard"])(
    "does not treat %s as sensitive",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});
