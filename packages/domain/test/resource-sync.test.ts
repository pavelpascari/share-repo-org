import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type CurrentResource,
  type ObservedRepository,
  planResourceSync,
  type ResourceSyncPlan,
} from "../src/index.ts";

const repo = (externalId: string, overrides: Partial<ObservedRepository> = {}) => ({
  externalId,
  name: `octocat/repo-${externalId}`,
  ownerExternalId: "583231",
  private: true,
  archived: false,
  ...overrides,
});

const resource = (
  externalId: string,
  overrides: Partial<CurrentResource> = {},
): CurrentResource => ({
  id: `res-${externalId}`,
  selection: "selected",
  ...repo(externalId),
  ...overrides,
});

const EMPTY = { discovered: [], updated: [], selectionChanged: [] };

describe("planResourceSync", () => {
  it("discovers repositories it has not seen", () => {
    expect(planResourceSync([], [repo("2"), repo("1")])).toEqual({
      ...EMPTY,
      discovered: [repo("1"), repo("2")],
      unchanged: 0,
    });
  });

  it("leaves identical selected repositories unchanged", () => {
    expect(planResourceSync([resource("1")], [repo("1")])).toEqual({ ...EMPTY, unchanged: 1 });
  });

  it("records every changed field as from/to", () => {
    const current = resource("1");
    const observed = repo("1", {
      name: "monalisa/renamed",
      ownerExternalId: "999",
      private: false,
      archived: true,
    });
    expect(planResourceSync([current], [observed])).toEqual({
      ...EMPTY,
      updated: [
        {
          id: "res-1",
          externalId: "1",
          changes: {
            name: { from: current.name, to: "monalisa/renamed" },
            ownerExternalId: { from: "583231", to: "999" },
            private: { from: true, to: false },
            archived: { from: false, to: true },
          },
        },
      ],
      unchanged: 0,
    });
  });

  it.each([
    ["name", { name: "octocat/other" }, { name: { from: "octocat/repo-1", to: "octocat/other" } }],
    ["owner", { ownerExternalId: "7" }, { ownerExternalId: { from: "583231", to: "7" } }],
    ["visibility", { private: false }, { private: { from: true, to: false } }],
    ["archival", { archived: true }, { archived: { from: false, to: true } }],
  ] as const)("detects a %s change alone", (_, overrides, changes) => {
    const plan = planResourceSync([resource("1")], [repo("1", overrides)]);
    expect(plan).toEqual({
      ...EMPTY,
      updated: [{ id: "res-1", externalId: "1", changes }],
      unchanged: 0,
    });
  });

  it("marks a selected repository that is no longer observed as removed", () => {
    expect(planResourceSync([resource("1")], [])).toEqual({
      ...EMPTY,
      selectionChanged: [{ id: "res-1", externalId: "1", from: "selected", to: "removed" }],
      unchanged: 0,
    });
  });

  it("leaves a removed repository that is still not observed alone", () => {
    expect(planResourceSync([resource("1", { selection: "removed" })], [])).toEqual({
      ...EMPTY,
      unchanged: 1,
    });
  });

  it("reselects a removed repository that is observed again, with any field changes", () => {
    const plan = planResourceSync(
      [resource("1", { selection: "removed" }), resource("2", { selection: "removed" })],
      [repo("1"), repo("2", { archived: true })],
    );
    expect(plan).toEqual({
      ...EMPTY,
      updated: [{ id: "res-2", externalId: "2", changes: { archived: { from: false, to: true } } }],
      selectionChanged: [
        { id: "res-1", externalId: "1", from: "removed", to: "selected" },
        { id: "res-2", externalId: "2", from: "removed", to: "selected" },
      ],
      unchanged: 0,
    });
  });

  it("sorts every list by external ID", () => {
    const plan = planResourceSync(
      [resource("b", { name: "x" }), resource("a", { name: "x" }), resource("d"), resource("c")],
      [repo("f"), repo("b"), repo("e"), repo("a")],
    );
    expect(plan.discovered.map((r) => r.externalId)).toEqual(["e", "f"]);
    expect(plan.updated.map((r) => r.externalId)).toEqual(["a", "b"]);
    expect(plan.selectionChanged.map((r) => r.externalId)).toEqual(["c", "d"]);
  });

  it("orders selection changes from both directions together", () => {
    const plan = planResourceSync(
      [resource("c"), resource("b", { selection: "removed" }), resource("a")],
      [repo("b")],
    );
    expect(plan.selectionChanged.map((r) => `${r.externalId}:${r.to}`)).toEqual([
      "a:removed",
      "b:selected",
      "c:removed",
    ]);
  });

  it("refuses duplicate external IDs in either input", () => {
    expect(() => planResourceSync([resource("1"), resource("1")], [])).toThrow(
      "duplicate external ID in current resources",
    );
    expect(() => planResourceSync([], [repo("1"), repo("1")])).toThrow(
      "duplicate external ID in observed repositories",
    );
  });
});

