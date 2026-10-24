/**
 * How a Paddle customer came to be linked to a subject (decision 0012): a checkout reference
 * (path 1), an emailed claim link (path 2), or an owner's manual link (path 3).
 */
export const LinkPath = {
  Checkout: "checkout",
  Email: "email",
  Manual: "manual",
} as const;
export type LinkPath = (typeof LinkPath)[keyof typeof LinkPath];
/** Every link path, as stored in audit details. */
export const LINK_PATHS = [LinkPath.Checkout, LinkPath.Email, LinkPath.Manual] as const;

/**
 * Why a claim linked nothing. Stored in `claim.rejected` audit details: add codes, never rename
 * them. A buyer can rewrite a checkout reference (threat T11), so each is an expected outcome.
 */
export const ClaimRejectionReason = {
  /** The reference's MAC does not verify, or the reference is malformed. */
  SignatureInvalid: "signature_invalid",
  /** No checkout claim or claim token matches. */
  UnknownClaim: "unknown_claim",
  /** The claim belongs to a different workspace than the subscription. */
  OtherWorkspace: "other_workspace",
  /** The claim or token is past its expiry. */
  Expired: "expired",
  /** The checkout claim was already consumed by a different customer. */
  ConsumedByOtherCustomer: "consumed_by_other_customer",
  /** The single-use claim token was already used. */
  AlreadyUsed: "already_used",
} as const;
export type ClaimRejectionReason = (typeof ClaimRejectionReason)[keyof typeof ClaimRejectionReason];
/** Every claim rejection reason, as stored in audit details. */
export const CLAIM_REJECTION_REASONS = [
  ClaimRejectionReason.SignatureInvalid,
  ClaimRejectionReason.UnknownClaim,
  ClaimRejectionReason.OtherWorkspace,
  ClaimRejectionReason.Expired,
  ClaimRejectionReason.ConsumedByOtherCustomer,
  ClaimRejectionReason.AlreadyUsed,
] as const;
