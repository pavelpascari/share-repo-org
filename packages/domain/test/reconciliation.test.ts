import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CONNECTION_STATUSES,
  GRANT_STATES,
  planReconciliation,
  RETRY_CLASSES,
  type ReconciliationDecision,
  type ReconciliationEntitlement,
  type ReconciliationGrant,
  type ReconciliationInput,
  type ReconciliationResource,
} from "../src/index.ts";

const NOW = 1_700_000_000_000;

const entitlement = (
  id: string,
  overrides: Partial<ReconciliationEntitlement> = {},
): ReconciliationEntitlement => ({
  id,
  subjectId: "s1",
  resourceId: "r1",
  accessLevel: "write",
  validUntil: null,
  ...overrides,
});

const grant = (id: string, overrides: Partial<ReconciliationGrant> = {}): ReconciliationGrant => ({
  id,
  subjectId: "s1",
  resourceId: "r1",
  connectionId: "c1",
  accessLevel: "write",
  state: "active",
  managed: true,
  indirect: false,
  expiresAt: null,
  retryClass: null,
  nextAttemptAt: null,
  ...overrides,
});

const resource = (
  id: string,
  overrides: Partial<ReconciliationResource> = {},
): ReconciliationResource => ({
  id,
  connectionId: "c1",
  private: true,
  archived: false,
  selection: "selected",
  capabilities: { readOnlyGrant: false },
  ...overrides,
});

const plan = (overrides: Partial<ReconciliationInput> = {}) =>
  planReconciliation({
    now: NOW,
    entitlements: [entitlement("e1")],
    grants: [],
    resources: [resource("r1")],
    connections: [{ id: "c1", status: "active" }],
    ...overrides,
  });

/** The single decision's action and reason. */
const outcome = (overrides: Partial<ReconciliationInput> = {}) => {
  const decisions = plan(overrides);
  expect(decisions).toHaveLength(1);
  const [only] = decisions as [ReconciliationDecision];
  return `${only.action}/${only.reason}`;
};

