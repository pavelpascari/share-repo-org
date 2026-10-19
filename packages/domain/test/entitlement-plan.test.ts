import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ACCESS_POLICY_VERSION,
  type EntitlementPlan,
  type EntitlementPlanInput,
  type LiveEntitlement,
  type PlanOffer,
  type PlanSubscription,
  planEntitlements,
  SUBSCRIPTION_STATES,
} from "../src/index.ts";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

const subscription = (overrides: Partial<PlanSubscription> = {}): PlanSubscription => ({
  id: "sub1",
  state: "active",
  cancelAt: null,
  endedAt: null,
  pastDueSince: null,
  items: ["item"],
  ...overrides,
});

const offer = (offerId: string, overrides: Partial<PlanOffer> = {}): PlanOffer => ({
  offerId,
  version: 1,
  status: "active",
  gracePeriodDays: 7,
  items: ["item"],
  accesses: [{ resourceId: "r1", accessLevel: "write" }],
  ...overrides,
});

const live = (id: string, overrides: Partial<LiveEntitlement> = {}): LiveEntitlement => ({
  id,
  offerId: "o1",
  offerVersion: 1,
  resourceId: "r1",
  subjectId: "s1",
  accessLevel: "write",
  validFrom: NOW - DAY,
  validUntil: null,
  decisionReason: "active",
  policyVersion: ACCESS_POLICY_VERSION,
  ...overrides,
});

const plan = (overrides: Partial<EntitlementPlanInput> = {}) =>
  planEntitlements({
    now: NOW,
    subscription: subscription(),
    subjectId: "s1",
    offers: [offer("o1")],
    live: [],
    ...overrides,
  });

const EMPTY: EntitlementPlan = { create: [], update: [], end: [], nextEvaluationAt: null };

const created = (offerId: string, resourceId: string, overrides = {}) => ({
  offerId,
  offerVersion: 1,
  resourceId,
  subjectId: "s1",
  accessLevel: "write",
  validFrom: NOW,
  validUntil: null,
  decisionReason: "active",
  policyVersion: ACCESS_POLICY_VERSION,
  ...overrides,
});

