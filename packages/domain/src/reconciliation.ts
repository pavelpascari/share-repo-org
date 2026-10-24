import type { ConnectionStatus } from "./connection.ts";
import { type AccessLevel, supportsAccessLevel } from "./entitlement.ts";
import type { GrantState, RetryClass } from "./grant.ts";
import { isSellable, type ResourceCapabilities, type ResourceSelection } from "./resource.ts";
import type { Instant } from "./time.ts";

/** What reconciliation should do for one subject and resource. */
export const RECONCILIATION_ACTIONS = [
  "provision",
  "verify",
  "wait",
  "retry",
  "request_action",
  "blocked",
  "revoke",
  "noop",
] as const;
export type ReconciliationAction = (typeof RECONCILIATION_ACTIONS)[number];

/**
 * Why reconciliation chose its action. Stable codes, shown to creators.
 *
 * Access desired:
 * - `grant_missing` (provision): no grant, or it is absent or unknown;
 * - `access_level_change` (provision): a managed grant is active at a lower level;
 * - `invitation_expired` (provision): the pending invitation lapsed and is reissued;
 * - `grant_active` (verify): the grant is active at the desired level or higher, or the access
 *   is indirect (indirect access is never changed);
 * - `intermediate_state` (verify): the grant is provisioning or revoking, so re-observe it
 *   (also when access is not desired: a provisioning grant is settled by observation before it
 *   can be revoked);
 * - `invitation_pending` (wait): an invitation is pending and has not lapsed;
 * - `transient_error` / `rate_limited` (retry): the last attempt failed and can be retried now;
 *   (wait) the same, but the grant's `nextAttemptAt` has not come yet;
 * - `user_action_required` (request_action): the subscriber or creator must act;
 * - `terminal_error` (blocked): the last attempt failed for good;
 * - `unmanaged_lower_access` (blocked): access ShareRepo did not create is active at a lower
 *   level, and ShareRepo never changes unmanaged access.
 *
 * A provider change (provision, retry) is blocked first by `resource_missing`,
 * `connection_inactive`, `resource_unavailable` (not sellable) or `access_level_unsupported`.
 *
 * Access not desired:
 * - `not_entitled` (revoke): a managed grant remains;
 * - `connection_inactive` (blocked): it would be revoked, but the connection is not active;
 * - `revocation_in_progress` (verify): a managed grant is being revoked;
 * - `unmanaged_access` (noop): access ShareRepo did not create, never revoked;
 * - `no_access` (noop): the grant is absent or unknown.
 *
 * Phase 4 (decision 0010):
 * - `invitation_quota` (wait): a provision or retry, which sends an invitation, waits for the
 *   repository's invitation budget; checked after the blocking reasons and the retry time;
 * - `indirect_access` (noop): access that does not come from a direct grant, never revoked.
 */
export const RECONCILIATION_REASONS = [
  "grant_missing",
  "access_level_change",
  "invitation_expired",
  "grant_active",
  "intermediate_state",
  "invitation_pending",
  "transient_error",
  "rate_limited",
  "user_action_required",
  "terminal_error",
  "unmanaged_lower_access",
  "resource_missing",
  "connection_inactive",
  "resource_unavailable",
  "access_level_unsupported",
  "not_entitled",
  "revocation_in_progress",
  "unmanaged_access",
  "no_access",
  "invitation_quota",
  "indirect_access",
] as const;
export type ReconciliationReason = (typeof RECONCILIATION_REASONS)[number];

export interface ReconciliationEntitlement {
  readonly id: string;
  readonly subjectId: string;
  readonly resourceId: string;
  readonly accessLevel: AccessLevel;
  readonly validUntil: Instant | null;
}

export interface ReconciliationGrant {
  readonly id: string;
  readonly subjectId: string;
  readonly resourceId: string;
  readonly connectionId: string;
  readonly accessLevel: AccessLevel;
  readonly state: GrantState;
  readonly managed: boolean;
  /** Access that does not come from a direct grant; reported, never changed (decision 0010). */
  readonly indirect: boolean;
  /** When a pending invitation lapses. */
  readonly expiresAt: Instant | null;
  readonly retryClass: RetryClass | null;
  /** When an errored grant may be retried; null when it may be retried now or needs a person. */
  readonly nextAttemptAt: Instant | null;
}

