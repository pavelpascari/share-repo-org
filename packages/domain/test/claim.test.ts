import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CHECKOUT_CLAIM_LIFETIME_MS,
  CHECKOUT_CLOCK_SKEW_MS,
  CHECKOUT_REJECTION_REASONS,
  CLAIM_TOKEN_LIFETIME_MS,
  CUSTOMER_LINK_DECISIONS,
  CustomerLinkDecision,
  checkoutClaimUsable,
  claimTokenUsable,
  customerPredatesCheckout,
  decideCustomerLink,
  EMAIL_REJECTION_REASONS,
  LINK_PATHS,
  type LinkPath,
} from "../src/index.ts";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

describe("claim constants (decision 0012)", () => {
  it("lifetimes", () =>
    expect([CHECKOUT_CLAIM_LIFETIME_MS, CLAIM_TOKEN_LIFETIME_MS]).toEqual([
      7 * 24 * HOUR,
      24 * HOUR,
    ]));
  it("clock skew allowed when comparing provider and ShareRepo times", () =>
    expect(CHECKOUT_CLOCK_SKEW_MS).toBe(60_000));
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
      "customer_predates_checkout",
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

describe("customerPredatesCheckout", () => {
  const SKEW = 60_000;

  it("a customer recorded and created with or after the claim does not predate it", () => {
    expect(customerPredatesCheckout(NOW, { recordedAt: NOW, createdAt: NOW })).toBe(false);
    expect(customerPredatesCheckout(NOW, { recordedAt: NOW + 1, createdAt: null })).toBe(false);
  });

  it("a customer ShareRepo recorded before the claim predates it, whatever the provider says", () => {
    expect(customerPredatesCheckout(NOW, { recordedAt: NOW - 1, createdAt: null })).toBe(true);
    expect(customerPredatesCheckout(NOW, { recordedAt: NOW - 1, createdAt: NOW })).toBe(true);
  });

  it("allows the provider's clock to run up to the skew behind", () => {
    expect(customerPredatesCheckout(NOW, { recordedAt: NOW, createdAt: NOW - SKEW })).toBe(false);
    expect(customerPredatesCheckout(NOW, { recordedAt: NOW, createdAt: NOW - SKEW - 1 })).toBe(
      true,
    );
  });

  it("decides from ShareRepo's record alone until the provider is read", () => {
    const instant = fc.integer({ min: 0, max: 2 * NOW });
    fc.assert(
      fc.property(instant, instant, (claimCreatedAt, recordedAt) => {
        expect(customerPredatesCheckout(claimCreatedAt, { recordedAt, createdAt: null })).toBe(
          recordedAt < claimCreatedAt,
        );
      }),
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
