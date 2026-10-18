import type { CommercialSource, Instant } from "@sharerepo/domain";
import { and, asc, eq, isNotNull, lte, or, type SQL, sql } from "drizzle-orm";
import { type AuditEvents, conditionalAuditInserts } from "./audit-repository.ts";
import { insertWhere, runBatch, type Statement } from "./batch.ts";
import type { Db } from "./client.ts";
import type { Customer } from "./customer-repository.ts";
import { isUniqueViolation } from "./errors.ts";
import { conditionalOutboxInsert, type NewOutboxRow } from "./outbox-repository.ts";
import { customers, entitlements, subscriptionItems, subscriptions } from "./schema/index.ts";

/** Domain `Subscription`: normalized commercial facts observed from a source. Not access. */
export type Subscription = typeof subscriptions.$inferSelect;
export type SubscriptionItem = typeof subscriptionItems.$inferSelect;
/** A subscription with the external IDs of the commercial items it carries, sorted. */
export type SubscriptionWithItems = Subscription & { items: string[] };
/** Domain `Entitlement`: desired access. Only `active` rows are live. */
export type Entitlement = typeof entitlements.$inferSelect;
/** A complete entitlement row to create (`state` `active`, `endedAt` null). */
export type NewEntitlement = Entitlement;

/** What a refresh may change on a live entitlement. `updated_at` is always set to `now`. */
export type EntitlementChanges = Partial<
  Pick<Entitlement, "validUntil" | "decisionReason" | "offerVersion" | "policyVersion">
>;

/** The entitlement plan of one refresh, already decided by the domain. */
export interface EntitlementPlanWrite {
  create: readonly NewEntitlement[];
  update: readonly { id: string; set: EntitlementChanges }[];
  end: readonly { id: string; state: "expired" | "revoked"; reason: string }[];
}

export interface SubscriptionRefresh {
  workspaceId: string;
  now: Instant;
  /** The subscription's `version` when the refresh read it; 0 when it did not exist yet. */
  expectedVersion: number;
  /** A customer to create, unless one with the same source and external ID already exists. */
  customer?: Customer;
  /** Sets a customer's subject (an explicit link, or null to unlink). */
  customerLink?: { customerId: string; subjectId: string | null };
  /** The complete new subscription row, at `version` `expectedVersion + 1`. */
  subscription: Subscription;
  /** The external IDs of the items the subscription now carries; they replace the current ones. */
  items: readonly string[];
  entitlements: EntitlementPlanWrite;
  outbox?: readonly NewOutboxRow[];
}

export type ApplySubscriptionRefreshResult =
  | { ok: true }
  /**
   * Another writer recorded this subscription (or its customer) first: nothing was written. Read
   * again and refresh from fresh state.
   */
  | { ok: false; reason: "stale" };

const EXTERNAL_KEY = [
  "subscriptions.workspace_id",
  "subscriptions.source",
  "subscriptions.external_subscription_id",
] as const;

async function withItems(db: Db, row: Subscription | undefined) {
  if (row === undefined) return null;
  const items = await db
    .select({ externalItemId: subscriptionItems.externalItemId })
    .from(subscriptionItems)
    .where(
      and(
        eq(subscriptionItems.workspaceId, row.workspaceId),
        eq(subscriptionItems.subscriptionId, row.id),
      ),
    )
    .orderBy(asc(subscriptionItems.externalItemId));
  return { ...row, items: items.map((item) => item.externalItemId) };
}

export async function getSubscriptionByExternal(
  db: Db,
  key: { workspaceId: string; source: CommercialSource; externalSubscriptionId: string },
): Promise<SubscriptionWithItems | null> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, key.workspaceId),
        eq(subscriptions.source, key.source),
        eq(subscriptions.externalSubscriptionId, key.externalSubscriptionId),
      ),
    )
    .limit(1);
  return withItems(db, rows[0]);
}

export async function getSubscription(
  db: Db,
  key: { workspaceId: string; subscriptionId: string },
): Promise<SubscriptionWithItems | null> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(eq(subscriptions.workspaceId, key.workspaceId), eq(subscriptions.id, key.subscriptionId)),
    )
    .limit(1);
  return withItems(db, rows[0]);
}

const chronological = [asc(entitlements.createdAt), asc(entitlements.id)] as const;
const live = eq(entitlements.state, "active");

export async function listLiveEntitlementsForSubscription(
  db: Db,
  key: { workspaceId: string; subscriptionId: string },
): Promise<Entitlement[]> {
  return db
    .select()
    .from(entitlements)
    .where(
      and(
        eq(entitlements.workspaceId, key.workspaceId),
        eq(entitlements.sourceId, key.subscriptionId),
        live,
      ),
    )
    .orderBy(...chronological);
}

