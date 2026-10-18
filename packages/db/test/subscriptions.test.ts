import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applySubscriptionRefresh,
  getCustomer,
  getSubscription,
  getSubscriptionByExternal,
  listEntitlementsForWorkspace,
  listLiveEntitlementsForSubscription,
  listLiveEntitlementsForWorkspace,
  type SubscriptionRefresh,
} from "../src/index.ts";
import { auditCount, workspaceEvent } from "./support/audit.ts";
import {
  customerRow,
  entitlementRow,
  outboxRow,
  seedOffer,
  seedSubject,
  subscribedWorkspace,
  subscriptionRow,
} from "./support/commerce.ts";
import { count, db } from "./support/connections.ts";
import { T0, uniqueId } from "./support/rows.ts";

const NOW = T0 + 1_000;

type Ws = Awaited<ReturnType<typeof subscribedWorkspace>>;

/** A refresh of the seeded subscription from version 1 that changes nothing but the version. */
function refresh(ws: Ws, overrides: Partial<SubscriptionRefresh> = {}): SubscriptionRefresh {
  return {
    workspaceId: ws.workspaceId,
    now: NOW,
    expectedVersion: 1,
    subscription: { ...ws.subscription, version: 2, updatedAt: NOW, lastObservedAt: NOW },
    items: [ws.item],
    offers: [{ offerId: ws.offer.offer.id, version: 1 }],
    entitlements: { create: [], update: [], end: [] },
    ...overrides,
  };
}

const entitlementState = (id: string) =>
  env.DB.prepare(
    "SELECT state, valid_until, decision_reason, ended_at FROM entitlements WHERE id = ?",
  )
    .bind(id)
    .first();