describe("planEntitlements", () => {
  it("creates one entitlement per access of each applicable offer, sorted", () => {
    const result = plan({
      offers: [
        offer("o2", { version: 3, items: ["other", "item"] }),
        offer("o1", {
          accesses: [
            { resourceId: "r2", accessLevel: "read" },
            { resourceId: "r1", accessLevel: "write" },
          ],
        }),
      ],
    });
    expect(result).toEqual({
      ...EMPTY,
      create: [
        created("o1", "r1"),
        created("o1", "r2", { accessLevel: "read" }),
        created("o2", "r1", { offerVersion: 3 }),
      ],
    });
  });

  it("records the decision's validity and reason on a new entitlement", () => {
    const result = plan({ subscription: subscription({ state: "trialing", cancelAt: NOW + DAY }) });
    expect(result).toEqual({
      ...EMPTY,
      create: [created("o1", "r1", { validUntil: NOW + DAY, decisionReason: "cancel_scheduled" })],
      nextEvaluationAt: NOW + DAY,
    });
  });

  it.each([
    ["the offer is archived", { offers: [offer("o1", { status: "archived" })] }],
    ["the offer's items do not intersect", { offers: [offer("o1", { items: ["other"] })] }],
    ["the offer has no items", { offers: [offer("o1", { items: [] })] }],
    ["the customer is not linked", { subjectId: null }],
    ["the subscription is gone", { subscription: null }],
    ["access is not granted", { subscription: subscription({ state: "paused" }) }],
  ] as const)("creates nothing when %s", (_, overrides) => {
    expect(plan(overrides)).toEqual(EMPTY);
  });

  it("leaves a matching live entitlement alone", () => {
    expect(plan({ live: [live("e1")] })).toEqual(EMPTY);
  });

  it.each([
    ["validity", { validUntil: NOW + DAY }],
    ["reason", { decisionReason: "trialing" }],
    ["offer version", { offerVersion: 2 }],
    ["policy version", { policyVersion: ACCESS_POLICY_VERSION + 1 }],
  ] as const)("updates a live entitlement whose %s differs", (_, overrides) => {
    expect(plan({ live: [live("e1", overrides)] })).toEqual({
      ...EMPTY,
      update: [
        {
          id: "e1",
          set: {
            validUntil: null,
            decisionReason: "active",
            offerVersion: 1,
            policyVersion: ACCESS_POLICY_VERSION,
          },
        },
      ],
    });
  });

  it("moves a live entitlement to a newer offer version and validity", () => {
    expect(
      plan({
        subscription: subscription({ cancelAt: NOW + DAY }),
        offers: [offer("o1", { version: 2 })],
        live: [live("e1")],
      }),
    ).toEqual({
      ...EMPTY,
      update: [
        {
          id: "e1",
          set: {
            validUntil: NOW + DAY,
            decisionReason: "cancel_scheduled",
            offerVersion: 2,
            policyVersion: ACCESS_POLICY_VERSION,
          },
        },
      ],
      nextEvaluationAt: NOW + DAY,
    });
  });

  it("replaces a live entitlement whose access level changed", () => {
    expect(
      plan({
        offers: [offer("o1", { accesses: [{ resourceId: "r1", accessLevel: "read" }] })],
        live: [live("e1")],
      }),
    ).toEqual({
      ...EMPTY,
      create: [created("o1", "r1", { accessLevel: "read" })],
      end: [{ id: "e1", state: "revoked", reason: "offer_access_changed" }],
    });
  });

  it.each([
    ["paused", subscription({ state: "paused" }), "revoked"],
    ["grace_expired", subscription({ state: "past_due", pastDueSince: NOW - 7 * DAY }), "expired"],
    ["cancellation_effective", subscription({ cancelAt: NOW }), "expired"],
    ["canceled", subscription({ state: "canceled", endedAt: NOW }), "expired"],
    ["expired", subscription({ state: "expired", endedAt: NOW }), "expired"],
  ] as const)("ends a live entitlement when policy says %s", (reason, sub, state) => {
    expect(plan({ subscription: sub, live: [live("e1")] })).toEqual({
      ...EMPTY,
      end: [{ id: "e1", state, reason }],
    });
  });

  it("ends rather than replaces when access is no longer granted at a changed level", () => {
    expect(
      plan({
        subscription: subscription({ state: "paused" }),
        offers: [offer("o1", { accesses: [{ resourceId: "r1", accessLevel: "read" }] })],
        live: [live("e1")],
      }),
    ).toEqual({ ...EMPTY, end: [{ id: "e1", state: "revoked", reason: "paused" }] });
  });

  it.each([
    ["subscription_missing", { subscription: null }],
    ["customer_unlinked", { subjectId: null }],
    ["customer_unlinked", { subjectId: "s2" }],
    ["offer_archived", { offers: [offer("o1", { status: "archived" })] }],
    ["item_removed", { offers: [offer("o1", { items: ["other"] })] }],
    [
      "offer_access_removed",
      { offers: [offer("o1", { accesses: [{ resourceId: "r2", accessLevel: "write" }] })] },
    ],
  ] as const)("revokes a live entitlement that lost its mapping: %s", (reason, overrides) => {
    const result = plan({ ...overrides, live: [live("e1")] });
    expect(result.end).toEqual([{ id: "e1", state: "revoked", reason }]);
    expect(result.update).toEqual([]);
  });

  describe("a live entitlement that lapsed before this plan (a late sweep)", () => {
    it.each([
      ["cancel_scheduled", "cancellation_effective"],
      ["past_due_in_grace", "grace_expired"],
      ["canceled_until_end", "canceled"],
      ["active", "expired"],
    ] as const)(
      "ends a lapsed %s row as expired (%s) and grants again on a new row",
      (granted, reason) => {
        const lapsed = live("e1", { validUntil: NOW - DAY, decisionReason: granted });
        expect(plan({ live: [lapsed] })).toEqual({
          ...EMPTY,
          create: [created("o1", "r1")],
          end: [{ id: "e1", state: "expired", reason }],
        });
      },
    );

    it("treats an end exactly at now as passed, and one just after as live", () => {
      const at = (validUntil: number) =>
        plan({ live: [live("e1", { validUntil, decisionReason: "cancel_scheduled" })] });
      expect(at(NOW).end).toEqual([
        { id: "e1", state: "expired", reason: "cancellation_effective" },
      ]);
      expect(at(NOW + 1)).toEqual({
        ...EMPTY,
        update: [
          {
            id: "e1",
            set: {
              validUntil: null,
              decisionReason: "active",
              offerVersion: 1,
              policyVersion: ACCESS_POLICY_VERSION,
            },
          },
        ],
      });
    });

    it.each([
      ["no longer desired", { subscription: null }],
      ["not granted now", { subscription: subscription({ state: "paused" }) }],
    ] as const)("only ends it, as expired, when access is %s", (_, overrides) => {
      const lapsed = live("e1", { validUntil: NOW - 1, decisionReason: "past_due_in_grace" });
      expect(plan({ ...overrides, live: [lapsed] })).toEqual({
        ...EMPTY,
        end: [{ id: "e1", state: "expired", reason: "grace_expired" }],
      });
    });

    it("replaces it at a changed access level with one end and one create", () => {
      const lapsed = live("e1", { validUntil: NOW - 1, decisionReason: "cancel_scheduled" });
      expect(
        plan({
          offers: [offer("o1", { accesses: [{ resourceId: "r1", accessLevel: "read" }] })],
          live: [lapsed],
        }),
      ).toEqual({
        ...EMPTY,
        create: [created("o1", "r1", { accessLevel: "read" })],
        end: [{ id: "e1", state: "expired", reason: "cancellation_effective" }],
      });
    });
  });

  it("names the subscription first, then the subject, then the offer", () => {
    const archived = [offer("o1", { status: "archived", items: [] })];
    const reasonFor = (overrides: Partial<EntitlementPlanInput>) =>
      plan({ offers: archived, live: [live("e1")], ...overrides }).end[0]?.reason;
    expect(reasonFor({ subscription: null, subjectId: null })).toBe("subscription_missing");
    expect(reasonFor({ subjectId: null })).toBe("customer_unlinked");
    expect(reasonFor({})).toBe("offer_archived");
    expect(
      plan({ offers: [offer("o1", { items: [], accesses: [] })], live: [live("e1")] }).end[0]
        ?.reason,
    ).toBe("item_removed");
  });

  it("revokes the old subject's entitlement and creates one for the new subject", () => {
    expect(plan({ subjectId: "s2", live: [live("e1")] })).toEqual({
      ...EMPTY,
      create: [created("o1", "r1", { subjectId: "s2" })],
      end: [{ id: "e1", state: "revoked", reason: "customer_unlinked" }],
    });
  });

  it("sorts ends and updates by offer, resource and subject", () => {
    const result = plan({
      subscription: null,
      offers: [offer("o1"), offer("o2")],
      live: [
        live("e1", { offerId: "o2" }),
        live("e2", { resourceId: "r2" }),
        live("e3", { subjectId: "s0" }),
        live("e4"),
      ],
    });
    expect(result.end.map((e) => e.id)).toEqual(["e3", "e4", "e2", "e1"]);
  });

  it("keeps entitlements apart even when IDs share prefixes", () => {
    const result = plan({
      offers: [offer("o"), offer("o1", { accesses: [{ resourceId: "r", accessLevel: "write" }] })],
      live: [
        live("e1", { offerId: "o", resourceId: "1r" }),
        live("e2", { offerId: "o1", resourceId: "r" }),
      ],
    });
    expect(result).toEqual({
      ...EMPTY,
      create: [created("o", "r1")],
      end: [{ id: "e1", state: "revoked", reason: "offer_access_removed" }],
    });
  });

  it("schedules the next evaluation at the earliest granted boundary", () => {
    const sub = subscription({ state: "past_due", pastDueSince: NOW });
    const offers = [
      offer("o1", { gracePeriodDays: 3 }),
      offer("o2", { gracePeriodDays: 1 }),
      offer("o3", { gracePeriodDays: 2 }),
    ];
    expect(plan({ subscription: sub, offers }).nextEvaluationAt).toBe(NOW + DAY);
    expect(plan({ subscription: sub, offers: [...offers].reverse() }).nextEvaluationAt).toBe(
      NOW + DAY,
    );
  });

  it("ignores open-ended and denied decisions when scheduling", () => {
    const sub = subscription({ state: "past_due", pastDueSince: NOW });
    const bounded = offer("o1", { gracePeriodDays: 2 });
    const none = offer("o2", { gracePeriodDays: 0 });
    expect(plan({ subscription: sub, offers: [bounded, none] }).nextEvaluationAt).toBe(
      NOW + 2 * DAY,
    );
    expect(plan({ subscription: sub, offers: [none, bounded] }).nextEvaluationAt).toBe(
      NOW + 2 * DAY,
    );
    expect(plan({ subscription: sub, offers: [none] }).nextEvaluationAt).toBeNull();
  });

  it("refuses inputs that break its preconditions", () => {
    expect(() => plan({ offers: [offer("o1"), offer("o1")] })).toThrow("duplicate offers");
    expect(() => plan({ live: [live("e1"), live("e2")] })).toThrow("duplicate live entitlements");
    expect(() =>
      plan({
        offers: [
          offer("o1", {
            accesses: [
              { resourceId: "r1", accessLevel: "write" },
              { resourceId: "r1", accessLevel: "read" },
            ],
          }),
        ],
      }),
    ).toThrow("duplicate resource in offer accesses");
    expect(() => plan({ offers: [], live: [live("e1")] })).toThrow(
      "live entitlement refers to an offer not in the input",
    );
  });
});