/**
 * The workspace's entitlements, oldest first. Live rows always; ended rows only with
 * `includeEnded`, and then only those that ended at or after `endedSince` when it is given.
 */
export async function listEntitlementsForWorkspace(
  db: Db,
  workspaceId: string,
  options: { includeEnded?: boolean; endedSince?: Instant } = {},
): Promise<Entitlement[]> {
  let visible: SQL | undefined = live;
  if (options.includeEnded === true) {
    visible =
      options.endedSince === undefined
        ? undefined
        : or(live, lte(sql`${options.endedSince}`, entitlements.endedAt));
  }
  return db
    .select()
    .from(entitlements)
    .where(and(eq(entitlements.workspaceId, workspaceId), visible))
    .orderBy(...chronological);
}

export async function listLiveEntitlementsForWorkspace(
  db: Db,
  workspaceId: string,
): Promise<Entitlement[]> {
  return listEntitlementsForWorkspace(db, workspaceId);
}

/** Rows a refresh writes must belong to the refreshed subscription; anything else is a bug. */
function assertRefreshScoped(input: SubscriptionRefresh): void {
  const { workspaceId, subscription } = input;
  const scoped =
    subscription.workspaceId === workspaceId &&
    subscription.version === input.expectedVersion + 1 &&
    (input.customer === undefined || input.customer.workspaceId === workspaceId) &&
    input.entitlements.create.every(
      (row) => row.workspaceId === workspaceId && row.sourceId === subscription.id,
    );
  if (!scoped) {
    throw new Error(
      "applySubscriptionRefresh: rows must belong to the refreshed subscription at expectedVersion + 1",
    );
  }
}

/**
 * Writes one refresh decision in one atomic batch (decision 0003): the customer (created or
 * linked), the subscription and its items, the entitlement plan, outbox rows and audit events.
 *
 * Concurrency. D1 runs a batch as one transaction, so a guard evaluated by one statement still
 * holds for every later statement until a statement in the batch changes it.
 *
 * - **Existing subscription** (`expectedVersion` ≥ 1): every dependent statement is guarded by
 *   "the subscription is still at `expectedVersion` and its customer exists", and the guarded
 *   subscription UPDATE (which bumps the version) runs last. Either all statements write or, when
 *   another writer bumped the version first, none does. (Guarding on "the subscription is at
 *   `expectedVersion + 1`" after the bump would let a stale writer through: a concurrent writer
 *   that read the same version writes that same version number.)
 * - **New subscription** (`expectedVersion` 0): the INSERT runs first and the dependents are
 *   guarded by the existence of this row's own ID. A concurrent writer that recorded the same
 *   external subscription first makes the INSERT fail its UNIQUE key, which rolls the batch back
 *   and is reported as `stale`.
 *
 * In both cases a new customer is inserted only if no customer with its source and external ID
 * exists; if a concurrent writer created that customer under another ID, the subscription write
 * is skipped (its customer does not exist) and the result is `stale`, never a foreign key error.
 * Entitlement updates and ends touch only live rows of this subscription in this workspace.
 */
