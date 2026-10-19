import * as repo from "@sharerepo/db";
import {
  type AccessLevel,
  type EntitlementState,
  type GrantState,
  type Instant,
  planReconciliation,
  type ReconciliationAction,
  type ReconciliationReason,
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
  /** Live entitlements first, then those that ended in the last 30 days, newest first. */
  readonly entitlements: readonly AccessEntitlement[];
  /** Observed access, or null when it has not been checked yet. */
  readonly grant: {
    readonly state: GrantState;
    readonly accessLevel: AccessLevel;
    readonly managed: boolean;
    readonly observedAt: Instant | null;
  } | null;
  /** What reconciliation would do now, or null when nothing is desired or observed. */
  readonly planned: {
    readonly action: ReconciliationAction;
    readonly reason: ReconciliationReason;
  } | null;
}

const pairKey = (subjectId: string, resourceId: string) => [subjectId, resourceId].join("\u0000");

/**
 * The workspace's access, one row per subscriber and repository, for any member. Planned actions
 * are computed at the current instant, so an entitlement whose validity has passed is shown as no
 * longer desired even before its subscription is re-evaluated.
 */
export async function listAccess(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
): Promise<AccessRow[]> {
  const { scope } = await openWorkspace(context, actor, slug, "workspace.read");
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

  // The database lists the pairs in display order, with their names.
  type MutableRow = AccessRow & { entitlements: AccessEntitlement[] };
  const rows = new Map<string, MutableRow>();
  for (const pair of pairs) {
    const key = pairKey(pair.subjectId, pair.resourceId);
    const decision = decisionFor.get(key);
    // A pair with a grant always has a decision about it.
    const grant = decision?.grantId == null ? undefined : grantsById.get(decision.grantId);
    rows.set(key, {
      ...pair,
      entitlements: [],
      grant:
        grant === undefined
          ? null
          : {
              state: grant.state,
              accessLevel: grant.accessLevel,
              managed: grant.managed,
              observedAt: grant.observedAt,
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
  return [...rows.values()];
}