// Property tests over any current state and any observation.

const observedArb = fc.record({
  externalId: fc.constantFrom("1", "2", "3", "4", "5", "6"),
  name: fc.constantFrom("a/x", "a/y", "b/x"),
  ownerExternalId: fc.constantFrom("10", "20"),
  private: fc.boolean(),
  archived: fc.boolean(),
});
const observedListArb = fc.uniqueArray(observedArb, { selector: (r) => r.externalId });
const currentListArb = fc.uniqueArray(
  fc
    .tuple(observedArb, fc.constantFrom<"selected" | "removed">("selected", "removed"))
    .map(([r, selection]): CurrentResource => ({ ...r, id: `res-${r.externalId}`, selection })),
  { selector: (r) => r.externalId },
);

/** What the stored resources look like after a plan is written. */
function applyPlan(current: readonly CurrentResource[], plan: ResourceSyncPlan): CurrentResource[] {
  const byExternalId = new Map(current.map((r) => [r.externalId, { ...r }]));
  const find = (externalId: string) => {
    const found = byExternalId.get(externalId);
    if (found === undefined) throw new Error("plan refers to an unknown resource");
    return found;
  };
  for (const { externalId, changes } of plan.updated) {
    const target = find(externalId);
    for (const [field, change] of Object.entries(changes)) {
      Object.assign(target, { [field]: (change as { to: unknown }).to });
    }
  }
  for (const { externalId, to } of plan.selectionChanged) find(externalId).selection = to;
  for (const r of plan.discovered) {
    byExternalId.set(r.externalId, { ...r, id: `res-${r.externalId}`, selection: "selected" });
  }
  return [...byExternalId.values()];
}

describe("planResourceSync properties", () => {
  it("is idempotent: re-planning after applying a plan changes nothing", () => {
    fc.assert(
      fc.property(currentListArb, observedListArb, (current, observed) => {
        const after = applyPlan(current, planResourceSync(current, observed));
        expect(planResourceSync(after, observed)).toEqual({ ...EMPTY, unchanged: after.length });
      }),
    );
  });

  it("does not depend on input order", () => {
    fc.assert(
      fc.property(
        currentListArb.chain((c) =>
          fc.tuple(fc.constant(c), fc.shuffledSubarray(c, { minLength: c.length })),
        ),
        observedListArb.chain((o) =>
          fc.tuple(fc.constant(o), fc.shuffledSubarray(o, { minLength: o.length })),
        ),
        ([current, shuffledCurrent], [observed, shuffledObserved]) => {
          expect(planResourceSync(shuffledCurrent, shuffledObserved)).toEqual(
            planResourceSync(current, observed),
          );
        },
      ),
    );
  });

  it("leaves observed repositories selected and everything else removed", () => {
    fc.assert(
      fc.property(currentListArb, observedListArb, (current, observed) => {
        const after = applyPlan(current, planResourceSync(current, observed));
        const seen = new Set<string>(observed.map((r) => r.externalId));
        for (const r of after) {
          expect(r.selection).toBe(seen.has(r.externalId) ? "selected" : "removed");
        }
        for (const id of seen) expect(after.some((r) => r.externalId === id)).toBe(true);
      }),
    );
  });

  it("accounts for every current resource exactly once", () => {
    fc.assert(
      fc.property(currentListArb, observedListArb, (current, observed) => {
        const plan = planResourceSync(current, observed);
        const touched = new Set([
          ...plan.updated.map((r) => r.externalId),
          ...plan.selectionChanged.map((r) => r.externalId),
        ]);
        expect(touched.size + plan.unchanged).toBe(current.length);
      }),
    );
  });
});
