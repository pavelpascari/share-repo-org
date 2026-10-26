import type { AccessLevel } from "./entitlement.ts";
import {
  type Desired,
  desire,
  diffEntitlements,
  type EntitlementPlan,
  type LiveEntitlement,
} from "./entitlement-plan.ts";
import type { AccessWithdrawal } from "./lifecycle.ts";
import type { OfferStatus } from "./offer.ts";
import type { AccessDecision, AccessDecisionReason } from "./policy.ts";
import type { RateLimitBucket } from "./rate-limit.ts";
import type { Instant } from "./time.ts";
import { hasAsciiControlCharacter, type ParseResult } from "./workspace.ts";

// Manual access (decision 0016): a workspace owner grants an offer's repositories to a GitHub
// account by hand, with no subscription. It is an entitlement source of its own: its entitlements
// are planned, reconciled, revoked and explained like a subscription's.

const DAY_MS = 86_400_000;

/** The longest note an owner can attach to a manual access, in Unicode code points. */
export const MANUAL_ACCESS_NOTE_MAX_LENGTH = 500;

/**
 * At most this many manual accesses a workspace keeps open (not revoked) at once. Bounds the
 * GitHub invitations one workspace can have ShareRepo send for people who did not buy, and the
 * work of re-evaluating a workspace's manual access when it is deleted or restored.
 */
export const MANUAL_ACCESS_OPEN_LIMIT = 100;

/** New manual accesses per workspace: 50 a day, for all its owners. */
export const MANUAL_ACCESS_RATE_LIMIT = { windowMs: DAY_MS, limit: 50 } as const;

/** The bucket one new manual access counts against: `manual_access:<workspaceId>:d`. */
export function manualAccessRateLimitBuckets(workspaceId: string): readonly RateLimitBucket[] {
  return [{ bucket: `manual_access:${workspaceId}:d`, ...MANUAL_ACCESS_RATE_LIMIT, retired: [] }];
}

/**
 * Why a manual access was revoked. Stored in `manual_accesses.revoke_cause` and in audit details:
 * add codes, never rename them.
 */
export const ManualAccessRevokeCause = {
  /** A workspace owner revoked it. */
  Owner: "owner",
  /** The person it was granted to deleted their ShareRepo account (decision 0015). */
  AccountDeleted: "account_deleted",
} as const;
export type ManualAccessRevokeCause =
  (typeof ManualAccessRevokeCause)[keyof typeof ManualAccessRevokeCause];
export const MANUAL_ACCESS_REVOKE_CAUSES = [
  ManualAccessRevokeCause.Owner,
  ManualAccessRevokeCause.AccountDeleted,
] as const;

/** What an owner sees of a manual access. Derived, never stored. */
export const ManualAccessStatus = {
  /** Granted, with no end date or one still ahead. */
  Active: "active",
  /** Its end date has passed. Editing the end date grants it again. */
  Ended: "ended",
  /** Revoked by an owner, or by an account deletion. Final. */
  Revoked: "revoked",
} as const;
export type ManualAccessStatus = (typeof ManualAccessStatus)[keyof typeof ManualAccessStatus];

/** The facts of one manual access that decide its access. */
export interface ManualAccessTerms {
  /** When access ends, or null while open-ended. */
  readonly endsAt: Instant | null;
  /** When it was revoked, or null. */
  readonly revokedAt: Instant | null;
}

/** A manual access's status at `now`: an end date equal to `now` has already passed. */
export function manualAccessStatus(terms: ManualAccessTerms, now: Instant): ManualAccessStatus {
  if (terms.revokedAt !== null) return ManualAccessStatus.Revoked;
  if (terms.endsAt !== null && terms.endsAt <= now) return ManualAccessStatus.Ended;
  return ManualAccessStatus.Active;
}

export type ManualAccessNoteError = "note_too_long" | "note_invalid_characters";

/**
 * An owner's optional note on a manual access, trimmed; null when empty. Shown on the manual
 * access page and recorded as the audit event's reason, so it may not contain control characters.
 */
export function parseManualAccessNote(
  input: string,
): ParseResult<string | null, ManualAccessNoteError> {
  const note = input.trim();
  if (note === "") return { ok: true, value: null };
  if ([...note].length > MANUAL_ACCESS_NOTE_MAX_LENGTH)
    return { ok: false, error: "note_too_long" };
  if (hasAsciiControlCharacter(note)) return { ok: false, error: "note_invalid_characters" };
  return { ok: true, value: note };
}

/**
 * How far past the chosen date's UTC midnight a manual access ends: the end of that date anywhere
 * on Earth (AoE, UTC−12), that is 12:00 UTC on the next day (decision 0017). ShareRepo cannot know
 * the recipient's time zone, so no recipient loses access before their own day ends.
 */
const END_OF_DAY_AOE_MS = 36 * 3_600_000;