export async function applySubscriptionRefresh(
  db: Db,
  input: SubscriptionRefresh,
  audit: AuditEvents,
): Promise<ApplySubscriptionRefreshResult> {
  assertRefreshScoped(input);
  const { workspaceId, now, expectedVersion, subscription } = input;
  const creating = expectedVersion === 0;

  const customerExists = sql`EXISTS (SELECT 1 FROM ${customers} WHERE ${customers.workspaceId} = ${workspaceId} AND ${customers.id} = ${subscription.customerId})`;
  const current = and(
    eq(subscriptions.workspaceId, workspaceId),
    eq(subscriptions.id, subscription.id),
    eq(subscriptions.version, expectedVersion),
  );
  const atExpected = sql`EXISTS (SELECT 1 FROM ${subscriptions} WHERE ${current})`;
  const created = sql`EXISTS (SELECT 1 FROM ${subscriptions} WHERE ${subscriptions.workspaceId} = ${workspaceId} AND ${subscriptions.id} = ${subscription.id})`;

  const statements: Statement[] = [];
  if (input.customer !== undefined) {
    const { customer } = input;
    const absent = sql`NOT EXISTS (SELECT 1 FROM ${customers} WHERE ${customers.workspaceId} = ${workspaceId} AND ${customers.source} = ${customer.source} AND ${customers.externalCustomerId} = ${customer.externalCustomerId})`;
    statements.push(
      insertWhere(db, customers, customer, creating ? absent : sql`${absent} AND ${atExpected}`),
    );
  }
  if (creating) statements.push(insertWhere(db, subscriptions, subscription, customerExists));
  const decisive = creating ? statements.length - 1 : null;

  const guard = creating ? created : sql`${atExpected} AND ${customerExists}`;
  if (input.customerLink !== undefined) {
    const link = input.customerLink;
    statements.push(
      db
        .update(customers)
        .set({ subjectId: link.subjectId, updatedAt: now })
        .where(
          and(eq(customers.workspaceId, workspaceId), eq(customers.id, link.customerId), guard),
        ),
    );
  }
  statements.push(
    db
      .delete(subscriptionItems)
      .where(
        and(
          eq(subscriptionItems.workspaceId, workspaceId),
          eq(subscriptionItems.subscriptionId, subscription.id),
          guard,
        ),
      ),
    ...input.items.map((externalItemId) =>
      insertWhere(
        db,
        subscriptionItems,
        { id: crypto.randomUUID(), workspaceId, subscriptionId: subscription.id, externalItemId },
        guard,
      ),
    ),
    ...input.entitlements.create.map((row) => insertWhere(db, entitlements, row, guard)),
  );
  const liveOfSubscription = (id: string) =>
    and(
      eq(entitlements.workspaceId, workspaceId),
      eq(entitlements.sourceId, subscription.id),
      eq(entitlements.id, id),
      live,
      guard,
    );
  statements.push(
    ...input.entitlements.update.map(({ id, set }) =>
      db
        .update(entitlements)
        .set({ ...set, updatedAt: now })
        .where(liveOfSubscription(id)),
    ),
    ...input.entitlements.end.map(({ id, state, reason }) =>
      db
        .update(entitlements)
        .set({ state, decisionReason: reason, endedAt: now, updatedAt: now })
        .where(liveOfSubscription(id)),
    ),
    ...(input.outbox ?? []).map((row) => conditionalOutboxInsert(db, row, guard)),
    ...conditionalAuditInserts(db, audit, guard),
  );
  if (!creating) {
    const { id: _id, workspaceId: _ws, createdAt: _createdAt, ...fields } = subscription;
    // Last: once it runs, `atExpected` no longer holds.
    statements.push(db.update(subscriptions).set(fields).where(and(current, customerExists)));
  }

  let changes: number[];
  try {
    changes = await runBatch(db, statements);
  } catch (error) {
    if (creating && isUniqueViolation(error, EXTERNAL_KEY)) return { ok: false, reason: "stale" };
    throw error;
  }
  return changes.at(decisive ?? -1) === 1 ? { ok: true } : { ok: false, reason: "stale" };
}

/**
 * Queues a `refresh_subscription` (built by `makeOutboxRow`) for up to `limit` subscriptions, in
 * any workspace, whose `next_evaluation_at` is at or before `now`, and clears their
 * `next_evaluation_at`. Returns how many it queued. For the per-minute cron sweep.
 *
 * Race safety. Each subscription gets a pair of statements in one batch (one transaction):
 *
 * 1. `UPDATE … SET next_evaluation_at = NULL WHERE workspace, id AND next_evaluation_at = <the
 *    value this sweep read>`;
 * 2. the outbox insert, `WHERE changes() = 1`: `changes()` is the row count of the statement just
 *    before it in the same transaction, i.e. statement 1 of the same pair.
 *
 * A concurrent sweep that claimed the subscription first has set the column to NULL, so this
 * sweep's UPDATE matches nothing and queues nothing: no double queueing. A concurrent refresh that
 * set a different `next_evaluation_at` is not matched either, so its new boundary is neither wiped
 * nor queued early (a later sweep picks it up when it is due). The claim does not bump the
 * subscription's version: it changes only a scheduling hint, and the queued refresh re-reads the
 * source and recomputes the boundary anyway. Clearing the hint is bookkeeping like the outbox,
 * so it carries no audit event.
 */
export async function claimDueEvaluations(
  db: Db,
  input: {
    now: Instant;
    limit: number;
    makeOutboxRow: (subscription: Subscription) => NewOutboxRow;
  },
): Promise<number> {
  const due = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        isNotNull(subscriptions.nextEvaluationAt),
        lte(subscriptions.nextEvaluationAt, input.now),
      ),
    )
    .orderBy(asc(subscriptions.nextEvaluationAt), asc(subscriptions.id))
    .limit(input.limit);
  if (due.length === 0) return 0;
  const changes = await runBatch(
    db,
    due.flatMap((subscription) => [
      db
        .update(subscriptions)
        .set({ nextEvaluationAt: null })
        .where(
          and(
            eq(subscriptions.workspaceId, subscription.workspaceId),
            eq(subscriptions.id, subscription.id),
            eq(subscriptions.nextEvaluationAt, subscription.nextEvaluationAt as Instant),
          ),
        ),
      conditionalOutboxInsert(db, input.makeOutboxRow(subscription), sql`changes() = 1`),
    ]),
  );
  return changes.filter((_, index) => index % 2 === 1).reduce((sum, n) => sum + n, 0);
}
