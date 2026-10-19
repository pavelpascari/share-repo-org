import type { CommercialSource, Instant, OfferStatus } from "@sharerepo/domain";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type AuditEvents, auditInserts, conditionalAuditInserts } from "./audit-repository.ts";
import { insertWhere, runBatch } from "./batch.ts";
import { ascending, selectInChunks } from "./chunks.ts";
import type { Db } from "./client.ts";
import { conditionalOutboxInsert, type NewOutboxRow, outboxInsert } from "./outbox-repository.ts";
import {
  entitlements,
  offerAccesses,
  offerItems,
  offers,
  offerVersions,
  subscriptionItems,
  subscriptions,
} from "./schema/index.ts";

/** Domain `Offer`: a creator's promise, at its current `version`. */
export type Offer = typeof offers.$inferSelect;
/** Immutable configuration snapshot of one offer version (append-only). */
export type OfferVersion = typeof offerVersions.$inferSelect;
/** A commercial item the offer currently sells. */
export type OfferItem = typeof offerItems.$inferSelect;
/** Access to one resource the offer currently promises. */
export type OfferAccess = typeof offerAccesses.$inferSelect;
/** An offer with its current items and accesses. */
export type OfferWithConfig = Offer & { items: OfferItem[]; accesses: OfferAccess[] };

export interface NewOffer {
  /** `version` 1. */
  offer: Offer;
  /** The snapshot of version 1. */
  version: OfferVersion;
  items: readonly OfferItem[];
  accesses: readonly OfferAccess[];
  /** Work the new offer causes (a `recompute_offer` when it sells items). */
  outbox: readonly NewOutboxRow[];
}

export interface OfferUpdate {
  workspaceId: string;
  offerId: string;
  /** The offer's `version` when the caller read it; the write fails if it changed. */
  expectedVersion: number;
  set: { name: string; gracePeriodDays: number; status: OfferStatus; updatedAt: Instant };
  /** The snapshot of the new version, `expectedVersion + 1`. */
  version: OfferVersion;
  /** The offer's complete new items and accesses; they replace the current ones. */
  items: readonly OfferItem[];
  accesses: readonly OfferAccess[];
  outbox: readonly NewOutboxRow[];
}

export type UpdateOfferResult =
  | { ok: true }
  /** Another writer changed the offer since it was read (or it does not exist): nothing written. */
  | { ok: false; reason: "stale" };

/**
 * Creates an offer at version 1 with its snapshot, items, accesses, outbox rows and audit, in one
 * batch.
 */
export async function createOffer(db: Db, input: NewOffer, audit: AuditEvents): Promise<void> {
  await runBatch(db, [
    db.insert(offers).values(input.offer),
    db.insert(offerVersions).values(input.version),
    ...input.items.map((item) => db.insert(offerItems).values(item)),
    ...input.accesses.map((access) => db.insert(offerAccesses).values(access)),
    ...input.outbox.map((row) => outboxInsert(db, row)),
    ...auditInserts(db, audit),
  ]);
}

/**
 * Applies one offer change (an edit or an archive) as a new version, in one atomic batch with
 * optimistic concurrency.
 *
 * Every statement is guarded by "the offer is still at `expectedVersion`", and the version bump
 * runs last. D1 runs a batch as one transaction, so nothing can change the offer between the
 * guard of the first statement and the bump: either every statement writes, or (a concurrent
 * writer bumped the version first) none does. Guarding the dependents on "the offer is at
 * `expectedVersion + 1`" after the bump would not be safe: a concurrent writer that read the same
 * version produces that same version number, so its write would satisfy a stale writer's guard.
 */
export async function updateOffer(
  db: Db,
  input: OfferUpdate,
  audit: AuditEvents,
): Promise<UpdateOfferResult> {
  const { workspaceId, offerId, expectedVersion } = input;
  if (input.version.version !== expectedVersion + 1) {
    throw new Error("updateOffer: the snapshot must be version expectedVersion + 1");
  }
  const current = and(
    eq(offers.workspaceId, workspaceId),
    eq(offers.id, offerId),
    eq(offers.version, expectedVersion),
  );
  const guard = sql`EXISTS (SELECT 1 FROM ${offers} WHERE ${current})`;
  const changes = await runBatch(db, [
    insertWhere(db, offerVersions, input.version, guard),
    db
      .delete(offerItems)
      .where(and(eq(offerItems.workspaceId, workspaceId), eq(offerItems.offerId, offerId), guard)),
    db
      .delete(offerAccesses)
      .where(
        and(eq(offerAccesses.workspaceId, workspaceId), eq(offerAccesses.offerId, offerId), guard),
      ),
    ...input.items.map((item) => insertWhere(db, offerItems, item, guard)),
    ...input.accesses.map((access) => insertWhere(db, offerAccesses, access, guard)),
    ...input.outbox.map((row) => conditionalOutboxInsert(db, row, guard)),
    ...conditionalAuditInserts(db, audit, guard),
    // Last: once it runs, the guard above no longer holds.
    db
      .update(offers)
      .set({ ...input.set, version: expectedVersion + 1 })
      .where(current),
  ]);
  return changes.at(-1) === 1 ? { ok: true } : { ok: false, reason: "stale" };
}

/**
 * Loads the current items and accesses of offers in one workspace, keeping the given order. The
 * offer IDs are bound in chunks (D1's parameter limit); each offer's rows come from one chunk.
 */
