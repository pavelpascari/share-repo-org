import { parseSubscriptionSnapshot, type SubscriptionSnapshot } from "@sharerepo/domain";
import { PaddleApiError } from "./errors.ts";
import type { PaddleSubscription } from "./port.ts";

/** The custom data key carrying a checkout's claim reference (decision 0012). */
export const CLAIM_REFERENCE_KEY = "sharerepo_claim";
/** Longer values are not ShareRepo's references and are ignored. */
export const CLAIM_REFERENCE_MAX_LENGTH = 256;

export interface NormalizedPaddleSubscription {
  readonly snapshot: SubscriptionSnapshot;
  /**
   * `custom_data.sharerepo_claim` when it is a non-empty string of at most 256 characters. Untrusted: the
   * application verifies its MAC before linking anything (threat model T11).
   */
  readonly claimReference: string | null;
}

/**
 * Paddle's commercial facts as an entitlement-source snapshot (Phase 5 plan, "The Paddle
 * entitlement source"). Paddle never reports `expired`. A scheduled pause or resume is ignored
 * until it takes effect. The customer link is never decided here.
 *
 * Throws `malformed` when the facts break the snapshot's invariants (for example a canceled
 * subscription without `canceled_at`), so a broken response never overwrites stored facts.
 */
export function normalizePaddleSubscription(
  subscription: PaddleSubscription,
): NormalizedPaddleSubscription {
  const { status, currentBillingPeriod: period, scheduledChange: change } = subscription;
  const items = subscription.items
    .filter((item) => item.status === "active" || item.status === "trialing")
    .map((item) => item.priceId);
  const parsed = parseSubscriptionSnapshot({
    externalSubscriptionId: subscription.id,
    externalCustomerId: subscription.customerId,
    items: [...new Set(items)],
    state: status,
    providerState: status,
    currentPeriodStart: period?.startsAt ?? null,
    currentPeriodEnd: period?.endsAt ?? null,
    cancelAt: change?.action === "cancel" ? change.effectiveAt : null,
    endedAt: status === "canceled" ? subscription.canceledAt : null,
    pastDueSince: status === "past_due" ? subscription.updatedAt : null,
    sourceUpdatedAt: subscription.updatedAt,
  });
  if (!parsed.ok) {
    throw new PaddleApiError("malformed", "Paddle subscription breaks the snapshot invariants");
  }
  const reference = subscription.customData?.[CLAIM_REFERENCE_KEY];
  return {
    snapshot: parsed.value,
    claimReference:
      typeof reference === "string" &&
      reference !== "" &&
      reference.length <= CLAIM_REFERENCE_MAX_LENGTH
        ? reference
        : null,
  };
}
