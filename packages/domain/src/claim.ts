import type { Instant } from "./time.ts";

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
  /**
   * The customer existed before the checkout started, so the checkout did not create it: a buyer
   * who enters someone else's email at checkout must not adopt that person's customer.
   */
  CustomerPredatesCheckout: "customer_predates_checkout",
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
  ClaimRejectionReason.CustomerPredatesCheckout,
] as const;

/** The reasons a checkout reference (path 1) can be rejected for. */
export const CHECKOUT_REJECTION_REASONS = [
  ClaimRejectionReason.SignatureInvalid,
  ClaimRejectionReason.UnknownClaim,
  ClaimRejectionReason.OtherWorkspace,
  ClaimRejectionReason.Expired,
  ClaimRejectionReason.ConsumedByOtherCustomer,
  ClaimRejectionReason.CustomerPredatesCheckout,
] as const;
/** The reasons an emailed claim token (path 2) can be rejected for. */
export const EMAIL_REJECTION_REASONS = [
  ClaimRejectionReason.UnknownClaim,
  ClaimRejectionReason.Expired,
  ClaimRejectionReason.AlreadyUsed,
] as const;

const HOUR_MS = 3_600_000;

/** How long a checkout claim's reference may first link a customer (decision 0012, path 1). */
export const CHECKOUT_CLAIM_LIFETIME_MS = 7 * 24 * HOUR_MS;
/** How long an emailed claim link stays usable (decision 0012, path 2). */
export const CLAIM_TOKEN_LIFETIME_MS = 24 * HOUR_MS;
/**
 * How far the payment provider's clock may run behind ShareRepo's when path 1 compares the time
 * the provider created a customer with the time the checkout claim was created (decision 0012).
 */
export const CHECKOUT_CLOCK_SKEW_MS = 60_000;

// Linking -------------------------------------------------------------------------------------

/** What applying a claim does to a customer's link to a subject. */
export const CustomerLinkDecision = {
  /** The customer is unlinked: link it. */
  Link: "link",
  /** The customer is linked to another subject, and the path may move the link: move it. */
  Relink: "relink",
  /** The customer is already linked to the proposed subject. */
  Noop: "noop",
  /** The customer is linked to another subject, and the path may not move the link. */
  Conflict: "conflict",
} as const;
export type CustomerLinkDecision = (typeof CustomerLinkDecision)[keyof typeof CustomerLinkDecision];
/** Every customer link decision. */
export const CUSTOMER_LINK_DECISIONS = [
  CustomerLinkDecision.Link,
  CustomerLinkDecision.Relink,
  CustomerLinkDecision.Noop,
  CustomerLinkDecision.Conflict,
] as const;

/**
 * Decides how a claim changes a customer's link (decision 0012). A checkout reference (path 1)
 * never moves an existing link (threat T8). Proof of the payment mailbox (path 2) and an owner's
 * audited manual link (path 3) do.
 */
export function decideCustomerLink(input: {
  readonly currentSubjectId: string | null;
  readonly proposedSubjectId: string;
  readonly path: LinkPath;
}): CustomerLinkDecision {
  if (input.currentSubjectId === null) return CustomerLinkDecision.Link;
  if (input.currentSubjectId === input.proposedSubjectId) return CustomerLinkDecision.Noop;
  return input.path === LinkPath.Checkout
    ? CustomerLinkDecision.Conflict
    : CustomerLinkDecision.Relink;
}

// Claim rules ---------------------------------------------------------------------------------

/** The stored checkout claim fields its usability depends on. */
export interface UsableCheckoutClaim {
  readonly expiresAt: Instant;
  /** The ShareRepo customer that first presented the claim's reference, if any. */
  readonly consumedByCustomerId: string | null;
}

/** Whether a verified checkout reference may link a customer, and why not. */
export type CheckoutClaimUsability =
  | {
      readonly usable: true;
      /** The customer already consumed the claim: a renewal carrying the same reference. */
      readonly renewal: boolean;
    }
  | {
      readonly usable: false;
      readonly reason:
        | typeof ClaimRejectionReason.Expired
        | typeof ClaimRejectionReason.ConsumedByOtherCustomer;
    };

/**
 * Whether a checkout claim, found in the subscription's workspace through a verified reference,
 * may link `customerId`. The first customer to present it before it expires consumes it. That
 * customer's renewals carry the same reference and stay usable after the expiry; any other
 * customer is refused.
 */
export function checkoutClaimUsable(
  claim: UsableCheckoutClaim,
  at: { readonly now: Instant; readonly customerId: string },
): CheckoutClaimUsability {
  if (claim.consumedByCustomerId !== null) {
    return claim.consumedByCustomerId === at.customerId
      ? { usable: true, renewal: true }
      : { usable: false, reason: ClaimRejectionReason.ConsumedByOtherCustomer };
  }
  return at.now < claim.expiresAt
    ? { usable: true, renewal: false }
    : { usable: false, reason: ClaimRejectionReason.Expired };
}

/** What is known about when a customer came to exist, for {@link customerPredatesCheckout}. */
export interface CustomerOrigin {
  /** When ShareRepo first recorded the customer, by ShareRepo's clock. */
  readonly recordedAt: Instant;
  /** When the payment provider created the customer, by its clock; null when not read yet. */
  readonly createdAt: Instant | null;
}

/**
 * Whether a customer existed before a checkout claim was created, so the checkout cannot have
 * created it (decision 0012, path 1). Paddle reuses an existing customer when the buyer enters
 * that customer's email at checkout; linking it would hand every subscription of that customer to
 * whoever started the checkout. A customer ShareRepo recorded before the claim predates it; so
 * does one the provider created more than {@link CHECKOUT_CLOCK_SKEW_MS} before it.
 */
export function customerPredatesCheckout(
  claimCreatedAt: Instant,
  customer: CustomerOrigin,
): boolean {
  if (customer.recordedAt < claimCreatedAt) return true;
  return (
    customer.createdAt !== null && customer.createdAt < claimCreatedAt - CHECKOUT_CLOCK_SKEW_MS
  );
}

/** The stored claim token fields its usability depends on. */
export interface UsableClaimToken {
  readonly expiresAt: Instant;
  readonly consumedAt: Instant | null;
}

/** Whether an emailed claim token may still be confirmed, and why not. */
export type ClaimTokenUsability =
  | { readonly usable: true }
  | {
      readonly usable: false;
      readonly reason:
        | typeof ClaimRejectionReason.Expired
        | typeof ClaimRejectionReason.AlreadyUsed;
    };

/** Whether a claim token is unused and unexpired at `now`. A used token reports that first. */
export function claimTokenUsable(token: UsableClaimToken, now: Instant): ClaimTokenUsability {
  if (token.consumedAt !== null) {
    return { usable: false, reason: ClaimRejectionReason.AlreadyUsed };
  }
  return now < token.expiresAt
    ? { usable: true }
    : { usable: false, reason: ClaimRejectionReason.Expired };
}