/**
 * The end instant of an owner's chosen end date (`YYYY-MM-DD`): the end of that date anywhere on
 * Earth. Empty means no end; anything not shaped `YYYY-MM-DD`, or that does not parse, is
 * `end_date_invalid`. The page's date input sends only real dates.
 */
export function parseManualAccessEndDate(
  input: string,
): ParseResult<Instant | null, "end_date_invalid"> {
  const date = input.trim();
  if (date === "") return { ok: true, value: null };
  const midnight = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(midnight)) return { ok: false, error: "end_date_invalid" };
  return { ok: true, value: midnight + END_OF_DAY_AOE_MS };
}

/** The date an owner chose for an end instant (the inverse of {@link parseManualAccessEndDate}). */
export function manualAccessEndDate(endsAt: Instant): string {
  return new Date(endsAt - END_OF_DAY_AOE_MS).toISOString().slice(0, 10);
}

/** An end date for a manual access: none, or an instant after `now`. */
export function parseManualAccessEnd(
  endsAt: Instant | null,
  now: Instant,
): ParseResult<Instant | null, "end_not_in_future"> {
  if (endsAt !== null && endsAt <= now) return { ok: false, error: "end_not_in_future" };
  return { ok: true, value: endsAt };
}

/**
 * The access policy of a manual access (decision 0016), for every repository of its offer:
 * granted with reason `manual` until its end date (open-ended without one); `manual_ended` once
 * the end date has passed; `manual_revoked` once revoked. There is no grace period and no
 * expiry confirmation: ShareRepo itself holds the facts, so the minute sweep that re-evaluates
 * the access at its end date confirms the end.
 */
export function decideManualAccess(terms: ManualAccessTerms, now: Instant): AccessDecision {
  if (terms.revokedAt !== null) return notGranted("manual_revoked");
  if (terms.endsAt === null) {
    return { granted: true, validUntil: null, reason: "manual", nextEvaluationAt: null };
  }
  if (terms.endsAt <= now) return notGranted("manual_ended");
  return {
    granted: true,
    validUntil: terms.endsAt,
    reason: "manual",
    nextEvaluationAt: terms.endsAt,
  };
}

function notGranted(reason: AccessDecisionReason): AccessDecision {
  return { granted: false, validUntil: null, reason, nextEvaluationAt: null };
}

/** The manual access being planned. */
export interface PlanManualAccess extends ManualAccessTerms {
  readonly id: string;
  readonly offerId: string;
  readonly subjectId: string;
}

/** Its offer at the current version, as manual planning needs it. */
export interface PlanManualOffer {
  readonly offerId: string;
  readonly version: number;
  readonly status: OfferStatus;
  readonly accesses: readonly { readonly resourceId: string; readonly accessLevel: AccessLevel }[];
}

export interface ManualPlanInput {
  readonly now: Instant;
  readonly access: PlanManualAccess;
  readonly offer: PlanManualOffer;
  /** The manual access's live entitlements; at most one per resource. */
  readonly live: readonly LiveEntitlement[];
  /** Set while the workspace is being deleted (decision 0015): nothing is desired. */
  readonly withdrawn?: AccessWithdrawal | null;
}

/**
 * Diffs a manual access's live entitlements against what it desires now, with the same rules as
 * a subscription's (`diffEntitlements`): one entitlement per repository of its offer, at the
 * offer's current version, for its subject, while the offer is active and the workspace is not
 * being deleted. A revoked access ends its entitlements `revoked` (`manual_revoked`); one whose end
 * date passed ends them `expired` (`manual_ended`). Entitlements of repositories the offer no
 * longer lists are revoked (`offer_access_removed`, or `offer_archived` with the whole offer).
 * `nextEvaluationAt` is the end date while access is granted until it.
 *
 * Throws when the offer or a live entitlement belongs to another offer or subject: caller defects.
 */
export function planManualEntitlements(input: ManualPlanInput): EntitlementPlan {
  const { now, access, offer } = input;
  if (offer.offerId !== access.offerId) throw new Error("offer is not the manual access's offer");
  if (input.live.some((e) => e.offerId !== access.offerId || e.subjectId !== access.subjectId)) {
    throw new Error("live entitlement is not the manual access's");
  }
  const desired = new Map<string, Desired>();
  let nextEvaluationAt: Instant | null = null;
  if (!input.withdrawn && offer.status === "active") {
    const decision = decideManualAccess(access, now);
    nextEvaluationAt = decision.nextEvaluationAt;
    desire(desired, offer, access.subjectId, decision);
  }
  const diff = diffEntitlements({
    now,
    subjectId: access.subjectId,
    live: input.live,
    desired,
    lostMapping: () => {
      if (input.withdrawn) return input.withdrawn;
      if (access.revokedAt !== null) return "manual_revoked";
      return offer.status === "archived" ? "offer_archived" : "offer_access_removed";
    },
  });
  return { ...diff, nextEvaluationAt };
}
