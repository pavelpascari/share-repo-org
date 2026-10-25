import { type Instant, OutboxKind, type PruneCutoffs } from "@sharerepo/domain";
import { getTableName, type SQL, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { type AuditEvents, auditInserts, conditionalAuditInserts } from "./audit-repository.ts";
import { runBatch, type Statement } from "./batch.ts";
import type { Db } from "./client.ts";
import { type NewOutboxRow, outboxInsert } from "./outbox-repository.ts";
import * as schema from "./schema/index.ts";
import {
  customers,
  entitlements,
  outbox,
  subjects,
  systemState,
  workspaces,
} from "./schema/index.ts";

// The data lifecycle (decision 0015): retention pruning, workspace deletion and its purge, and
// account deletion. Every delete is bounded and names its scope explicitly.

/** A JSON array bound as one parameter and expanded by `json_each`, for lists of any length. */
const jsonList = (values: readonly string[]) =>
  sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;

const ident = (name: string) => sql.raw(`"${name}"`);

/**
 * Every table by its SQL name. Batch statements are Drizzle builders (raw `db.run` statements
 * with parameters cannot be batched), so a statement over a table named in data looks it up here.
 */
const TABLES: Readonly<Record<string, SQLiteTable>> = Object.fromEntries(
  Object.values(schema).map((table) => [getTableName(table), table]),
);

/** `DELETE FROM <table> WHERE <condition>`, as a batchable statement. */
function deleteFrom(db: Db, table: string, condition: SQL): Statement {
  // Callers name tables from this module's own constants.
  return db.delete(TABLES[table] as SQLiteTable).where(condition);
}

// Retention ------------------------------------------------------------------------------------

/** One prunable table: the key it is deleted by and the query selecting what may go. */
interface Prunable {
  readonly key: string;
  readonly select: (cutoffs: PruneCutoffs) => SQL;
}

/**
 * What each pruning run may delete (decision 0015 § Retention), by table name. A row that
 * something still references is never selected: an external event a pending or failed job still
 * reads, a checkout claim whose customer is still linked, a `started` provider mutation.
 */
export const PRUNABLE: Readonly<Record<string, Prunable>> = {
  external_events: {
    key: "id",
    select: (c) => sql`SELECT id AS key FROM external_events
      WHERE received_at < ${c.externalEventsReceivedBefore} AND processing_state <> 'pending'
        AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.kind = ${OutboxKind.ProcessExternalEvent}
          AND outbox.subject_id = external_events.id AND outbox.sent_at IS NULL)`,
  },
  outbox: {
    key: "id",
    select: (c) => sql`SELECT id AS key FROM outbox
      WHERE sent_at < ${c.outboxSentBefore} OR dismissed_at < ${c.outboxDismissedBefore}`,
  },
  claim_tokens: {
    key: "id",
    select: (c) => sql`SELECT id AS key FROM claim_tokens
      WHERE consumed_at < ${c.claimsEndedBefore}
        OR (consumed_at IS NULL AND expires_at < ${c.claimsEndedBefore})`,
  },
  claim_requests: {
    key: "id",
    select: (c) => sql`SELECT id AS key FROM claim_requests
      WHERE processed_at < ${c.claimsEndedBefore}`,
  },
  // A used checkout claim stays while the customer it linked is still linked (decision 0015).
  checkout_claims: {
    key: "id",
    select: (c) => sql`SELECT id AS key FROM checkout_claims
      WHERE (consumed_at IS NULL AND expires_at < ${c.claimsEndedBefore})
        OR (consumed_at < ${c.claimsEndedBefore} AND NOT EXISTS (SELECT 1 FROM customers
          WHERE customers.workspace_id = checkout_claims.workspace_id
            AND customers.id = checkout_claims.consumed_by_customer_id
            AND customers.subject_id IS NOT NULL))`,
  },
  claim_rate_limits: {
    key: "bucket",
    select: (c) => sql`SELECT bucket AS key FROM claim_rate_limits
      WHERE window_start < ${c.rateLimitWindowStartedBefore}`,
  },
  provider_mutations: {
    key: "id",
    select: (c) => sql`SELECT id AS key FROM provider_mutations
      WHERE status <> 'started' AND finished_at < ${c.mutationsFinishedBefore}`,
  },
  auth_sessions: {
    key: "id",
    select: (c) => sql`SELECT id AS key FROM auth_sessions
      WHERE expires_at < ${c.authExpiredBefore}`,
  },
  auth_verifications: {
    key: "id",
    select: (c) => sql`SELECT id AS key FROM auth_verifications
      WHERE expires_at < ${c.authExpiredBefore}`,
  },
  // A user row an account deletion had to keep, once nothing names it any more.
  users: {
    key: "id",
    select: (c) => sql`SELECT id AS key FROM users
      WHERE created_at < ${c.orphanedUsersCreatedBefore}
        AND NOT EXISTS (SELECT 1 FROM auth_users WHERE auth_users.id = users.id)
        AND NOT EXISTS (SELECT 1 FROM external_identities WHERE user_id = users.id)
        AND NOT EXISTS (SELECT 1 FROM workspace_memberships WHERE user_id = users.id)
        AND NOT EXISTS (SELECT 1 FROM connection_intents WHERE user_id = users.id)
        AND NOT EXISTS (SELECT 1 FROM connections WHERE created_by_user_id = users.id)
        AND NOT EXISTS (SELECT 1 FROM offer_versions WHERE created_by_user_id = users.id)
        AND NOT EXISTS (SELECT 1 FROM checkout_claims WHERE user_id = users.id)
        AND NOT EXISTS (SELECT 1 FROM claim_requests WHERE user_id = users.id)
        AND NOT EXISTS (SELECT 1 FROM claim_tokens WHERE consumed_by_user_id = users.id)`,
  },
};

/** Rows deleted per table, by table name. */
export type DeletedRows = Readonly<Record<string, number>>;

/**
 * One pruning run: selects up to `limit` prunable rows per table, then deletes them and writes
 * the run's audit event (built from the counts) in one batch, so the counts are exactly what was
 * deleted. Returns the counts.
 */
export async function pruneExpiredData(
  db: Db,
  input: {
    cutoffs: PruneCutoffs;
    limit: number;
    audit: (deleted: DeletedRows) => AuditEvents;
  },
): Promise<DeletedRows> {
  const deleted: Record<string, number> = {};
  const statements: Statement[] = [];
  for (const [table, { key, select }] of Object.entries(PRUNABLE)) {
    const rows = await db.all<{ key: string }>(sql`${select(input.cutoffs)} LIMIT ${input.limit}`);
    deleted[table] = rows.length;
    if (rows.length === 0) continue;
    statements.push(
      deleteFrom(db, table, sql`${ident(key)} IN ${jsonList(rows.map((r) => r.key))}`),
    );
  }
  await runBatch(db, [...statements, ...auditInserts(db, input.audit(deleted))]);
  return deleted;
}

// Workspace deletion ---------------------------------------------------------------------------

/**
 * A `refresh_subscription` row for every subscription of the workspace from one of `sources`
 * that has none pending, built in SQL so any number of subscriptions costs one statement. The key
 * is `encodeRefreshKey`'s `<workspaceId>:<source>:<externalSubscriptionId>`; IDs are random.
 */
export function refreshAllInsert(
  db: Db,
  input: { workspaceId: string; sources: readonly string[]; now: Instant; when: SQL },
): Statement {
  const key = sql`s.workspace_id || ':' || s.source || ':' || s.external_subscription_id`;
  // Every outbox column, in the table's column order: Drizzle names them all in the INSERT.
  return db.insert(outbox).select(sql`SELECT lower(hex(randomblob(16))),
      ${OutboxKind.RefreshSubscription}, ${key}, ${input.now}, ${input.now}, 0, NULL, NULL, NULL,
      s.workspace_id, NULL, NULL, NULL
    FROM subscriptions AS s
    WHERE s.workspace_id = ${input.workspaceId} AND s.source IN ${jsonList(input.sources)}
      AND ${input.when}
      AND NOT EXISTS (SELECT 1 FROM outbox AS o WHERE o.kind = ${OutboxKind.RefreshSubscription}
        AND o.subject_id = ${key} AND o.sent_at IS NULL AND o.failed_at IS NULL)`);
}

/**
 * Audit inserts to place immediately after a guarded UPDATE of one row: the first event is written
 * only if that UPDATE changed the row (`changes()` is its count), and the rest only if the first
 * was written. `written` guards the batch's later statements the same way. Unlike re-checking
 * the row's new state, it cannot match an identical change made earlier.
 */
function afterUpdate(db: Db, audit: AuditEvents): { inserts: Statement[]; written: SQL } {
  const [first, ...rest] = audit;
  const written = sql`EXISTS (SELECT 1 FROM audit_events WHERE id = ${first.id})`;
  return {
    inserts: [
      ...conditionalAuditInserts(db, [first], sql`changes() = 1`),
      ...(rest.length === 0
        ? []
        : conditionalAuditInserts(db, rest as unknown as AuditEvents, written)),
    ],
    written,
  };
}

/** Queues a refresh of each of the workspace's subscriptions from `sources` not already queued. */
export async function queueWorkspaceRefreshes(
  db: Db,
  input: { workspaceId: string; sources: readonly string[]; now: Instant },
): Promise<number> {
  const [queued] = await runBatch(db, [refreshAllInsert(db, { ...input, when: sql`1` })]);
  return queued as number;
}

/**
 * Schedules an active workspace's deletion (decision 0015) in one batch: it becomes `deleting`
 * until `deleteAfter`, a refresh is queued for each of its subscriptions (the refresh ends their
 * entitlements, because the workspace is being deleted, and reconciliation then revokes managed
 * access), and the audit events are written. Nothing is written unless the workspace was active.
 */
export async function scheduleWorkspaceDeletion(
  db: Db,
  input: { workspaceId: string; requestedBy: string; now: Instant; deleteAfter: Instant },
  audit: AuditEvents,
): Promise<{ ok: boolean }> {
  const { workspaceId, now } = input;
  const { inserts, written } = afterUpdate(db, audit);
  const [changed] = await runBatch(db, [
    db
      .update(workspaces)
      .set({
        status: "deleting",
        deleteAfter: input.deleteAfter,
        deletionRequestedBy: input.requestedBy,
        updatedAt: now,
      })
      .where(sql`id = ${workspaceId} AND status = 'active'`),
    ...inserts,
    refreshAllInsert(db, { workspaceId, sources: ["paddle", "simulated"], now, when: written }),
  ]);
  return { ok: changed === 1 };
}

/** The `system_state` key of a workspace purge's progress: rows deleted so far, per table. */
export const purgeProgressKey = (workspaceId: string) => `purge_progress:${workspaceId}`;
/**
 * The `system_state` key under which a due purge records why it waits, for the failure pages and
 * `/ops`: `{ "reason": PurgeBlock, "since": Instant, "checkedAt": Instant }`. Removed when the
 * purge starts or the deletion is cancelled.
 */
export const purgeBlockedKey = (workspaceId: string) => `purge_blocked:${workspaceId}`;

/**
 * Cancels a workspace's deletion in one batch: it becomes `active` again, a refresh is queued for
 * each subscription from `sources` (those whose source can be read now), any recorded purge
 * block is removed, and the audit events are written. Nothing is written unless it was
 * `deleting`.
 */
export async function cancelWorkspaceDeletion(
  db: Db,
  input: { workspaceId: string; now: Instant; sources: readonly string[] },
  audit: AuditEvents,
): Promise<{ ok: boolean }> {
  const { workspaceId, now } = input;
  const { inserts, written } = afterUpdate(db, audit);
  const [changed] = await runBatch(db, [
    db
      .update(workspaces)
      .set({ status: "active", deleteAfter: null, deletionRequestedBy: null, updatedAt: now })
      .where(sql`id = ${workspaceId} AND status = 'deleting'`),
    ...inserts,
    refreshAllInsert(db, { workspaceId, sources: input.sources, now, when: written }),
    db.delete(systemState).where(sql`key = ${purgeBlockedKey(workspaceId)} AND ${written}`),
  ]);
  return { ok: changed === 1 };
}

/** A workspace's deletion schedule and purge state, as the settings page and the purge read it. */
export interface WorkspaceDeletionState {
  readonly status: string;
  readonly deleteAfter: Instant | null;
  /** Why a due purge waits, as last recorded, or null. */
  readonly blocked: { readonly reason: string; readonly since: Instant } | null;
}

export async function getWorkspaceDeletionState(
  db: Db,
  workspaceId: string,
): Promise<WorkspaceDeletionState | null> {
  const [row] = await db.all<{
    status: string;
    delete_after: Instant | null;
    blocked: string | null;
  }>(
    sql`SELECT status, delete_after,
        (SELECT value FROM system_state WHERE key = ${purgeBlockedKey(workspaceId)}) AS blocked
      FROM workspaces WHERE id = ${workspaceId}`,
  );
  if (row === undefined) return null;
  const blocked =
    row.blocked === null
      ? null
      : (JSON.parse(row.blocked) as { reason: string; since: Instant; checkedAt: Instant });
  return {
    status: row.status,
    deleteAfter: row.delete_after,
    blocked: blocked === null ? null : { reason: blocked.reason, since: blocked.since },
  };
}

/** A due purge that waits, with its workspace, for the failure pages and `/ops`. */
export interface PurgeBlocked {
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  /** A `PurgeBlock` reason, as the purge recorded it. */
  readonly reason: string;
  /** Since when the purge has waited for this reason. */
  readonly since: Instant;
  /** When the purge last checked. */
  readonly checkedAt: Instant;
}

/**
 * The recorded purge blocks of one workspace, or of every workspace (operators), oldest first.
 * A block outlives nothing: the purge removes it when it starts, and a cancel removes it too.
 */
export async function listPurgeBlocks(
  db: Db,
  input: { readonly workspaceId: string } | { readonly all: true; readonly limit: number },
): Promise<PurgeBlocked[]> {
  const where =
    "workspaceId" in input
      ? sql`s.key = ${purgeBlockedKey(input.workspaceId)} AND w.id = ${input.workspaceId}`
      : sql`s.key LIKE 'purge_blocked:%'`;
  const rows = await db.all<{ id: string; slug: string; name: string; value: string }>(
    sql`SELECT w.id, w.slug, w.name, s.value FROM system_state s
      JOIN workspaces w ON s.key = 'purge_blocked:' || w.id
      WHERE ${where}
      ORDER BY json_extract(s.value, '$.since'), w.id
      LIMIT ${"workspaceId" in input ? 1 : input.limit}`,
  );
  return rows.map((row) => {
    const value = JSON.parse(row.value) as { reason: string; since: Instant; checkedAt: Instant };
    return {
      workspaceId: row.id,
      workspaceSlug: row.slug,
      workspaceName: row.name,
      reason: value.reason,
      since: value.since,
      checkedAt: value.checkedAt,
    };
  });
}

/** What still holds a purge back: live entitlements and managed grants, in the workspace. */
export async function countRemainingAccess(
  db: Db,
  workspaceId: string,
): Promise<{ liveEntitlements: number; managedGrants: number }> {
  const [row] = await db.all<{ live: number; managed: number }>(sql`SELECT
    (SELECT count(*) FROM entitlements WHERE workspace_id = ${workspaceId} AND state = 'active') AS live,
    (SELECT count(*) FROM grants WHERE workspace_id = ${workspaceId} AND managed = 1) AS managed`);
  return { liveEntitlements: Number(row?.live), managedGrants: Number(row?.managed) };
}

/**
 * Records why a due purge waits. `since` is kept while the reason stays the same, so the pages
 * can say how long it has waited.
 */
export async function recordPurgeBlocked(
  db: Db,
  input: { workspaceId: string; reason: string; now: Instant },
): Promise<void> {
  const value = JSON.stringify({ reason: input.reason, since: input.now, checkedAt: input.now });
  await db.run(sql`INSERT INTO system_state (key, value, updated_at)
    VALUES (${purgeBlockedKey(input.workspaceId)}, ${value}, ${input.now})
    ON CONFLICT (key) DO UPDATE SET
      value = CASE WHEN json_extract(system_state.value, '$.reason') = ${input.reason}
        THEN json_set(system_state.value, '$.checkedAt', ${input.now}) ELSE excluded.value END,
      updated_at = excluded.updated_at`);
}

/**
 * Every workspace-owned table, in an order in which each table's rows are no longer referenced
 * once the tables before it are empty (every foreign key is ON DELETE RESTRICT). Paddle's
 * received events belong to the workspace's Paddle connections. `audit_events` comes last: the
 * workspace's history goes only once everything it describes has gone.
 */
export const PURGE_ORDER: readonly string[] = [
  "outbox",
  "provider_mutations",
  "grants",
  "entitlements",
  "claim_tokens",
  "checkout_claims",
  "claim_requests",
  "subscription_items",
  "subscriptions",
  "customers",
  "subjects",
  "offer_accesses",
  "offer_items",
  "offer_versions",
  "offers",
  "simulated_subscriptions",
  "paddle_prices",
  "external_events",
  "paddle_connections",
  "resources",
  "connection_intents",
  "connections",
  "workspace_memberships",
  "audit_events",
];

function purgeScope(table: string, workspaceId: string): SQL {
  return table === "external_events"
    ? sql`connection_id IN (SELECT id FROM paddle_connections WHERE workspace_id = ${workspaceId})`
    : sql`workspace_id = ${workspaceId}`;
}

/** Whether the workspace still has rows in a workspace-owned table. */
export async function purgeTableHasRows(
  db: Db,
  input: { workspaceId: string; table: string },
): Promise<boolean> {
  if (!PURGE_ORDER.includes(input.table)) throw new Error("not a workspace-owned table");
  const [row] = await db.all<{ found: number }>(
    sql`SELECT EXISTS (SELECT 1 FROM ${ident(input.table)}
      WHERE ${purgeScope(input.table, input.workspaceId)}) AS found`,
  );
  return row?.found === 1;
}

/**
 * One bounded purge batch: deletes up to `limit` of the workspace's rows from `table` and adds
 * the count to the purge's progress, in one D1 batch. It deletes only while the workspace is
 * `purging`. With `start`, the batch first moves a due `deleting` workspace to `purging`, but only
 * if no entitlement is live and no managed grant remains (decision 0015), and removes the
 * recorded block: the audit triggers allow deleting its history only from then on. Returns how
 * many rows it deleted, and whether the workspace is `purging`.
 */
export async function purgeBatch(
  db: Db,
  input: { workspaceId: string; table: string; limit: number; now: Instant; start: boolean },
): Promise<{ deleted: number; purging: boolean }> {
  const { workspaceId, table, now } = input;
  if (!PURGE_ORDER.includes(table)) throw new Error("not a workspace-owned table");
  const purging = sql`EXISTS (SELECT 1 FROM workspaces WHERE id = ${workspaceId} AND status = 'purging')`;
  const statements: Statement[] = [];
  if (input.start) {
    statements.push(
      db
        .update(workspaces)
        .set({ status: "purging", updatedAt: sql`max(updated_at, ${now})` })
        .where(sql`id = ${workspaceId} AND status = 'deleting' AND delete_after <= ${now}
          AND NOT EXISTS (SELECT 1 FROM entitlements WHERE workspace_id = ${workspaceId} AND state = 'active')
          AND NOT EXISTS (SELECT 1 FROM grants WHERE workspace_id = ${workspaceId} AND managed = 1)`),
      db.delete(systemState).where(sql`key = ${purgeBlockedKey(workspaceId)} AND ${purging}`),
    );
  }
  const key = purgeProgressKey(workspaceId);
  const path = `$.${table}`;
  statements.push(
    db
      .insert(systemState)
      .select(sql`SELECT ${key}, '{}', ${now} WHERE ${purging}`)
      .onConflictDoNothing(),
    deleteFrom(
      db,
      table,
      sql`rowid IN (SELECT rowid FROM ${ident(table)} WHERE ${purgeScope(table, workspaceId)}
        LIMIT ${input.limit}) AND ${purging}`,
    ),
    // Immediately after the DELETE: `changes()` is its count, in the same transaction.
    db
      .update(systemState)
      .set({
        value: sql`json_set(value, ${path}, coalesce(json_extract(value, ${path}), 0) + changes())`,
        updatedAt: now,
      })
      .where(sql`key = ${key}`),
  );
  const changes = await runBatch(db, statements);
  const deleted = changes.at(-2) as number;
  const [workspace] = await db.all<{ status: string }>(
    sql`SELECT status FROM workspaces WHERE id = ${workspaceId}`,
  );
  return { deleted, purging: workspace?.status === "purging" };
}

/** The purge's progress so far: rows deleted per table. */
export async function purgeProgress(db: Db, workspaceId: string): Promise<DeletedRows> {
  const [row] = await db.all<{ value: string }>(
    sql`SELECT value FROM system_state WHERE key = ${purgeProgressKey(workspaceId)}`,
  );
  return row === undefined ? {} : (JSON.parse(row.value) as DeletedRows);
}

/**
 * The purge's last batch, once every workspace-owned table is empty: deletes any outbox row
 * queued for the workspace meanwhile, the `purging` workspace itself, and its progress, and
 * writes the account-scoped tombstone (built from the final counts) only if the workspace row
 * was deleted. Returns whether it was. A row another job wrote meanwhile makes the batch fail on
 * its foreign key, and the purge runs again.
 */
export async function finishPurge(
  db: Db,
  input: { workspaceId: string; audit: (deleted: DeletedRows) => AuditEvents },
): Promise<boolean> {
  const { workspaceId } = input;
  const progress = await purgeProgress(db, workspaceId);
  const counts = { ...progress };
  counts.workspaces = 1;
  const changes = await runBatch(db, [
    db.delete(outbox).where(
      sql`workspace_id = ${workspaceId}
        AND EXISTS (SELECT 1 FROM workspaces WHERE id = ${workspaceId} AND status = 'purging')`,
    ),
    db.delete(workspaces).where(sql`id = ${workspaceId} AND status = 'purging'`),
    // Immediately after the workspace's delete: the tombstone only if it deleted the row.
    ...conditionalAuditInserts(db, input.audit(counts), sql`changes() = 1`),
    db.delete(systemState).where(
      sql`key = ${purgeProgressKey(workspaceId)}
          AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = ${workspaceId})`,
    ),
  ]);
  return changes[1] === 1;
}

/** Workspaces being deleted whose purge is due, for the daily queueing. */
export async function listDuePurges(db: Db, now: Instant): Promise<string[]> {
  const rows = await db.all<{ id: string }>(sql`SELECT id FROM workspaces
    WHERE status IN ('deleting', 'purging') AND delete_after <= ${now} ORDER BY id`);
  return rows.map((row) => row.id);
}

// Account deletion -----------------------------------------------------------------------------

/** A subject linked to a user's identity, in some workspace. */
export interface LinkedSubject {
  readonly workspaceId: string;
  readonly id: string;
  readonly provider: string;
  readonly externalSubjectId: string;
}

/**
 * Every subject, in any workspace, of the identity's GitHub account: those linked to the identity,
 * and those of the same GitHub account that name no user (created by a simulated subscription or
 * a manual link before any claim, or left by an earlier account deletion). Account deletion
 * clears both: a customer may be linked to either (decision 0015).
 */
export async function listSubjectsOfIdentity(
  db: Db,
  identity: { id: string; provider: string; externalUserId: string },
): Promise<LinkedSubject[]> {
  const rows = await db.all<{
    workspace_id: string;
    id: string;
    provider: string;
    external_subject_id: string;
  }>(sql`SELECT workspace_id, id, provider, external_subject_id FROM subjects
    WHERE provider = ${identity.provider} AND external_subject_id = ${identity.externalUserId}
      AND (external_identity_id = ${identity.id} OR external_identity_id IS NULL)
    ORDER BY workspace_id, id`);
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    id: r.id,
    provider: r.provider,
    externalSubjectId: r.external_subject_id,
  }));
}

