import type { SubscriptionSnapshot } from "./subscription.ts";
import type { Instant } from "./time.ts";

/**
 * Why access is or is not desired. Stored in `entitlements.decision_reason` and shown to
 * creators, so the codes are stable: add new ones, never rename.
 *
 * Granted: `active`, `trialing`, `cancel_scheduled` (until the scheduled cancellation),
 * `past_due_in_grace` (until the grace period or a scheduled cancellation ends), and
 * `canceled_until_end` (canceled, but paid up to its effective end).
 *
 * Not granted, from the subscription: `paused`, `grace_expired`, `cancellation_effective`,
 * `canceled`, `expired`. From the mapping (entitlement planning): `offer_archived`,
 * `offer_access_removed`, `offer_access_changed`, `item_removed`, `customer_unlinked`,
 * `subscription_missing`.
 */
export const ACCESS_DECISION_REASONS = [
  "active",
  "trialing",
  "cancel_scheduled",
  "past_due_in_grace",
  "canceled_until_end",
  "paused",
  "grace_expired",
  "cancellation_effective",
  "canceled",
  "expired",
  "offer_archived",
  "offer_access_removed",
  "offer_access_changed",
  "item_removed",
  "customer_unlinked",
  "subscription_missing",
] as const;
export type AccessDecisionReason = (typeof ACCESS_DECISION_REASONS)[number];

/** What policy decides for one subscription under one offer, at one instant. */
export interface AccessDecision {
  readonly granted: boolean;
  /** When granted access ends by policy, or null while open-ended. Null when not granted. */
  readonly validUntil: Instant | null;
  readonly reason: AccessDecisionReason;
  /** When this decision must be made again because a boundary passes, or null. */
  readonly nextEvaluationAt: Instant | null;
}

export type PolicySubscription = Pick<
  SubscriptionSnapshot,
  "state" | "cancelAt" | "endedAt" | "pastDueSince"
>;

const DAY_MS = 86_400_000;

/**
 * Access policy version 1 (decision 0009, `ACCESS_POLICY_VERSION`). Access never outlives
 * policy: a boundary equal to `now` has already passed.
 *
 * - trialing, active: granted, until `cancelAt` when a cancellation is scheduled;
 * - past_due: granted until `pastDueSince + gracePeriodDays` or `cancelAt`, whichever is earlier
 *   (a grace period of 0 days gives none);
 * - paused, expired: not granted;
 * - canceled: granted until `endedAt`.
 *
 * Throws when the subscription breaks the snapshot invariants it relies on (a past-due
 * subscription without `pastDueSince`, a canceled one without `endedAt`).
 */
export function decideAccess(
  subscription: PolicySubscription,
  gracePeriodDays: number,
  now: Instant,
): AccessDecision {
  switch (subscription.state) {
    case "trialing":
    case "active":
      return subscription.cancelAt === null
        ? { granted: true, validUntil: null, reason: subscription.state, nextEvaluationAt: null }
        : grantedUntil(subscription.cancelAt, now, "cancel_scheduled", "cancellation_effective");
    case "past_due": {
      if (subscription.pastDueSince === null) throw new Error("past_due needs pastDueSince");
      const graceEnd = subscription.pastDueSince + gracePeriodDays * DAY_MS;
      const { cancelAt } = subscription;
      return cancelAt !== null && cancelAt < graceEnd
        ? grantedUntil(cancelAt, now, "past_due_in_grace", "cancellation_effective")
        : grantedUntil(graceEnd, now, "past_due_in_grace", "grace_expired");
    }
    case "paused":
    case "expired":
      return notGranted(subscription.state);
    case "canceled":
      if (subscription.endedAt === null) throw new Error("canceled needs endedAt");
      return grantedUntil(subscription.endedAt, now, "canceled_until_end", "canceled");
  }
}

function grantedUntil(
  end: Instant,
  now: Instant,
  grantedReason: AccessDecisionReason,
  endedReason: AccessDecisionReason,
): AccessDecision {
  return end > now
    ? { granted: true, validUntil: end, reason: grantedReason, nextEvaluationAt: end }
    : notGranted(endedReason);
}

function notGranted(reason: AccessDecisionReason): AccessDecision {
  return { granted: false, validUntil: null, reason, nextEvaluationAt: null };
}
