import { describe, expect, it } from "vitest";

describe("integrations test environment", () => {
  it("has WebCrypto with RSA signing", async () => {
    const key = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    expect((key as CryptoKeyPair).privateKey.algorithm.name).toBe("RSASSA-PKCS1-v1_5");
  });
});
