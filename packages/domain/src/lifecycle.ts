import type { AccessDecisionReason } from "./policy.ts";
import type { Instant } from "./time.ts";
import type { WorkspaceRole, WorkspaceStatus } from "./workspace.ts";

// The data lifecycle (decision 0015): retention, export, workspace deletion and account deletion,
// as data and pure decisions. Storage applies them in bounded batches.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How long each kind of operational data is kept (decision 0015 § Retention). */
export const RETENTION_MS = {
  /** `external_events` that were handled (processed, ignored or failed), after receipt. */
  externalEvents: 30 * DAY_MS,
  /** Sent `outbox` rows, after sending. */
  sentOutbox: 7 * DAY_MS,
  /** Failed `outbox` rows an operator dismissed, after dismissal. */
  dismissedOutbox: 90 * DAY_MS,
  /** Claim tokens, claim requests and checkout claims, after expiry or use. */
  claims: 30 * DAY_MS,
  /** Settled `provider_mutations`, after they finished. The invitation budget reads 24 hours. */
  settledMutations: 90 * DAY_MS,
  /** Better Auth sessions and verifications, after they expired. */
  expiredAuth: 7 * DAY_MS,
  /**
   * Rate-limit counters, after their window started: the longest window is a day, so every
   * counter older than that has ended.
   */
  rateLimitCounters: DAY_MS,
  /**
   * A `users` row left behind by an account deletion because another workspace's history still
   * named it (decision 0015 § Account deletion), once nothing references it. The age keeps a
   * sign-up in progress, whose login profile is written just after the user, out of reach.
   */
  orphanedUsers: DAY_MS,
} as const;

/** Rows deleted per table in one pruning run, and per batch of a workspace purge. */
export const LIFECYCLE_BATCH_SIZE = 500;

/** The instants before which each kind of data is pruned, for a run at `now`. */
export interface PruneCutoffs {
  readonly externalEventsReceivedBefore: Instant;
  readonly outboxSentBefore: Instant;
  readonly outboxDismissedBefore: Instant;
  readonly claimsEndedBefore: Instant;
  readonly mutationsFinishedBefore: Instant;
  readonly authExpiredBefore: Instant;
  readonly rateLimitWindowStartedBefore: Instant;
  readonly orphanedUsersCreatedBefore: Instant;
}

export function pruneCutoffs(now: Instant): PruneCutoffs {
  return {
    externalEventsReceivedBefore: now - RETENTION_MS.externalEvents,
    outboxSentBefore: now - RETENTION_MS.sentOutbox,
    outboxDismissedBefore: now - RETENTION_MS.dismissedOutbox,
    claimsEndedBefore: now - RETENTION_MS.claims,
    mutationsFinishedBefore: now - RETENTION_MS.settledMutations,
    authExpiredBefore: now - RETENTION_MS.expiredAuth,
    rateLimitWindowStartedBefore: now - RETENTION_MS.rateLimitCounters,
    orphanedUsersCreatedBefore: now - RETENTION_MS.orphanedUsers,
  };
}

// Workspace deletion ---------------------------------------------------------------------------

/** How long a workspace stays `deleting`, and can be restored, before its purge may start. */
export const WORKSPACE_DELETION_DELAY_MS = 30 * DAY_MS;

/** The owner confirms a deletion by typing the workspace's slug exactly. */
export function workspaceDeletionConfirmed(slug: string, typed: string): boolean {
  return typed.trim() === slug;
}

/** A workspace whose deletion was requested: `deleting`, or already `purging`. */
export function isBeingDeleted(status: WorkspaceStatus): boolean {
  return status === "deleting" || status === "purging";
}

/** A purge may run once the workspace is being deleted and its `delete_after` has passed. */
export function purgeDue(
  workspace: { readonly status: WorkspaceStatus; readonly deleteAfter: Instant | null },
  now: Instant,
): boolean {
  return (
    isBeingDeleted(workspace.status) &&
    workspace.deleteAfter !== null &&
    workspace.deleteAfter <= now
  );
}

/**
 * Why a due purge waits (decision 0015): access ShareRepo granted must be revoked first, so that
 * deleting the workspace's data never leaves a collaborator it can no longer manage.
 *
 * - `entitlements_remaining`: some entitlements are still live; their refreshes end them.
 * - `managed_access_remaining`: reconciliation has not yet removed every managed grant, or it
 *   cannot (the GitHub App was uninstalled too early).
 */
export const PurgeBlock = {
  EntitlementsRemaining: "entitlements_remaining",
  ManagedAccessRemaining: "managed_access_remaining",
} as const;
export type PurgeBlock = (typeof PurgeBlock)[keyof typeof PurgeBlock];

/** What blocks a purge from starting, or null when it may start. */
export function purgeBlock(remaining: {
  readonly liveEntitlements: number;
  readonly managedGrants: number;
}): PurgeBlock | null {
  if (remaining.liveEntitlements > 0) return PurgeBlock.EntitlementsRemaining;
  if (remaining.managedGrants > 0) return PurgeBlock.ManagedAccessRemaining;
  return null;
}

/**
 * Why access is withdrawn from everything a subscription would grant, regardless of its
 * commercial state (decision 0015): its workspace is being deleted, or the subscriber deleted
 * their account.
 */
export type AccessWithdrawal = Extract<
  AccessDecisionReason,
  "workspace_deleted" | "account_deleted"
>;

/** The withdrawal a workspace's status imposes on all of its access, or null. */
export function workspaceWithdrawal(status: WorkspaceStatus): AccessWithdrawal | null {
  return isBeingDeleted(status) ? "workspace_deleted" : null;
}

// Account deletion -----------------------------------------------------------------------------

/** A user confirms deleting their account by typing their GitHub login (logins ignore case). */
export function accountDeletionConfirmed(login: string, typed: string): boolean {
  return typed.trim().toLowerCase() === login.toLowerCase();
}

/**
 * The workspaces that refuse an account deletion: those the user owns that are not being
 * deleted. ShareRepo has no ownership transfer, so the owner must delete them first.
 */
export function workspacesBlockingAccountDeletion<
  W extends { readonly role: WorkspaceRole; readonly status: WorkspaceStatus },
>(memberships: readonly W[]): W[] {
  return memberships.filter((m) => m.role === "owner" && !isBeingDeleted(m.status));
}

// Export ---------------------------------------------------------------------------------------

/** The version of the workspace export's JSON shape, recorded in `workspace.exported`. */
export const WORKSPACE_EXPORT_FORMAT_VERSION = 1;
