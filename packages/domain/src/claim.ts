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
   * The customer has a purchase other than this checkout's: a subscription without this claim's
   * reference, or more subscriptions than the source would list. A buyer who enters someone
   * else's email at checkout must not adopt that person's customer.
   */
  CustomerHasOtherPurchases: "customer_has_other_purchases",
  /**
   * The reference reached a subscription other than the one its checkout created: the claim's
   * transaction belongs to another subscription, Paddle does not know it, or the claim has none.
   * A seller's edit of the custom data, or a buyer's own checkout carrying a copied reference
   * (threats T11, T12), must not use the claim (decision 0016).
   */
  NotThisCheckout: "not_this_checkout",
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
  ClaimRejectionReason.CustomerHasOtherPurchases,
  ClaimRejectionReason.NotThisCheckout,
] as const;

/** The reasons a checkout reference (path 1) can be rejected for. */
export const CHECKOUT_REJECTION_REASONS = [
  ClaimRejectionReason.SignatureInvalid,
  ClaimRejectionReason.UnknownClaim,
  ClaimRejectionReason.OtherWorkspace,
  ClaimRejectionReason.Expired,
  ClaimRejectionReason.ConsumedByOtherCustomer,
  ClaimRejectionReason.CustomerHasOtherPurchases,
  ClaimRejectionReason.NotThisCheckout,
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
 * How long a buyer who starts checkout again for the same price is sent back to the checkout
 * they already started, rather than to a new Paddle transaction (decision 0012, path 1).
 */
export const CHECKOUT_REUSE_WINDOW_MS = HOUR_MS;

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

/** One subscription in the provider's list of a customer's subscriptions. */
export interface CustomerSubscriptionListing {
  readonly externalSubscriptionId: string;
  /** The customer the provider says the subscription belongs to. */
  readonly externalCustomerId: string;
  /** The claim reference the subscription carries, or null for one without. */
  readonly claimReference: string | null;
}

/** A customer's subscriptions as the payment provider lists them, for path 1. */
export interface CustomerPurchases {
  readonly subscriptions: readonly CustomerSubscriptionListing[];
  /** The provider stopped listing at its page cap with more to come. */
  readonly truncated: boolean;
}

/**
 * Whether a checkout reference may link a customer (decision 0012, path 1). The link must follow
 * the purchase, not the customer: at checkout a buyer can enter anyone's email, and Paddle then
 * puts the new subscription on that person's existing customer. So the customer qualifies only
 * when every subscription the provider holds for it carries this same reference.
 *
 * The provider's list is checked rather than trusted: every listed subscription must belong to
 * this customer, and the list must include the subscription that presented the reference and
 * every subscription ShareRepo already stores for the customer. A list that is cut short, empty,
 * or misses any of those does not qualify.
 */
export function purchasesOnlyThroughClaim(input: {
  readonly reference: string;
  readonly externalCustomerId: string;
  /** The subscription whose refresh reported the reference. */
  readonly externalSubscriptionId: string;
  /** Every subscription ShareRepo stores for the customer, by external ID. */
  readonly storedSubscriptionIds: readonly string[];
  readonly purchases: CustomerPurchases;
}): boolean {
  const { purchases } = input;
  if (purchases.truncated) return false;
  const listed = new Set(purchases.subscriptions.map((sub) => sub.externalSubscriptionId));
  return (
    listed.has(input.externalSubscriptionId) &&
    input.storedSubscriptionIds.every((id) => listed.has(id)) &&
    purchases.subscriptions.every(
      (sub) =>
        sub.externalCustomerId === input.externalCustomerId &&
        sub.claimReference === input.reference,
    )
  );
}

/**
 * Whether ShareRepo recorded the customer before the checkout claim was created. ShareRepo
 * records a customer with its first subscription, which then cannot carry the claim's reference,
 * so such a customer fails {@link purchasesOnlyThroughClaim} too; this answers without asking the
 * provider.
 */
export const customerKnownBeforeClaim = (input: {
  readonly claimCreatedAt: Instant;
  readonly customerRecordedAt: Instant;
}): boolean => input.customerRecordedAt < input.claimCreatedAt;

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
