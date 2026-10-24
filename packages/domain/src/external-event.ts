/** Processing state of a received provider event (domain model § External event). */
export const EXTERNAL_EVENT_STATES = ["pending", "processed", "ignored", "failed"] as const;
export type ExternalEventState = (typeof EXTERNAL_EVENT_STATES)[number];

/**
 * Work handed from a committed change to the jobs Worker (decision 0003). ShareRepo's own
 * vocabulary, not a provider's: stored in the outbox and sent on the queue.
 */
export const OutboxKind = {
  /** Re-read the provider state a stored webhook event points at. */
  ProcessExternalEvent: "process_external_event",
  /** Re-read a GitHub connection's installation and repositories. */
  ResyncConnection: "resync_connection",
  /** Re-read a subscription from its entitlement source and recompute its entitlements. */
  RefreshSubscription: "refresh_subscription",
  /** Recompute the entitlements of every subscription an offer covers. */
  RecomputeOffer: "recompute_offer",
  /** Observe a repository's access and converge it to its entitlements (decision 0010). */
  ReconcileResource: "reconcile_resource",
} as const;
export type OutboxKind = (typeof OutboxKind)[keyof typeof OutboxKind];
/** Every outbox kind, in the order the database CHECK lists them. */
export const OUTBOX_KINDS = [
  OutboxKind.ProcessExternalEvent,
  OutboxKind.ResyncConnection,
  OutboxKind.RefreshSubscription,
  OutboxKind.RecomputeOffer,
  OutboxKind.ReconcileResource,
] as const;
