import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.ts";
import {
  customerRow,
  entitlementRow,
  newOffer,
  offerAccessRow,
  offerItemRow,
  simulatedRow,
  subjectRow,
  subscribedWorkspace,
  subscriptionRow,
} from "./support/commerce.ts";
import { db } from "./support/connections.ts";
import { T0, uniqueId } from "./support/rows.ts";

type Table = Parameters<typeof db.insert>[0];

/**
 * Inserts through D1 directly with the SQL Drizzle would run, so a failure surfaces SQLite's own
 * message (Drizzle wraps it in a message that quotes the statement).
 */
function insert<T extends Table>(table: T, row: T["$inferInsert"]) {
  const query = db.insert(table).values(row).toSQL();
  return env.DB.prepare(query.sql)
    .bind(...query.params)
    .run();
}

const ok = { success: true };
type Ws = Awaited<ReturnType<typeof subscribedWorkspace>>;

const entitlementFor = (ws: Ws, overrides: Parameters<typeof entitlementRow>[1] = {}) =>
  entitlementRow(
    {
      workspaceId: ws.workspaceId,
      subjectId: ws.subject.id,
      resourceId: ws.resource.id,
      subscriptionId: ws.subscription.id,
      offerId: ws.offer.offer.id,
    },
    overrides,
  );

