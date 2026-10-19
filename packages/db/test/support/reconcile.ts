import {
  claimReconcileLease,
  type Grant,
  type NewOutboxRow,
  type ProviderMutation,
  reconcileKey,
  schema,
} from "../../src/index.ts";
import { outboxRow, subscribedWorkspace } from "./commerce.ts";
import { db } from "./connections.ts";
import { T0, uniqueId } from "./rows.ts";

export function grantRow(
  input: { workspaceId: string; connectionId: string; subjectId: string; resourceId: string },
  overrides: Partial<Grant> = {},
): Grant {
  return {
    id: uniqueId("gra"),
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    subjectId: input.subjectId,
    resourceId: input.resourceId,
    accessLevel: "write",
    state: "active",
    managed: false,
    indirect: false,
    entitlementId: null,
    externalGrantId: null,
    expiresAt: null,
    observedAt: T0,
    lastAttemptAt: null,
    lastErrorCode: null,
    retryClass: null,
    nextAttemptAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** A `started` invitation for `grant`. */
export function mutationRow(
  grant: Grant,
  overrides: Partial<ProviderMutation> = {},
): ProviderMutation {
  return {
    id: uniqueId("mut"),
    workspaceId: grant.workspaceId,
    connectionId: grant.connectionId,
    grantId: grant.id,
    subjectId: grant.subjectId,
    resourceId: grant.resourceId,
    operation: "invite",
    accessLevel: grant.accessLevel,
    status: "started",
    errorCode: null,
    retryClass: null,
    externalId: null,
    entitlementIds: JSON.stringify([]),
    correlationId: uniqueId("corr"),
    startedAt: T0,
    finishedAt: null,
    ...overrides,
  };
}

export async function seedGrant(grant: Grant) {
  await db.insert(schema.grants).values(grant);
  return grant;
}

export async function seedMutation(mutation: ProviderMutation) {
  await db.insert(schema.providerMutations).values(mutation);
  return mutation;
}

export function reconcileRow(workspaceId: string, resourceId: string): NewOutboxRow {
  return outboxRow("reconcile_resource", reconcileKey(workspaceId, resourceId));
}

/**
 * A subscribed workspace (one repository, a subject with a live entitlement) whose repository is
 * leased to a run with `token`, plus the identity fields of a grant for that subject.
 */
export async function leasedWorkspace(now = T0) {
  const ws = await subscribedWorkspace();
  const token = uniqueId("tok");
  const lease = { workspaceId: ws.workspaceId, resourceId: ws.resource.id, token };
  const claimed = await claimReconcileLease(db, { ...lease, now, leaseMs: 120_000 });
  if (!claimed) throw new Error("lease not claimed");
  const identity = {
    workspaceId: ws.workspaceId,
    connectionId: ws.connection.id,
    subjectId: ws.subject.id,
    resourceId: ws.resource.id,
  };
  return { ...ws, token, lease, identity };
}
