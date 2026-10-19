/** Observed provider-side access state (domain model § Grant). */
export const GRANT_STATES = [
  "unknown",
  "absent",
  "provisioning",
  "pending_invitation",
  "active",
  "revoking",
  "error",
] as const;
export type GrantState = (typeof GRANT_STATES)[number];

/** How a grant error can be resolved. */
export const RETRY_CLASSES = [
  "retryable",
  "rate_limited",
  "user_action_required",
  "terminal",
] as const;
export type RetryClass = (typeof RETRY_CLASSES)[number];

/** A change ShareRepo asks an access provider to make (decision 0010). */
export const MUTATION_OPERATIONS = ["invite", "remove_collaborator", "cancel_invitation"] as const;
export type MutationOperation = (typeof MUTATION_OPERATIONS)[number];

/**
 * A provider mutation's outcome. `started` is written before the request is sent; it changes
 * exactly once, to `succeeded`, `failed`, or `resolved` when a later observation settled an
 * outcome that was never recorded (a lost response or a crash).
 */
export const MUTATION_STATUSES = ["started", "succeeded", "failed", "resolved"] as const;
export type MutationStatus = (typeof MUTATION_STATUSES)[number];

/** Access-provider principals. v1: GitHub users. */
export const SUBJECT_TYPES = ["user"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];
