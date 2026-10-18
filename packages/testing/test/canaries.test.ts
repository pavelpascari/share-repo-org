import { describe, expect, it } from "vitest";
import {
  CANARY_PREFIX,
  createSecretCanaries,
  expectNoCanaryLeak,
  withSecretCanaries,
} from "../src/index.ts";

describe("createSecretCanaries", () => {
  it("creates one recognisable, unique value per name", () => {
    const canaries = createSecretCanaries(["githubToken", "webhookSecret"]);
    expect(Object.keys(canaries)).toEqual(["githubToken", "webhookSecret"]);
    expect(canaries.githubToken).toMatch(new RegExp(`^${CANARY_PREFIX}_GITHUBTOKEN_[0-9a-f]{16}$`));
    expect(canaries.githubToken).not.toBe(canaries.webhookSecret);
    expect(createSecretCanaries(["githubToken"]).githubToken).not.toBe(canaries.githubToken);
  });

  it("only uses characters that survive JSON, URL, and header encoding unchanged", () => {
    const { key } = createSecretCanaries(["key"]);
    expect(JSON.stringify(key)).toBe(`"${key}"`);
    expect(encodeURIComponent(key)).toBe(key);
  });

  it("rejects duplicate or empty names", () => {
    expect(() => createSecretCanaries(["a", "a"])).toThrow(/duplicate/);
    expect(() => createSecretCanaries([""])).toThrow(/empty/);
  });
});

describe("expectNoCanaryLeak", () => {
  const canaries = createSecretCanaries(["token", "privateKey"]);

  it("passes when no canary appears", () => {
    expect(() =>
      expectNoCanaryLeak(["safe", { nested: ["also safe", 42, null, undefined, true] }], canaries),
    ).not.toThrow();
  });

  it("finds a canary inside a string and names the canary and location", () => {
    expect(() => expectNoCanaryLeak([`Bearer ${canaries.token}`], canaries)).toThrow(
      /canary "token" leaked at \[0\]/,
    );
  });

  it("finds canaries deep inside objects, arrays, maps, sets, and keys", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ a: { b: [1, { c: canaries.token }] } }, /\.a\.b\[1\]\.c/],
      [{ [canaries.token]: 1 }, /<key>/],
      [new Map([["k", canaries.token]]), /<map value>/],
      [new Map([[canaries.token, "v"]]), /<map key>/],
      [new Set([canaries.token]), /<set>/],
    ];
    for (const [haystack, location] of cases) {
      expect(() => expectNoCanaryLeak(haystack, canaries)).toThrow(location);
    }
  });

  it("checks error messages, stacks, causes, and own properties", () => {
    const withMessage = new Error(`failed with ${canaries.privateKey}`);
    expect(() => expectNoCanaryLeak(withMessage, canaries)).toThrow(/"privateKey".*\.message/);

    const withCause = new Error("outer", { cause: new Error(canaries.token) });
    expect(() => expectNoCanaryLeak(withCause, canaries)).toThrow(/\.cause\.message/);

    const withProp = Object.assign(new Error("x"), { detail: { token: canaries.token } });
    expect(() => expectNoCanaryLeak(withProp, canaries)).toThrow(/\.detail\.token/);
  });

  it("decodes binary buffers", () => {
    const bytes = new TextEncoder().encode(`raw ${canaries.token} body`);
    expect(() => expectNoCanaryLeak(bytes, canaries)).toThrow(/"token"/);
    expect(() => expectNoCanaryLeak(bytes.buffer, canaries)).toThrow(/"token"/);
  });

  it("inspects Headers, URLs, and other iterables", () => {
    const headers = new Headers({ authorization: `Bearer ${canaries.token}` });
    expect(() => expectNoCanaryLeak(headers, canaries)).toThrow(/"token"/);
    const url = new URL(`https://example.test/?key=${canaries.token}`);
    expect(() => expectNoCanaryLeak(url, canaries)).toThrow(/"token"/);
  });

  it("checks bigints, symbols, and function names without throwing on them", () => {
    expect(() =>
      expectNoCanaryLeak([1n, Symbol("s"), () => undefined, new Date(0)], canaries),
    ).not.toThrow();
    expect(() => expectNoCanaryLeak(Symbol(canaries.token), canaries)).toThrow(/"token"/);
  });

  it("handles circular structures", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    value.secret = canaries.token;
    expect(() => expectNoCanaryLeak(value, canaries)).toThrow(/\.secret/);
  });

  it("accepts canaries as a list of strings", () => {
    expect(() => expectNoCanaryLeak("contains SECRET-1", ["SECRET-1"])).toThrow(
      /canary "SECRET-1"/,
    );
  });

  it("lists every leak and never prints the full canary value", () => {
    let message = "";
    try {
      expectNoCanaryLeak({ a: canaries.token, b: canaries.privateKey }, canaries);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/2 secret canary leak/);
    expect(message).toContain('"token"');
    expect(message).toContain('"privateKey"');
    expect(message).not.toContain(canaries.token);
  });

  it("refuses an empty canary value", () => {
    expect(() => expectNoCanaryLeak("x", [""])).toThrow(/empty canary/);
  });
});

describe("withSecretCanaries", () => {
  it("fails when the callback logs a canary", async () => {
    await expect(
      withSecretCanaries(["token"], ({ token }) => {
        console.error("auth failed", { token });
      }),
    ).rejects.toThrow(/"token" leaked/);
  });

  it("returns the callback result and passes captured logs", async () => {
    const result = await withSecretCanaries(["token"], async (canaries, logs) => {
      console.log("calling provider");
      expect(canaries.token).toContain(CANARY_PREFIX);
      expect(logs.lines()).toEqual(["calling provider"]);
      return "done";
    });
    expect(result).toBe("done");
  });

  it("checks the returned value and restores the console even on error", async () => {
    const before = Object.getOwnPropertyDescriptor(console, "log");
    await expect(withSecretCanaries(["token"], ({ token }) => ({ token }))).rejects.toThrow(
      /<result>/,
    );
    await expect(
      withSecretCanaries(["token"], () => {
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");
    expect(Object.getOwnPropertyDescriptor(console, "log")).toEqual(before);
  });

  it("fails when the callback throws an error that contains a canary", async () => {
    await expect(
      withSecretCanaries(["token"], ({ token }) => {
        throw new Error(`bad token ${token}`);
      }),
    ).rejects.toThrow(/<thrown>/);
  });
});