describe("planReconciliation: access desired", () => {
  it("provisions a missing grant", () => {
    expect(plan()).toEqual([
      {
        subjectId: "s1",
        resourceId: "r1",
        action: "provision",
        reason: "grant_missing",
        accessLevel: "write",
        entitlementIds: ["e1"],
        grantId: null,
      },
    ]);
  });

  it.each(["unknown", "absent"] as const)("provisions over a grant that is %s", (state) => {
    expect(plan({ grants: [grant("g1", { state })] })).toEqual([
      expect.objectContaining({ action: "provision", reason: "grant_missing", grantId: "g1" }),
    ]);
  });

  it("verifies an active grant at the desired level or higher", () => {
    expect(outcome({ grants: [grant("g1")] })).toBe("verify/grant_active");
    expect(
      outcome({
        entitlements: [entitlement("e1", { accessLevel: "read" })],
        grants: [grant("g1")],
      }),
    ).toBe("verify/grant_active");
    expect(
      outcome({
        entitlements: [entitlement("e1", { accessLevel: "read" })],
        grants: [grant("g1", { accessLevel: "read" })],
      }),
    ).toBe("verify/grant_active");
  });

  it("verifies an active grant even when the resource could not be provisioned now", () => {
    expect(outcome({ grants: [grant("g1")], resources: [], connections: [] })).toBe(
      "verify/grant_active",
    );
  });

  it("upgrades a managed grant active at a lower level", () => {
    expect(
      outcome({
        resources: [resource("r1", { capabilities: { readOnlyGrant: true } })],
        grants: [grant("g1", { accessLevel: "read" })],
      }),
    ).toBe("provision/access_level_change");
  });

  it("never changes unmanaged access at a lower level", () => {
    expect(outcome({ grants: [grant("g1", { accessLevel: "read", managed: false })] })).toBe(
      "blocked/unmanaged_lower_access",
    );
  });

  it("waits for a pending invitation until it lapses, then reissues it", () => {
    const pending = (expiresAt: number | null) => ({
      grants: [grant("g1", { state: "pending_invitation", expiresAt })],
    });
    expect(outcome(pending(null))).toBe("wait/invitation_pending");
    expect(outcome(pending(NOW + 1))).toBe("wait/invitation_pending");
    expect(outcome(pending(NOW))).toBe("provision/invitation_expired");
    expect(outcome(pending(NOW - 1))).toBe("provision/invitation_expired");
  });

  it.each(["provisioning", "revoking"] as const)("re-observes a grant stuck %s", (state) => {
    expect(outcome({ grants: [grant("g1", { state })] })).toBe("verify/intermediate_state");
  });

  it.each([
    ["retryable", "retry/transient_error"],
    ["rate_limited", "retry/rate_limited"],
    ["user_action_required", "request_action/user_action_required"],
    ["terminal", "blocked/terminal_error"],
    [null, "blocked/terminal_error"],
  ] as const)("handles a %s error as %s", (retryClass, expected) => {
    expect(outcome({ grants: [grant("g1", { state: "error", retryClass })] })).toBe(expected);
  });

  describe("blocks a provider change it cannot make", () => {
    const changes = [
      ["provision", {}],
      ["retry", { grants: [grant("g1", { state: "error", retryClass: "retryable" })] }],
      ["reissue", { grants: [grant("g1", { state: "pending_invitation", expiresAt: NOW - 1 })] }],
    ] as const;

    it.each(changes)("%s: the resource is missing", (_, overrides) => {
      expect(outcome({ ...overrides, resources: [] })).toBe("blocked/resource_missing");
    });

    it.each(changes)("%s: the connection is not active", (_, overrides) => {
      expect(outcome({ ...overrides, connections: [{ id: "c1", status: "suspended" }] })).toBe(
        "blocked/connection_inactive",
      );
      expect(outcome({ ...overrides, connections: [] })).toBe("blocked/connection_inactive");
      expect(outcome({ ...overrides, resources: [resource("r1", { connectionId: "c2" })] })).toBe(
        "blocked/connection_inactive",
      );
    });

    it.each(changes)("%s: the resource is not sellable", (_, overrides) => {
      for (const unsellable of [
        { private: false },
        { archived: true },
        { selection: "removed" as const },
      ]) {
        expect(outcome({ ...overrides, resources: [resource("r1", unsellable)] })).toBe(
          "blocked/resource_unavailable",
        );
      }
    });

    it.each(changes)("%s: the access level is unsupported", (_, overrides) => {
      expect(
        outcome({ ...overrides, entitlements: [entitlement("e1", { accessLevel: "read" })] }),
      ).toBe("blocked/access_level_unsupported");
    });

    it("access_level_change: blocked like any other change", () => {
      expect(
        outcome({
          grants: [grant("g1", { accessLevel: "read" })],
          resources: [resource("r1", { archived: true })],
        }),
      ).toBe("blocked/resource_unavailable");
    });

    it("checks the resource, connection, sellability and level in that order", () => {
      const read = [entitlement("e1", { accessLevel: "read" })];
      expect(outcome({ entitlements: read, resources: [], connections: [] })).toBe(
        "blocked/resource_missing",
      );
      expect(
        outcome({
          entitlements: read,
          resources: [resource("r1", { archived: true })],
          connections: [],
        }),
      ).toBe("blocked/connection_inactive");
      expect(outcome({ entitlements: read, resources: [resource("r1", { archived: true })] })).toBe(
        "blocked/resource_unavailable",
      );
    });
  });

  it("wants the highest level any desired entitlement gives, listing them all", () => {
    expect(
      plan({
        entitlements: [
          entitlement("e2", { accessLevel: "read" }),
          entitlement("e3"),
          entitlement("e1", { accessLevel: "read" }),
        ],
      }),
    ).toEqual([
      expect.objectContaining({ accessLevel: "write", entitlementIds: ["e1", "e2", "e3"] }),
    ]);
    expect(
      plan({
        resources: [resource("r1", { capabilities: { readOnlyGrant: true } })],
        entitlements: [entitlement("e1", { accessLevel: "read" })],
      }),
    ).toEqual([expect.objectContaining({ action: "provision", accessLevel: "read" })]);
  });

  it("does not desire an entitlement whose validity has passed", () => {
    const at = (validUntil: number) => ({
      entitlements: [entitlement("e1", { validUntil }), entitlement("e2", { validUntil: NOW + 1 })],
    });
    expect(plan(at(NOW))).toEqual([expect.objectContaining({ entitlementIds: ["e2"] })]);
    expect(plan(at(NOW - 1))).toEqual([expect.objectContaining({ entitlementIds: ["e2"] })]);
    expect(plan({ entitlements: [entitlement("e1", { validUntil: NOW })] })).toEqual([]);
  });
});

