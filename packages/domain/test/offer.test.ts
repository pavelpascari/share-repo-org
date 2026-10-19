import { describe, expect, it } from "vitest";
import {
  checkOfferAccesses,
  GITHUB_PERSONAL_REPOSITORY_CAPABILITIES,
  type OfferResource,
  parseOfferInput,
  parseOfferSnapshot,
  supportsAccessLevel,
} from "../src/index.ts";

const valid = {
  name: "Pro",
  gracePeriodDays: 7,
  items: [{ source: "simulated", externalItemId: "sim_monthly" }],
  accesses: [{ resourceId: "r1", accessLevel: "write" }],
};

const parse = (overrides: Record<string, unknown>) => parseOfferInput({ ...valid, ...overrides });
const errorOf = (overrides: Record<string, unknown>) => {
  const result = parse(overrides);
  return result.ok ? null : result.error;
};

describe("supportsAccessLevel", () => {
  it("always supports write", () => {
    expect(supportsAccessLevel({ readOnlyGrant: false }, "write")).toBe(true);
    expect(supportsAccessLevel({ readOnlyGrant: true }, "write")).toBe(true);
  });

  it("supports read only with read-only grants", () => {
    expect(supportsAccessLevel({ readOnlyGrant: true }, "read")).toBe(true);
    expect(supportsAccessLevel(GITHUB_PERSONAL_REPOSITORY_CAPABILITIES, "read")).toBe(false);
  });
});