// Property tests over any subscription, link, offers and live entitlements.

const OFFER_IDS = ["o1", "o2", "o3"] as const;
const RESOURCE_IDS = ["r1", "r2", "r3"] as const;
const ITEMS = ["i1", "i2", "i3"] as const;
const SUBJECTS = ["s1", "s2"] as const;
const LEVELS = ["read", "write"] as const;

const nowArb = fc.integer({ min: NOW - 10 * DAY, max: NOW + 10 * DAY });
const nearArb = fc.integer({ min: NOW - 10 * DAY, max: NOW + 10 * DAY });

const subscriptionArb: fc.Arbitrary<PlanSubscription | null> = fc.option(
  fc
    .record({
      state: fc.constantFrom(...SUBSCRIPTION_STATES),
      cancelAt: fc.option(nearArb),
      at: nearArb,
      items: fc.subarray([...ITEMS]),
    })
    .map(({ state, cancelAt, at, items }) => ({
      id: "sub1",
      state,
      cancelAt,
      pastDueSince: state === "past_due" ? at : null,
      endedAt: state === "canceled" || state === "expired" ? at : null,
      items,
    })),
);

const offersArb: fc.Arbitrary<PlanOffer[]> = fc.uniqueArray(
  fc.record({
    offerId: fc.constantFrom(...OFFER_IDS),
    version: fc.integer({ min: 1, max: 3 }),
    status: fc.constantFrom("active" as const, "archived" as const),
    gracePeriodDays: fc.integer({ min: 0, max: 30 }),
    items: fc.subarray([...ITEMS]),
    accesses: fc.uniqueArray(
      fc.record({
        resourceId: fc.constantFrom(...RESOURCE_IDS),
        accessLevel: fc.constantFrom(...LEVELS),
      }),
      { selector: (a) => a.resourceId, minLength: 1 },
    ),
  }),
  { selector: (o) => o.offerId },
);

