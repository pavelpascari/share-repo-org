import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createOffer,
  findOffersForItems,
  findOfferWorkspaceId,
  getOffer,
  getOfferVersion,
  listOffers,
  listOffersByIds,
  listSubscriptionsForOffer,
  type NewOffer,
  type OfferUpdate,
  updateOffer,
} from "../src/index.ts";
import { auditCount, workspaceEvent } from "./support/audit.ts";
import {
  commerceWorkspace,
  newOffer,
  offerAccessRow,
  offerItemRow,
  outboxRow,
  seedOffer,
  subscribedWorkspace,
} from "./support/commerce.ts";
import { count, db } from "./support/connections.ts";
import { T0, uniqueId } from "./support/rows.ts";

const NOW = T0 + 100;

/** An update of `offer` from version `expectedVersion`, replacing its configuration. */
function change(
  offer: NewOffer,
  userId: string,
  overrides: Partial<OfferUpdate> = {},
  expectedVersion = 1,
): OfferUpdate {
  const { workspaceId, id } = offer.offer;
  return {
    workspaceId,
    offerId: id,
    expectedVersion,
    set: { name: "Pro Plus", gracePeriodDays: 14, status: "active", updatedAt: NOW },
    version: {
      id: uniqueId("ofv"),
      workspaceId,
      offerId: id,
      version: expectedVersion + 1,
      snapshot: JSON.stringify({ name: "Pro Plus" }),
      createdAt: NOW,
      createdByUserId: userId,
    },
    items: [offerItemRow(workspaceId, id, { externalItemId: "sim_new" })],
    accesses: offer.accesses,
    outbox: [outboxRow("recompute_offer", id)],
    ...overrides,
  };
}

describe("findOfferWorkspaceId (system lookup)", () => {
  it("names the offer's workspace, and null for an unknown offer", async () => {
    const { workspaceId, offer } = await subscribedWorkspace();
    await expect(findOfferWorkspaceId(db, offer.offer.id)).resolves.toBe(workspaceId);
    await expect(findOfferWorkspaceId(db, uniqueId("off"))).resolves.toBeNull();
  });
});

describe("createOffer", () => {
  it("writes the offer, its version-1 snapshot, items, accesses and audit together", async () => {
    const ws = await commerceWorkspace(2);
    const offer = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: ws.resources.map((r) => r.id),
      itemIds: ["sim_b", "sim_a"],
    });
    const stored = await getOffer(db, { workspaceId: ws.workspaceId, offerId: offer.offer.id });
    expect(stored).toMatchObject(offer.offer);
    expect(stored?.items.map((i) => i.externalItemId)).toEqual(["sim_a", "sim_b"]);
    expect(stored?.accesses).toHaveLength(2);
    expect(
      await getOfferVersion(db, {
        workspaceId: ws.workspaceId,
        offerId: offer.offer.id,
        version: 1,
      }),
    ).toEqual(offer.version);
    expect(await count("audit_events", "workspace_id = ?", ws.workspaceId)).toBeGreaterThan(0);
  });

  it("queues its outbox rows in the same batch", async () => {
    const ws = await commerceWorkspace();
    const offer = newOffer({ workspaceId: ws.workspaceId, userId: ws.userId, resourceIds: [] });
    const work = outboxRow("recompute_offer", `${ws.workspaceId}:${offer.offer.id}`);
    await createOffer(db, { ...offer, outbox: [work] }, [workspaceEvent(ws.workspaceId)]);
    expect(await count("outbox", "id = ? AND kind = 'recompute_offer'", work.id)).toBe(1);

    // A failed create queues nothing.
    const duplicate = {
      ...newOffer({
        workspaceId: ws.workspaceId,
        userId: ws.userId,
        resourceIds: [],
        itemIds: offer.items.map((i) => i.externalItemId),
      }),
      outbox: [outboxRow("recompute_offer", "x")],
    };
    await expect(createOffer(db, duplicate, [workspaceEvent(ws.workspaceId)])).rejects.toThrow();
    expect(await count("outbox", "id = ?", duplicate.outbox[0]?.id)).toBe(0);
  });

  it("writes nothing when one row fails, such as an item another offer already sells", async () => {
    const ws = await commerceWorkspace();
    await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [],
      itemIds: ["sim_x"],
    });
    const event = workspaceEvent(ws.workspaceId);
    const duplicate = newOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [],
      itemIds: ["sim_x"],
    });
    await expect(createOffer(db, duplicate, [event])).rejects.toThrow();
    expect(await count("offers", "workspace_id = ?", ws.workspaceId)).toBe(1);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });
});