/** The subjects among `subjectIds` still linked to the identity, in the workspace. */
export async function subjectsLinkedToIdentity(
  db: Db,
  input: { workspaceId: string; identityId: string; subjectIds: readonly string[] },
): Promise<string[]> {
  const rows = await db.all<{ id: string }>(
    sql`SELECT id FROM subjects WHERE workspace_id = ${input.workspaceId}
      AND id IN ${jsonList(input.subjectIds)} AND external_identity_id = ${input.identityId}
      ORDER BY id`,
  );
  return rows.map((row) => row.id);
}

/** What unlinking a workspace's subjects from a deleted account changes, read before it does. */
export interface SubjectAccess {
  readonly customers: readonly { readonly id: string; readonly subjectId: string }[];
  readonly liveEntitlements: readonly { readonly id: string; readonly resourceId: string }[];
  readonly subscriptions: readonly {
    readonly source: string;
    readonly externalSubscriptionId: string;
  }[];
}

export async function readSubjectAccess(
  db: Db,
  input: { workspaceId: string; subjectIds: readonly string[] },
): Promise<SubjectAccess> {
  const { workspaceId } = input;
  const subjects = jsonList(input.subjectIds);
  const customers = await db.all<{ id: string; subject_id: string }>(
    sql`SELECT id, subject_id FROM customers WHERE workspace_id = ${workspaceId}
      AND subject_id IN ${subjects} ORDER BY id`,
  );
  const liveEntitlements = await db.all<{ id: string; resource_id: string }>(
    sql`SELECT id, resource_id FROM entitlements WHERE workspace_id = ${workspaceId}
      AND subject_id IN ${subjects} AND state = 'active' ORDER BY id`,
  );
  const subscriptions = await db.all<{ source: string; external_subscription_id: string }>(
    sql`SELECT source, external_subscription_id FROM subscriptions
      WHERE workspace_id = ${workspaceId} AND customer_id IN ${jsonList(customers.map((c) => c.id))}
      ORDER BY id`,
  );
  return {
    customers: customers.map((c) => ({ id: c.id, subjectId: c.subject_id })),
    liveEntitlements: liveEntitlements.map((e) => ({ id: e.id, resourceId: e.resource_id })),
    subscriptions: subscriptions.map((s) => ({
      source: s.source,
      externalSubscriptionId: s.external_subscription_id,
    })),
  };
}

