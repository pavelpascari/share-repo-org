import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AccessDecision,
  decideAccess,
  type PolicySubscription,
  SUBSCRIPTION_STATES,
} from "../src/index.ts";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

const sub = (overrides: Partial<PolicySubscription>): PolicySubscription => ({
  state: "active",
  cancelAt: null,
  endedAt: null,
  pastDueSince: null,
  ...overrides,
});

const granted = (reason: AccessDecision["reason"], until: number | null): AccessDecision => ({
  granted: true,
  validUntil: until,
  reason,
  nextEvaluationAt: until,
});
const denied = (reason: AccessDecision["reason"]): AccessDecision => ({
  granted: false,
  validUntil: null,
  reason,
  nextEvaluationAt: null,
});

describe("decideAccess (policy v1)", () => {
  it.each(["trialing", "active"] as const)("grants %s open-ended", (state) => {
    expect(decideAccess(sub({ state }), 7, NOW)).toEqual(granted(state, null));
  });

  it("does not grant paused or expired subscriptions", () => {
    expect(decideAccess(sub({ state: "paused" }), 7, NOW)).toEqual(denied("paused"));
    expect(decideAccess(sub({ state: "expired", endedAt: NOW - 1 }), 7, NOW)).toEqual(
      denied("expired"),
    );
    // Even an end in the future does not grant an expired subscription.
    expect(decideAccess(sub({ state: "expired", endedAt: NOW + DAY }), 7, NOW)).toEqual(
      denied("expired"),
    );
  });

  describe("timing/cancellation-revokes-at-effective-time", () => {
    it.each(["trialing", "active"] as const)(
      "%s with a scheduled cancellation is granted until it",
      (state) => {
        expect(decideAccess(sub({ state, cancelAt: NOW + 1 }), 7, NOW)).toEqual(
          granted("cancel_scheduled", NOW + 1),
        );
      },
    );

    it.each([0, 1])("ends access when the cancellation is %i ms past", (past) => {
      expect(decideAccess(sub({ cancelAt: NOW - past }), 7, NOW)).toEqual(
        denied("cancellation_effective"),
      );
    });

    it("grants a canceled subscription until its effective end, not at it", () => {
      const canceled = sub({ state: "canceled", endedAt: NOW + DAY });
      expect(decideAccess(canceled, 7, NOW)).toEqual(granted("canceled_until_end", NOW + DAY));
      expect(decideAccess(canceled, 7, NOW + DAY - 1)).toEqual(
        granted("canceled_until_end", NOW + DAY),
      );
      expect(decideAccess(canceled, 7, NOW + DAY)).toEqual(denied("canceled"));
      expect(decideAccess(canceled, 7, NOW + 2 * DAY)).toEqual(denied("canceled"));
    });

    it("ends a past-due grace period at an earlier scheduled cancellation", () => {
      const pastDue = sub({ state: "past_due", pastDueSince: NOW, cancelAt: NOW + DAY });
      expect(decideAccess(pastDue, 7, NOW)).toEqual(granted("past_due_in_grace", NOW + DAY));
      expect(decideAccess(pastDue, 7, NOW + DAY)).toEqual(denied("cancellation_effective"));
    });
  });

  describe("timing/past-due-within-grace-keeps-access", () => {
    it("grants a past-due subscription until the grace period ends", () => {
      const pastDue = sub({ state: "past_due", pastDueSince: NOW - DAY });
      expect(decideAccess(pastDue, 7, NOW)).toEqual(granted("past_due_in_grace", NOW + 6 * DAY));
      expect(decideAccess(pastDue, 7, NOW + 6 * DAY - 1)).toEqual(
        granted("past_due_in_grace", NOW + 6 * DAY),
      );
    });

    it("uses the grace period when a cancellation is scheduled later", () => {
      const pastDue = sub({ state: "past_due", pastDueSince: NOW, cancelAt: NOW + 8 * DAY });
      expect(decideAccess(pastDue, 7, NOW)).toEqual(granted("past_due_in_grace", NOW + 7 * DAY));
      expect(decideAccess(pastDue, 7, NOW + 7 * DAY)).toEqual(denied("grace_expired"));
    });

    it("counts a cancellation at exactly the grace end as the grace expiring", () => {
      const pastDue = sub({ state: "past_due", pastDueSince: NOW, cancelAt: NOW + 7 * DAY });
      expect(decideAccess(pastDue, 7, NOW + 7 * DAY)).toEqual(denied("grace_expired"));
    });
  });

  describe("timing/grace-expiry-revokes", () => {
    it("ends access when the grace period ends", () => {
      const pastDue = sub({ state: "past_due", pastDueSince: NOW - 7 * DAY });
      expect(decideAccess(pastDue, 7, NOW)).toEqual(denied("grace_expired"));
      expect(decideAccess(pastDue, 7, NOW + 1)).toEqual(denied("grace_expired"));
    });

    it("gives no grace when the offer's grace period is 0 days", () => {
      expect(decideAccess(sub({ state: "past_due", pastDueSince: NOW }), 0, NOW)).toEqual(
        denied("grace_expired"),
      );
    });

    it("measures grace in whole days of 86 400 000 ms", () => {
      const pastDue = sub({ state: "past_due", pastDueSince: NOW });
      expect(decideAccess(pastDue, 30, NOW)).toEqual(granted("past_due_in_grace", NOW + 30 * DAY));
      expect(decideAccess(pastDue, 1, NOW)).toEqual(granted("past_due_in_grace", NOW + DAY));
    });
  });

  it("refuses a subscription that breaks the snapshot invariants", () => {
    expect(() => decideAccess(sub({ state: "past_due" }), 7, NOW)).toThrow(
      "past_due needs pastDueSince",
    );
    expect(() => decideAccess(sub({ state: "canceled" }), 7, NOW)).toThrow(
      "canceled needs endedAt",
    );
  });

  it("never grants past now and never sets times on a denial", () => {
    const instant = fc.integer({ min: 0, max: 2 * NOW });
    fc.assert(
      fc.property(
        fc.constantFrom(...SUBSCRIPTION_STATES),
        instant,
        fc.option(instant),
        fc.integer({ min: 0, max: 30 }),
        instant,
        (state, at, cancelAt, grace, now) => {
          const decision = decideAccess(
            sub({
              state,
              cancelAt,
              pastDueSince: state === "past_due" ? at : null,
              endedAt: state === "canceled" || state === "expired" ? at : null,
            }),
            grace,
            now,
          );
          if (decision.granted) {
            expect(decision.validUntil === null || decision.validUntil > now).toBe(true);
            expect(decision.nextEvaluationAt).toBe(decision.validUntil);
          } else {
            expect(decision.validUntil).toBeNull();
            expect(decision.nextEvaluationAt).toBeNull();
          }
        },
      ),
    );
  });
});
