import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLAIM_REFERENCE_MAX_LENGTH,
  createLogger,
  hashClaimEmail,
  hashClaimToken,
  hashIp,
  isClaimToken,
  newClaimToken,
  parseClaimReference,
  redact,
  redactString,
  signClaimReference,
  verifyClaimReference,
} from "../src/index.ts";
import { captureConsole } from "./support/capture-console.ts";

const KEY = new TextEncoder().encode("k".repeat(32));
const OTHER_KEY = new TextEncoder().encode("o".repeat(32));
const binding = {
  workspaceId: "ws_1",
  checkoutClaimId: "0b5e0b3c-2f2b-4c43-9d55-1ad1c1f2a001",
  userId: "usr_1",
  offerId: "off_1",
};

const HEX64 = /^[0-9a-f]{64}$/;

describe("claim references", () => {
  it("are v1.<checkoutClaimId>.<HMAC-SHA256 over the binding, base64url>", async () => {
    const reference = await signClaimReference({ key: KEY, ...binding });
    const expected = createHmac("sha256", KEY)
      .update(`v1|ws_1|${binding.checkoutClaimId}|usr_1|off_1`)
      .digest("base64url");
    expect(reference).toBe(`v1.${binding.checkoutClaimId}.${expected}`);
    expect(reference.length).toBeLessThanOrEqual(CLAIM_REFERENCE_MAX_LENGTH);
    expect(parseClaimReference(reference)).toEqual({
      ok: true,
      checkoutClaimId: binding.checkoutClaimId,
      mac: expected,
    });
  });

  it("verify for exactly their binding", async () => {
    const reference = await signClaimReference({ key: KEY, ...binding });
    const verify = (overrides: Partial<Parameters<typeof verifyClaimReference>[0]>) =>
      verifyClaimReference({ key: KEY, reference, ...binding, ...overrides });
    expect(await verify({})).toBe(true);
    expect(await verify({ workspaceId: "ws_2" })).toBe(false);
    expect(await verify({ userId: "usr_2" })).toBe(false);
    expect(await verify({ offerId: "off_2" })).toBe(false);
    expect(await verify({ key: OTHER_KEY })).toBe(false);
  });

  it("claim/checkout-reference-tamper-rejected: a forged or edited reference fails", async () => {
    const reference = await signClaimReference({ key: KEY, ...binding });
    const [, id, mac] = reference.split(".") as [string, string, string];
    const otherClaim = await signClaimReference({ key: KEY, ...binding, checkoutClaimId: "ckc_2" });
    const forged = [
      `v1.ckc_2.${mac}`,
      `v1.${id}.${otherClaim.split(".")[2]}`,
      `v1.${id}.${mac.slice(0, -2)}${mac.at(-2) === "A" ? "B" : "A"}${mac.at(-1)}`,
      `v1.${id}.${"A".repeat(43)}`,
      // The same MAC bytes with a non-canonical last character.
      `v1.${id}.${mac.slice(0, -1)}${String.fromCharCode((mac.at(-1) as string).charCodeAt(0) + 1)}`,
    ];
    for (const candidate of forged) {
      expect(await verifyClaimReference({ key: KEY, reference: candidate, ...binding })).toBe(
        false,
      );
    }
  });

  it.each<[string, unknown]>([
    ["a non-string", 42],
    ["null", null],
    ["an empty string", ""],
    ["another version", `v2.ckc_1.${"A".repeat(43)}`],
    ["a short MAC", `v1.ckc_1.${"A".repeat(42)}`],
    ["a long MAC", `v1.ckc_1.${"A".repeat(44)}`],
    ["padding", `v1.ckc_1.${"A".repeat(42)}=`],
    ["standard base64", `v1.ckc_1.${"+".repeat(42)}A`],
    ["an extra segment", `v1.ckc.1.${"A".repeat(43)}`],
    ["an empty ID", `v1..${"A".repeat(43)}`],
    ["surrounding whitespace", ` v1.ckc_1.${"A".repeat(43)}`],
    ["a trailing newline", `v1.ckc_1.${"A".repeat(43)}\n`],
    ["an ID over 128 characters", `v1.${"c".repeat(129)}.${"A".repeat(43)}`],
    ["over 256 characters", `v1.${"c".repeat(128)}.${"A".repeat(43)}${" ".repeat(90)}`],
  ])("parse rejects %s", async (_, reference) => {
    expect(parseClaimReference(reference)).toEqual({ ok: false });
    expect(await verifyClaimReference({ key: KEY, reference, ...binding })).toBe(false);
  });

  it("refuses to sign parts that could contain the separator", async () => {
    await expect(signClaimReference({ key: KEY, ...binding, userId: "usr|1" })).rejects.toThrow(
      "Claim reference parts must be identifiers",
    );
    await expect(
      signClaimReference({ key: KEY, ...binding, checkoutClaimId: "a.b" }),
    ).rejects.toThrow();
  });

  it("does not verify against parts that could contain the separator", async () => {
    const reference = await signClaimReference({ key: KEY, ...binding });
    expect(await verifyClaimReference({ key: KEY, reference, ...binding, offerId: "off|1" })).toBe(
      false,
    );
  });
});

