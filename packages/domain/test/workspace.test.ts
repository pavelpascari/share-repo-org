import { describe, expect, it } from "vitest";
import {
  hasAsciiControlCharacter,
  isWorkspaceRole,
  isWorkspaceStatus,
  normalizeWorkspaceSlug,
  parseWorkspaceName,
  parseWorkspaceRole,
  parseWorkspaceSlug,
  parseWorkspaceStatus,
  WORKSPACE_NAME_MAX_LENGTH,
  WORKSPACE_ROLES,
  WORKSPACE_SLUG_MAX_LENGTH,
  WORKSPACE_SLUG_MIN_LENGTH,
  WORKSPACE_STATUSES,
} from "../src/index.ts";

describe("workspace slug", () => {
  it("has the documented length bounds", () => {
    expect(WORKSPACE_SLUG_MIN_LENGTH).toBe(3);
    expect(WORKSPACE_SLUG_MAX_LENGTH).toBe(48);
  });

  it("normalises by trimming surrounding whitespace and lowercasing", () => {
    expect(normalizeWorkspaceSlug("  Acme-Co\t\n")).toBe("acme-co");
    expect(normalizeWorkspaceSlug("acme")).toBe("acme");
  });

  it.each(["abc", "a-b", "a1b", "123", "acme-co", "acme-co-2", "a".repeat(48)])(
    "accepts %j",
    (slug) => {
      expect(parseWorkspaceSlug(slug)).toEqual({ ok: true, value: slug });
    },
  );

  it("returns the normalised value", () => {
    expect(parseWorkspaceSlug(" Acme-Co ")).toEqual({ ok: true, value: "acme-co" });
  });

  it("measures length after normalisation", () => {
    expect(parseWorkspaceSlug("  ab  ")).toEqual({ ok: false, error: "slug_too_short" });
    expect(parseWorkspaceSlug(` ${"a".repeat(48)} `)).toEqual({
      ok: true,
      value: "a".repeat(48),
    });
  });

  it.each([
    ["", "slug_too_short"],
    ["a", "slug_too_short"],
    ["ab", "slug_too_short"],
    ["a".repeat(49), "slug_too_long"],
    ["a".repeat(200), "slug_too_long"],
  ] as const)("rejects %j by length with %s", (slug, error) => {
    expect(parseWorkspaceSlug(slug)).toEqual({ ok: false, error });
  });

  it.each([
    "-abc",
    "abc-",
    "-ab-",
    "ab--cd",
    "ab_cd",
    "ab cd",
    "ab.cd",
    "ab/cd",
    "abç",
    "ab\u0000c",
    "---",
  ])("rejects %j as invalid format", (slug) => {
    expect(parseWorkspaceSlug(slug)).toEqual({ ok: false, error: "slug_invalid_format" });
  });

  it("checks length before format", () => {
    expect(parseWorkspaceSlug("-a")).toEqual({ ok: false, error: "slug_too_short" });
    expect(parseWorkspaceSlug(`-${"a".repeat(48)}`)).toEqual({
      ok: false,
      error: "slug_too_long",
    });
  });
});

