import { FakeClock } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import { createGitHubApp } from "../src/index.ts";
import { appKey } from "./support/keys.ts";
import { API, stubFetch } from "./support/stub-fetch.ts";

const decode = (part: string) =>
  JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

describe("GitHub App JWT", () => {
  it("is an RS256 JWT with backdated iat, 9-minute exp and the App ID as issuer", async () => {
    const { pem, publicKey } = await appKey();
    const clock = new FakeClock("2026-10-18T12:00:00Z");
    const app = createGitHubApp({
      appId: "1000",
      privateKeyPem: pem,
      apiBaseUrl: API,
      fetch: stubFetch([]).fetch,
      clock,
    });

    const jwt = await app.appJwt();
    const [header = "", payload = "", signature = ""] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const now = Math.floor(clock.now() / 1000);
    expect(decode(payload)).toEqual({ iat: now - 60, exp: now + 540, iss: 1000 });
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64UrlToBytes(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
    expect(jwt).not.toMatch(/[+/=]/);
  });

  it("reuses the imported key and follows the clock", async () => {
    const clock = new FakeClock("2026-10-18T12:00:00Z");
    const app = createGitHubApp({
      appId: "7",
      privateKeyPem: (await appKey()).pem,
      apiBaseUrl: API,
      fetch: stubFetch([]).fetch,
      clock,
    });
    const first = await app.appJwt();
    clock.advance(10_000);
    const second = await app.appJwt();
    expect(decode(second.split(".")[1] ?? "").iat).toBe(
      (decode(first.split(".")[1] ?? "").iat as number) + 10,
    );
  });
});
