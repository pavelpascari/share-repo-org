import * as repo from "@sharerepo/db";
import {
  type AccessLevel,
  type CommercialSource,
  type EntitlementState,
  type GrantState,
  INVITATION_WINDOW_MS,
  type Instant,
  type InvitationBudget,
  invitationBudget,
  type ObservationErrorCode,
  planReconciliation,
  type ReconciliationAction,
  type ReconciliationReason,
  type RetryClass,
  roleAllows,
} from "@sharerepo/domain";
import type { ServiceContext, UserActor } from "./context.ts";
import { capabilitiesOf } from "./offers.ts";
import { openWorkspace } from "./workspaces.ts";

// The access view (phase-3 plan § Creator views): per subscriber and repository, the desired
// access (entitlements), the observed access (grants) and what reconciliation would do and why.

/** How long an ended entitlement stays in the view. */
export const ENDED_ACCESS_VISIBLE_MS = 30 * 86_400_000;

/** One entitlement behind a row: what was decided, from which source, offer and policy. */
export interface AccessEntitlement {
  readonly id: string;
  readonly state: EntitlementState;
  readonly accessLevel: AccessLevel;
  readonly subscriptionId: string;
  /** Where the subscription comes from: Paddle, or the simulator outside production. */
  readonly source: CommercialSource;
  readonly offerId: string;
  readonly offerName: string;
  readonly offerVersion: number;
  readonly policyVersion: number;
  readonly validFrom: Instant;
  readonly validUntil: Instant | null;
  readonly reason: string;
  readonly endedAt: Instant | null;
}

export interface AccessRow {
  readonly subjectId: string;
  readonly subjectLogin: string;
  readonly resourceId: string;
  readonly resourceName: string;
  /** When the repository was last reconciled, or null when it never was. */
  readonly resourceLastReconciledAt: Instant | null;
  /** When the repository's next reconciliation is due, or null when none is scheduled. */
  readonly resourceNextReconcileAt: Instant | null;
  /**
   * Why the repository's last observation failed (an `ObservationErrorCode`), or null when it
   * succeeded or was never tried. Cleared by the next successful observation.
   */
  readonly resourceLastReconcileError: ObservationErrorCode | null;
  /** Live entitlements first, then those that ended in the last 30 days, newest first. */
  readonly entitlements: readonly AccessEntitlement[];
  /** Observed access, or null when it has not been checked yet. */
  readonly grant: {
    readonly id: string;
    readonly state: GrantState;
    readonly accessLevel: AccessLevel;
    readonly managed: boolean;
    /** Access that does not come from a direct grant (the repository owner's own). */
    readonly indirect: boolean;
    readonly observedAt: Instant | null;
    /** When a pending invitation lapses. */
    readonly expiresAt: Instant | null;
    /** Why the last provider change failed, while the grant is in error. */
    readonly lastErrorCode: string | null;
    readonly retryClass: RetryClass | null;
    /** When a failed change is retried; null when it waits for a person ("Retry"). */
    readonly nextAttemptAt: Instant | null;
  } | null;
  /** What reconciliation would do now, or null when nothing is desired or observed. */
  readonly planned: {
    readonly action: ReconciliationAction;
    readonly reason: ReconciliationReason;
  } | null;
}

/** The access view: its rows, and whether the viewer may use "Check now" and "Retry". */
export interface AccessView {
  readonly rows: readonly AccessRow[];
  /** The viewer has `workspace.manage`. */
  readonly canManage: boolean;
}

const pairKey = (subjectId: string, resourceId: string) => [subjectId, resourceId].join("\u0000");

/**
 * The workspace's access, one row per subscriber and repository, for any member. Planned actions
 * are computed at the current instant, so an entitlement whose validity has passed is shown as
 * expiry pending (waiting for its source to confirm) even before its subscription is
 * re-evaluated, and as no longer desired once the confirmation window has passed (decision
 * 0013); provisioning that waits for a repository's invitation budget is shown as waiting.
 */
