import { type CommercialSource, type Instant, OutboxKind } from "@sharerepo/domain";
import { and, asc, eq, isNotNull, lte, or, type SQL, sql } from "drizzle-orm";
import { type AuditEvents, conditionalAuditInserts } from "./audit-repository.ts";
import { insertWhere, runBatch, type Statement } from "./batch.ts";
import type { Db } from "./client.ts";
import type { Customer } from "./customer-repository.ts";
import { isUniqueViolation } from "./errors.ts";
import {
  assertReconcileRows,
  conditionalOutboxInsert,
  dedupedOutboxInsert,
  type NewOutboxRow,
  pendingOutbox,
} from "./outbox-repository.ts";
import { reconcileRequest } from "./reconcile-repository.ts";
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

/** An offer at the version a refresh read it. */
export interface OfferVersionRef {
  offerId: string;
  version: number;
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
  /**
   * Every offer the entitlement plan was decided from, at the version the refresh read: the
   * offers carrying `items` and those the live entitlements refer to. The write is stale unless
   * each is still at that version and no other offer carries any of `items`.
   */
  offers: readonly OfferVersionRef[];
  entitlements: EntitlementPlanWrite;
  outbox?: readonly NewOutboxRow[];
  /**
   * `reconcile_resource` rows (keyed `<workspaceId>:<resourceId>`) for every resource whose
   * entitlements the plan creates, updates or ends. Each is inserted only if no row with its key
   * is pending, and stamps the resource's reconcile request either way.
   */
  reconcile: readonly NewOutboxRow[];
}

export type ApplySubscriptionRefreshResult =
  | { ok: true }
  /**
   * Another writer recorded this subscription (or its customer) first, or an offer the plan used
   * changed: nothing was written. Read again and refresh from fresh state.
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

/** The external IDs of every subscription the workspace stores for one customer. */
export async function listCustomerSubscriptionIds(
  db: Db,
  key: { workspaceId: string; customerId: string },
): Promise<string[]> {
  const rows = await db
    .select({ externalSubscriptionId: subscriptions.externalSubscriptionId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, key.workspaceId),
        eq(subscriptions.customerId, key.customerId),
      ),
    )
    .orderBy(asc(subscriptions.externalSubscriptionId));
  return rows.map((row) => row.externalSubscriptionId);
}

/**
 * The source's `updated_at` of every subscription the workspace stores from `source`, by external
 * ID: what a repair sweep compares the source's list with, in one query.
 */