/**
 * Unlinks one workspace's subjects from a deleted account's identity in one batch (decision
 * 0015): their customers are unlinked, their live entitlements end `revoked` with reason
 * `account_deleted`, the subjects keep their GitHub record but name no user, and the work that
 * follows (refreshes of the customers' subscriptions, reconciles of the repositories) is queued
 * with the audit events.
 */
export async function unlinkSubjectsFromIdentity(
  db: Db,
  input: {
    workspaceId: string;
    identityId: string;
    subjectIds: readonly string[];
    entitlementIds: readonly string[];
    now: Instant;
    work: readonly NewOutboxRow[];
  },
  audit: AuditEvents,
): Promise<void> {
  const { workspaceId, now } = input;
  const subjectIds = jsonList(input.subjectIds);
  await runBatch(db, [
    ...auditInserts(db, audit),
    ...input.work.map((row) => outboxInsert(db, row)),
    db
      .update(customers)
      .set({ subjectId: null, updatedAt: sql`max(updated_at, ${now})` })
      .where(sql`workspace_id = ${workspaceId} AND subject_id IN ${subjectIds}`),
    db
      .update(entitlements)
      .set({
        state: "revoked",
        decisionReason: "account_deleted",
        endedAt: now,
        updatedAt: sql`max(updated_at, ${now})`,
      })
      .where(
        sql`workspace_id = ${workspaceId} AND id IN ${jsonList(input.entitlementIds)}
          AND state = 'active'`,
      ),
    db
      .update(subjects)
      .set({ externalIdentityId: null, updatedAt: sql`max(updated_at, ${now})` })
      .where(
        sql`workspace_id = ${workspaceId} AND id IN ${subjectIds}
          AND external_identity_id = ${input.identityId}`,
      ),
  ]);
}

