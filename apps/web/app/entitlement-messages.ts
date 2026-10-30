import type {
  OfferableResource,
  OfferFieldError,
  SimulationAction,
  SimulationError,
} from "@sharerepo/application";
import type {
  AccessDecisionReason,
  CommercialSource,
  GrantErrorCode,
  GrantState,
  OfferAccessError,
  OfferInputError,
  OfferStatus,
  ReconciliationAction,
  ReconciliationReason,
  SubscriptionState,
} from "@sharerepo/domain";

/** Where an entitlement comes from: a subscription's source, or an owner's manual access. */
type AccessSource = CommercialSource | "manual";

// User-facing copy for the offers, access and simulator pages. Every map is total over its codes
// (the Record types make a missing code a type error), so a raw code is never shown alone.
// The language is repository-centric: "repository" and "subscriber", never "resource" or "subject".

export const CONFLICT_MESSAGE = "Something changed; reload and try again.";

const OFFER_INPUT_ERRORS: Record<OfferInputError, string> = {
  input_invalid: "The form could not be read. Reload and try again.",
  name_invalid: "Enter a name of at most 100 characters.",
  grace_period_invalid: "Enter a grace period of 0 to 30 whole days.",
  items_invalid: "Use at most 100 commercial item IDs.",
  item_invalid:
    "Commercial item IDs use letters, digits and _ . : - only, up to 100 characters each.",
  item_duplicate: "Enter each commercial item ID once.",
  accesses_invalid: "Choose at most 100 repositories.",
  access_invalid: "Choose repositories from the list.",
  access_level_invalid: "Choose a supported access level.",
  access_required: "Choose at least one repository.",
  access_duplicate: "Choose each repository once.",
};

const OFFER_ACCESS_ERRORS: Record<OfferAccessError, string> = {
  resource_not_found: "is no longer connected to this workspace.",
  resource_not_sellable:
    "can't be sold right now: it must be private, not archived, and selected in the GitHub App.",
  access_level_unsupported: "doesn't support this access level.",
};

/** One message per refused field, naming the repository when a repository was refused. */
export function offerErrorMessages(
  errors: readonly OfferFieldError[],
  repositoryNames: ReadonlyMap<string, string>,
): string[] {
  return errors.map((error) => {
    if (error.field === "input") return OFFER_INPUT_ERRORS[error.code];
    if (error.field === "access") {
      const name = repositoryNames.get(error.resourceId) ?? "A repository";
      return `${name} ${OFFER_ACCESS_ERRORS[error.code]}`;
    }
    if (error.field === "items") {
      return "One of these commercial item IDs is already used by another offer.";
    }
    return "This offer is archived and can't be edited.";
  });
}

export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  active: "Active",
  archived: "Archived",
};

/** Why a repository can't be added to an offer, or null when it can. */
export function repositoryUnavailableReason(repository: OfferableResource): string | null {
  if (repository.sellable) return null;
  if (repository.selection === "removed") return "Removed from the GitHub App";
  if (repository.archived) return "Archived on GitHub";
  if (!repository.private) return "Public: not sellable";
  return "GitHub connection not active";
}

