import { describe, expect, it } from "vitest";
import { isUniqueViolation, uniqueViolationColumns } from "../src/index.ts";

const d1Unique = (columns: string) =>
  new Error(`D1_ERROR: UNIQUE constraint failed: ${columns}: SQLITE_CONSTRAINT`);

describe("uniqueViolationColumns", () => {
  it("reads one column", () => {
    expect(uniqueViolationColumns(d1Unique("workspaces.slug"))).toEqual(["workspaces.slug"]);
  });

  it("reads a composite key in order", () => {
    expect(uniqueViolationColumns(d1Unique("t.a, t.b"))).toEqual(["t.a", "t.b"]);
  });

  it("finds the D1 error in the cause chain of a wrapper", () => {
    const wrapped = new Error("Failed query: insert ... params: secret", {
      cause: new Error("outer", { cause: d1Unique("users.id") }),
    });
    expect(uniqueViolationColumns(wrapped)).toEqual(["users.id"]);
  });

  it("returns null for other errors and non-errors", () => {
    expect(uniqueViolationColumns(new Error("FOREIGN KEY constraint failed"))).toBeNull();
    expect(uniqueViolationColumns("UNIQUE constraint failed: t.a")).toBeNull();
    expect(uniqueViolationColumns(undefined)).toBeNull();
  });

  it("stops on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    Object.defineProperty(a, "cause", { value: b });
    expect(uniqueViolationColumns(a)).toBeNull();
  });
});

describe("isUniqueViolation", () => {
  it("matches the exact columns only", () => {
    const error = d1Unique("t.a, t.b");
    expect(isUniqueViolation(error, ["t.a", "t.b"])).toBe(true);
    expect(isUniqueViolation(error, ["t.a"])).toBe(false);
    expect(isUniqueViolation(error, ["t.b", "t.a"])).toBe(false);
  });

  it("is false for errors that are not UNIQUE failures", () => {
    expect(isUniqueViolation(new Error("boom"), [])).toBe(false);
    expect(isUniqueViolation(new Error("boom"), ["t.a"])).toBe(false);
  });
});