/** The account-scoped rows of a user that account deletion removes, by table. */
const ACCOUNT_ROWS: readonly (readonly [table: string, column: string])[] = [
  ["checkout_claims", "user_id"],
  ["claim_requests", "user_id"],
  ["claim_tokens", "consumed_by_user_id"],
  ["connection_intents", "user_id"],
  ["workspace_memberships", "user_id"],
  ["auth_sessions", "user_id"],
  ["auth_accounts", "user_id"],
  ["external_identities", "user_id"],
  ["auth_users", "id"],
];

/** Another workspace's history still names the user, so its `users` row must stay for now. */
const userStillReferenced = (userId: string) => sql`(
  EXISTS (SELECT 1 FROM connections WHERE created_by_user_id = ${userId})
  OR EXISTS (SELECT 1 FROM offer_versions WHERE created_by_user_id = ${userId}))`;

/**
 * Deletes a user's account rows in one batch, with the audit event built from the counts: their
 * checkout claims, claim requests and consumed claim tokens, connection intents, memberships,
 * Better Auth sessions, accounts and profile, external identities, and the `users` row unless a
 * connection or offer version still names it (it holds only the ID; pruning removes it once
 * nothing does). Subjects must already be unlinked from the identity.
 *
 * The batch writes nothing while the user owns a workspace that is not being deleted, checked in
 * the batch itself: a deletion cancelled concurrently, after the caller's check, must not leave
 * an active workspace without its owner. Returns the counts, or null when it wrote nothing.
 */
