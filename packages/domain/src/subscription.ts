/** Normalized commercial state of a subscription (product § policies, decision 0009). */
export const SUBSCRIPTION_STATES = [
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
  "expired",
] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];