const liveArb = (offers: readonly PlanOffer[], now: number): fc.Arbitrary<LiveEntitlement[]> =>
  offers.length === 0
    ? fc.constant([])
    : fc
        .uniqueArray(
          fc.record({
            offerId: fc.constantFrom(...offers.map((o) => o.offerId)),
            resourceId: fc.constantFrom(...RESOURCE_IDS),
            subjectId: fc.constantFrom(...SUBJECTS),
            accessLevel: fc.constantFrom(...LEVELS),
            offerVersion: fc.integer({ min: 1, max: 3 }),
            // Ends before, at and after `now`: a late sweep leaves lapsed rows live.
            validUntil: fc.option(fc.integer({ min: now - 20 * DAY, max: now + 20 * DAY })),
            decisionReason: fc.constantFrom(
              "active" as const,
              "trialing" as const,
              "cancel_scheduled" as const,
              "past_due_in_grace" as const,
              "canceled_until_end" as const,
            ),
            policyVersion: fc.constant(ACCESS_POLICY_VERSION),
          }),
          { selector: (e) => `${e.offerId}/${e.resourceId}/${e.subjectId}` },
        )
        .map((entries) => entries.map((e, i) => ({ ...e, id: `e${i}`, validFrom: now - DAY })));

const inputArb: fc.Arbitrary<EntitlementPlanInput> = fc
  .tuple(nowArb, subscriptionArb, fc.option(fc.constantFrom(...SUBJECTS)), offersArb)
  .chain(([now, sub, subjectId, offers]) =>
    liveArb(offers, now).map((liveEntitlements) => ({
      now,
      subscription: sub,
      subjectId,
      offers,
      live: liveEntitlements,
    })),
  );

