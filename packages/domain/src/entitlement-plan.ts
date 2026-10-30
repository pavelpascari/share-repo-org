import {
  ACCESS_POLICY_VERSION,
  type AccessLevel,
  EntitlementValidity,
  entitlementValidity,
} from "./entitlement.ts";
import type { AccessWithdrawal } from "./lifecycle.ts";
import type { OfferStatus } from "./offer.ts";
import {
  type AccessDecision,
  type AccessDecisionReason,
  decideAccess,
  type PolicySubscription,
} from "./policy.ts";
import type { SubscriptionSnapshot } from "./subscription.ts";
import type { Instant } from "./time.ts";

/** The subscription being planned, as stored, with its item IDs. */
export type PlanSubscription = PolicySubscription &
  Pick<SubscriptionSnapshot, "items"> & { readonly id: string };

/** An offer at its current version, as entitlement planning needs it. */
export interface PlanOffer {
  readonly offerId: string;
  readonly version: number;
  readonly status: OfferStatus;
  readonly gracePeriodDays: number;
  /** External item IDs of the offer's commercial items. */
  readonly items: readonly string[];
  readonly accesses: readonly { readonly resourceId: string; readonly accessLevel: AccessLevel }[];
}

/** A live (`active`) entitlement of the subscription being planned. */
export interface LiveEntitlement {
  readonly id: string;
  readonly offerId: string;
  readonly offerVersion: number;
  readonly resourceId: string;
  readonly subjectId: string;
  readonly accessLevel: AccessLevel;
  readonly validFrom: Instant;
  readonly validUntil: Instant | null;
  readonly decisionReason: AccessDecisionReason;
  readonly policyVersion: number;
}

export interface EntitlementPlanInput {
  readonly now: Instant;
  /** Null when the source no longer has the subscription. */
  readonly subscription: PlanSubscription | null;
  /** The subscriber's subject, or null while the customer is not linked to one. */
  readonly subjectId: string | null;
  /**
   * Every offer whose current items intersect the subscription's items, and every offer a live
   * entitlement refers to. The planner decides which apply.
   */
  readonly offers: readonly PlanOffer[];
  /** The subscription's live entitlements; at most one per offer, resource and subject. */
  readonly live: readonly LiveEntitlement[];
  /**
   * Set when all access is withdrawn whatever the subscription says (decision 0015): nothing is
   * desired, and every live entitlement is revoked with this reason. Absent or null otherwise.
   */
  readonly withdrawn?: AccessWithdrawal | null;
}

export interface NewEntitlementPlan {
  readonly offerId: string;
  readonly offerVersion: number;
  readonly resourceId: string;
  readonly subjectId: string;
  readonly accessLevel: AccessLevel;
  readonly validFrom: Instant;
  readonly validUntil: Instant | null;
  readonly decisionReason: AccessDecisionReason;
  readonly policyVersion: number;
}

export interface EntitlementUpdatePlan {
  readonly id: string;
  readonly set: {
    readonly validUntil: Instant | null;
    readonly decisionReason: AccessDecisionReason;
    readonly offerVersion: number;
    readonly policyVersion: number;
  };
}

export interface EntitlementEndPlan {
  readonly id: string;
  /** `expired` when its validity interval ran out, `revoked` when the mapping went away. */
  readonly state: "expired" | "revoked";
  readonly reason: AccessDecisionReason;
}

/** The writes that bring a subscription's live entitlements to the desired state. */
export interface EntitlementPlan {
  readonly create: readonly NewEntitlementPlan[];
  readonly update: readonly EntitlementUpdatePlan[];
  readonly end: readonly EntitlementEndPlan[];
  /** The earliest boundary at which a granted decision changes, or null. */
  readonly nextEvaluationAt: Instant | null;
}

/**
 * Why a live entitlement whose `validUntil` has passed ended, by the reason it was granted
 * under: the boundary that reason set. A lapsed row with any other reason (policy never sets an
 * end for one) is simply `expired`.
 */
const LAPSE_REASONS: ReadonlyMap<AccessDecisionReason, AccessDecisionReason> = new Map([
  ["cancel_scheduled", "cancellation_effective"],
  ["past_due_in_grace", "grace_expired"],
  ["canceled_until_end", "canceled"],
  ["manual", "manual_ended"],
] as const);

/** Decisions that end access because time ran out; any other ending is a revocation. */
const EXPIRING_REASONS: ReadonlySet<AccessDecisionReason> = new Set([
  "grace_expired",
  "cancellation_effective",
  "canceled",
  "expired",
  "manual_ended",
]);