export async function listSubscriptionSourceVersions(
  db: Db,
  key: { workspaceId: string; source: CommercialSource },
): Promise<Map<string, Instant>> {
  const rows = await db
    .select({
      externalSubscriptionId: subscriptions.externalSubscriptionId,
      sourceUpdatedAt: subscriptions.sourceUpdatedAt,
    })
    .from(subscriptions)
    .where(
      and(eq(subscriptions.workspaceId, key.workspaceId), eq(subscriptions.source, key.source)),
    );
  return new Map(rows.map((row) => [row.externalSubscriptionId, row.sourceUpdatedAt]));
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
  assertReconcileRows(input.reconcile, workspaceId, "applySubscriptionRefresh");
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
 * "Each offer the plan used is still at the version read, and no other offer of the workspace
 * carries one of the subscription's items from its source." The offer pairs and the items are
 * bound as one JSON parameter each, so the guard binds a fixed number of parameters however many
 * offers and items there are (D1 binds at most 100 per statement). Aliased raw SQL, because
 * `json_each` has columns (`id`, `value`) that would clash with unqualified names.
 */
function offersUnchanged(input: SubscriptionRefresh): SQL {
  const { workspaceId, subscription } = input;
  const expected = JSON.stringify(input.offers.map((offer) => [offer.offerId, offer.version]));
  const items = JSON.stringify(input.items);
  const atVersion = sql`(SELECT count(*) FROM offers AS o INNER JOIN json_each(${expected}) AS e ON o.id = json_extract(e.value, '$[0]') AND o.version = json_extract(e.value, '$[1]') WHERE o.workspace_id = ${workspaceId}) = ${input.offers.length}`;
  const noOtherOffer = sql`NOT EXISTS (SELECT 1 FROM offer_items AS oi INNER JOIN json_each(${items}) AS i ON oi.external_item_id = i.value WHERE oi.workspace_id = ${workspaceId} AND oi.source = ${subscription.source} AND oi.offer_id NOT IN (SELECT json_extract(value, '$[0]') FROM json_each(${expected})))`;
  return sql`(${atVersion} AND ${noOtherOffer})`;
}

/**
 * Writes one refresh decision in one atomic batch (decision 0003): the customer (created or
 * linked), the subscription and its items, the entitlement plan, outbox rows (`reconcile` rows
 * deduplicated against pending ones) and audit events.
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
 * Entitlement ends run before creates, so a lapsed live row can be replaced by a new one under
 * the live-row unique index. Entitlement updates and ends touch only live rows of this
 * subscription in this workspace.
 *
 * Offers. Every statement is also guarded by "each of `offers` is still at its version, and no
 * other offer carries any of `items`" (`offersUnchanged`). An offer edit, archive or creation
 * that commits between the refresh's read and this write would otherwise be lost: its recompute
 * may run before this subscription row exists or before this write lands, and then nothing
 * revisits the subscription. A changed offer makes the write `stale`, and the refresh re-reads.
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
  const offersCurrent = offersUnchanged(input);

  const statements: Statement[] = [];
  if (input.customer !== undefined) {
    const { customer } = input;
    const absent = sql`NOT EXISTS (SELECT 1 FROM ${customers} WHERE ${customers.workspaceId} = ${workspaceId} AND ${customers.source} = ${customer.source} AND ${customers.externalCustomerId} = ${customer.externalCustomerId})`;
    statements.push(
      insertWhere(
        db,
        customers,
        customer,
        creating
          ? sql`${absent} AND ${offersCurrent}`
          : sql`${absent} AND ${atExpected} AND ${offersCurrent}`,
      ),
    );
  }
  if (creating) {
    statements.push(
      insertWhere(db, subscriptions, subscription, sql`${customerExists} AND ${offersCurrent}`),
    );
  }
  const decisive = creating ? statements.length - 1 : null;

  // A new subscription row exists only if the offers were unchanged; nothing in the batch
  // changes an offer, so the subscription's existence carries that guard to the dependents.
  const guard = creating ? created : sql`${atExpected} AND ${customerExists} AND ${offersCurrent}`;
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
    // Ends first: a replacement for an ended row is created below under the live-row index.
    ...input.entitlements.end.map(({ id, state, reason }) =>
      db
        .update(entitlements)
        .set({ state, decisionReason: reason, endedAt: now, updatedAt: now })
        .where(liveOfSubscription(id)),
    ),
    ...input.entitlements.update.map(({ id, set }) =>
      db
        .update(entitlements)
        .set({ ...set, updatedAt: now })
        .where(liveOfSubscription(id)),
    ),
    ...input.entitlements.create.map((row) => insertWhere(db, entitlements, row, guard)),
    ...(input.outbox ?? []).map((row) => conditionalOutboxInsert(db, row, guard)),
    ...input.reconcile.flatMap((row) => reconcileRequest(db, workspaceId, row, guard)),
    ...conditionalAuditInserts(db, audit, guard),
  );
  if (!creating) {
    const { id: _id, workspaceId: _ws, createdAt: _createdAt, ...fields } = subscription;
    // Last: once it runs, `atExpected` no longer holds.
    statements.push(
      db
        .update(subscriptions)
        .set(fields)
        .where(and(current, customerExists, offersCurrent)),
    );
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
 * The `refresh_subscription` outbox key of the subscription row in scope, in SQL. Must match the
 * application's `encodeRefreshKey` (`<workspaceId>:<source>:<externalSubscriptionId>`); the
 * application's sweep tests queue rows with that encoder and check this lookup finds them.
 */
const refreshKeyOfRow = sql`${subscriptions.workspaceId} || ':' || ${subscriptions.source} || ':' || ${subscriptions.externalSubscriptionId}`;

/**
 * Queues a `refresh_subscription` (built by `makeOutboxRow`) for up to `limit` subscriptions, in
 * any workspace, and returns how many it queued. For the per-minute cron sweep. Two kinds, due
 * ones first:
 *
 * - **Due:** `next_evaluation_at` is at or before `now`. The sweep clears it.
 * - **Repair:** a live entitlement's `valid_until` is at or before `now` (and the subscription is
 *   not due). This is the scheduled repair path: a refresh that failed for good after the sweep
 *   had cleared `next_evaluation_at` would otherwise leave the entitlement live past its end
 *   forever. A subscription whose refresh is already queued (an unsent, unfailed row with the
 *   same key) is skipped, in the query and again when inserting, so a minutely sweep cannot pile
 *   up work for a refresh that keeps failing; once that row fails, the next sweep queues another.
 *
 * Race safety of a due claim. Each due subscription gets a pair of statements in one batch (one
 * transaction):
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
 * so it carries no audit event. A repair claim is one outbox insert guarded by "not already
 * queued", so concurrent sweeps queue it at most once.
 */
export async function claimDueEvaluations(
  db: Db,
  input: {
    now: Instant;
    limit: number;
    makeOutboxRow: (subscription: Subscription) => NewOutboxRow;
  },
): Promise<number> {
  const isDue = and(
    isNotNull(subscriptions.nextEvaluationAt),
    lte(subscriptions.nextEvaluationAt, input.now),
  ) as SQL;
  const due = await db
    .select()
    .from(subscriptions)
    .where(isDue)
    .orderBy(asc(subscriptions.nextEvaluationAt), asc(subscriptions.id))
    .limit(input.limit);
  // Driven by `entitlements_state_valid_until_idx`: the few live entitlements past their end,
  // rather than a probe per subscription (decision 0013).
  const lapsed = sql`(${subscriptions.workspaceId}, ${subscriptions.id}) IN (SELECT ${entitlements.workspaceId}, ${entitlements.sourceId} FROM ${entitlements} WHERE ${entitlements.state} = 'active' AND ${entitlements.validUntil} <= ${input.now})`;
  const repair =
    due.length < input.limit
      ? await db
          .select()
          .from(subscriptions)
          .where(
            and(
              lapsed,
              sql`NOT (${isDue})`,
              sql`NOT ${pendingOutbox(OutboxKind.RefreshSubscription, refreshKeyOfRow)}`,
            ),
          )
          .orderBy(asc(subscriptions.id))
          .limit(input.limit - due.length)
      : [];
  if (due.length + repair.length === 0) return 0;
  const changes = await runBatch(db, [
    ...due.flatMap((subscription) => [
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
    ...repair.map((subscription) => dedupedOutboxInsert(db, input.makeOutboxRow(subscription))),
  ]);
  const queuedDue = changes.slice(0, 2 * due.length).filter((_, index) => index % 2 === 1);
  return [...queuedDue, ...changes.slice(2 * due.length)].reduce((sum, n) => sum + n, 0);
}