const grantFor = (
  ws: Ws,
  overrides: Partial<typeof schema.grants.$inferInsert> = {},
): typeof schema.grants.$inferInsert => ({
  id: uniqueId("gra"),
  workspaceId: ws.workspaceId,
  connectionId: ws.connection.id,
  subjectId: ws.subject.id,
  resourceId: ws.resource.id,
  accessLevel: "write",
  state: "unknown",
  managed: true,
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

describe("offers constraints", () => {
  it.each([
    [0, true],
    [30, true],
    [-1, false],
    [31, false],
  ])("CHECK offers_grace_period_bounds with %d days", async (days, accepted) => {
    const ws = await subscribedWorkspace();
    const { offer } = newOffer({ workspaceId: ws.workspaceId, userId: ws.userId, resourceIds: [] });
    const result = insert(schema.offers, { ...offer, gracePeriodDays: days });
    if (accepted) await expect(result).resolves.toMatchObject(ok);
    else
      await expect(result).rejects.toThrow(/CHECK constraint failed: offers_grace_period_bounds/);
  });

  it("CHECK offers_status_valid rejects an unknown status", async () => {
    const ws = await subscribedWorkspace();
    const { offer } = newOffer({ workspaceId: ws.workspaceId, userId: ws.userId, resourceIds: [] });
    await expect(
      insert(schema.offers, { ...offer, status: "deleted" as "active" }),
    ).rejects.toThrow(/CHECK constraint failed: offers_status_valid/);
  });

  it("UNIQUE offer_items_item_unique maps an item to at most one offer per workspace", async () => {
    const ws = await subscribedWorkspace();
    const other = await subscribedWorkspace();
    await expect(
      insert(
        schema.offerItems,
        offerItemRow(ws.workspaceId, ws.offer.offer.id, { externalItemId: ws.item }),
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    // The same item ID in another workspace, or from another source, is a different item.
    await expect(
      insert(
        schema.offerItems,
        offerItemRow(other.workspaceId, other.offer.offer.id, { externalItemId: ws.item }),
      ),
    ).resolves.toMatchObject(ok);
    await expect(
      insert(
        schema.offerItems,
        offerItemRow(ws.workspaceId, ws.offer.offer.id, {
          externalItemId: ws.item,
          source: "paddle",
        }),
      ),
    ).resolves.toMatchObject(ok);
  });
});

describe("offer_versions append-only", () => {
  it("aborts UPDATE and DELETE", async () => {
    const ws = await subscribedWorkspace();
    const id = ws.offer.version.id;
    await expect(
      env.DB.prepare("UPDATE offer_versions SET snapshot = '{}' WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/offer_versions is append-only/);
    await expect(
      env.DB.prepare("DELETE FROM offer_versions WHERE id = ?").bind(id).run(),
    ).rejects.toThrow(/offer_versions is append-only/);
  });

  it("CHECK offer_versions_snapshot_json requires a JSON object", async () => {
    const ws = await subscribedWorkspace();
    for (const snapshot of ["[]", "not json"]) {
      await expect(
        insert(schema.offerVersions, {
          ...ws.offer.version,
          id: uniqueId("ofv"),
          version: 2,
          snapshot,
        }),
      ).rejects.toThrow(/CHECK constraint failed: offer_versions_snapshot_json/);
    }
  });
});

describe("subscriptions constraints", () => {
  const cases: [string, Partial<typeof schema.subscriptions.$inferSelect>, string | null][] = [
    ["past_due with past_due_since", { state: "past_due", pastDueSince: T0 }, null],
    [
      "past_due without past_due_since",
      { state: "past_due" },
      "subscriptions_past_due_since_iff_past_due",
    ],
    [
      "past_due_since while active",
      { pastDueSince: T0 },
      "subscriptions_past_due_since_iff_past_due",
    ],
    ["canceled with ended_at", { state: "canceled", endedAt: T0 }, null],
    ["expired with ended_at", { state: "expired", endedAt: T0 }, null],
    ["canceled without ended_at", { state: "canceled" }, "subscriptions_ended_at_iff_ended"],
    ["expired without ended_at", { state: "expired" }, "subscriptions_ended_at_iff_ended"],
    ["ended_at while paused", { state: "paused", endedAt: T0 }, "subscriptions_ended_at_iff_ended"],
    ["an unknown state", { state: "gone" as "active" }, "subscriptions_state_valid"],
  ];

  it.each(cases)("%s", async (_, overrides, check) => {
    const ws = await subscribedWorkspace();
    const result = insert(
      schema.subscriptions,
      subscriptionRow(ws.workspaceId, ws.customer.id, overrides),
    );
    if (check === null) await expect(result).resolves.toMatchObject(ok);
    else await expect(result).rejects.toThrow(new RegExp(`CHECK constraint failed: ${check}`));
  });
});

describe("entitlements constraints", () => {
  const cases: [string, Parameters<typeof entitlementRow>[1], string][] = [
    ["valid_until equal to valid_from", { validUntil: T0 }, "entitlements_interval_valid"],
    ["valid_until before valid_from", { validUntil: T0 - 1 }, "entitlements_interval_valid"],
    ["an active row with ended_at", { endedAt: T0 }, "entitlements_ended_iff_not_active"],
    ["an expired row without ended_at", { state: "expired" }, "entitlements_ended_iff_not_active"],
    ["an unknown state", { state: "pending" as "active", endedAt: T0 }, "entitlements_state_valid"],
    ["a policy version of 0", { policyVersion: 0 }, "entitlements_policy_version_positive"],
  ];

  it.each(cases)("CHECK rejects %s", async (_, overrides, check) => {
    const ws = await subscribedWorkspace();
    // Ended rows never collide with the live seeded row.
    await expect(insert(schema.entitlements, entitlementFor(ws, overrides))).rejects.toThrow(
      new RegExp(`CHECK constraint failed: ${check}`),
    );
  });

  it("partial UNIQUE entitlements_live_unique admits one live row per key, plus ended rows", async () => {
    const ws = await subscribedWorkspace();
    await expect(insert(schema.entitlements, entitlementFor(ws))).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    for (const state of ["expired", "revoked"] as const) {
      await expect(
        insert(schema.entitlements, entitlementFor(ws, { state, endedAt: T0 })),
      ).resolves.toMatchObject(ok);
    }
  });
});

describe("grants constraints", () => {
  const cases: [string, Partial<typeof schema.grants.$inferInsert>, string | null][] = [
    [
      "a classified error",
      { state: "error", lastErrorCode: "rate_limited", retryClass: "rate_limited" },
      null,
    ],
    [
      "an error without a code",
      { state: "error", retryClass: "retryable" },
      "grants_error_classified",
    ],
    [
      "an error without a retry class",
      { state: "error", lastErrorCode: "x" },
      "grants_error_classified",
    ],
    [
      "an error code outside the error state",
      { lastErrorCode: "x", retryClass: "terminal" },
      "grants_error_classified",
    ],
    ["an unknown state", { state: "granted" as "active" }, "grants_state_valid"],
    [
      "an unknown retry class",
      { state: "error", lastErrorCode: "x", retryClass: "later" as "terminal" },
      "grants_retry_class_valid",
    ],
  ];

  it.each(cases)("%s", async (_, overrides, check) => {
    const ws = await subscribedWorkspace();
    const result = insert(schema.grants, grantFor(ws, overrides));
    if (check === null) await expect(result).resolves.toMatchObject(ok);
    else await expect(result).rejects.toThrow(new RegExp(`CHECK constraint failed: ${check}`));
  });
});

describe("simulated_subscriptions constraints", () => {
  it.each(['{"a":1}', "nope"])(
    "CHECK simulated_subscriptions_items_json rejects %j",
    async (items) => {
      const ws = await subscribedWorkspace();
      await expect(
        insert(schema.simulatedSubscriptions, simulatedRow(ws.workspaceId, { items })),
      ).rejects.toThrow(/CHECK constraint failed: simulated_subscriptions_items_json/);
    },
  );
});

// Decision 0004: a row may only reference rows of its own workspace. Each case builds a row in
// workspace A that points at a row of workspace B.
describe("isolation/composite-fk-rejects-cross-tenant-link: entitlement core", () => {
  const cases: [string, (a: Ws, b: Ws) => Promise<unknown>][] = [
    [
      "offer_versions -> offers",
      (a, b) =>
        insert(schema.offerVersions, {
          ...a.offer.version,
          id: uniqueId("ofv"),
          offerId: b.offer.offer.id,
          version: 2,
        }),
    ],
    [
      "offer_items -> offers",
      (a, b) => insert(schema.offerItems, offerItemRow(a.workspaceId, b.offer.offer.id)),
    ],
    [
      "offer_accesses -> offers",
      (a, b) =>
        insert(
          schema.offerAccesses,
          offerAccessRow(a.workspaceId, b.offer.offer.id, a.resource.id),
        ),
    ],
    [
      "offer_accesses -> resources",
      async (a, b) => {
        const offer = newOffer({ workspaceId: a.workspaceId, userId: a.userId, resourceIds: [] });
        await insert(schema.offers, offer.offer);
        return insert(
          schema.offerAccesses,
          offerAccessRow(a.workspaceId, offer.offer.id, b.resource.id),
        );
      },
    ],
    [
      "customers -> subjects",
      (a, b) => insert(schema.customers, customerRow(a.workspaceId, { subjectId: b.subject.id })),
    ],
    [
      "subscriptions -> customers",
      (a, b) => insert(schema.subscriptions, subscriptionRow(a.workspaceId, b.customer.id)),
    ],
    [
      "subscription_items -> subscriptions",
      (a, b) =>
        insert(schema.subscriptionItems, {
          id: uniqueId("sit"),
          workspaceId: a.workspaceId,
          subscriptionId: b.subscription.id,
          externalItemId: "sim_x",
        }),
    ],
    [
      "entitlements -> subjects",
      (a, b) => insert(schema.entitlements, entitlementFor(a, { subjectId: b.subject.id })),
    ],
    [
      "entitlements -> resources",
      (a, b) => insert(schema.entitlements, entitlementFor(a, { resourceId: b.resource.id })),
    ],
    [
      "entitlements -> subscriptions",
      (a, b) => insert(schema.entitlements, entitlementFor(a, { sourceId: b.subscription.id })),
    ],
    [
      "entitlements -> offer_versions",
      (a, b) => insert(schema.entitlements, entitlementFor(a, { offerId: b.offer.offer.id })),
    ],
    [
      "grants -> connections",
      (a, b) => insert(schema.grants, grantFor(a, { connectionId: b.connection.id })),
    ],
    [
      "grants -> subjects",
      (a, b) => insert(schema.grants, grantFor(a, { subjectId: b.subject.id })),
    ],
    [
      "grants -> resources",
      (a, b) => insert(schema.grants, grantFor(a, { resourceId: b.resource.id })),
    ],
    [
      "grants -> entitlements",
      (a, b) => insert(schema.grants, grantFor(a, { entitlementId: b.entitlement.id })),
    ],
  ];

  it.each(cases)("%s", async (_, link) => {
    const a = await subscribedWorkspace();
    const b = await subscribedWorkspace();
    await expect(link(a, b)).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("accepts the same links within one workspace", async () => {
    const a = await subscribedWorkspace();
    await expect(
      insert(schema.grants, grantFor(a, { entitlementId: a.entitlement.id })),
    ).resolves.toMatchObject(ok);
    await expect(
      insert(schema.customers, customerRow(a.workspaceId, { subjectId: a.subject.id })),
    ).resolves.toMatchObject(ok);
    await expect(insert(schema.subjects, subjectRow(a.workspaceId))).resolves.toMatchObject(ok);
  });
});