export interface ReconciliationResource {
  readonly id: string;
  readonly connectionId: string;
  readonly private: boolean;
  readonly archived: boolean;
  readonly selection: ResourceSelection;
  readonly capabilities: Pick<ResourceCapabilities, "readOnlyGrant">;
}

export interface ReconciliationInput {
  readonly now: Instant;
  /** Live (`active`) entitlements; those whose validity has passed are not desired. */
  readonly entitlements: readonly ReconciliationEntitlement[];
  readonly grants: readonly ReconciliationGrant[];
  readonly resources: readonly ReconciliationResource[];
  readonly connections: readonly { readonly id: string; readonly status: ConnectionStatus }[];
  /** Invitation budgets by resource ID; a resource without one is not limited. */
  readonly invitationBudgets?: ReadonlyMap<string, InvitationBudget>;
}

/** What is left of a repository's rolling invitation budget (decision 0010). */
export interface InvitationBudget {
  readonly remaining: number;
  /** When the next invitation fits again, while none is left; otherwise null. */
  readonly opensAt: Instant | null;
}

export interface ReconciliationDecision {
  readonly subjectId: string;
  readonly resourceId: string;
  readonly action: ReconciliationAction;
  readonly reason: ReconciliationReason;
  /** The desired access level, or null when no access is desired. */
  readonly accessLevel: AccessLevel | null;
  /** The desired entitlements behind the decision, sorted. */
  readonly entitlementIds: readonly string[];
  /** The grant the decision is about, or null when there is none. */
  readonly grantId: string | null;
}

interface Pair {
  readonly subjectId: string;
  readonly resourceId: string;
  readonly entitlements: ReconciliationEntitlement[];
  readonly grants: ReconciliationGrant[];
}

type Outcome = Pick<ReconciliationDecision, "action" | "reason">;

/**
 * Compares desired access (entitlements) with observed access (grants) and returns one decision
 * per subject and resource that has either, sorted by subject then resource. Pure: it plans,
 * and the caller acts. An entitlement whose `validUntil` has passed is not desired, so access
 * never outlives policy because an evaluation ran late. Unmanaged and indirect access is never
 * revoked or changed.
 *
 * When a pair has several grants (v1 grants only `write`, so normally one), the decision is
 * about the one with the highest access level, then the lowest ID.
 */
export function planReconciliation(input: ReconciliationInput): ReconciliationDecision[] {
  const pairs = new Map<string, Pair>();
  const pairFor = (subjectId: string, resourceId: string): Pair => {
    const key = [subjectId, resourceId].join("\u0000");
    const existing = pairs.get(key);
    if (existing !== undefined) return existing;
    const pair: Pair = { subjectId, resourceId, entitlements: [], grants: [] };
    pairs.set(key, pair);
    return pair;
  };
  for (const entitlement of input.entitlements) {
    if (entitlement.validUntil !== null && entitlement.validUntil <= input.now) continue;
    pairFor(entitlement.subjectId, entitlement.resourceId).entitlements.push(entitlement);
  }
  for (const grant of input.grants) pairFor(grant.subjectId, grant.resourceId).grants.push(grant);

  const resources = new Map(input.resources.map((resource) => [resource.id, resource]));
  const connections = new Map(input.connections.map((c) => [c.id, c.status]));
  const connectionActive = (id: string) => connections.get(id) === "active";

  return [...pairs.keys()].sort().map((key) => {
    const pair = pairs.get(key) as Pair;
    const grant = preferredGrant(pair.grants);
    const accessLevel = desiredLevel(pair.entitlements);
    // Expired entitlements make no pair, so a pair with no desired access exists for a grant.
    const outcome =
      accessLevel === null
        ? undesired(grant as ReconciliationGrant, connectionActive)
        : desired(accessLevel, grant, input.now, (change, notBefore = input.now) => {
            const resource = resources.get(pair.resourceId);
            if (resource === undefined) return blocked("resource_missing");
            if (!connectionActive(resource.connectionId)) return blocked("connection_inactive");
            if (!isSellable(resource, "active")) return blocked("resource_unavailable");
            if (!supportsAccessLevel(resource.capabilities, accessLevel)) {
              return blocked("access_level_unsupported");
            }
            if (notBefore > input.now) return { action: "wait", reason: change.reason };
            const budget = input.invitationBudgets?.get(pair.resourceId);
            if (budget !== undefined && budget.remaining <= 0) {
              return { action: "wait", reason: "invitation_quota" };
            }
            return change;
          });
    return {
      subjectId: pair.subjectId,
      resourceId: pair.resourceId,
      ...outcome,
      accessLevel,
      entitlementIds: pair.entitlements.map((e) => e.id).sort(),
      grantId: grant?.id ?? null,
    };
  });
}