/** Splits commercial item IDs entered one per line or separated by commas. */
export function parseItemIds(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

const ACCESS_REASONS: Record<AccessDecisionReason, string> = {
  active: "Subscription active",
  trialing: "Trial",
  cancel_scheduled: "Cancellation scheduled",
  past_due_in_grace: "Payment failed; within the grace period",
  canceled_until_end: "Canceled; paid until the period ends",
  paused: "Subscription paused",
  grace_expired: "Payment failed and the grace period ended",
  cancellation_effective: "Cancellation took effect",
  canceled: "Subscription canceled",
  expired: "Subscription expired",
  offer_archived: "Offer archived",
  offer_access_removed: "Repository removed from the offer",
  offer_access_changed: "Offer access level changed",
  item_removed: "Item no longer on the subscription",
  customer_unlinked: "Subscriber unlinked from the customer",
  subscription_missing: "Subscription no longer found",
  workspace_deleted: "Workspace being deleted",
  account_deleted: "Subscriber deleted their account",
  manual: "Manual access, granted by an owner",
  manual_ended: "Manual access ended on its end date",
  manual_revoked: "Manual access revoked by an owner",
};

/** Human text for a stored decision reason; an unrecognized one still reads as a sentence. */
export function accessReasonText(reason: string): string {
  return (ACCESS_REASONS as Record<string, string>)[reason] ?? "Unrecognized reason";
}

const PLANNED_ACTIONS: Record<ReconciliationAction, string> = {
  provision: "Will invite",
  verify: "Will check access",
  wait: "Waiting",
  retry: "Will retry",
  request_action: "Needs action",
  blocked: "Blocked",
  revoke: "Will remove access",
  noop: "Nothing to do",
};

const PLANNED_REASONS: Record<ReconciliationReason, string> = {
  grant_missing: "no access yet",
  access_level_change: "access level will be raised",
  invitation_expired: "the invitation expired and will be sent again",
  grant_active: "access is in place",
  intermediate_state: "a change is in progress on GitHub",
  invitation_pending: "invitation sent, not accepted yet",
  transient_error: "GitHub had a temporary error",
  rate_limited: "GitHub rate limit reached",
  user_action_required: "the subscriber or you must act on GitHub",
  terminal_error: "the last attempt failed and won't be retried",
  unmanaged_lower_access: "the subscriber has lower access that ShareRepo didn't grant",
  resource_missing: "repository no longer connected",
  connection_inactive: "GitHub connection not active",
  resource_unavailable: "repository not sellable",
  access_level_unsupported: "access level not supported by the repository",
  not_entitled: "no longer entitled",
  revocation_in_progress: "removal in progress",
  unmanaged_access: "access not granted by ShareRepo, left as is",
  no_access: "no access",
  invitation_quota: "invitation limit for this repository reached, waiting for it to reset",
  indirect_access: "has access as the repository owner, left as is",
  expiry_pending:
    "the end date passed; access stays while the subscription's end is confirmed, for up to 6 hours",
};

/** What a wait is for, by its reason; other waits read as "Waiting". */
const WAITS: Partial<Record<ReconciliationReason, string>> = {
  invitation_pending: "Waiting for the subscriber to accept",
  invitation_quota: "Waiting: invitation limit for this repository reached",
  transient_error: "Waiting to retry",
  rate_limited: "Waiting to retry",
  expiry_pending: "Ending: confirming the subscription",
};

/**
 * An expiry-pending wait names Paddle when Paddle is the source it confirms with (0013); a manual
 * access needs no confirmation, and its end is recorded at the next minute's sweep (0016).
 */
const EXPIRY_PENDING_WITH: Partial<Record<AccessSource, string>> = {
  paddle: "Ending: confirming with Paddle",
  manual: "Ending: the end date passed",
};

/**
 * What reconciliation will do, as a label and a detail: "Will invite" / "No access yet", or
 * "Blocked: repository not sellable" when a change is blocked. A wait to retry names when, given
 * the grant's next attempt; a wait for an expiry to be confirmed names the subscription's source
 * when it is Paddle.
 */
export function plannedActionText(
  action: ReconciliationAction,
  reason: ReconciliationReason,
  retryAt: number | null = null,
  source: AccessSource | null = null,
): { label: string; detail: string } {
  const why = PLANNED_REASONS[reason];
  let label = PLANNED_ACTIONS[action];
  if (action === "blocked") label = `Blocked: ${why}`;
  if (action === "wait") {
    const named =
      reason === "expiry_pending" && source !== null ? EXPIRY_PENDING_WITH[source] : undefined;
    label = named ?? WAITS[reason] ?? label;
    if (label === "Waiting to retry" && retryAt !== null) {
      label = `${label} at ${formatInstant(retryAt)}`;
    }
  }
  return { label, detail: why.charAt(0).toUpperCase() + why.slice(1) };
}

/** The observed side of an access row, as the access page shows it. */
export interface ObservedRow {
  readonly subjectLogin: string;
  /** The row's current entitlement is live. */
  readonly entitled: boolean;
  readonly resourceLastReconciledAt: number | null;
  readonly grant: {
    readonly state: GrantState;
    readonly managed: boolean;
    readonly indirect: boolean;
    readonly observedAt: number | null;
    readonly expiresAt: number | null;
    readonly lastErrorCode: string | null;
    readonly nextAttemptAt: number | null;
  } | null;
}

/** What GitHub showed, a hint for an error, when it is retried, and when it was checked. */
export interface ObservedText {
  readonly label: string;
  readonly hint: string | null;
  readonly retry: string | null;
  readonly checked: string | null;
}

const GRANT_ERRORS: Record<GrantErrorCode, { message: string; hint: string }> = {
  provider_unavailable: {
    message: "GitHub was unavailable",
    hint: "ShareRepo tries again automatically.",
  },
  rate_limited: {
    message: "GitHub's rate limit was reached",
    hint: "ShareRepo waits until GitHub allows more changes, then tries again.",
  },
  invitation_rejected: {
    message: "GitHub refused the invitation",
    hint: "The account may be blocked or flagged by GitHub. Check it with the subscriber, then press Retry.",
  },
  app_permission_missing: {
    message: "The GitHub App can't manage collaborators on this repository",
    hint: "Grant the App the “Administration: write” permission on GitHub, then press Retry.",
  },
  account_not_found: {
    message: "The subscriber's GitHub account no longer exists",
    hint: "Ask the subscriber which GitHub account to use. Retry won't help until it exists.",
  },
  provider_rejected: {
    message: "GitHub refused the change",
    hint: "Check the repository and the subscriber's account on GitHub, then press Retry.",
  },
};

const UNKNOWN_GRANT_ERROR = {
  message: "The last change on GitHub failed",
  hint: "Press Retry, or wait for the next check.",
};

/** A stored grant error code as a message and a hint; an unrecognized one still reads well. */
export function grantErrorText(code: string | null): { message: string; hint: string } {
  return (
    (GRANT_ERRORS as Record<string, { message: string; hint: string }>)[code ?? ""] ??
    UNKNOWN_GRANT_ERROR
  );
}

/** "just now", "5 min ago", or a UTC instant once it is an hour old or more. */
export function checkedText(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${minutes} min ago`;
  return `Checked ${formatInstant(at)}`;
}

/** A UTC day as `2026-10-26`. */
export function formatDate(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10);
}

/**
 * The observed access of one subscriber on one repository (phase-4 plan § Access view):
 * invitation, active, removed, unmanaged or the owner's own access, or the error with what to do
 * and when it is retried. `now` comes from the loader, so the server and browser agree.
 */
export function observedAccessText(row: ObservedRow, now: number): ObservedText {
  const { grant } = row;
  const latest = Math.max(grant?.observedAt ?? -1, row.resourceLastReconciledAt ?? -1);
  const checked = latest < 0 ? null : checkedText(latest, now);
  const text = (label: string, hint: string | null = null, retry: string | null = null) => ({
    label,
    hint,
    retry,
    checked,
  });
  if (grant === null || grant.state === "unknown") return text("Not checked yet");
  const listed = grant.state === "active" || grant.state === "pending_invitation";
  if (listed && grant.indirect) return text("Has access as the repository owner");
  if (listed && !grant.managed) return text("Has access ShareRepo does not manage");
  switch (grant.state) {
    case "pending_invitation":
      if (grant.expiresAt !== null && grant.expiresAt <= now) return text("Invitation expired");
      return text(
        `Invitation sent, waiting for @${row.subjectLogin} to accept${
          grant.expiresAt === null ? "" : ` (expires ${formatDate(grant.expiresAt)})`
        }`,
      );
    case "active":
      return text("Active");
    case "provisioning":
      return text("Inviting…");
    case "revoking":
      return text("Removing…");
    case "absent":
      return text(row.entitled ? "No access" : "Removed");
    case "error": {
      const { message, hint } = grantErrorText(grant.lastErrorCode);
      return text(
        `Error: ${message}`,
        hint,
        grant.nextAttemptAt === null ? null : `Retrying at ${formatInstant(grant.nextAttemptAt)}`,
      );
    }
  }
}

export const SUBSCRIPTION_STATE_LABELS: Record<SubscriptionState, string> = {
  trialing: "Trialing",
  active: "Active",
  past_due: "Past due",
  paused: "Paused",
  canceled: "Canceled",
  expired: "Expired",
};

export const SIMULATION_ACTION_LABELS: Record<SimulationAction, string> = {
  start_trial: "Start trial",
  activate: "Activate",
  renew: "Renew",
  mark_past_due: "Mark past due",
  recover: "Mark payment recovered",
  pause: "Pause",
  resume: "Resume",
  cancel_at_period_end: "Cancel at period end",
  cancel_now: "Cancel now",
  expire: "Expire",
  reactivate: "Reactivate",
};

export const SIMULATION_ERRORS: Record<SimulationError, string> = {
  input_invalid:
    "Check the subscriber: a valid GitHub login, at least one commercial item ID, and a period of 1 to 366 days.",
  connection_missing: "Connect GitHub first: ShareRepo looks up subscribers' GitHub accounts.",
  login_not_found: "GitHub has no account with that login.",
  account_not_user: "That login is an organization or bot. Subscribers must be personal accounts.",
  action_invalid: "That action doesn't exist. Reload and try again.",
  invalid_transition: "That action doesn't apply to the subscription's current state.",
};

/** A UTC instant as `2026-10-19 14:05 UTC`: the same on the server and in the browser. */
export function formatInstant(instant: number): string {
  return `${new Date(instant).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
