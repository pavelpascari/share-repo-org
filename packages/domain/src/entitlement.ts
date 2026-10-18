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
