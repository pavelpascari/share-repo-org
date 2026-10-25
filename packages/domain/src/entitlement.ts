import type { ResourceCapabilities } from "./resource.ts";
import type { Instant } from "./time.ts";

/**
 * Stored entitlement states (decision 0009). Pending and blocked are planner decisions, and
 * "expiring" is an active entitlement with `validUntil` set.
 */
export const ENTITLEMENT_STATES = ["active", "expired", "revoked"] as const;
export type EntitlementState = (typeof ENTITLEMENT_STATES)[number];

/** What an entitlement derives from. v1: subscriptions only. */
export const ENTITLEMENT_SOURCE_TYPES = ["subscription"] as const;
export type EntitlementSourceType = (typeof ENTITLEMENT_SOURCE_TYPES)[number];

/** Version of the access policy in code; stored on every entitlement it decides. */
export const ACCESS_POLICY_VERSION = 1;

/** Access a grant gives to a resource. Personal repositories support only `write` (0008). */
export const ACCESS_LEVELS = ["read", "write"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/**
 * Whether a resource with these capabilities can be granted the access level (domain invariant
 * 12). Every provider can grant write access; a read-only grant needs explicit support.
 */
export function supportsAccessLevel(
  capabilities: Pick<ResourceCapabilities, "readOnlyGrant">,
  level: AccessLevel,
): boolean {
  return level === "write" || capabilities.readOnlyGrant;
}

/**
 * How long an `active` entitlement past its `validUntil` waits for its subscription's refresh to
 * confirm the end before reconciliation revokes on the stored facts alone (decision 0013). Covers
 * a source that stays unreadable, such as a Paddle outage. A domain constant, not a setting.
 */
export const EXPIRY_CONFIRMATION_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * What an `active` entitlement means for access at an instant (decision 0013):
 * - `desired`: `validUntil` is null or still ahead;
 * - `expiry_pending`: `validUntil` has passed, by less than the confirmation window. It grants
 *   nothing new and revokes nothing, while the subscription's refresh re-reads the source and
 *   either ends the entitlement or extends it;
 * - `not_desired`: the window has passed too.
 *
 * Stored `expired` and `revoked` entitlements are never desired.
 */
export const EntitlementValidity = {
  Desired: "desired",
  ExpiryPending: "expiry_pending",
  NotDesired: "not_desired",
} as const;
export type EntitlementValidity = (typeof EntitlementValidity)[keyof typeof EntitlementValidity];
export const ENTITLEMENT_VALIDITIES = [
  EntitlementValidity.Desired,
  EntitlementValidity.ExpiryPending,
  EntitlementValidity.NotDesired,
] as const;

/** The validity of an `active` entitlement ending at `validUntil` (null: open-ended), at `now`. */
export function entitlementValidity(validUntil: Instant | null, now: Instant): EntitlementValidity {
  if (validUntil === null || validUntil > now) return EntitlementValidity.Desired;
  return now < validUntil + EXPIRY_CONFIRMATION_WINDOW_MS
    ? EntitlementValidity.ExpiryPending
    : EntitlementValidity.NotDesired;
}