describe("parseOfferInput", () => {
  it("accepts a valid offer", () => {
    expect(parseOfferInput(valid)).toEqual({ ok: true, value: valid });
  });

  it.each(["a", "x".repeat(100), "😀".repeat(100)])("accepts the name %s", (name) => {
    expect(parse({ name })).toMatchObject({ ok: true, value: { name } });
  });

  it("trims surrounding Unicode whitespace from the name", () => {
    expect(parse({ name: "  Pro plan\t " })).toMatchObject({
      ok: true,
      value: { name: "Pro plan" },
    });
  });

  it.each([
    ["empty", ""],
    ["blank", " 　\n"],
    ["too long", "x".repeat(101)],
    ["too long in code points", "😀".repeat(101)],
    ["not a string", 42],
    ["absent", undefined],
  ])("rejects a name that is %s", (_, name) => {
    expect(errorOf({ name })).toBe("name_invalid");
  });

  it("defaults an absent grace period to 7 days", () => {
    const { gracePeriodDays: _omitted, ...rest } = valid;
    expect(parseOfferInput(rest)).toMatchObject({ ok: true, value: { gracePeriodDays: 7 } });
  });

  it.each([0, 1, 29, 30])("accepts a grace period of %i days", (gracePeriodDays) => {
    expect(parse({ gracePeriodDays })).toMatchObject({ ok: true, value: { gracePeriodDays } });
  });

  it.each([-1, 31, 1.5, "7", null, Number.NaN])("rejects a grace period of %s", (days) => {
    expect(errorOf({ gracePeriodDays: days })).toBe("grace_period_invalid");
  });

  it.each([null, undefined, "x", 1])("rejects input %j", (raw) => {
    expect(parseOfferInput(raw)).toEqual({ ok: false, error: "input_invalid" });
  });

  it("accepts an offer with no items yet", () => {
    expect(parse({ items: [] })).toMatchObject({ ok: true, value: { items: [] } });
  });

  it.each(["a", "x".repeat(100), "pri_01h8XYZ", "Z9", "a.b:c-d_e"])(
    "accepts the item ID %s",
    (externalItemId) => {
      const items = [{ source: "paddle", externalItemId }];
      expect(parse({ items })).toMatchObject({ ok: true, value: { items } });
    },
  );

  it.each(["", "x".repeat(101), "a b", "a/b", "é", "!abc", "abc!", "abc\n"])(
    "rejects the item ID %j",
    (externalItemId) => {
      expect(errorOf({ items: [{ source: "simulated", externalItemId }] })).toBe("item_invalid");
    },
  );

  it.each([
    [{ source: "stripe", externalItemId: "x" }],
    [{ externalItemId: "x" }],
    [{ source: "simulated" }],
    ["x"],
  ])("rejects the item %j", (item) => {
    expect(errorOf({ items: [item] })).toBe("item_invalid");
  });

  it.each([undefined, null, "x", { length: 1 }])("rejects items %j", (items) => {
    expect(errorOf({ items })).toBe("items_invalid");
  });

  it("limits the number of items", () => {
    const items = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ source: "simulated", externalItemId: `i${i}` }));
    expect(parse({ items: items(100) }).ok).toBe(true);
    expect(errorOf({ items: items(101) })).toBe("items_invalid");
  });

  it("rejects a duplicate item, but not the same ID from another source", () => {
    const item = { source: "simulated", externalItemId: "x" };
    expect(errorOf({ items: [item, { ...item }] })).toBe("item_duplicate");
    expect(parse({ items: [item, { ...item, source: "paddle" }] }).ok).toBe(true);
  });

  it("sorts items by source then ID, and accesses by resource ID", () => {
    const result = parse({
      items: [
        { source: "simulated", externalItemId: "b" },
        { source: "paddle", externalItemId: "z" },
        { source: "simulated", externalItemId: "a" },
      ],
      accesses: [
        { resourceId: "r2", accessLevel: "write" },
        { resourceId: "r1", accessLevel: "read" },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        items: [
          { source: "paddle", externalItemId: "z" },
          { source: "simulated", externalItemId: "a" },
          { source: "simulated", externalItemId: "b" },
        ],
        accesses: [
          { resourceId: "r1", accessLevel: "read" },
          { resourceId: "r2", accessLevel: "write" },
        ],
      },
    });
  });

  it("sorts an item ID before the same ID with a suffix", () => {
    const items = [
      { source: "simulated", externalItemId: "a.b" },
      { source: "simulated", externalItemId: "a" },
      { source: "simulated", externalItemId: "a-" },
    ];
    expect(parse({ items })).toMatchObject({
      ok: true,
      value: { items: [items[1], items[2], items[0]] },
    });
  });

  it("drops unknown keys", () => {
    const result = parse({
      extra: 1,
      items: [{ source: "simulated", externalItemId: "x", extra: 1 }],
      accesses: [{ resourceId: "r1", accessLevel: "write", extra: 1 }],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        ...valid,
        items: [{ source: "simulated", externalItemId: "x" }],
      },
    });
  });

  it("requires at least one access", () => {
    expect(errorOf({ accesses: [] })).toBe("access_required");
  });

  it.each([undefined, null, "r1", { length: 1 }])("rejects accesses %j", (accesses) => {
    expect(errorOf({ accesses })).toBe("accesses_invalid");
  });

  it("limits the number of accesses", () => {
    const accesses = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ resourceId: `r${i}`, accessLevel: "write" }));
    expect(parse({ accesses: accesses(100) }).ok).toBe(true);
    expect(errorOf({ accesses: accesses(101) })).toBe("accesses_invalid");
  });

  it.each([
    [{ resourceId: "", accessLevel: "write" }],
    [{ accessLevel: "write" }],
    [{ resourceId: 1, accessLevel: "write" }],
    [{ resourceId: "", accessLevel: "admin" }],
    ["r1"],
  ])("rejects the access %j", (access) => {
    expect(errorOf({ accesses: [access] })).toBe("access_invalid");
  });

  it.each([[{ resourceId: "r1", accessLevel: "admin" }], [{ resourceId: "r1" }]])(
    "rejects the access level of %j",
    (access) => {
      expect(errorOf({ accesses: [access] })).toBe("access_level_invalid");
    },
  );

  it("rejects the same resource twice, even at another level", () => {
    expect(
      errorOf({
        accesses: [
          { resourceId: "r1", accessLevel: "write" },
          { resourceId: "r1", accessLevel: "read" },
        ],
      }),
    ).toBe("access_duplicate");
  });

  it("checks fields in order and never echoes values", () => {
    const result = parseOfferInput({
      name: "",
      gracePeriodDays: -1,
      items: "x",
      accesses: [],
    });
    expect(result).toEqual({ ok: false, error: "name_invalid" });
    expect(errorOf({ gracePeriodDays: -1, items: "x" })).toBe("grace_period_invalid");
    expect(errorOf({ items: "x", accesses: "x" })).toBe("items_invalid");
  });
});

