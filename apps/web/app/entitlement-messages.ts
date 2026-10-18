import type {
  OfferableResource,
  OfferFieldError,
  SimulationAction,
  SimulationError,
} from "@sharerepo/application";
import type {
  AccessDecisionReason,
  GrantState,
  OfferAccessError,
  OfferInputError,
  OfferStatus,
  ReconciliationAction,
  ReconciliationReason,
  SubscriptionState,
} from "@sharerepo/domain";

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
};

/** Human text for a stored decision reason; an unrecognized one still reads as a sentence. */
export function accessReasonText(reason: string): string {
  return (ACCESS_REASONS as Record<string, string>)[reason] ?? "Unrecognized reason";
}

export const GRANT_STATE_LABELS: Record<GrantState, string> = {
  unknown: "Unknown",
  absent: "No access",
  provisioning: "Being granted",
  pending_invitation: "Invitation pending",
  active: "Has access",
  revoking: "Being removed",
  error: "Error",
};

const PLANNED_ACTIONS: Record<ReconciliationAction, string> = {
  provision: "Will invite",
  verify: "Will check access",
  wait: "Waiting for the subscriber to accept",
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
};

/**
 * What reconciliation will do, as a label and a detail: "Will invite" / "No access yet", or
 * "Blocked: repository not sellable" when a change is blocked.
 */
export function plannedActionText(
  action: ReconciliationAction,
  reason: ReconciliationReason,
): { label: string; detail: string } {
  const why = PLANNED_REASONS[reason];
  return {
    label: action === "blocked" ? `Blocked: ${why}` : PLANNED_ACTIONS[action],
    detail: why.charAt(0).toUpperCase() + why.slice(1),
  };
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