describe("hashClaimEmail and hashIp", () => {
  it("is a keyed, normalised hash of the email", async () => {
    const hash = await hashClaimEmail(KEY, "  Buyer@Example.COM ");
    expect(hash).toMatch(HEX64);
    expect(hash).toBe(createHmac("sha256", KEY).update("email|buyer@example.com").digest("hex"));
    expect(await hashClaimEmail(KEY, "buyer@example.com")).toBe(hash);
    expect(await hashClaimEmail(OTHER_KEY, "buyer@example.com")).not.toBe(hash);
    expect(await hashClaimEmail(KEY, "other@example.com")).not.toBe(hash);
  });

  it("separates IP hashes from email hashes", async () => {
    const ip = await hashIp(KEY, "203.0.113.7");
    expect(ip).toMatch(HEX64);
    expect(ip).toBe(createHmac("sha256", KEY).update("ip|203.0.113.7").digest("hex"));
    expect(ip).not.toBe(await hashClaimEmail(KEY, "203.0.113.7"));
  });
});

describe("claim tokens", () => {
  it("are 256 random bits as base64url, stored only as their SHA-256", async () => {
    const { token, hash } = await newClaimToken();
    expect(isClaimToken(token)).toBe(true);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(hash).toMatch(HEX64);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(await hashClaimToken(token)).toBe(hash);
    expect((await newClaimToken()).token).not.toBe(token);
  });

  it.each<[string, unknown]>([
    ["a non-string", 1],
    ["a short value", "A".repeat(42)],
    ["a long value", "A".repeat(44)],
    ["a non-canonical last character", `${"A".repeat(42)}B`],
    ["standard base64", `${"+".repeat(42)}A`],
  ])("rejects %s as a token shape", (_, value) => {
    expect(isClaimToken(value)).toBe(false);
  });
});

describe("audit/no-secrets-in-logs-or-audit: claims", () => {
  it("redacts references, tokens and claim links wherever they appear", async () => {
    const reference = await signClaimReference({ key: KEY, ...binding });
    const { token } = await newClaimToken();
    const capture = captureConsole();
    try {
      const logger = createLogger({ correlationId: "req-00000001" });
      logger.info("refreshing subscription", {
        customData: { sharerepo_claim: reference },
        claimToken: token,
        link: `https://sharerepo.org/claim/${token}`,
      });
      logger.warn(`reference ${reference} rejected; link /claim/${token} opened`);
      expect(capture.lines).toHaveLength(2);
      expect(capture.text()).not.toContain(reference.split(".")[2]);
      expect(capture.text()).not.toContain(token);
    } finally {
      capture.restore();
    }
    expect(redactString(`x v1.${binding.checkoutClaimId}.${"A".repeat(43)} y`)).toBe(
      "x [REDACTED] y",
    );
    expect(redactString(`/claim/${token}?a=1`)).toBe("/claim/[REDACTED]?a=1");
    expect(redact({ sharerepoClaimReference: "x" })).toEqual({
      sharerepoClaimReference: "[REDACTED]",
    });
  });
});
