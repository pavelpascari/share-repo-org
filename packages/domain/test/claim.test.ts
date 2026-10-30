import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CHECKOUT_CLAIM_LIFETIME_MS,
  CHECKOUT_REJECTION_REASONS,
  CHECKOUT_REUSE_WINDOW_MS,
  CLAIM_TOKEN_LIFETIME_MS,
  CUSTOMER_LINK_DECISIONS,
  CustomerLinkDecision,
  checkoutClaimUsable,
  claimTokenUsable,
  customerKnownBeforeClaim,
  decideCustomerLink,
  EMAIL_REJECTION_REASONS,
  LINK_PATHS,
  type LinkPath,
  purchasesOnlyThroughClaim,
} from "../src/index.ts";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

describe("claim constants (decision 0012)", () => {
  it("lifetimes", () =>
    expect([CHECKOUT_CLAIM_LIFETIME_MS, CLAIM_TOKEN_LIFETIME_MS]).toEqual([
      7 * 24 * HOUR,
      24 * HOUR,
    ]));
  it("reuses an open checkout for an hour", () => expect(CHECKOUT_REUSE_WINDOW_MS).toBe(HOUR));
  it("customer link decisions", () =>
    expect(CUSTOMER_LINK_DECISIONS).toEqual(["link", "relink", "noop", "conflict"]));
  it("customer link decisions by name", () =>
    expect(Object.values(CustomerLinkDecision)).toEqual(CUSTOMER_LINK_DECISIONS));
  // Stored in `claim.rejected` details: add codes, never rename them.
  it("checkout rejection reasons", () =>
    expect(CHECKOUT_REJECTION_REASONS).toEqual([
      "signature_invalid",
      "unknown_claim",
      "other_workspace",
      "expired",
      "consumed_by_other_customer",
      "customer_has_other_purchases",
      "not_this_checkout",
    ]));
  it("email rejection reasons", () =>
    expect(EMAIL_REJECTION_REASONS).toEqual(["unknown_claim", "expired", "already_used"]));
});

describe("decideCustomerLink", () => {
  it.each([
    [null, "checkout", "link"],
    [null, "email", "link"],
    [null, "manual", "link"],
    ["s1", "checkout", "noop"],
    ["s1", "email", "noop"],
    ["s1", "manual", "noop"],
    ["s2", "checkout", "conflict"],
    ["s2", "email", "relink"],
    ["s2", "manual", "relink"],
  ] as const)("a customer linked to %s, claimed for s1 by %s: %s", (current, path, expected) => {
    expect(decideCustomerLink({ currentSubjectId: current, proposedSubjectId: "s1", path })).toBe(
      expected,
    );
  });

  const subject = fc.constantFrom("s1", "s2", "s3");
  const input = fc.record({
    currentSubjectId: fc.option(subject, { nil: null }),
    proposedSubjectId: subject,
    path: fc.constantFrom<LinkPath>(...LINK_PATHS),
  });

  it("never moves a link through a checkout reference (threat T8)", () => {
    fc.assert(
      fc.property(input, (i) => {
        const decision = decideCustomerLink({ ...i, path: "checkout" });
        expect(decision).not.toBe("relink");
      }),
    );
  });

  it("links an unlinked customer, keeps a matching link, and only touches a different one", () => {
    fc.assert(
      fc.property(input, (i) => {
        const decision = decideCustomerLink(i);
        expect(decision === "link").toBe(i.currentSubjectId === null);
        expect(decision === "noop").toBe(i.currentSubjectId === i.proposedSubjectId);
      }),
    );
  });
});

describe("purchasesOnlyThroughClaim", () => {
  const REF = "v1.a.mac";
  const CTM = "ctm_a";
  const listed = (
    externalSubscriptionId: string,
    claimReference: string | null = REF,
    externalCustomerId = CTM,
  ) => ({ externalSubscriptionId, externalCustomerId, claimReference });
  const only = (
    subscriptions: ReturnType<typeof listed>[],
    options: { truncated?: boolean; stored?: string[]; trigger?: string } = {},
  ) =>
    purchasesOnlyThroughClaim({
      reference: REF,
      externalCustomerId: CTM,
      externalSubscriptionId: options.trigger ?? "sub_1",
      storedSubscriptionIds: options.stored ?? ["sub_1"],
      purchases: { subscriptions, truncated: options.truncated ?? false },
    });

  it("qualifies a customer whose every subscription carries the reference", () => {
    expect(only([listed("sub_1")])).toBe(true);
    expect(only([listed("sub_2"), listed("sub_1")], { stored: ["sub_1", "sub_2"] })).toBe(true);
  });

  it("refuses a customer with any subscription without it or with another reference", () => {
    expect(only([listed("sub_1"), listed("sub_2", null)])).toBe(false);
    expect(only([listed("sub_2", null), listed("sub_1")])).toBe(false);
    expect(only([listed("sub_1"), listed("sub_2", "v1.b.mac")])).toBe(false);
  });

  it("refuses when nothing is listed, or the list was cut short", () => {
    expect(only([])).toBe(false);
    expect(only([listed("sub_1")], { truncated: true })).toBe(false);
  });

  // Review F4: the listing is Paddle's answer, not proof. It must be about this customer, and
  // complete as far as ShareRepo can tell.
  it("refuses a listing with another customer's subscription", () => {
    expect(only([listed("sub_1"), listed("sub_2", REF, "ctm_b")])).toBe(false);
    expect(only([listed("sub_1", REF, "ctm_b")])).toBe(false);
  });

  it("refuses a listing without the subscription that presented the reference", () => {
    expect(only([listed("sub_2")], { trigger: "sub_1", stored: [] })).toBe(false);
  });

  it("refuses a listing without a subscription ShareRepo stores for the customer", () => {
    expect(only([listed("sub_1")], { stored: ["sub_1", "sub_0"] })).toBe(false);
    expect(only([listed("sub_1")], { stored: [] })).toBe(true);
  });

  it("is the conjunction over every subscription", () => {
    const carried = fc.option(fc.constantFrom(REF, "v1.b.mac"), { nil: null });
    fc.assert(
      fc.property(fc.array(carried, { minLength: 1 }), (refs) => {
        const subscriptions = refs.map((ref, i) => listed(`sub_${i + 1}`, ref));
        expect(only(subscriptions)).toBe(refs.every((r) => r === REF));
      }),
    );
  });
});

