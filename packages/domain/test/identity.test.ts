import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GITHUB_LOGIN_MAX_LENGTH, parseGitHubLogin, parseGitHubUserId } from "../src/index.ts";

describe("GitHub user ID", () => {
  it.each([
    [1, "1"],
    [12345, "12345"],
    [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
    ["1", "1"],
    ["583231", "583231"],
    [String(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER)],
  ] as const)("accepts %j as %j", (input, value) => {
    expect(parseGitHubUserId(input)).toEqual({ ok: true, value });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "0",
    "-1",
    "+1",
    "01",
    "1.0",
    "1e3",
    " 1",
    "1 ",
    "",
    "abc",
    String(Number.MAX_SAFE_INTEGER + 2),
    "99999999999999999999",
    null,
    undefined,
    12n,
    {},
  ])("rejects %o", (input) => {
    expect(parseGitHubUserId(input)).toEqual({ ok: false, error: "github_user_id_invalid" });
  });

  it("round-trips every positive safe integer through its canonical string", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (id) => {
        expect(parseGitHubUserId(id)).toEqual({ ok: true, value: String(id) });
        expect(parseGitHubUserId(String(id))).toEqual({ ok: true, value: String(id) });
      }),
    );
  });

  it("rejects strings with leading zeros", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (id) => {
        expect(parseGitHubUserId(`0${id}`).ok).toBe(false);
      }),
    );
  });
});

describe("GitHub login", () => {
  it("has GitHub's maximum length", () => {
    expect(GITHUB_LOGIN_MAX_LENGTH).toBe(39);
  });

  // Hyphen placement is not checked: legacy logins break the current rules, and a login is
  // only ever a snapshot, never a key.
  it.each(["a", "octocat", "Octo-Cat", "a-", "-a", "a--b", "0", "a".repeat(39)])(
    "accepts %j",
    (login) => {
      expect(parseGitHubLogin(login)).toEqual({ ok: true, value: login });
    },
  );

  it.each([
    ["", "login_empty"],
    ["a".repeat(40), "login_too_long"],
    ["octo cat", "login_invalid_format"],
    ["octo_cat", "login_invalid_format"],
    ["octo.cat", "login_invalid_format"],
    ["ócto", "login_invalid_format"],
    ["octocat\n", "login_invalid_format"],
    ["\noctocat", "login_invalid_format"],
    [42, "login_invalid_format"],
    [null, "login_invalid_format"],
  ] as const)("rejects %j with %s", (login, error) => {
    expect(parseGitHubLogin(login)).toEqual({ ok: false, error });
  });

  it("accepts every 1–39 character string of letters, digits and hyphens", () => {
    const char = fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-".split(""),
    );
    fc.assert(
      fc.property(fc.string({ unit: char, minLength: 1, maxLength: 39 }), (login) => {
        expect(parseGitHubLogin(login)).toEqual({ ok: true, value: login });
      }),
    );
  });

  it("rejects any string containing another character", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 10 }),
        fc.string({ minLength: 1, maxLength: 1 }).filter((c) => !/[A-Za-z0-9-]/.test(c)),
        fc.string({ maxLength: 10 }),
        (before, bad, after) => {
          expect(parseGitHubLogin(`${before}${bad}${after}`).ok).toBe(false);
        },
      ),
    );
  });
});