/** What a source desires for one offer, resource and subject. */
export interface Desired {
  readonly offer: { readonly offerId: string; readonly version: number };
  readonly resourceId: string;
  readonly accessLevel: AccessLevel;
  readonly decision: AccessDecision;
}

/**
 * Diffs a subscription's live entitlements against what policy desires now. Desired access is
 * one entitlement per active offer whose items intersect the subscription's, per offer access,
 * for the linked subject. The plan depends only on the input sets, not their order, and every
 * list is sorted by offer, resource and subject, so re-planning after applying it is empty.
 *
 * - Granted and not live: create. Granted and live: update when validity, reason, offer version
 *   or policy version differ; a changed access level ends the live one and creates a new one.
 * - Not granted and live: end, `expired` for time-based reasons and `revoked` otherwise.
 * - Live but no longer desired: revoke, with the most specific reason. A withdrawal (the workspace
 *   is being deleted) desires nothing and is the reason for every revocation.
 * - Live but lapsed (`validUntil` at or before `now`, because the sweep that should have ended it
 *   ran late): it has already ended, whatever is desired now. End it `expired`, with the reason
 *   its own boundary implies (`cancel_scheduled` → `cancellation_effective`,
 *   `past_due_in_grace` → `grace_expired`, `canceled_until_end` → `canceled`); when access is
 *   granted again, create a new row, so the gap stays visible (decision 0009: a reactivation
 *   creates a new row). A `past_due_in_grace` row cut short by a scheduled cancellation also
 *   reads `grace_expired`: the row records only that its grace-period access ran out.
 * - Except while its expiry is pending (decision 0013: within the confirmation window after
 *   `validUntil`, reconciliation neither granted nor revoked for it): when access is granted
 *   again, the source has confirmed it went on (a renewal whose webhook was lost), so the row
 *   continues like any live one. Access never had a gap, so neither does the record.
 *
 * Throws on duplicate offers, live entitlements or accesses, and when a live entitlement refers
 * to an offer missing from the input: those are caller defects, not facts to act on.
 */
export function planEntitlements(input: EntitlementPlanInput): EntitlementPlan {
  const { now, subscription, subjectId } = input;
  const offers = keyed(input.offers, (offer) => offer.offerId, "offers");
  const desired = new Map<string, Desired>();
  let nextEvaluationAt: Instant | null = null;

  if (subscription !== null && subjectId !== null && !input.withdrawn) {
    for (const offer of offers.values()) {
      if (offer.status !== "active" || !intersects(offer.items, subscription.items)) continue;
      const decision = decideAccess(subscription, offer.gracePeriodDays, now);
      nextEvaluationAt = earliest(nextEvaluationAt, decision.nextEvaluationAt);
      desire(desired, offer, subjectId, decision);
    }
  }

  const diff = diffEntitlements({
    now,
    subjectId,
    live: input.live,
    desired,
    lostMapping: (entitlement) => lostMapping(entitlement, input),
  });
  return { ...diff, nextEvaluationAt };
}

/**
 * Adds one desired entitlement per access of `offer`, for the subject, under one decision.
 * Throws on a resource the offer lists twice: a caller defect.
 */
export function desire(
  desired: Map<string, Desired>,
  offer: Desired["offer"] & {
    readonly accesses: readonly {
      readonly resourceId: string;
      readonly accessLevel: AccessLevel;
    }[];
  },
  subjectId: string,
  decision: AccessDecision,
): void {
  for (const { resourceId, accessLevel } of offer.accesses) {
    const key = entitlementKey(offer.offerId, resourceId, subjectId);
    if (desired.has(key)) throw new Error("duplicate resource in offer accesses");
    desired.set(key, { offer, resourceId, accessLevel, decision });
  }
}

/** The input of {@link diffEntitlements}: one source's live entitlements and its desired ones. */
export interface EntitlementDiffInput {
  readonly now: Instant;
  /** The subject desired entitlements are for, or null when none is desired. */
  readonly subjectId: string | null;
  readonly live: readonly LiveEntitlement[];
  /** Keyed by offer, resource and subject, as {@link desire} builds it. */
  readonly desired: ReadonlyMap<string, Desired>;
  /** Why a live entitlement that nothing desires any more ends (it is revoked). */
  readonly lostMapping: (entitlement: LiveEntitlement) => AccessDecisionReason;
}

/**
 * The writes that bring one source's live entitlements to what it desires (the rules listed on
 * {@link planEntitlements}). Shared by every entitlement source: subscriptions and manual access
 * (decision 0016). Throws on duplicate live entitlements.
 */