/** What the live entitlements look like after a plan is written. */
function applyPlan(input: EntitlementPlanInput, result: EntitlementPlan): LiveEntitlement[] {
  const ended = new Set(result.end.map((e) => e.id));
  const updates = new Map(result.update.map((u) => [u.id, u.set]));
  const kept = input.live
    .filter((e) => !ended.has(e.id))
    .map((e) => ({ ...e, ...updates.get(e.id) }));
  const added = result.create.map((c, i) => ({ ...c, id: `new${i}` }));
  return [...kept, ...added];
}

function shuffled<T>(items: readonly T[]): fc.Arbitrary<T[]> {
  return fc.shuffledSubarray([...items], { minLength: items.length });
}

const PROPERTY_TIMEOUT = 60_000;

describe("planEntitlements properties", () => {
  it(
    "is deterministic and does not depend on input order",
    () => {
      fc.assert(
        fc.property(
          inputArb.chain((input) =>
            fc.tuple(
              fc.constant(input),
              fc
                .tuple(
                  ...input.offers.map((o) =>
                    fc
                      .tuple(shuffled(o.items), shuffled(o.accesses))
                      .map(([items, accesses]) => ({ ...o, items, accesses })),
                  ),
                )
                .chain((offers) => shuffled(offers)),
              shuffled(input.live),
            ),
          ),
          ([input, offers, liveEntitlements]) => {
            const expected = planEntitlements(input);
            expect(planEntitlements(input)).toEqual(expected);
            expect(planEntitlements({ ...input, offers, live: liveEntitlements })).toEqual(
              expected,
            );
          },
        ),
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "is idempotent: re-planning after applying a plan at the same instant changes nothing",
    () => {
      fc.assert(
        fc.property(inputArb, (input) => {
          const first = planEntitlements(input);
          const second = planEntitlements({ ...input, live: applyPlan(input, first) });
          expect(second).toEqual({ ...EMPTY, nextEvaluationAt: first.nextEvaluationAt });
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "never plans an inverted or already-passed interval",
    () => {
      fc.assert(
        fc.property(inputArb, (input) => {
          const result = planEntitlements(input);
          const untils = [
            ...result.create.map((c) => c.validUntil),
            ...result.update.map((u) => u.set.validUntil),
          ];
          for (const until of untils) expect(until === null || until > input.now).toBe(true);
          for (const c of result.create) expect(c.validFrom).toBe(input.now);
          if (result.nextEvaluationAt !== null) {
            expect(result.nextEvaluationAt).toBeGreaterThan(input.now);
          }
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "gives every new entitlement its provenance",
    () => {
      fc.assert(
        fc.property(inputArb, (input) => {
          const result = planEntitlements(input);
          for (const c of result.create) {
            const source = input.offers.find((o) => o.offerId === c.offerId);
            expect(source?.status).toBe("active");
            expect(c.offerVersion).toBe(source?.version);
            expect(c.policyVersion).toBeGreaterThanOrEqual(1);
            expect(c.decisionReason).not.toBe("");
            expect(c.subjectId).toBe(input.subjectId);
          }
          for (const e of result.end) {
            expect(input.live.some((l) => l.id === e.id)).toBe(true);
          }
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "ends every lapsed live entitlement once, as expired, and never extends it",
    () => {
      fc.assert(
        fc.property(inputArb, (input) => {
          const result = planEntitlements(input);
          const ended = result.end.map((e) => e.id);
          expect(new Set(ended).size).toBe(ended.length);
          for (const e of input.live) {
            if (e.validUntil === null || e.validUntil > input.now) continue;
            expect(result.end).toContainEqual(
              expect.objectContaining({ id: e.id, state: "expired" }),
            );
            expect(result.update.some((u) => u.id === e.id)).toBe(false);
          }
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );
});