export async function deleteAccountRows(
  db: Db,
  input: { userId: string; audit: (deleted: DeletedRows) => AuditEvents },
): Promise<DeletedRows | null> {
  const { userId } = input;
  const deleted: Record<string, number> = {};
  for (const [table, column] of ACCOUNT_ROWS) {
    const [row] = await db.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM ${ident(table)} WHERE ${ident(column)} = ${userId}`,
    );
    deleted[table] = Number(row?.n);
  }
  const [user] = await db.all<{ deletable: number }>(
    sql`SELECT (EXISTS (SELECT 1 FROM users WHERE id = ${userId}) AND NOT ${userStillReferenced(userId)}) AS deletable`,
  );
  deleted.users = Number(user?.deletable);
  const audit = input.audit(deleted);
  const ownsNoLiveWorkspace = sql`NOT EXISTS (SELECT 1 FROM workspace_memberships m
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = ${userId} AND m.role = 'owner' AND w.status NOT IN ('deleting', 'purging'))`;
  // The audit event goes first, on the ownership check; every delete follows only if it was
  // written (the check would pass trivially once the memberships are gone).
  const written = sql`EXISTS (SELECT 1 FROM audit_events WHERE id = ${audit[0].id})`;
  const [first] = await runBatch(db, [
    ...conditionalAuditInserts(db, audit, ownsNoLiveWorkspace),
    ...ACCOUNT_ROWS.map(([table, column]) =>
      deleteFrom(db, table, sql`${ident(column)} = ${userId} AND ${written}`),
    ),
    deleteFrom(
      db,
      "users",
      sql`id = ${userId} AND NOT ${userStillReferenced(userId)} AND ${written}`,
    ),
  ]);
  return first === 1 ? deleted : null;
}
