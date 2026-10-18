import { describe, expect, it } from "vitest";
import { assertSameOrigin, isSameOrigin } from "../app/security/same-origin.ts";

const BASE = "https://sharerepo.example";
const post = (headers: Record<string, string>) =>
  new Request(`${BASE}/workspaces/new`, { method: "POST", headers });

describe("same-origin check", () => {
  it.each([
    [{ origin: BASE }, true],
    [{ origin: "https://evil.example" }, false],
    [{ origin: "null" }, false],
    // Origin wins over Sec-Fetch-Site when both are present.
    [{ origin: "https://evil.example", "sec-fetch-site": "same-origin" }, false],
    [{ "sec-fetch-site": "same-origin" }, true],
    [{ "sec-fetch-site": "cross-site" }, false],
    [{ "sec-fetch-site": "same-site" }, false],
    [{}, false],
  ])("%j → %s", (headers, expected) => {
    expect(isSameOrigin(post(headers), BASE)).toBe(expected);
  });

  it("throws a 403 response for a cross-origin request", () => {
    let thrown: unknown;
    try {
      assertSameOrigin(post({ origin: "https://evil.example" }), BASE);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ init: { status: 403 } });
    expect(() => assertSameOrigin(post({ origin: BASE }), BASE)).not.toThrow();
  });
});
