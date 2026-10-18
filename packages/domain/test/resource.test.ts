import { describe, expect, it } from "vitest";
import {
  CONNECTION_STATUSES,
  connectionStatusFor,
  GITHUB_PERSONAL_REPOSITORY_CAPABILITIES,
  isSellable,
  parseResourceCapabilities,
  RESOURCE_SELECTIONS,
} from "../src/index.ts";

describe("GitHub personal repository capabilities (decision 0008)", () => {
  it("grant write access only, with GitHub's invitation limits", () => {
    expect(GITHUB_PERSONAL_REPOSITORY_CAPABILITIES).toEqual({
      readOnlyGrant: false,
      maxInvitationsPerDay: 50,
      invitationExpiryDays: 7,
    });
    expect(Object.isFrozen(GITHUB_PERSONAL_REPOSITORY_CAPABILITIES)).toBe(true);
  });
});

describe("parseResourceCapabilities", () => {
  it("accepts a stored capability snapshot", () => {
    expect(parseResourceCapabilities(GITHUB_PERSONAL_REPOSITORY_CAPABILITIES)).toEqual({
      ok: true,
      value: GITHUB_PERSONAL_REPOSITORY_CAPABILITIES,
    });
  });

  it("ignores keys added by a newer version", () => {
    const stored = { ...GITHUB_PERSONAL_REPOSITORY_CAPABILITIES, futureFlag: true };
    expect(parseResourceCapabilities(stored)).toEqual({
      ok: true,
      value: GITHUB_PERSONAL_REPOSITORY_CAPABILITIES,
    });
  });

  it.each([
    null,
    "{}",
    {},
    { ...GITHUB_PERSONAL_REPOSITORY_CAPABILITIES, readOnlyGrant: "no" },
    { ...GITHUB_PERSONAL_REPOSITORY_CAPABILITIES, maxInvitationsPerDay: 0 },
    { ...GITHUB_PERSONAL_REPOSITORY_CAPABILITIES, maxInvitationsPerDay: 2.5 },
    { ...GITHUB_PERSONAL_REPOSITORY_CAPABILITIES, invitationExpiryDays: 0 },
    { ...GITHUB_PERSONAL_REPOSITORY_CAPABILITIES, invitationExpiryDays: 1.5 },
  ])("rejects %j", (value) => {
    expect(parseResourceCapabilities(value)).toEqual({ ok: false, error: "capabilities_invalid" });
  });
});

describe("isSellable", () => {
  const sellable = { private: true, archived: false, selection: "selected" } as const;

  it("is true for a private, unarchived, selected repository on an active connection", () => {
    expect(isSellable(sellable, "active")).toBe(true);
  });

  it.each([
    [{ ...sellable, private: false }, "active"],
    [{ ...sellable, archived: true }, "active"],
    [{ ...sellable, selection: "removed" }, "active"],
    [sellable, "suspended"],
    [sellable, "deleted"],
  ] as const)("is false for %j on a %s connection", (resource, status) => {
    expect(isSellable(resource, status)).toBe(false);
  });

  it("is true for exactly one combination of every input", () => {
    let count = 0;
    for (const isPrivate of [true, false]) {
      for (const archived of [true, false]) {
        for (const selection of RESOURCE_SELECTIONS) {
          for (const status of CONNECTION_STATUSES) {
            if (isSellable({ private: isPrivate, archived, selection }, status)) count += 1;
          }
        }
      }
    }
    expect(count).toBe(1);
  });
});

describe("connectionStatusFor", () => {
  it("is active when the installation is not suspended", () => {
    expect(connectionStatusFor({ suspendedAt: null })).toBe("active");
  });

  it("is suspended when the installation has a suspension time", () => {
    expect(connectionStatusFor({ suspendedAt: 0 })).toBe("suspended");
    expect(connectionStatusFor({ suspendedAt: 1_700_000_000_000 })).toBe("suspended");
  });
});