describe("updateOffer", () => {
  it("bumps the version, appends the snapshot, replaces items and accesses, queues and audits", async () => {
    const ws = await commerceWorkspace(2);
    const [first, second] = ws.resources as [(typeof ws.resources)[0], (typeof ws.resources)[0]];
    const offer = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [first.id],
    });
    const event = workspaceEvent(ws.workspaceId);
    const update = change(offer, ws.userId, {
      accesses: [offerAccessRow(ws.workspaceId, offer.offer.id, second.id)],
    });
    await expect(updateOffer(db, update, [event])).resolves.toEqual({ ok: true });

    const stored = await getOffer(db, { workspaceId: ws.workspaceId, offerId: offer.offer.id });
    expect(stored).toMatchObject({
      name: "Pro Plus",
      gracePeriodDays: 14,
      version: 2,
      updatedAt: NOW,
    });
    expect(stored?.items.map((i) => i.externalItemId)).toEqual(["sim_new"]);
    expect(stored?.accesses.map((a) => a.resourceId)).toEqual([second.id]);
    expect(
      await getOfferVersion(db, {
        workspaceId: ws.workspaceId,
        offerId: offer.offer.id,
        version: 1,
      }),
    ).toEqual(offer.version);
    expect(
      await getOfferVersion(db, {
        workspaceId: ws.workspaceId,
        offerId: offer.offer.id,
        version: 2,
      }),
    ).toEqual(update.version);
    expect(await count("outbox", "id = ?", update.outbox[0]?.id)).toBe(1);
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });

  it("archives as a new version, keeping items and accesses", async () => {
    const ws = await commerceWorkspace();
    const offer = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: ws.resources.map((r) => r.id),
    });
    await updateOffer(
      db,
      change(offer, ws.userId, {
        set: { name: "Pro", gracePeriodDays: 7, status: "archived", updatedAt: NOW },
        items: offer.items,
        accesses: offer.accesses,
        outbox: [],
      }),
      [workspaceEvent(ws.workspaceId)],
    );
    const stored = await getOffer(db, { workspaceId: ws.workspaceId, offerId: offer.offer.id });
    expect(stored).toEqual({
      ...offer.offer,
      status: "archived",
      version: 2,
      updatedAt: NOW,
      items: offer.items,
      accesses: offer.accesses,
    });
  });

  it("writes nothing when another writer changed the offer first (stale)", async () => {
    const ws = await commerceWorkspace();
    const offer = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: ws.resources.map((r) => r.id),
    });
    // Both writers read version 1; the first one wins.
    const winner = change(offer, ws.userId);
    const loser = change(offer, ws.userId, {
      set: { name: "Loser", gracePeriodDays: 0, status: "archived", updatedAt: NOW + 1 },
      items: [offerItemRow(ws.workspaceId, offer.offer.id, { externalItemId: "sim_loser" })],
      accesses: [],
    });
    await expect(updateOffer(db, winner, [workspaceEvent(ws.workspaceId)])).resolves.toEqual({
      ok: true,
    });
    const event = workspaceEvent(ws.workspaceId);
    await expect(updateOffer(db, loser, [event])).resolves.toEqual({ ok: false, reason: "stale" });

    const stored = await getOffer(db, { workspaceId: ws.workspaceId, offerId: offer.offer.id });
    expect(stored).toMatchObject({ name: "Pro Plus", status: "active", version: 2 });
    expect(stored?.items.map((i) => i.externalItemId)).toEqual(["sim_new"]);
    expect(stored?.accesses).toEqual(offer.accesses);
    expect(await count("offer_versions", "id = ?", loser.version.id)).toBe(0);
    expect(await count("outbox", "id = ?", loser.outbox[0]?.id)).toBe(0);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("never writes through another workspace's key", async () => {
    const theirs = await commerceWorkspace();
    const mine = await commerceWorkspace();
    const offer = await seedOffer({
      workspaceId: theirs.workspaceId,
      userId: theirs.userId,
      resourceIds: theirs.resources.map((r) => r.id),
    });
    const update = change(offer, mine.userId, {
      workspaceId: mine.workspaceId,
      items: [],
      accesses: [],
      outbox: [],
    });
    const event = workspaceEvent(mine.workspaceId);
    await expect(
      updateOffer(
        db,
        { ...update, version: { ...update.version, workspaceId: mine.workspaceId } },
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    const stored = await getOffer(db, { workspaceId: theirs.workspaceId, offerId: offer.offer.id });
    expect(stored).toMatchObject({ name: "Pro", version: 1 });
    expect(stored?.items).toEqual(offer.items);
    expect(stored?.accesses).toEqual(offer.accesses);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("rejects a snapshot that is not version expectedVersion + 1 (programmer error)", async () => {
    const ws = await commerceWorkspace();
    const offer = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [],
    });
    const update = change(offer, ws.userId);
    await expect(
      updateOffer(db, { ...update, version: { ...update.version, version: 3 } }, [
        workspaceEvent(ws.workspaceId),
      ]),
    ).rejects.toThrow(/expectedVersion \+ 1/);
  });
});