describe("planReconciliation: access not desired", () => {
  const undesired = (g: ReconciliationGrant, overrides: Partial<ReconciliationInput> = {}) =>
    outcome({ entitlements: [], grants: [g], ...overrides });

  it.each(["active", "pending_invitation", "provisioning", "error"] as const)(
    "revokes a managed grant that is %s",
    (state) => {
      expect(undesired(grant("g1", { state }))).toBe("revoke/not_entitled");
    },
  );

  it("revokes a grant whose entitlement has expired, with no level desired", () => {
    expect(
      plan({ entitlements: [entitlement("e1", { validUntil: NOW })], grants: [grant("g1")] }),
    ).toEqual([
      {
        subjectId: "s1",
        resourceId: "r1",
        action: "revoke",
        reason: "not_entitled",
        accessLevel: null,
        entitlementIds: [],
        grantId: "g1",
      },
    ]);
  });

  it("cannot revoke through an inactive connection", () => {
    expect(undesired(grant("g1"), { connections: [{ id: "c1", status: "deleted" }] })).toBe(
      "blocked/connection_inactive",
    );
    expect(undesired(grant("g1", { connectionId: "c9" }))).toBe("blocked/connection_inactive");
  });

  it("revokes through the grant's connection whatever the resource", () => {
    expect(undesired(grant("g1"), { resources: [] })).toBe("revoke/not_entitled");
  });

  it("verifies a managed grant being revoked", () => {
    expect(undesired(grant("g1", { state: "revoking" }))).toBe("verify/revocation_in_progress");
  });

  it.each(["active", "pending_invitation", "provisioning", "revoking", "error"] as const)(
    "never revokes unmanaged access that is %s",
    (state) => {
      expect(undesired(grant("g1", { state, managed: false }))).toBe("noop/unmanaged_access");
    },
  );

  it.each(["absent", "unknown"] as const)("does nothing for a grant that is %s", (state) => {
    expect(undesired(grant("g1", { state }))).toBe("noop/no_access");
    expect(undesired(grant("g1", { state, managed: false }))).toBe("noop/no_access");
  });
});

describe("planReconciliation: retry times (phase 4)", () => {
  const failed = (retryClass: "retryable" | "rate_limited", nextAttemptAt: number | null) => ({
    grants: [grant("g1", { state: "error", retryClass, nextAttemptAt })],
  });

  it.each([
    ["retryable", "transient_error"],
    ["rate_limited", "rate_limited"],
  ] as const)("waits for a %s error's retry time, then retries", (retryClass, reason) => {
    expect(outcome(failed(retryClass, NOW + 1))).toBe(`wait/${reason}`);
    expect(outcome(failed(retryClass, NOW))).toBe(`retry/${reason}`);
    expect(outcome(failed(retryClass, NOW - 1))).toBe(`retry/${reason}`);
    expect(outcome(failed(retryClass, null))).toBe(`retry/${reason}`);
  });

  it("reports a blocked change before the retry time", () => {
    expect(
      outcome({
        ...failed("retryable", NOW + 1),
        connections: [{ id: "c1", status: "suspended" }],
      }),
    ).toBe("blocked/connection_inactive");
  });

  it("ignores the retry time of an error that needs a person", () => {
    expect(
      outcome({
        grants: [
          grant("g1", {
            state: "error",
            retryClass: "user_action_required",
            nextAttemptAt: NOW + 1,
          }),
        ],
      }),
    ).toBe("request_action/user_action_required");
  });
});

describe("planReconciliation: invitation budget (phase 4)", () => {
  const spent = (remaining: number, resourceId = "r1") => ({
    invitationBudgets: new Map([[resourceId, { remaining, opensAt: NOW + 10 }]]),
  });

  it("waits to provision while the repository's budget is spent", () => {
    expect(outcome(spent(0))).toBe("wait/invitation_quota");
    expect(outcome(spent(-1))).toBe("wait/invitation_quota");
    expect(outcome(spent(1))).toBe("provision/grant_missing");
  });

  it("applies only the decision's own repository's budget", () => {
    expect(outcome(spent(0, "r2"))).toBe("provision/grant_missing");
    expect(outcome({ invitationBudgets: new Map() })).toBe("provision/grant_missing");
  });

  it.each([
    ["a reissue", grant("g1", { state: "pending_invitation", expiresAt: NOW })],
    ["a level change", grant("g1", { accessLevel: "read" })],
    ["a due retry", grant("g1", { state: "error", retryClass: "retryable" })],
    ["a rate-limited retry", grant("g1", { state: "error", retryClass: "rate_limited" })],
  ])("waits for %s too", (_, g) => {
    expect(
      outcome({
        ...spent(0),
        grants: [g],
        resources: [resource("r1", { capabilities: { readOnlyGrant: true } })],
      }),
    ).toBe("wait/invitation_quota");
  });

  it("reports a blocked change and a retry time first", () => {
    expect(outcome({ ...spent(0), resources: [resource("r1", { archived: true })] })).toBe(
      "blocked/resource_unavailable",
    );
    expect(
      outcome({
        ...spent(0),
        grants: [grant("g1", { state: "error", retryClass: "retryable", nextAttemptAt: NOW + 1 })],
      }),
    ).toBe("wait/transient_error");
  });

  it("does not hold back anything that sends no invitation", () => {
    expect(outcome({ ...spent(0), grants: [grant("g1")] })).toBe("verify/grant_active");
    expect(outcome({ ...spent(0), entitlements: [], grants: [grant("g1")] })).toBe(
      "revoke/not_entitled",
    );
  });
});

