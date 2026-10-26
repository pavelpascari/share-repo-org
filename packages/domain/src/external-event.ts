/**
 * Providers whose webhooks ShareRepo receives. Wider than `IDENTITY_PROVIDERS`: Paddle sends
 * events but is never a sign-in identity or an access subject.
 */
export const EventProvider = {
  GitHub: "github",
  Paddle: "paddle",
} as const;
export type EventProvider = (typeof EventProvider)[keyof typeof EventProvider];
/** Every event provider, in the order the database CHECK lists them. */
export const EVENT_PROVIDERS = [EventProvider.GitHub, EventProvider.Paddle] as const;

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
  /** Look up a claim request's Paddle customers and email them claim links (decision 0012). */
  SendClaimEmail: "send_claim_email",
  /** Probe a Paddle connection's API key and record its status (decision 0011). */
  CheckPaddleConnection: "check_paddle_connection",
  /** List a Paddle connection's subscriptions and refresh the new or changed ones (repair). */
  SweepPaddleSubscriptions: "sweep_paddle_subscriptions",
  /** Delete operational data past its retention period, in bounded batches (decision 0015). */
  PruneData: "prune_data",
  /** Delete a `deleting` workspace's rows once `delete_after` has passed (decision 0015). */
  PurgeWorkspace: "purge_workspace",
  /** Re-seal every credential envelope still under a non-current key (secret rotation). */
  RewrapCredentials: "rewrap_credentials",
} as const;
export type OutboxKind = (typeof OutboxKind)[keyof typeof OutboxKind];
/** Every outbox kind, in the order the database CHECK lists them. */
export const OUTBOX_KINDS = [
  OutboxKind.ProcessExternalEvent,
  OutboxKind.ResyncConnection,
  OutboxKind.RefreshSubscription,
  OutboxKind.RecomputeOffer,
  OutboxKind.ReconcileResource,
  OutboxKind.SendClaimEmail,
  OutboxKind.CheckPaddleConnection,
  OutboxKind.SweepPaddleSubscriptions,
  OutboxKind.PruneData,
  OutboxKind.PurgeWorkspace,
  OutboxKind.RewrapCredentials,
] as const;