export async function listAccess(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
): Promise<AccessView> {
  const { scope, workspace } = await openWorkspace(context, actor, slug, "workspace.read");
  const { workspaceId } = scope;
  const { db } = context;
  const now = context.clock.now();
  const endedSince = now - ENDED_ACCESS_VISIBLE_MS;
  const [{ pairs, entitlements, grants }, resources, connections, offers] = await Promise.all([
    repo.readAccessState(db, workspaceId, { endedSince }),
    repo.listResourcesForWorkspace(db, workspaceId),
    repo.listConnectionsForWorkspace(db, workspaceId),
    repo.listOffers(db, workspaceId),
  ]);
  const live = entitlements.filter((e) => e.state === "active");
  const decisions = planReconciliation({
    invitationBudgets: await invitationBudgets(db, workspaceId, live, now),
    now,
    entitlements: live,
    grants,
    resources: resources.map((resource) => ({
      ...resource,
      capabilities: capabilitiesOf(resource),
    })),
    connections,
  });

  const offerNames = new Map(offers.map((o) => [o.id, o.name]));
  const decisionFor = new Map(decisions.map((d) => [pairKey(d.subjectId, d.resourceId), d]));
  const grantsById = new Map(grants.map((g) => [g.id, g]));
  const resourcesById = new Map(resources.map((r) => [r.id, r]));

  // The database lists the pairs in display order, with their names.
  type MutableRow = AccessRow & { entitlements: AccessEntitlement[] };
  const rows = new Map<string, MutableRow>();
  for (const pair of pairs) {
    const key = pairKey(pair.subjectId, pair.resourceId);
    const decision = decisionFor.get(key);
    // A pair with a grant always has a decision about it.
    const grant = decision?.grantId == null ? undefined : grantsById.get(decision.grantId);
    // A pair's resource is the workspace's (both pair queries join on it).
    const resource = resourcesById.get(pair.resourceId) as repo.Resource;
    rows.set(key, {
      ...pair,
      resourceLastReconciledAt: resource.lastReconciledAt,
      resourceNextReconcileAt: resource.nextReconcileAt,
      resourceLastReconcileError: resource.lastReconcileError,
      entitlements: [],
      grant:
        grant === undefined
          ? null
          : {
              id: grant.id,
              state: grant.state,
              accessLevel: grant.accessLevel,
              managed: grant.managed,
              indirect: grant.indirect,
              observedAt: grant.observedAt,
              expiresAt: grant.expiresAt,
              lastErrorCode: grant.lastErrorCode,
              retryClass: grant.retryClass,
              nextAttemptAt: grant.nextAttemptAt,
            },
      planned: decision === undefined ? null : { action: decision.action, reason: decision.reason },
    });
  }
  // Already live first, newest first. One snapshot, so every entitlement has its pair's row.
  for (const entitlement of entitlements) {
    const row = rows.get(pairKey(entitlement.subjectId, entitlement.resourceId)) as MutableRow;
    row.entitlements.push({
      id: entitlement.id,
      state: entitlement.state,
      accessLevel: entitlement.accessLevel,
      subscriptionId: entitlement.sourceId,
      source: entitlement.source,
      offerId: entitlement.offerId,
      offerName: offerNames.get(entitlement.offerId) as string,
      offerVersion: entitlement.offerVersion,
      policyVersion: entitlement.policyVersion,
      validFrom: entitlement.validFrom,
      validUntil: entitlement.validUntil,
      reason: entitlement.decisionReason,
      endedAt: entitlement.endedAt,
    });
  }
  // As `openWorkspace` decides for "workspace.manage".
  const canManage = workspace.status === "active" && roleAllows(workspace.role, "workspace.manage");
  return { rows: [...rows.values()], canManage };
}

/** The invitation budget of each of the workspace's repositories with live entitlements. */
async function invitationBudgets(
  db: repo.Db,
  workspaceId: string,
  live: readonly repo.Entitlement[],
  now: Instant,
): Promise<Map<string, InvitationBudget>> {
  const resourceIds = [...new Set(live.map((e) => e.resourceId))];
  const starts = await Promise.all(
    resourceIds.map((resourceId) =>
      repo.listInviteStarts(db, { workspaceId, resourceId, since: now - INVITATION_WINDOW_MS }),
    ),
  );
  return new Map(resourceIds.map((id, i) => [id, invitationBudget(starts[i] as Instant[], now)]));
}