describe("planReconciliation: indirect access (phase 4)", () => {
  const indirect = (overrides: Partial<ReconciliationGrant> = {}) =>
    grant("g1", { indirect: true, managed: false, ...overrides });

  it("verifies indirect access when access is desired, whatever its level", () => {
    expect(outcome({ grants: [indirect()] })).toBe("verify/grant_active");
    expect(
      outcome({
        resources: [resource("r1", { capabilities: { readOnlyGrant: true } })],
        grants: [
          indirect({ accessLevel: "read" }),
          indirect({ accessLevel: "read", managed: true }),
        ],
      }),
    ).toBe("verify/grant_active");
  });

  it.each(["active", "pending_invitation", "error"] as const)(
    "never revokes indirect access that is %s, even if marked managed",
    (state) => {
      for (const managed of [true, false]) {
        expect(outcome({ entitlements: [], grants: [indirect({ state, managed })] })).toBe(
          "noop/indirect_access",
        );
      }
    },
  );

  it("reports no access for an absent grant first", () => {
    expect(outcome({ entitlements: [], grants: [indirect({ state: "absent" })] })).toBe(
      "noop/no_access",
    );
  });
});

describe("planReconciliation: shape", () => {
  it("returns nothing when there is nothing to reconcile", () => {
    expect(plan({ entitlements: [] })).toEqual([]);
  });

  it("decides about the highest-level grant, then the lowest ID", () => {
    const ids = (grants: ReconciliationGrant[]) => plan({ grants })[0]?.grantId;
    expect(ids([grant("g1", { accessLevel: "read" }), grant("g2")])).toBe("g2");
    expect(ids([grant("g3"), grant("g2"), grant("g1", { accessLevel: "read" })])).toBe("g2");
    expect(ids([grant("g2", { accessLevel: "read" }), grant("g1", { accessLevel: "read" })])).toBe(
      "g1",
    );
  });

  it("sorts decisions by subject, then resource", () => {
    const decisions = plan({
      entitlements: [
        entitlement("e1", { subjectId: "s2", resourceId: "r1" }),
        entitlement("e2", { subjectId: "s1", resourceId: "r2" }),
      ],
      grants: [grant("g1", { subjectId: "s1", resourceId: "r1" })],
      resources: [resource("r1"), resource("r2")],
    });
    expect(decisions.map((d) => `${d.subjectId}/${d.resourceId}`)).toEqual([
      "s1/r1",
      "s1/r2",
      "s2/r1",
    ]);
  });

  it("keeps pairs apart even when IDs share prefixes", () => {
    const decisions = plan({
      entitlements: [
        entitlement("e1", { subjectId: "s", resourceId: "1r" }),
        entitlement("e2", { subjectId: "s1", resourceId: "r" }),
      ],
    });
    expect(decisions.map((d) => d.entitlementIds)).toEqual([["e1"], ["e2"]]);
  });
});

// Property tests over any desired and observed state.

const SUBJECTS = ["s1", "s2"] as const;
const RESOURCES = ["r1", "r2", "r3"] as const;
const LEVELS = ["read", "write"] as const;