describe("offer reads", () => {
  it("lists by name then ID, scoped to the workspace", async () => {
    const ws = await commerceWorkspace();
    const other = await commerceWorkspace();
    const zeta = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [],
      name: "Zeta",
    });
    const alpha = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [],
      name: "Alpha",
    });
    await seedOffer({ workspaceId: other.workspaceId, userId: other.userId, resourceIds: [] });
    const listed = await listOffers(db, ws.workspaceId);
    expect(listed.map((o) => o.id)).toEqual([alpha.offer.id, zeta.offer.id]);
    expect(listed[0]?.items).toEqual(alpha.items);
    expect(await listOffers(db, uniqueId("ws"))).toEqual([]);
  });

  it("returns null for a missing offer, an offer of another workspace, or a missing version", async () => {
    const ws = await commerceWorkspace();
    const other = await commerceWorkspace();
    const offer = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [],
    });
    expect(
      await getOffer(db, { workspaceId: ws.workspaceId, offerId: uniqueId("off") }),
    ).toBeNull();
    expect(
      await getOffer(db, { workspaceId: other.workspaceId, offerId: offer.offer.id }),
    ).toBeNull();
    expect(
      await getOfferVersion(db, {
        workspaceId: other.workspaceId,
        offerId: offer.offer.id,
        version: 1,
      }),
    ).toBeNull();
    expect(
      await getOfferVersion(db, {
        workspaceId: ws.workspaceId,
        offerId: offer.offer.id,
        version: 2,
      }),
    ).toBeNull();
  });

  it("lists offers by ID, ignoring IDs of other workspaces", async () => {
    const ws = await commerceWorkspace();
    const other = await commerceWorkspace();
    const a = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [],
      name: "B",
    });
    const b = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [],
      name: "A",
    });
    await seedOffer({ workspaceId: ws.workspaceId, userId: ws.userId, resourceIds: [], name: "C" });
    const theirs = await seedOffer({
      workspaceId: other.workspaceId,
      userId: other.userId,
      resourceIds: [],
    });
    const listed = await listOffersByIds(db, {
      workspaceId: ws.workspaceId,
      offerIds: [a.offer.id, b.offer.id, theirs.offer.id],
    });
    expect(listed.map((o) => o.id)).toEqual([b.offer.id, a.offer.id]);
    expect(await listOffersByIds(db, { workspaceId: ws.workspaceId, offerIds: [] })).toEqual([]);
  });

  it("finds offers selling any of the items, from the same source and workspace", async () => {
    const ws = await commerceWorkspace();
    const other = await commerceWorkspace();
    const one = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [],
      itemIds: ["sim_1", "sim_1b"],
      name: "One",
    });
    const two = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [],
      itemIds: ["sim_2"],
      name: "Two",
    });
    await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [],
      itemIds: ["sim_3"],
    });
    await seedOffer({
      workspaceId: other.workspaceId,
      userId: other.userId,
      resourceIds: [],
      itemIds: ["sim_1"],
    });
    const found = await findOffersForItems(db, {
      workspaceId: ws.workspaceId,
      source: "simulated",
      externalItemIds: ["sim_2", "sim_1", "sim_1b", "sim_unknown"],
    });
    expect(found.map((o) => o.id)).toEqual([one.offer.id, two.offer.id]);
    expect(found[0]?.items.map((i) => i.externalItemId)).toEqual(["sim_1", "sim_1b"]);
    expect(
      await findOffersForItems(db, {
        workspaceId: ws.workspaceId,
        source: "paddle",
        externalItemIds: ["sim_1"],
      }),
    ).toEqual([]);
    expect(
      await findOffersForItems(db, {
        workspaceId: ws.workspaceId,
        source: "simulated",
        externalItemIds: [],
      }),
    ).toEqual([]);
  });
});