async function withConfig(
  db: Db,
  workspaceId: string,
  rows: readonly Offer[],
): Promise<OfferWithConfig[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((offer) => offer.id);
  const [items, accesses] = await Promise.all([
    selectInChunks(ids, (chunk) =>
      db
        .select()
        .from(offerItems)
        .where(and(eq(offerItems.workspaceId, workspaceId), inArray(offerItems.offerId, chunk)))
        .orderBy(asc(offerItems.source), asc(offerItems.externalItemId), asc(offerItems.id)),
    ),
    selectInChunks(ids, (chunk) =>
      db
        .select()
        .from(offerAccesses)
        .where(
          and(eq(offerAccesses.workspaceId, workspaceId), inArray(offerAccesses.offerId, chunk)),
        )
        .orderBy(asc(offerAccesses.resourceId), asc(offerAccesses.id)),
    ),
  ]);
  return rows.map((offer) => ({
    ...offer,
    items: items.filter((item) => item.offerId === offer.id),
    accesses: accesses.filter((access) => access.offerId === offer.id),
  }));
}

const byName = [asc(offers.name), asc(offers.id)] as const;
/** `byName` for offers merged from several chunked statements. */
const sortByName = (rows: Offer[]) =>
  rows.sort((a, b) => ascending(a.name, b.name) || ascending(a.id, b.id));

export async function getOffer(
  db: Db,
  key: { workspaceId: string; offerId: string },
): Promise<OfferWithConfig | null> {
  const rows = await db
    .select()
    .from(offers)
    .where(and(eq(offers.workspaceId, key.workspaceId), eq(offers.id, key.offerId)))
    .limit(1);
  const [offer] = await withConfig(db, key.workspaceId, rows);
  return offer ?? null;
}

/** Every offer of the workspace, archived ones included, by name. */
export async function listOffers(db: Db, workspaceId: string): Promise<OfferWithConfig[]> {
  const rows = await db
    .select()
    .from(offers)
    .where(eq(offers.workspaceId, workspaceId))
    .orderBy(...byName);
  return withConfig(db, workspaceId, rows);
}

/** The workspace's offers with these IDs, by name; IDs of other workspaces are ignored. */
export async function listOffersByIds(
  db: Db,
  key: { workspaceId: string; offerIds: readonly string[] },
): Promise<OfferWithConfig[]> {
  const rows = await selectInChunks(key.offerIds, (chunk) =>
    db
      .select()
      .from(offers)
      .where(and(eq(offers.workspaceId, key.workspaceId), inArray(offers.id, chunk))),
  );
  return withConfig(db, key.workspaceId, sortByName(rows));
}

export async function getOfferVersion(
  db: Db,
  key: { workspaceId: string; offerId: string; version: number },
): Promise<OfferVersion | null> {
  const rows = await db
    .select()
    .from(offerVersions)
    .where(
      and(
        eq(offerVersions.workspaceId, key.workspaceId),
        eq(offerVersions.offerId, key.offerId),
        eq(offerVersions.version, key.version),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Offers whose current items include any of these commercial items, by name. An item maps to at
 * most one offer per workspace (unique index), but several items may map to several offers. The
 * items are bound in chunks (D1's parameter limit; a subscription may carry 100 items).
 */
export async function findOffersForItems(
  db: Db,
  key: { workspaceId: string; source: CommercialSource; externalItemIds: readonly string[] },
): Promise<OfferWithConfig[]> {
  const found = await selectInChunks(key.externalItemIds, (chunk) => {
    const carrying = db
      .select({ offerId: offerItems.offerId })
      .from(offerItems)
      .where(
        and(
          eq(offerItems.workspaceId, key.workspaceId),
          eq(offerItems.source, key.source),
          inArray(offerItems.externalItemId, chunk),
        ),
      );
    return db
      .select()
      .from(offers)
      .where(and(eq(offers.workspaceId, key.workspaceId), inArray(offers.id, carrying)));
  });
  // Items of one offer may fall into several chunks.
  const unique = [...new Map(found.map((offer) => [offer.id, offer])).values()];
  return withConfig(db, key.workspaceId, sortByName(unique));
}

/** A subscription an offer change must recompute, as its refresh is keyed. */
export interface OfferSubscriptionRef {
  id: string;
  source: CommercialSource;
  externalSubscriptionId: string;
}

/**
 * Subscriptions an offer change must recompute, by ID, in one query: those carrying one of the
 * offer's current items (from the same source), and those with a live entitlement from the offer
 * (which may have lost the item that granted it, or the offer its items when it was archived).
 */
export async function listSubscriptionsForOffer(
  db: Db,
  key: { workspaceId: string; offerId: string },
): Promise<OfferSubscriptionRef[]> {
  const { workspaceId, offerId } = key;
  const carriesItem = sql`EXISTS (SELECT 1 FROM ${subscriptionItems} INNER JOIN ${offerItems} ON ${offerItems.workspaceId} = ${subscriptionItems.workspaceId} AND ${offerItems.externalItemId} = ${subscriptionItems.externalItemId} WHERE ${subscriptionItems.workspaceId} = ${workspaceId} AND ${subscriptionItems.subscriptionId} = ${subscriptions.id} AND ${offerItems.offerId} = ${offerId} AND ${offerItems.source} = ${subscriptions.source})`;
  const hasLiveEntitlement = sql`EXISTS (SELECT 1 FROM ${entitlements} WHERE ${entitlements.workspaceId} = ${workspaceId} AND ${entitlements.sourceId} = ${subscriptions.id} AND ${entitlements.offerId} = ${offerId} AND ${entitlements.state} = 'active')`;
  return db
    .select({
      id: subscriptions.id,
      source: subscriptions.source,
      externalSubscriptionId: subscriptions.externalSubscriptionId,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, workspaceId),
        sql`(${carriesItem} OR ${hasLiveEntitlement})`,
      ),
    )
    .orderBy(asc(subscriptions.id));
}