describe("applySubscriptionRefresh: new subscription", () => {
  it("records customer, subscription, items, entitlements, outbox and audit together", async () => {
    const ws = await subscribedWorkspace();
    expect(
      await getCustomer(db, { workspaceId: ws.workspaceId, customerId: ws.customer.id }),
    ).toEqual(ws.customer);
    expect(
      await getSubscription(db, {
        workspaceId: ws.workspaceId,
        subscriptionId: ws.subscription.id,
      }),
    ).toEqual({ ...ws.subscription, items: [ws.item] });
    expect(
      await listLiveEntitlementsForSubscription(db, {
        workspaceId: ws.workspaceId,
        subscriptionId: ws.subscription.id,
      }),
    ).toEqual([ws.entitlement]);
  });

  it("uses an existing customer, and writes outbox rows", async () => {
    const ws = await subscribedWorkspace();
    const subscription = subscriptionRow(ws.workspaceId, ws.customer.id);
    const outbox = outboxRow("refresh_subscription", subscription.id);
    const event = workspaceEvent(ws.workspaceId);
    await expect(
      applySubscriptionRefresh(
        db,
        {
          workspaceId: ws.workspaceId,
          now: NOW,
          expectedVersion: 0,
          subscription,
          items: ["sim_a", "sim_b"],
          offers: [],
          entitlements: { create: [], update: [], end: [] },
          outbox: [outbox],
        },
        [event],
      ),
    ).resolves.toEqual({ ok: true });
    expect(
      (await getSubscription(db, { workspaceId: ws.workspaceId, subscriptionId: subscription.id }))
        ?.items,
    ).toEqual(["sim_a", "sim_b"]);
    expect(await count("outbox", "id = ?", outbox.id)).toBe(1);
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });

  it("is stale when a concurrent writer recorded the same external subscription first", async () => {
    const ws = await subscribedWorkspace();
    const duplicate = subscriptionRow(ws.workspaceId, ws.customer.id, {
      externalSubscriptionId: ws.subscription.externalSubscriptionId,
    });
    const event = workspaceEvent(ws.workspaceId);
    const customer = customerRow(ws.workspaceId);
    await expect(
      applySubscriptionRefresh(
        db,
        {
          workspaceId: ws.workspaceId,
          now: NOW,
          expectedVersion: 0,
          customer,
          subscription: duplicate,
          items: ["sim_z"],
          offers: [],
          entitlements: { create: [], update: [], end: [] },
          outbox: [outboxRow("refresh_subscription", duplicate.id)],
        },
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    expect(await count("subscriptions", "id = ?", duplicate.id)).toBe(0);
    expect(await count("customers", "id = ?", customer.id)).toBe(0);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("is stale, writing nothing, when a concurrent writer created its customer under another ID", async () => {
    const ws = await subscribedWorkspace();
    // Same source and external customer ID as the stored customer, but a new row ID.
    const customer = customerRow(ws.workspaceId, {
      externalCustomerId: ws.customer.externalCustomerId,
    });
    const subscription = subscriptionRow(ws.workspaceId, customer.id);
    const outbox = outboxRow("refresh_subscription", subscription.id);
    const event = workspaceEvent(ws.workspaceId);
    await expect(
      applySubscriptionRefresh(
        db,
        {
          workspaceId: ws.workspaceId,
          now: NOW,
          expectedVersion: 0,
          customer,
          customerLink: { customerId: ws.customer.id, subjectId: null },
          subscription,
          items: ["sim_a"],
          offers: [],
          entitlements: { create: [], update: [], end: [] },
          outbox: [outbox],
        },
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    expect(await count("customers", "id = ?", customer.id)).toBe(0);
    expect(await count("subscriptions", "id = ?", subscription.id)).toBe(0);
    expect(await count("subscription_items", "subscription_id = ?", subscription.id)).toBe(0);
    expect(await count("outbox", "id = ?", outbox.id)).toBe(0);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
    expect(
      (await getCustomer(db, { workspaceId: ws.workspaceId, customerId: ws.customer.id }))
        ?.subjectId,
    ).toBe(ws.subject.id);
  });

  it("propagates other failures, such as an entitlement for another workspace's subject", async () => {
    const ws = await subscribedWorkspace();
    const other = await subscribedWorkspace();
    const subscription = subscriptionRow(ws.workspaceId, ws.customer.id);
    const event = workspaceEvent(ws.workspaceId);
    await expect(
      applySubscriptionRefresh(
        db,
        {
          workspaceId: ws.workspaceId,
          now: NOW,
          expectedVersion: 0,
          subscription,
          items: [],
          offers: [],
          entitlements: {
            create: [
              entitlementRow({
                workspaceId: ws.workspaceId,
                subjectId: other.subject.id,
                resourceId: ws.resource.id,
                subscriptionId: subscription.id,
                offerId: ws.offer.offer.id,
              }),
            ],
            update: [],
            end: [],
          },
        },
        [event],
      ),
    ).rejects.toThrow();
    expect(await count("subscriptions", "id = ?", subscription.id)).toBe(0);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });
});

describe("applySubscriptionRefresh: existing subscription", () => {
  it("applies the subscription, items, customer link and entitlement plan, and bumps the version", async () => {
    const ws = await subscribedWorkspace();
    const second = await seedSubject(ws.workspaceId);
    const replacement = entitlementRow(
      {
        workspaceId: ws.workspaceId,
        subjectId: second.id,
        resourceId: ws.resource.id,
        subscriptionId: ws.subscription.id,
        offerId: ws.offer.offer.id,
      },
      { validFrom: NOW, createdAt: NOW, updatedAt: NOW },
    );
    const outbox = outboxRow("refresh_subscription", ws.subscription.id);
    const event = workspaceEvent(ws.workspaceId);
    const subscription = {
      ...ws.subscription,
      state: "past_due" as const,
      providerState: "past_due",
      pastDueSince: NOW,
      sourceUpdatedAt: NOW,
      lastObservedAt: NOW,
      nextEvaluationAt: NOW + 7 * 86_400_000,
      version: 2,
      updatedAt: NOW,
    };
    await expect(
      applySubscriptionRefresh(
        db,
        refresh(ws, {
          customerLink: { customerId: ws.customer.id, subjectId: second.id },
          subscription,
          items: ["sim_other"],
          entitlements: {
            create: [replacement],
            update: [
              { id: ws.entitlement.id, set: { validUntil: NOW + 5, decisionReason: "past_due" } },
            ],
            end: [],
          },
          outbox: [outbox],
        }),
        [event],
      ),
    ).resolves.toEqual({ ok: true });

    expect(
      await getSubscription(db, {
        workspaceId: ws.workspaceId,
        subscriptionId: ws.subscription.id,
      }),
    ).toEqual({ ...subscription, items: ["sim_other"] });
    expect(
      await getCustomer(db, { workspaceId: ws.workspaceId, customerId: ws.customer.id }),
    ).toEqual({ ...ws.customer, subjectId: second.id, updatedAt: NOW });
    expect(
      await listLiveEntitlementsForSubscription(db, {
        workspaceId: ws.workspaceId,
        subscriptionId: ws.subscription.id,
      }),
    ).toEqual([
      { ...ws.entitlement, validUntil: NOW + 5, decisionReason: "past_due", updatedAt: NOW },
      replacement,
    ]);
    expect(await count("outbox", "id = ?", outbox.id)).toBe(1);
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });

  it("ends live entitlements with a reason, and a reactivation adds a new row", async () => {
    const ws = await subscribedWorkspace();
    await applySubscriptionRefresh(
      db,
      refresh(ws, {
        entitlements: {
          create: [],
          update: [],
          end: [{ id: ws.entitlement.id, state: "revoked", reason: "paused" }],
        },
      }),
      [workspaceEvent(ws.workspaceId)],
    );
    expect(await entitlementState(ws.entitlement.id)).toEqual({
      state: "revoked",
      valid_until: null,
      decision_reason: "paused",
      ended_at: NOW,
    });
    const reactivated = entitlementRow(
      {
        workspaceId: ws.workspaceId,
        subjectId: ws.subject.id,
        resourceId: ws.resource.id,
        subscriptionId: ws.subscription.id,
        offerId: ws.offer.offer.id,
      },
      { validFrom: NOW + 1, createdAt: NOW + 1, updatedAt: NOW + 1 },
    );
    await expect(
      applySubscriptionRefresh(
        db,
        {
          ...refresh(ws),
          expectedVersion: 2,
          subscription: { ...ws.subscription, version: 3, updatedAt: NOW + 1 },
          now: NOW + 1,
          entitlements: {
            create: [reactivated],
            update: [],
            // Ending an already ended row again changes nothing.
            end: [{ id: ws.entitlement.id, state: "expired", reason: "late" }],
          },
        },
        [workspaceEvent(ws.workspaceId)],
      ),
    ).resolves.toEqual({ ok: true });
    expect((await entitlementState(ws.entitlement.id))?.state).toBe("revoked");
    expect(
      (
        await listLiveEntitlementsForSubscription(db, {
          workspaceId: ws.workspaceId,
          subscriptionId: ws.subscription.id,
        })
      ).map((e) => e.id),
    ).toEqual([reactivated.id]);
  });

  it("moves the subscription to a new customer it creates", async () => {
    const ws = await subscribedWorkspace();
    const customer = customerRow(ws.workspaceId);
    await expect(
      applySubscriptionRefresh(
        db,
        refresh(ws, {
          customer,
          subscription: { ...ws.subscription, customerId: customer.id, version: 2, updatedAt: NOW },
        }),
        [workspaceEvent(ws.workspaceId)],
      ),
    ).resolves.toEqual({ ok: true });
    expect(
      (
        await getSubscription(db, {
          workspaceId: ws.workspaceId,
          subscriptionId: ws.subscription.id,
        })
      )?.customerId,
    ).toBe(customer.id);
  });

  it("writes nothing when another writer refreshed from the same version first (stale)", async () => {
    const ws = await subscribedWorkspace();
    await expect(
      applySubscriptionRefresh(db, refresh(ws), [workspaceEvent(ws.workspaceId)]),
    ).resolves.toEqual({ ok: true });

    // The loser read version 1 too, and would have written version 2 again.
    const customer = customerRow(ws.workspaceId);
    const outbox = outboxRow("refresh_subscription", ws.subscription.id);
    const event = workspaceEvent(ws.workspaceId);
    const created = entitlementRow(
      {
        workspaceId: ws.workspaceId,
        subjectId: (await seedSubject(ws.workspaceId)).id,
        resourceId: ws.resource.id,
        subscriptionId: ws.subscription.id,
        offerId: ws.offer.offer.id,
      },
      { validFrom: NOW, createdAt: NOW, updatedAt: NOW },
    );
    await expect(
      applySubscriptionRefresh(
        db,
        refresh(ws, {
          customer,
          customerLink: { customerId: ws.customer.id, subjectId: null },
          subscription: {
            ...ws.subscription,
            customerId: customer.id,
            state: "paused",
            version: 2,
            updatedAt: NOW,
          },
          items: ["sim_loser"],
          entitlements: {
            create: [created],
            update: [{ id: ws.entitlement.id, set: { decisionReason: "loser" } }],
            end: [{ id: ws.entitlement.id, state: "revoked", reason: "paused" }],
          },
          outbox: [outbox],
        }),
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "stale" });

    expect(
      await getSubscription(db, {
        workspaceId: ws.workspaceId,
        subscriptionId: ws.subscription.id,
      }),
    ).toMatchObject({ state: "active", customerId: ws.customer.id, version: 2, items: [ws.item] });
    expect(await count("customers", "id = ?", customer.id)).toBe(0);
    expect(
      (await getCustomer(db, { workspaceId: ws.workspaceId, customerId: ws.customer.id }))
        ?.subjectId,
    ).toBe(ws.subject.id);
    expect(await entitlementState(ws.entitlement.id)).toMatchObject({
      state: "active",
      decision_reason: "active",
    });
    expect(await count("entitlements", "id = ?", created.id)).toBe(0);
    expect(await count("outbox", "id = ?", outbox.id)).toBe(0);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("is stale when a concurrent writer created its new customer under another ID", async () => {
    const ws = await subscribedWorkspace();
    // A customer whose external ID already exists in this workspace under another row ID.
    const existing = customerRow(ws.workspaceId);
    await applySubscriptionRefresh(
      db,
      {
        workspaceId: ws.workspaceId,
        now: NOW,
        expectedVersion: 0,
        customer: existing,
        subscription: subscriptionRow(ws.workspaceId, existing.id),
        items: [],
        offers: [],
        entitlements: { create: [], update: [], end: [] },
      },
      [workspaceEvent(ws.workspaceId)],
    );
    const customer = customerRow(ws.workspaceId, {
      externalCustomerId: existing.externalCustomerId,
    });
    const event = workspaceEvent(ws.workspaceId);
    await expect(
      applySubscriptionRefresh(
        db,
        refresh(ws, {
          customer,
          subscription: { ...ws.subscription, customerId: customer.id, version: 2, updatedAt: NOW },
        }),
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    expect(await count("customers", "id = ?", customer.id)).toBe(0);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
    expect(
      (
        await getSubscription(db, {
          workspaceId: ws.workspaceId,
          subscriptionId: ws.subscription.id,
        })
      )?.version,
    ).toBe(1);
  });

  it("never touches entitlements of another subscription or workspace", async () => {
    const ws = await subscribedWorkspace();
    const other = await subscribedWorkspace();
    // A second subscription in the same workspace, with its own live entitlement.
    const sibling = subscriptionRow(ws.workspaceId, ws.customer.id);
    const siblingEntitlement = entitlementRow({
      workspaceId: ws.workspaceId,
      subjectId: ws.subject.id,
      resourceId: ws.resource.id,
      subscriptionId: sibling.id,
      offerId: ws.offer.offer.id,
    });
    await applySubscriptionRefresh(
      db,
      {
        workspaceId: ws.workspaceId,
        now: NOW,
        expectedVersion: 0,
        subscription: sibling,
        items: [],
        offers: [],
        entitlements: { create: [siblingEntitlement], update: [], end: [] },
      },
      [workspaceEvent(ws.workspaceId)],
    );
    await expect(
      applySubscriptionRefresh(
        db,
        refresh(ws, {
          entitlements: {
            create: [],
            update: [{ id: other.entitlement.id, set: { decisionReason: "hijack" } }],
            end: [
              { id: siblingEntitlement.id, state: "revoked", reason: "hijack" },
              { id: other.entitlement.id, state: "revoked", reason: "hijack" },
            ],
          },
        }),
        [workspaceEvent(ws.workspaceId)],
      ),
    ).resolves.toEqual({ ok: true });
    expect(await entitlementState(siblingEntitlement.id)).toMatchObject({ state: "active" });
    expect(await entitlementState(other.entitlement.id)).toMatchObject({
      state: "active",
      decision_reason: "active",
    });
  });

  it("is stale through another workspace's key, writing nothing", async () => {
    const theirs = await subscribedWorkspace();
    const mine = await subscribedWorkspace();
    const event = workspaceEvent(mine.workspaceId);
    await expect(
      applySubscriptionRefresh(
        db,
        {
          ...refresh(theirs),
          workspaceId: mine.workspaceId,
          subscription: {
            ...theirs.subscription,
            workspaceId: mine.workspaceId,
            state: "paused",
            version: 2,
          },
          entitlements: {
            create: [],
            update: [],
            end: [{ id: theirs.entitlement.id, state: "revoked", reason: "hijack" }],
          },
        },
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    expect(
      await getSubscription(db, {
        workspaceId: theirs.workspaceId,
        subscriptionId: theirs.subscription.id,
      }),
    ).toMatchObject({ state: "active", version: 1 });
    expect(await entitlementState(theirs.entitlement.id)).toMatchObject({ state: "active" });
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("propagates errors that are not a lost race", async () => {
    const ws = await subscribedWorkspace();
    // A second live entitlement for the same key breaks the partial unique index.
    const duplicate = entitlementRow({
      workspaceId: ws.workspaceId,
      subjectId: ws.subject.id,
      resourceId: ws.resource.id,
      subscriptionId: ws.subscription.id,
      offerId: ws.offer.offer.id,
    });
    const event = workspaceEvent(ws.workspaceId);
    await expect(
      applySubscriptionRefresh(
        db,
        refresh(ws, { entitlements: { create: [duplicate], update: [], end: [] } }),
        [event],
      ),
    ).rejects.toThrow();
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });
});

describe("applySubscriptionRefresh: offers changed since the read", () => {
  const bumpOffer = (offerId: string) =>
    env.DB.prepare("UPDATE offers SET version = version + 1 WHERE id = ?").bind(offerId).run();

  it("is stale, writing nothing, when an offer the plan used moved to another version", async () => {
    const ws = await subscribedWorkspace();
    await bumpOffer(ws.offer.offer.id);
    const customer = customerRow(ws.workspaceId);
    const outbox = outboxRow("refresh_subscription", ws.subscription.id);
    const event = workspaceEvent(ws.workspaceId);
    await expect(
      applySubscriptionRefresh(
        db,
        refresh(ws, {
          customer,
          subscription: { ...ws.subscription, customerId: customer.id, version: 2 },
          entitlements: {
            create: [],
            update: [],
            end: [{ id: ws.entitlement.id, state: "revoked", reason: "paused" }],
          },
          outbox: [outbox],
        }),
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    expect((await getSubscription(db, ws.subscriptionKey))?.version).toBe(1);
    expect(await count("customers", "id = ?", customer.id)).toBe(0);
    expect((await entitlementState(ws.entitlement.id))?.state).toBe("active");
    expect(await count("outbox", "id = ?", outbox.id)).toBe(0);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);

    // At the version it now has, the same write goes through.
    await expect(
      applySubscriptionRefresh(
        db,
        refresh(ws, { offers: [{ offerId: ws.offer.offer.id, version: 2 }] }),
        [workspaceEvent(ws.workspaceId)],
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("is stale when another offer started carrying one of the items", async () => {
    const ws = await subscribedWorkspace();
    const other = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [],
      itemIds: ["sim_new_offer"],
    });
    const items = [ws.item, "sim_new_offer"];
    await expect(
      applySubscriptionRefresh(db, refresh(ws, { items }), [workspaceEvent(ws.workspaceId)]),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    // The same item from another source is not the same commercial item.
    await env.DB.prepare("UPDATE offer_items SET source = 'paddle' WHERE offer_id = ?")
      .bind(other.offer.id)
      .run();
    await expect(
      applySubscriptionRefresh(db, refresh(ws, { items }), [workspaceEvent(ws.workspaceId)]),
    ).resolves.toEqual({ ok: true });
  });

  it("is stale for a new subscription, recording neither it nor its customer", async () => {
    const ws = await subscribedWorkspace();
    await bumpOffer(ws.offer.offer.id);
    const customer = customerRow(ws.workspaceId);
    const subscription = subscriptionRow(ws.workspaceId, customer.id);
    const event = workspaceEvent(ws.workspaceId);
    await expect(
      applySubscriptionRefresh(
        db,
        {
          workspaceId: ws.workspaceId,
          now: NOW,
          expectedVersion: 0,
          customer,
          subscription,
          items: [ws.item],
          offers: [{ offerId: ws.offer.offer.id, version: 1 }],
          entitlements: { create: [], update: [], end: [] },
        },
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    expect(await count("subscriptions", "id = ?", subscription.id)).toBe(0);
    expect(await count("customers", "id = ?", customer.id)).toBe(0);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("binds a fixed number of parameters however many items and offers the guard covers", async () => {
    const ws = await subscribedWorkspace();
    const items = [ws.item, ...Array.from({ length: 99 }, (_, i) => `sim_bulk_${i}`)];
    const extra = [];
    for (let i = 0; i < 3; i += 1) {
      extra.push(
        await seedOffer({ workspaceId: ws.workspaceId, userId: ws.userId, resourceIds: [] }),
      );
    }
    await expect(
      applySubscriptionRefresh(
        db,
        refresh(ws, {
          items,
          offers: [ws.offer, ...extra].map((o) => ({ offerId: o.offer.id, version: 1 })),
        }),
        [workspaceEvent(ws.workspaceId)],
      ),
    ).resolves.toEqual({ ok: true });
    expect((await getSubscription(db, ws.subscriptionKey))?.items).toHaveLength(100);
  });

  it("ends a live entitlement before creating its replacement under the same key", async () => {
    const ws = await subscribedWorkspace();
    const replacement = entitlementRow(
      {
        workspaceId: ws.workspaceId,
        subjectId: ws.subject.id,
        resourceId: ws.resource.id,
        subscriptionId: ws.subscription.id,
        offerId: ws.offer.offer.id,
      },
      { validFrom: NOW, createdAt: NOW, updatedAt: NOW },
    );
    await expect(
      applySubscriptionRefresh(
        db,
        refresh(ws, {
          entitlements: {
            create: [replacement],
            update: [],
            end: [{ id: ws.entitlement.id, state: "expired", reason: "cancellation_effective" }],
          },
        }),
        [workspaceEvent(ws.workspaceId)],
      ),
    ).resolves.toEqual({ ok: true });
    expect((await entitlementState(ws.entitlement.id))?.state).toBe("expired");
    expect(
      (await listLiveEntitlementsForSubscription(db, ws.subscriptionKey)).map((e) => e.id),
    ).toEqual([replacement.id]);
  });
});

describe("applySubscriptionRefresh: programmer errors", () => {
  const cases: [string, (ws: Ws) => Partial<SubscriptionRefresh>][] = [
    [
      "a subscription of another workspace",
      (ws) => ({
        subscription: { ...ws.subscription, workspaceId: uniqueId("ws"), version: 2 },
      }),
    ],
    [
      "a version other than expectedVersion + 1",
      (ws) => ({
        subscription: { ...ws.subscription, version: 3 },
      }),
    ],
    [
      "a customer of another workspace",
      (ws) => ({
        customer: customerRow(uniqueId("ws")),
        subscription: { ...ws.subscription, version: 2 },
      }),
    ],
    [
      "an entitlement of another subscription",
      (ws) => ({
        entitlements: {
          create: [
            entitlementRow({
              workspaceId: ws.workspaceId,
              subjectId: ws.subject.id,
              resourceId: ws.resource.id,
              subscriptionId: uniqueId("sbs"),
              offerId: ws.offer.offer.id,
            }),
          ],
          update: [],
          end: [],
        },
      }),
    ],
    [
      "an entitlement of another workspace",
      (ws) => ({
        entitlements: {
          create: [{ ...ws.entitlement, id: uniqueId("ent"), workspaceId: uniqueId("ws") }],
          update: [],
          end: [],
        },
      }),
    ],
  ];

  it.each(cases)("rejects %s before writing", async (_, overrides) => {
    const ws = await subscribedWorkspace();
    await expect(
      applySubscriptionRefresh(db, refresh(ws, overrides(ws)), [workspaceEvent(ws.workspaceId)]),
    ).rejects.toThrow(/must belong to the refreshed subscription/);
  });
});

describe("subscription and entitlement reads", () => {
  it("finds a subscription by external ID, scoped to the workspace and source", async () => {
    const ws = await subscribedWorkspace();
    const other = await subscribedWorkspace();
    const key = {
      workspaceId: ws.workspaceId,
      source: "simulated" as const,
      externalSubscriptionId: ws.subscription.externalSubscriptionId,
    };
    expect(await getSubscriptionByExternal(db, key)).toEqual({
      ...ws.subscription,
      items: [ws.item],
    });
    expect(await getSubscriptionByExternal(db, { ...key, source: "paddle" })).toBeNull();
    expect(
      await getSubscriptionByExternal(db, { ...key, workspaceId: other.workspaceId }),
    ).toBeNull();
    expect(
      await getSubscription(db, {
        workspaceId: other.workspaceId,
        subscriptionId: ws.subscription.id,
      }),
    ).toBeNull();
    expect(
      await listLiveEntitlementsForSubscription(db, {
        workspaceId: other.workspaceId,
        subscriptionId: ws.subscription.id,
      }),
    ).toEqual([]);
  });

  it("lists live entitlements by default, and ended ones on request", async () => {
    const ws = await subscribedWorkspace();
    await subscribedWorkspace();
    // End the first entitlement at NOW, then reactivate (a new live row).
    await applySubscriptionRefresh(
      db,
      refresh(ws, {
        entitlements: {
          create: [],
          update: [],
          end: [{ id: ws.entitlement.id, state: "expired", reason: "canceled" }],
        },
      }),
      [workspaceEvent(ws.workspaceId)],
    );
    const live = entitlementRow(
      {
        workspaceId: ws.workspaceId,
        subjectId: ws.subject.id,
        resourceId: ws.resource.id,
        subscriptionId: ws.subscription.id,
        offerId: ws.offer.offer.id,
      },
      { validFrom: NOW, createdAt: NOW, updatedAt: NOW },
    );
    await applySubscriptionRefresh(
      db,
      {
        ...refresh(ws),
        expectedVersion: 2,
        subscription: { ...ws.subscription, version: 3 },
        entitlements: { create: [live], update: [], end: [] },
      },
      [workspaceEvent(ws.workspaceId)],
    );
    const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
    expect(ids(await listLiveEntitlementsForWorkspace(db, ws.workspaceId))).toEqual([live.id]);
    expect(ids(await listEntitlementsForWorkspace(db, ws.workspaceId))).toEqual([live.id]);
    expect(
      ids(await listEntitlementsForWorkspace(db, ws.workspaceId, { includeEnded: true })),
    ).toEqual([ws.entitlement.id, live.id]);
    expect(
      ids(
        await listEntitlementsForWorkspace(db, ws.workspaceId, {
          includeEnded: true,
          endedSince: NOW,
        }),
      ),
    ).toEqual([ws.entitlement.id, live.id]);
    expect(
      ids(
        await listEntitlementsForWorkspace(db, ws.workspaceId, {
          includeEnded: true,
          endedSince: NOW + 1,
        }),
      ),
    ).toEqual([live.id]);
    expect(ids(await listEntitlementsForWorkspace(db, ws.workspaceId, { endedSince: 0 }))).toEqual([
      live.id,
    ]);
  });
});