/**
 * The decision when access is desired. `ifChangeable` vets any provider change, which waits
 * until `notBefore` when given.
 */
function desired(
  level: AccessLevel,
  grant: ReconciliationGrant | undefined,
  now: Instant,
  ifChangeable: (change: Outcome, notBefore?: Instant) => Outcome,
): Outcome {
  if (grant === undefined) return ifChangeable({ action: "provision", reason: "grant_missing" });
  switch (grant.state) {
    case "unknown":
    case "absent":
      return ifChangeable({ action: "provision", reason: "grant_missing" });
    case "active":
      if (grant.indirect || grant.accessLevel === "write" || level === "read") {
        return { action: "verify", reason: "grant_active" };
      }
      return grant.managed
        ? ifChangeable({ action: "provision", reason: "access_level_change" })
        : blocked("unmanaged_lower_access");
    case "pending_invitation":
      return grant.expiresAt === null || grant.expiresAt > now
        ? { action: "wait", reason: "invitation_pending" }
        : ifChangeable({ action: "provision", reason: "invitation_expired" });
    case "provisioning":
    case "revoking":
      return { action: "verify", reason: "intermediate_state" };
    case "error":
      switch (grant.retryClass) {
        case "retryable":
          return ifChangeable(
            { action: "retry", reason: "transient_error" },
            grant.nextAttemptAt ?? now,
          );
        case "rate_limited":
          return ifChangeable(
            { action: "retry", reason: "rate_limited" },
            grant.nextAttemptAt ?? now,
          );
        case "user_action_required":
          return { action: "request_action", reason: "user_action_required" };
        default:
          // `terminal`, or an unclassified error, which the grants CHECK forbids.
          return blocked("terminal_error");
      }
  }
}

/** The decision when no access is desired. Only managed access is ever revoked. */
function undesired(grant: ReconciliationGrant, connectionActive: (id: string) => boolean): Outcome {
  if (grant.state === "absent" || grant.state === "unknown") {
    return { action: "noop", reason: "no_access" };
  }
  if (grant.indirect) return { action: "noop", reason: "indirect_access" };
  if (!grant.managed) return { action: "noop", reason: "unmanaged_access" };
  if (grant.state === "revoking") return { action: "verify", reason: "revocation_in_progress" };
  // ShareRepo's invitation may not be listed yet: revoking now would remove no collaborator and
  // leave that invitation looking like the creator's. Observation settles it first (0010).
  if (grant.state === "provisioning") return { action: "verify", reason: "intermediate_state" };
  return connectionActive(grant.connectionId)
    ? { action: "revoke", reason: "not_entitled" }
    : blocked("connection_inactive");
}

function blocked(reason: ReconciliationReason): Outcome {
  return { action: "blocked", reason };
}

/** The highest level any desired entitlement gives, or null when none is desired. */
function desiredLevel(entitlements: readonly ReconciliationEntitlement[]): AccessLevel | null {
  if (entitlements.length === 0) return null;
  return entitlements.some((e) => e.accessLevel === "write") ? "write" : "read";
}

/**
 * The grant with the highest access level, then the lowest ID; independent of input order.
 * Shared with observation, so both pick the same grant for a subject and resource.
 */
export function preferredGrant<
  G extends { readonly id: string; readonly accessLevel: AccessLevel },
>(grants: readonly G[]): G | undefined {
  const write = grants.filter((grant) => grant.accessLevel === "write");
  const candidates = write.length > 0 ? write : grants;
  const id = candidates.map((grant) => grant.id).sort()[0];
  return candidates.find((grant) => grant.id === id);
}
