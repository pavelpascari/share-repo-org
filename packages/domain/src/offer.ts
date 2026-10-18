/** Whether an offer can be sold. Archived offers keep their history but map no new access. */
export const OFFER_STATUSES = ["active", "archived"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** Bounds for the creator-set past-due grace period, in days (decision 0009). */
export const GRACE_PERIOD_DAYS_MIN = 0;
export const GRACE_PERIOD_DAYS_MAX = 30;
export const GRACE_PERIOD_DAYS_DEFAULT = 7;

/**
 * Where commercial facts come from. `simulated` stands in for a provider outside production
 * (decision 0009); `paddle` is reserved for Phase 5 so the stored CHECK need not change then.
 */
export const COMMERCIAL_SOURCES = ["simulated", "paddle"] as const;
export type CommercialSource = (typeof COMMERCIAL_SOURCES)[number];