describe("parameter limits", () => {
  // D1 binds at most 100 parameters per statement; these lists exceed it.
  it("lists more offers by ID than one statement can bind, by name", async () => {
    const ws = await commerceWorkspace();
    const seeded = [];
    for (let i = 0; i < 105; i += 1) {
      seeded.push(
        await seedOffer({
          workspaceId: ws.workspaceId,
          userId: ws.userId,
          resourceIds: [],
          // Two share a name, so the merge also orders by ID.
          name: i < 2 ? "Same" : `Offer ${String(200 - i).padStart(3, "0")}`,
        }),
      );
    }
    const ids = seeded.map((o) => o.offer.id);
    const expected = [...seeded]
      .sort((a, b) => (`${a.offer.name} ${a.offer.id}` < `${b.offer.name} ${b.offer.id}` ? -1 : 1))
      .map((o) => o.offer.id);
    const listed = await listOffersByIds(db, { workspaceId: ws.workspaceId, offerIds: ids });
    expect(listed.map((o) => o.id)).toEqual(expected);
    // Every offer has its own item, loaded through chunked lookups too.
    expect(listed.every((o) => o.items.length === 1)).toBe(true);
    // Listing the whole workspace loads every offer's configuration.
    expect((await listOffers(db, ws.workspaceId)).map((o) => o.items.length)).toEqual(
      Array(105).fill(1),
    );
  });

  it("finds offers for more items than one statement can bind", async () => {
    const ws = await commerceWorkspace();
    const many = Array.from({ length: 100 }, (_, i) => `sim_${String(i).padStart(3, "0")}`);
    const big = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [],
      itemIds: many,
      name: "Big",
    });
    const small = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [],
      itemIds: ["sim_small"],
      name: "Small",
    });
    const found = await findOffersForItems(db, {
      workspaceId: ws.workspaceId,
      source: "simulated",
      externalItemIds: [...many, "sim_small", "sim_unknown"],
    });
    // The big offer's items span two chunks, and it is listed once.
    expect(found.map((o) => o.id)).toEqual([big.offer.id, small.offer.id]);
    expect(found[0]?.items).toHaveLength(100);
  });
});

describe("listSubscriptionsForOffer", () => {
  const ended = (id: string) =>
    env.DB.prepare("UPDATE entitlements SET state = 'revoked', ended_at = ? WHERE id = ?")
      .bind(NOW, id)
      .run();
  const ids = async (ws: { workspaceId: string }, offerId: string) =>
    (await listSubscriptionsForOffer(db, { workspaceId: ws.workspaceId, offerId })).map(
      (row) => row.id,
    );

  it("finds a subscription carrying one of the offer's current items, with its refresh key", async () => {
    const ws = await subscribedWorkspace();
    await ended(ws.entitlement.id);
    expect(
      await listSubscriptionsForOffer(db, {
        workspaceId: ws.workspaceId,
        offerId: ws.offer.offer.id,
      }),
    ).toEqual([
      {
        id: ws.subscription.id,
        source: "simulated",
        externalSubscriptionId: ws.subscription.externalSubscriptionId,
      },
    ]);

    // The offer stops selling the item, and no live entitlement links them.
    await updateOffer(
      db,
      change(ws.offer, ws.userId, { items: [], accesses: ws.offer.accesses, outbox: [] }),
      [workspaceEvent(ws.workspaceId)],
    );
    expect(await ids(ws, ws.offer.offer.id)).toEqual([]);
  });

  it("finds a subscription holding a live entitlement from the offer without its item", async () => {
    // A `paddle` subscription does not carry the offer's `simulated` item of the same ID.
    const ws = await subscribedWorkspace({ subscription: { source: "paddle" } });
    expect(await ids(ws, ws.offer.offer.id)).toEqual([ws.subscription.id]);
    await ended(ws.entitlement.id);
    expect(await ids(ws, ws.offer.offer.id)).toEqual([]);
  });

  it("never lists subscriptions of another workspace", async () => {
    const mine = await subscribedWorkspace();
    const theirs = await subscribedWorkspace();
    expect(await ids(mine, theirs.offer.offer.id)).toEqual([]);
  });
});