describe("customerKnownBeforeClaim", () => {
  it.each([
    [NOW - 1, true],
    [NOW, false],
    [NOW + 1, false],
  ])("a customer recorded at %d, for a claim created at NOW: %s", (recordedAt, known) => {
    expect(customerKnownBeforeClaim({ claimCreatedAt: NOW, customerRecordedAt: recordedAt })).toBe(
      known,
    );
  });
});

describe("checkoutClaimUsable", () => {
  const unconsumed = { expiresAt: NOW + HOUR, consumedByCustomerId: null };

  it("lets the first customer consume an unexpired claim", () => {
    expect(checkoutClaimUsable(unconsumed, { now: NOW, customerId: "c1" })).toEqual({
      usable: true,
      renewal: false,
    });
  });

  it("is usable until the instant before it expires", () => {
    expect(checkoutClaimUsable(unconsumed, { now: NOW + HOUR - 1, customerId: "c1" })).toEqual({
      usable: true,
      renewal: false,
    });
  });

  it.each([0, 1, HOUR])("refuses an unconsumed claim %d ms after it expires", (late) => {
    expect(checkoutClaimUsable(unconsumed, { now: NOW + HOUR + late, customerId: "c1" })).toEqual({
      usable: false,
      reason: "expired",
    });
  });

  it("accepts the consuming customer's renewal, even after the expiry", () => {
    const consumed = { expiresAt: NOW - HOUR, consumedByCustomerId: "c1" };
    expect(checkoutClaimUsable(consumed, { now: NOW, customerId: "c1" })).toEqual({
      usable: true,
      renewal: true,
    });
  });

  it.each([NOW - HOUR, NOW + HOUR])(
    "refuses another customer once consumed (expiring at %d)",
    (expiresAt) => {
      const consumed = { expiresAt, consumedByCustomerId: "c1" };
      expect(checkoutClaimUsable(consumed, { now: NOW, customerId: "c2" })).toEqual({
        usable: false,
        reason: "consumed_by_other_customer",
      });
    },
  );

  const claim = fc.record({
    expiresAt: fc.integer({ min: 0, max: 2 * NOW }),
    consumedByCustomerId: fc.option(fc.constantFrom("c1", "c2"), { nil: null }),
  });
  const customerId = fc.constantFrom("c1", "c2");
  const instant = fc.integer({ min: 0, max: 2 * NOW });

  it("once usable, is usable at every earlier instant", () => {
    fc.assert(
      fc.property(claim, customerId, instant, instant, (c, id, a, b) => {
        const [earlier, later] = a <= b ? [a, b] : [b, a];
        if (checkoutClaimUsable(c, { now: later, customerId: id }).usable) {
          expect(checkoutClaimUsable(c, { now: earlier, customerId: id }).usable).toBe(true);
        }
      }),
    );
  });

  it("is never usable by a customer other than its consumer", () => {
    fc.assert(
      fc.property(claim, customerId, instant, (c, id, now) => {
        const result = checkoutClaimUsable(c, { now, customerId: id });
        if (c.consumedByCustomerId !== null && c.consumedByCustomerId !== id) {
          expect(result.usable).toBe(false);
        }
      }),
    );
  });
});

describe("claimTokenUsable", () => {
  const fresh = { expiresAt: NOW + HOUR, consumedAt: null };

  it("accepts an unused, unexpired token", () => {
    expect(claimTokenUsable(fresh, NOW)).toEqual({ usable: true });
    expect(claimTokenUsable(fresh, NOW + HOUR - 1)).toEqual({ usable: true });
  });

  it.each([0, 1])("refuses a token %d ms past its expiry", (late) => {
    expect(claimTokenUsable(fresh, NOW + HOUR + late)).toEqual({
      usable: false,
      reason: "expired",
    });
  });

  it.each([NOW + HOUR, NOW - HOUR])(
    "refuses a used token, expiring at %d, as used",
    (expiresAt) => {
      expect(claimTokenUsable({ expiresAt, consumedAt: NOW - 1 }, NOW)).toEqual({
        usable: false,
        reason: "already_used",
      });
    },
  );

  it("once usable, is usable at every earlier instant, and never after use", () => {
    const token = fc.record({
      expiresAt: fc.integer({ min: 0, max: 2 * NOW }),
      consumedAt: fc.option(fc.integer({ min: 0, max: 2 * NOW }), { nil: null }),
    });
    const instant = fc.integer({ min: 0, max: 2 * NOW });
    fc.assert(
      fc.property(token, instant, instant, (t, a, b) => {
        const [earlier, later] = a <= b ? [a, b] : [b, a];
        if (claimTokenUsable(t, later).usable) {
          expect(claimTokenUsable(t, earlier).usable).toBe(true);
        }
        if (t.consumedAt !== null) expect(claimTokenUsable(t, a).usable).toBe(false);
      }),
    );
  });
});