const inputArb: fc.Arbitrary<ReconciliationInput> = fc.record({
  now: fc.constant(NOW),
  entitlements: fc
    .array(
      fc.record({
        subjectId: fc.constantFrom(...SUBJECTS),
        resourceId: fc.constantFrom(...RESOURCES),
        accessLevel: fc.constantFrom(...LEVELS),
        validUntil: fc.option(fc.integer({ min: NOW - 2, max: NOW + 2 })),
      }),
      { maxLength: 6 },
    )
    .map((entries) => entries.map((e, i) => ({ ...e, id: `e${i}` }))),
  grants: fc
    .uniqueArray(
      fc.record({
        subjectId: fc.constantFrom(...SUBJECTS),
        resourceId: fc.constantFrom(...RESOURCES),
        connectionId: fc.constantFrom("c1", "c2"),
        accessLevel: fc.constantFrom(...LEVELS),
        state: fc.constantFrom(...GRANT_STATES),
        managed: fc.boolean(),
        indirect: fc.boolean(),
        expiresAt: fc.option(fc.integer({ min: NOW - 2, max: NOW + 2 })),
        retryClass: fc.option(fc.constantFrom(...RETRY_CLASSES)),
        nextAttemptAt: fc.option(fc.integer({ min: NOW - 2, max: NOW + 2 })),
      }),
      {
        selector: (g) => `${g.connectionId}/${g.subjectId}/${g.resourceId}/${g.accessLevel}`,
        maxLength: 6,
      },
    )
    .map((entries) => entries.map((g, i) => ({ ...g, id: `g${i}` }))),
  resources: fc.uniqueArray(
    fc.record({
      id: fc.constantFrom(...RESOURCES),
      connectionId: fc.constantFrom("c1", "c2"),
      private: fc.boolean(),
      archived: fc.boolean(),
      selection: fc.constantFrom("selected" as const, "removed" as const),
      capabilities: fc.record({ readOnlyGrant: fc.boolean() }),
    }),
    { selector: (r) => r.id },
  ),
  connections: fc.uniqueArray(
    fc.record({ id: fc.constantFrom("c1", "c2"), status: fc.constantFrom(...CONNECTION_STATUSES) }),
    { selector: (c) => c.id },
  ),
  invitationBudgets: fc
    .array(
      fc.tuple(
        fc.constantFrom(...RESOURCES),
        fc.record({ remaining: fc.integer({ min: -1, max: 2 }), opensAt: fc.constant(null) }),
      ),
    )
    .map((entries) => new Map(entries)),
});

const shuffled = <T>(items: readonly T[]) =>
  fc.shuffledSubarray([...items], { minLength: items.length });

const PROPERTY_TIMEOUT = 60_000;

describe("planReconciliation properties", () => {
  it(
    "drift/unmanaged-access-is-not-revoked: never revokes or changes unmanaged or indirect access",
    () => {
      fc.assert(
        fc.property(inputArb, (input) => {
          const grants = new Map(input.grants.map((g) => [g.id, g]));
          for (const decision of planReconciliation(input)) {
            const target = decision.grantId === null ? undefined : grants.get(decision.grantId);
            if (decision.action === "revoke") {
              expect(target?.managed).toBe(true);
              expect(target?.indirect).toBe(false);
            }
            // Unmanaged or indirect access that exists is never changed either way.
            if (
              target !== undefined &&
              (!target.managed || target.indirect) &&
              target.state === "active"
            ) {
              expect(["verify", "blocked", "noop"]).toContain(decision.action);
            }
          }
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "gives every desired pair exactly one decision, at its highest level",
    () => {
      fc.assert(
        fc.property(inputArb, (input) => {
          const decisions = planReconciliation(input);
          const desired = input.entitlements.filter(
            (e) => e.validUntil === null || e.validUntil > input.now,
          );
          for (const e of desired) {
            const matching = decisions.filter(
              (d) => d.subjectId === e.subjectId && d.resourceId === e.resourceId,
            );
            expect(matching).toHaveLength(1);
            expect(matching[0]?.entitlementIds).toContain(e.id);
            if (e.accessLevel === "write") expect(matching[0]?.accessLevel).toBe("write");
          }
          const listed = decisions.flatMap((d) => d.entitlementIds);
          expect([...listed].sort()).toEqual(desired.map((e) => e.id).sort());
          for (const d of decisions) {
            expect(d.accessLevel === null).toBe(d.entitlementIds.length === 0);
          }
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "is sorted and does not depend on input order",
    () => {
      fc.assert(
        fc.property(
          inputArb.chain((input) =>
            fc.tuple(
              fc.constant(input),
              fc.record({
                now: fc.constant(input.now),
                entitlements: shuffled(input.entitlements),
                grants: shuffled(input.grants),
                resources: shuffled(input.resources),
                connections: shuffled(input.connections),
                invitationBudgets: fc.constant(input.invitationBudgets ?? new Map()),
              }),
            ),
          ),
          ([input, reordered]) => {
            const decisions = planReconciliation(input);
            expect(planReconciliation(reordered)).toEqual(decisions);
            const keys = decisions.map((d) => `${d.subjectId}\u0000${d.resourceId}`);
            expect(keys).toEqual([...new Set(keys)].sort());
          },
        ),
      );
    },
    PROPERTY_TIMEOUT,
  );
});