describe("workspace name", () => {
  it("has the documented maximum length", () => {
    expect(WORKSPACE_NAME_MAX_LENGTH).toBe(100);
  });

  it("trims surrounding whitespace", () => {
    expect(parseWorkspaceName("  Acme Co  ")).toEqual({ ok: true, value: "Acme Co" });
  });

  it("keeps inner whitespace and any characters", () => {
    expect(parseWorkspaceName("Ünïcødé  Team 🚀")).toEqual({
      ok: true,
      value: "Ünïcødé  Team 🚀",
    });
  });

  it.each(["", " ", "\t\n "])("rejects blank name %j", (name) => {
    expect(parseWorkspaceName(name)).toEqual({ ok: false, error: "name_empty" });
  });

  it("accepts 1 and 100 characters", () => {
    expect(parseWorkspaceName("a")).toEqual({ ok: true, value: "a" });
    expect(parseWorkspaceName("a".repeat(100))).toEqual({ ok: true, value: "a".repeat(100) });
  });

  it("rejects 101 characters", () => {
    expect(parseWorkspaceName("a".repeat(101))).toEqual({ ok: false, error: "name_too_long" });
  });

  it("measures length after trimming", () => {
    expect(parseWorkspaceName(`  ${"a".repeat(100)}  `)).toEqual({
      ok: true,
      value: "a".repeat(100),
    });
  });

  it("counts Unicode code points, matching SQLite length()", () => {
    // Each emoji is one code point but two UTF-16 units.
    expect(parseWorkspaceName("🚀".repeat(100))).toEqual({ ok: true, value: "🚀".repeat(100) });
    expect(parseWorkspaceName("🚀".repeat(101))).toEqual({ ok: false, error: "name_too_long" });
  });

  // The name reaches email subjects and headers: a CR or LF there could inject a header.
  it.each([
    "Acme\r\nBcc: x@example.com",
    "Acme\nCo",
    "Acme\tCo",
    "A\u0000B",
    "A\u001fB",
    "A\u007fB",
  ])("rejects ASCII control characters in %j", (name) => {
    expect(parseWorkspaceName(name)).toEqual({ ok: false, error: "name_invalid_characters" });
  });

  it("accepts the printable neighbours of the control ranges", () => {
    for (const name of ["A B", "A~B", "A\u0080B", "A B"]) {
      expect(parseWorkspaceName(name)).toEqual({ ok: true, value: name });
    }
  });

  it("checks length before characters", () => {
    expect(parseWorkspaceName(`${"a".repeat(101)}\n`)).toEqual({
      ok: false,
      error: "name_too_long",
    });
    expect(parseWorkspaceName(`a\n${"a".repeat(100)}`)).toEqual({
      ok: false,
      error: "name_too_long",
    });
  });
});

describe("hasAsciiControlCharacter", () => {
  it("finds C0 controls and DEL anywhere, and nothing else", () => {
    for (let code = 0; code < 0x20; code += 1) {
      expect(hasAsciiControlCharacter(`a${String.fromCharCode(code)}b`)).toBe(true);
    }
    expect(hasAsciiControlCharacter("\u007f")).toBe(true);
    expect(hasAsciiControlCharacter("x\r")).toBe(true);
    expect(hasAsciiControlCharacter("")).toBe(false);
    expect(hasAsciiControlCharacter(" ~Ünïcødé 🚀\u0080 ")).toBe(false);
  });
});

describe("workspace role", () => {
  it("lists exactly owner and member", () => {
    expect(WORKSPACE_ROLES).toEqual(["owner", "member"]);
  });

  it.each(["owner", "member"])("accepts %j", (role) => {
    expect(isWorkspaceRole(role)).toBe(true);
    expect(parseWorkspaceRole(role)).toEqual({ ok: true, value: role });
  });

  it.each(["Owner", "admin", "", " owner", 1, null, undefined, {}])("rejects %j", (role) => {
    expect(isWorkspaceRole(role)).toBe(false);
    expect(parseWorkspaceRole(role)).toEqual({ ok: false, error: "role_invalid" });
  });
});

describe("workspace status", () => {
  it("lists exactly active, suspended, deleting and purging", () => {
    expect(WORKSPACE_STATUSES).toEqual(["active", "suspended", "deleting", "purging"]);
  });

  it.each(["active", "suspended", "deleting", "purging"])("accepts %j", (status) => {
    expect(isWorkspaceStatus(status)).toBe(true);
    expect(parseWorkspaceStatus(status)).toEqual({ ok: true, value: status });
  });

  it.each(["Active", "deleted", "", 0, null, undefined])("rejects %j", (status) => {
    expect(isWorkspaceStatus(status)).toBe(false);
    expect(parseWorkspaceStatus(status)).toEqual({ ok: false, error: "status_invalid" });
  });
});