describe("parseOfferSnapshot", () => {
  it("accepts a stored snapshot and ignores keys from newer writers", () => {
    expect(parseOfferSnapshot({ ...valid, futureField: true })).toEqual({ ok: true, value: valid });
  });

  it.each([
    ["no name", { ...valid, name: "" }],
    ["a grace period out of range", { ...valid, gracePeriodDays: 31 }],
    ["no accesses", { ...valid, accesses: [] }],
    ["a malformed item", { ...valid, items: [{ source: "simulated", externalItemId: "a b" }] }],
    ["a malformed access", { ...valid, accesses: [{ resourceId: "r1", accessLevel: "admin" }] }],
    ["no items list", { ...valid, items: undefined }],
    ["not an object", "x"],
  ])("rejects a snapshot with %s", (_, snapshot) => {
    expect(parseOfferSnapshot(snapshot)).toEqual({ ok: false, error: "snapshot_invalid" });
  });
});

describe("checkOfferAccesses", () => {
  const resource = (id: string, overrides: Partial<OfferResource> = {}): OfferResource => ({
    id,
    private: true,
    archived: false,
    selection: "selected",
    capabilities: GITHUB_PERSONAL_REPOSITORY_CAPABILITIES,
    connectionStatus: "active",
    ...overrides,
  });

  it("accepts sellable resources at supported levels", () => {
    expect(
      checkOfferAccesses([{ resourceId: "r1", accessLevel: "write" }], {
        resources: [resource("r1")],
        previousResourceIds: [],
      }),
    ).toEqual([]);
  });

  it("reports each refused access in input order", () => {
    const problems = checkOfferAccesses(
      [
        { resourceId: "r3", accessLevel: "read" },
        { resourceId: "missing", accessLevel: "write" },
        { resourceId: "r1", accessLevel: "write" },
        { resourceId: "r2", accessLevel: "write" },
      ],
      {
        resources: [resource("r1"), resource("r2", { archived: true }), resource("r3")],
        previousResourceIds: [],
      },
    );
    expect(problems).toEqual([
      { resourceId: "r3", error: "access_level_unsupported" },
      { resourceId: "missing", error: "resource_not_found" },
      { resourceId: "r2", error: "resource_not_sellable" },
    ]);
  });

  it.each([
    ["public", { private: false }],
    ["archived", { archived: true }],
    ["removed from the installation", { selection: "removed" }],
    ["on a suspended connection", { connectionStatus: "suspended" }],
  ] as const)("refuses to add a resource that is %s", (_, overrides) => {
    expect(
      checkOfferAccesses([{ resourceId: "r1", accessLevel: "write" }], {
        resources: [resource("r1", overrides)],
        previousResourceIds: ["r2"],
      }),
    ).toEqual([{ resourceId: "r1", error: "resource_not_sellable" }]);
  });

  it("keeps a resource already in the offer after it stops being sellable", () => {
    expect(
      checkOfferAccesses([{ resourceId: "r1", accessLevel: "write" }], {
        resources: [resource("r1", { archived: true })],
        previousResourceIds: ["r1"],
      }),
    ).toEqual([]);
  });

  it("still refuses an unsupported level for a resource already in the offer", () => {
    expect(
      checkOfferAccesses([{ resourceId: "r1", accessLevel: "read" }], {
        resources: [resource("r1")],
        previousResourceIds: ["r1"],
      }),
    ).toEqual([{ resourceId: "r1", error: "access_level_unsupported" }]);
  });

  it("accepts read access where the capabilities allow it", () => {
    expect(
      checkOfferAccesses([{ resourceId: "r1", accessLevel: "read" }], {
        resources: [resource("r1", { capabilities: { readOnlyGrant: true } })],
        previousResourceIds: [],
      }),
    ).toEqual([]);
  });
});
