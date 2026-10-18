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

/** Access-provider principals. v1: GitHub users. */
export const SUBJECT_TYPES = ["user"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];
