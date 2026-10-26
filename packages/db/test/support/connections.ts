import { env } from "cloudflare:workers";
import {
  type Connection,
  type ConnectionIntent,
  createConnectionFromIntent,
  createConnectionIntent,
  createDb,
  type Resource,
} from "../../src/index.ts";
import { workspaceEvent } from "./audit.ts";
import { insertMembershipRow, insertUserRow, insertWorkspaceRow, T0, uniqueId } from "./rows.ts";

export const db = createDb(env.DB);

let nextInstallation = Math.floor(Math.random() * 1e8);
export const installationId = () => String(++nextInstallation);

/** A workspace with an owner, as rows. */
export async function workspaceWithOwner() {
  const workspaceId = uniqueId("ws");
  const userId = uniqueId("usr");
  await insertUserRow(userId);
  await insertWorkspaceRow({ id: workspaceId });
  await insertMembershipRow(workspaceId, userId, "owner");
  return { workspaceId, userId };
}

export function intentRow(
  workspaceId: string,
  userId: string,
  overrides: Partial<ConnectionIntent> = {},
): Omit<ConnectionIntent, "consumedAt"> {
  return {
    id: uniqueId("int"),
    workspaceId,
    userId,
    tokenHash: uniqueId("hash"),
    writeAccessAcknowledgedAt: T0,
    createdAt: T0,
    expiresAt: T0 + 15 * 60_000,
    ...overrides,
  };
}

export function connectionRow(
  workspaceId: string,
  userId: string,
  overrides: Partial<Connection> = {},
): Connection {
  return {
    id: uniqueId("con"),
    workspaceId,
    provider: "github",
    installationId: installationId(),
    accountExternalId: "583231",
    accountLoginSnapshot: "octocat",
    accountType: "user",
    status: "active",
    permissions: JSON.stringify({ administration: "write", metadata: "read" }),
    writeAccessAcknowledgedAt: T0,
    createdByUserId: userId,
    createdAt: T0 + 1,
    updatedAt: T0 + 1,
    lastSyncedAt: null,
    syncVersion: 0,
    syncToken: null,
    rateLimitedUntil: null,
    ...overrides,
  };
}

/** A workspace with an active connection, created through an intent. */
export async function connectedWorkspace(overrides: Partial<Connection> = {}) {
  const { workspaceId, userId } = await workspaceWithOwner();
  const intent = await createConnectionIntent(db, intentRow(workspaceId, userId), [
    workspaceEvent(workspaceId),
  ]);
  const connection = connectionRow(workspaceId, userId, overrides);
  const result = await createConnectionFromIntent(
    db,
    { intentId: intent.id, now: T0 + 1, connection },
    [workspaceEvent(workspaceId)],
  );
  if (!result.ok) throw new Error(result.reason);
  return { workspaceId, userId, connection };
}

export function resourceRow(
  workspaceId: string,
  connectionId: string,
  overrides: Partial<Resource> = {},
): Resource {
  return {
    id: uniqueId("res"),
    workspaceId,
    connectionId,
    provider: "github",
    type: "repository",
    externalId: String(Math.floor(Math.random() * 1e12)),
    nameSnapshot: "octocat/hello",
    ownerExternalId: "583231",
    private: true,
    archived: false,
    selection: "selected",
    capabilities: JSON.stringify({ readOnlyGrant: false }),
    discoveredAt: T0,
    updatedAt: T0,
    nextReconcileAt: null,
    lastReconciledAt: null,
    reconcileToken: null,
    reconcileLeaseUntil: null,
    reconcileRequestedAt: null,
    reconcileFailures: 0,
    lastReconcileError: null,
    ...overrides,
  };
}

export async function count(table: string, where = "1", ...params: unknown[]) {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  return Number(row?.n);
}