export function diffEntitlements(
  input: EntitlementDiffInput,
): Omit<EntitlementPlan, "nextEvaluationAt"> {
  const { now, desired } = input;
  const live = keyed(
    input.live,
    (e) => entitlementKey(e.offerId, e.resourceId, e.subjectId),
    "live entitlements",
  );
  const create: NewEntitlementPlan[] = [];
  const update: EntitlementUpdatePlan[] = [];
  const end: EntitlementEndPlan[] = [];

  for (const key of [...new Set([...live.keys(), ...desired.keys()])].sort()) {
    let current = live.get(key);
    const wanted = desired.get(key);
    const validity = current === undefined ? null : entitlementValidity(current.validUntil, now);
    const continues =
      validity === EntitlementValidity.ExpiryPending && wanted?.decision.granted === true;
    if (current !== undefined && validity !== EntitlementValidity.Desired && !continues) {
      end.push({ id: current.id, state: "expired", reason: lapseReason(current.decisionReason) });
      current = undefined;
      if (wanted === undefined || !wanted.decision.granted) continue;
    }
    if (wanted === undefined) {
      const entitlement = current as LiveEntitlement;
      end.push({ id: entitlement.id, state: "revoked", reason: input.lostMapping(entitlement) });
    } else if (!wanted.decision.granted) {
      if (current !== undefined) end.push(ended(current.id, wanted.decision.reason));
    } else if (current === undefined) {
      create.push(newEntitlement(wanted, input.subjectId as string, now));
    } else if (current.accessLevel !== wanted.accessLevel) {
      end.push({ id: current.id, state: "revoked", reason: "offer_access_changed" });
      create.push(newEntitlement(wanted, input.subjectId as string, now));
    } else {
      const set = {
        validUntil: wanted.decision.validUntil,
        decisionReason: wanted.decision.reason,
        offerVersion: wanted.offer.version,
        policyVersion: ACCESS_POLICY_VERSION,
      };
      if (
        set.validUntil !== current.validUntil ||
        set.decisionReason !== current.decisionReason ||
        set.offerVersion !== current.offerVersion ||
        set.policyVersion !== current.policyVersion
      ) {
        update.push({ id: current.id, set });
      }
    }
  }

  return { create, update, end };
}

/** Why a live entitlement no longer maps to desired access, most specific cause first. */
function lostMapping(
  entitlement: LiveEntitlement,
  { subscription, subjectId, offers, withdrawn }: EntitlementPlanInput,
): AccessDecisionReason {
  if (withdrawn) return withdrawn;
  if (subscription === null) return "subscription_missing";
  if (entitlement.subjectId !== subjectId) return "customer_unlinked";
  const offer = offers.find((o) => o.offerId === entitlement.offerId);
  if (offer === undefined) throw new Error("live entitlement refers to an offer not in the input");
  if (offer.status === "archived") return "offer_archived";
  if (!intersects(offer.items, subscription.items)) return "item_removed";
  return "offer_access_removed";
}

function lapseReason(reason: AccessDecisionReason): AccessDecisionReason {
  return LAPSE_REASONS.get(reason) ?? "expired";
}

function ended(id: string, reason: AccessDecisionReason): EntitlementEndPlan {
  return { id, state: EXPIRING_REASONS.has(reason) ? "expired" : "revoked", reason };
}

function newEntitlement(wanted: Desired, subjectId: string, now: Instant): NewEntitlementPlan {
  return {
    offerId: wanted.offer.offerId,
    offerVersion: wanted.offer.version,
    resourceId: wanted.resourceId,
    subjectId,
    accessLevel: wanted.accessLevel,
    validFrom: now,
    validUntil: wanted.decision.validUntil,
    decisionReason: wanted.decision.reason,
    policyVersion: ACCESS_POLICY_VERSION,
  };
}

function intersects(a: readonly string[], b: readonly string[]): boolean {
  return a.some((item) => b.includes(item));
}

function earliest(a: Instant | null, b: Instant | null): Instant | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** Joins key parts with NUL, which IDs never contain, so string order is tuple order. */
function entitlementKey(offerId: string, resourceId: string, subjectId: string): string {
  return [offerId, resourceId, subjectId].join("\u0000");
}

function keyed<T>(items: readonly T[], key: (item: T) => string, label: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (map.has(k)) throw new Error(`duplicate ${label}`);
    map.set(k, item);
  }
  return map;
}
