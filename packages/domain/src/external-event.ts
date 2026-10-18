/** Processing state of a received provider event (domain model § External event). */
export const EXTERNAL_EVENT_STATES = ["pending", "processed", "ignored", "failed"] as const;
export type ExternalEventState = (typeof EXTERNAL_EVENT_STATES)[number];

/** Work handed from a committed change to the jobs Worker (decision 0003). */
export const OUTBOX_KINDS = [
  "process_external_event",
  "resync_connection",
  "refresh_subscription",
  "recompute_offer",
] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];
