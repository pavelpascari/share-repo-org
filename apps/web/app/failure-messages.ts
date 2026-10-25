import type { AffectedAccess, DismissFailureResult } from "@sharerepo/application";
import type { OutboxKind, PurgeBlock } from "@sharerepo/domain";

// User-facing copy for failed jobs on the Access page and `/ops` (decision 0014). Repository-
// centric: "repository" and "subscriber", never "resource" or "subject".

/** What each kind of job does, as a person would say it. Total over the kinds. */
export const JOB_KIND_LABELS: Record<OutboxKind, string> = {
  process_external_event: "Processing a webhook",
  resync_connection: "Syncing repositories from GitHub",
  refresh_subscription: "Updating a subscriber's access",
  recompute_offer: "Applying an offer change",
  reconcile_resource: "Updating repository access on GitHub",
  send_claim_email: "Sending a purchase claim email",
  check_paddle_connection: "Checking the Paddle connection",
  sweep_paddle_subscriptions: "Checking subscriptions with Paddle",
  prune_data: "Removing old operational data",
  purge_workspace: "Deleting a workspace",
  rewrap_credentials: "Re-encrypting stored credentials",
};

/** Error codes worth explaining; any other code is shown as it is, after a generic sentence. */
const ERROR_TEXTS: Readonly<Record<string, string>> = {
  dead_lettered: "It kept failing and its retries ran out.",
  key_invalid: "The job could not be read.",
  source_unavailable: "Its billing source is not available here.",
  not_implemented: "This job is not available yet.",
  internal_error: "Something went wrong while it ran.",
  transient: "GitHub or Paddle was unavailable each time it ran.",
  rate_limited: "GitHub or Paddle rate limits stopped it each time it ran.",
  rejected: "GitHub or Paddle refused the request.",
  unauthorized: "Paddle refused the API key.",
  suspended: "The GitHub App installation is suspended.",
  not_found: "Something it needs no longer exists on GitHub or Paddle.",
  malformed: "Paddle sent a response ShareRepo could not read.",
  malformed_response: "GitHub sent a response ShareRepo could not read.",
};

/** Why a repository's checks keep failing (an `ObservationErrorCode`). */
const RECONCILE_ERROR_TEXTS: Readonly<Record<string, string>> = {
  provider_unavailable: "GitHub was unavailable.",
  rate_limited: "GitHub rate limits stopped the check.",
  provider_rejected: "GitHub refused the check.",
  malformed_response: "GitHub sent a response ShareRepo could not read.",
  suspended: "The GitHub App installation is suspended.",
  repository_not_found: "The repository was not found on GitHub.",
  installation_missing: "The GitHub App is no longer installed.",
};

export function reconcileErrorText(code: string | null): string {
  if (code === null) return "The last checks failed.";
  return RECONCILE_ERROR_TEXTS[code] ?? `The last checks failed (${code}).`;
}

/** Why a job failed, from its classified code (never a provider message). */
export function jobErrorText(code: string | null): string {
  if (code === null) return "It failed.";
  return ERROR_TEXTS[code] ?? `It failed (${code}).`;
}

/** What a failure affects, as short phrases: repositories, subscribers, offers, a connection. */
export function affectedText(affected: AffectedAccess): string[] {
  const parts: string[] = [];
  if (affected.repositories.length > 0) {
    parts.push(
      `${affected.repositories.length === 1 ? "Repository" : "Repositories"} ${affected.repositories.join(", ")}`,
    );
  }
  if (affected.subscribers.length > 0) {
    parts.push(
      `${affected.subscribers.length === 1 ? "Subscriber" : "Subscribers"} ${affected.subscribers.join(", ")}`,
    );
  }
  if (affected.offers.length > 0) {
    parts.push(
      `${affected.offers.length === 1 ? "Offer" : "Offers"} ${affected.offers.join(", ")}`,
    );
  }
  if (affected.connection !== null) {
    const provider = affected.connection.provider === "github" ? "GitHub" : "Paddle";
    parts.push(`${provider} connection ${affected.connection.name}`);
  }
  if (affected.event !== null) {
    const provider = affected.event.provider === "github" ? "GitHub" : "Paddle";
    parts.push(`${provider} event ${affected.event.type}`);
  }
  return parts;
}

export const DISMISS_ERRORS: Record<Extract<DismissFailureResult, { ok: false }>["error"], string> =
  {
    reason_required: "Enter why this failure is being dismissed.",
    reason_too_long: "Keep the reason to 500 characters or fewer.",
  };

/** A connection's unhealthy status, as shown on `/ops`. */
export const CONNECTION_STATUS_TEXTS: Readonly<Record<string, string>> = {
  suspended: "Suspended on GitHub",
  deleted: "Uninstalled from GitHub",
  unauthorized: "Paddle refused the API key",
};

/** Why a due purge waits (decision 0015), as the owner reads it. */
export const PURGE_BLOCK_MESSAGES: Record<PurgeBlock, string> = {
  entitlements_remaining:
    "Some subscribers' access is still being ended. ShareRepo retries every day.",
  managed_access_remaining:
    "ShareRepo is still removing collaborators it invited. Keep the GitHub App installed until the workspace is deleted, so it can remove them.",
};

/** A recorded purge block's reason as text; an unknown reason (from a newer version) as is. */
export function purgeBlockText(reason: string): string {
  return (PURGE_BLOCK_MESSAGES as Readonly<Record<string, string>>)[reason] ?? reason;
}
