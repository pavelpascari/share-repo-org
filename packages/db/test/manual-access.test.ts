import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  appendAuditEvents,
  applyCustomerLink,
  applyManualAccessWrite,
  cancelWorkspaceDeletion,
  getCustomer,
  getManualAccess,
  listCustomerLinkPaths,
  listDueManualAccesses,
  listLiveEntitlementsForManualAccess,
  listManualAccesses,
  type ManualAccess,
  type ManualAccessWrite,
  markManualAccessesDue,
  type NewEntitlement,
  readAccessState,
  readSweepBacklog,
  readWorkspaceExport,
  scheduleWorkspaceDeletion,
  schema,
} from "../src/index.ts";
import { auditCount, workspaceEvent } from "./support/audit.ts";
import {
  asRead,
  commerceWorkspace,
  customerRow,
  entitlementRow,
  outboxRow,
  seedOffer,
  seedSubject,
  subscribedWorkspace,
} from "./support/commerce.ts";
import { db } from "./support/connections.ts";
import { T0, uniqueId } from "./support/rows.ts";

// Manual access storage (decision 0016).

const DAY = 86_400_000;
const NOW = T0 + DAY;

/** A workspace with a repository, an offer for it and a subject, but no manual access yet. */
async function grantableWorkspace() {
  const ws = await commerceWorkspace();
  const resource = ws.resources[0] as (typeof ws.resources)[number];
  const offer = await seedOffer({
    workspaceId: ws.workspaceId,
    userId: ws.userId,
    resourceIds: [resource.id],
  });
  const subject = await seedSubject(ws.workspaceId);
  return { ...ws, resource, offer, subject, offerRef: { offerId: offer.offer.id, version: 1 } };
}

type Grantable = Awaited<ReturnType<typeof grantableWorkspace>>;

function accessRow(ws: Grantable, overrides: Partial<ManualAccess> = {}): ManualAccess {
  return {
    id: uniqueId("ma"),
    workspaceId: ws.workspaceId,
    offerId: ws.offer.offer.id,
    subjectId: ws.subject.id,
    endsAt: NOW + 30 * DAY,
    note: "early buyer",
    revokedAt: null,
    revokeCause: null,
    nextEvaluationAt: NOW + 30 * DAY,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function manualEntitlement(
  ws: Grantable,
  access: ManualAccess,
  overrides: Partial<NewEntitlement> = {},
): NewEntitlement {
  return entitlementRow(
    {
      workspaceId: ws.workspaceId,
      subjectId: ws.subject.id,
      resourceId: ws.resource.id,
      subscriptionId: access.id,
      offerId: ws.offer.offer.id,
    },
    {
      sourceType: "manual",
      validFrom: NOW,
      validUntil: access.endsAt,
      decisionReason: "manual",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    },
  );
}

const reconcileRow = (ws: Grantable) =>
  outboxRow("reconcile_resource", `${ws.workspaceId}:${ws.resource.id}`, ws.workspaceId);

/** Creates the access with one entitlement for the workspace's repository. */
async function granted(ws: Grantable, overrides: Partial<ManualAccess> = {}) {
  const access = accessRow(ws, overrides);
  const entitlement = manualEntitlement(ws, access);
  const result = await applyManualAccessWrite(
    db,
    {
      workspaceId: ws.workspaceId,
      now: NOW,
      expectedVersion: 0,
      access,
      offer: ws.offerRef,
      openLimit: 100,
      entitlements: { create: [entitlement], update: [], end: [] },
      reconcile: [reconcileRow(ws)],
    },
    [workspaceEvent(ws.workspaceId)],
  );
  expect(result).toEqual({ ok: true });
  return { access, entitlement };
}

const count = async (table: string, where: string, ...values: unknown[]) =>
  (
    await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
      .bind(...values)
      .first<{ n: number }>()
  )?.n;

describe("manual_accesses constraints", () => {
  const insert = (row: ManualAccess) => db.insert(schema.manualAccesses).values(row);

  it("stores a valid open access", async () => {
    const ws = await grantableWorkspace();
    const row = accessRow(ws);
    await insert(row);
    await expect(getManualAccess(db, { workspaceId: ws.workspaceId, id: row.id })).resolves.toEqual(
      row,
    );
  });

  it.each([
    ["an end before creation", { endsAt: NOW }, "manual_accesses_ends_after_created"],
    ["an empty note", { note: "  " }, "manual_accesses_note_bounds"],
    ["a note over 500 characters", { note: "a".repeat(501) }, "manual_accesses_note_bounds"],
    [
      "an unknown revoke cause",
      { revokedAt: NOW, revokeCause: "expired" as never, nextEvaluationAt: null },
      "manual_accesses_revoke_cause_valid",
    ],
    [
      "a revocation without a cause",
      { revokedAt: NOW, nextEvaluationAt: null },
      "manual_accesses_revoked_pair",
    ],
    [
      "a cause without a revocation",
      { revokeCause: "owner" as const },
      "manual_accesses_revoked_pair",
    ],
    [
      "a revocation before creation",
      { revokedAt: NOW - 1, revokeCause: "owner" as const, nextEvaluationAt: null },
      "manual_accesses_revoked_pair",
    ],
    [
      "a revoked access still scheduled",
      { revokedAt: NOW, revokeCause: "owner" as const },
      "manual_accesses_revoked_not_scheduled",
    ],
    ["version 0", { version: 0 }, "manual_accesses_version_positive"],
    ["an update before creation", { updatedAt: NOW - 1 }, "manual_accesses_updated_after_created"],
  ])("rejects %s", async (_, overrides, constraint) => {
    const ws = await grantableWorkspace();
    await expect(insert(accessRow(ws, overrides))).rejects.toThrow();
    const error = await insert(accessRow(ws, overrides)).catch((e: unknown) => e);
    expect(String((error as { cause?: unknown }).cause ?? error)).toContain(constraint);
  });

  it("allows one open access per offer and subject, and another once it is revoked", async () => {
    const ws = await grantableWorkspace();
    await insert(
      accessRow(ws, { revokedAt: NOW, revokeCause: "owner", nextEvaluationAt: null, version: 2 }),
    );
    await insert(accessRow(ws));
    await expect(insert(accessRow(ws))).rejects.toThrow();
  });

  it("isolation/composite-fk-rejects-cross-tenant-link: refuses another workspace's offer or subject", async () => {
    const ws = await grantableWorkspace();
    const other = await grantableWorkspace();
    await expect(insert(accessRow(ws, { offerId: other.offer.offer.id }))).rejects.toThrow();
    await expect(insert(accessRow(ws, { subjectId: other.subject.id }))).rejects.toThrow();
  });
});

describe("entitlement sources", () => {
  it("name their source under its table's column, checked by a foreign key per source type", async () => {
    const ws = await grantableWorkspace();
    const { access, entitlement } = await granted(ws);
    const [row] = await listLiveEntitlementsForManualAccess(db, {
      workspaceId: ws.workspaceId,
      manualAccessId: access.id,
    });
    expect(row).toEqual(asRead(entitlement));
    expect(row).toMatchObject({ subscriptionId: null, manualAccessId: access.id });

    const orphan = manualEntitlement(ws, access, { id: uniqueId("ent"), sourceId: "ma_missing" });
    await expect(db.insert(schema.entitlements).values(orphan)).rejects.toThrow();
    // A manual access is not a subscription, and the reverse.
    await expect(
      db
        .insert(schema.entitlements)
        .values({ ...orphan, sourceId: access.id, sourceType: "subscription" }),
    ).rejects.toThrow();
  });

  it("isolation/composite-fk-rejects-cross-tenant-link: refuses another workspace's manual access", async () => {
    const ws = await grantableWorkspace();
    const other = await grantableWorkspace();
    const { access } = await granted(other);
    await expect(
      db.insert(schema.entitlements).values(manualEntitlement(ws, access, { id: uniqueId("ent") })),
    ).rejects.toThrow();
  });

  it("keeps a subscription's live entitlements apart from a manual access's", async () => {
    const ws = await subscribedWorkspace();
    await expect(
      listLiveEntitlementsForManualAccess(db, {
        workspaceId: ws.workspaceId,
        manualAccessId: ws.subscription.id,
      }),
    ).resolves.toEqual([]);
  });
});

describe("applyManualAccessWrite: a new access", () => {
  it("writes the access, its entitlements, reconcile requests and audit together", async () => {
    const ws = await grantableWorkspace();
    const event = workspaceEvent(ws.workspaceId);
    const access = accessRow(ws);
    const entitlement = manualEntitlement(ws, access);
    await expect(
      applyManualAccessWrite(
        db,
        {
          workspaceId: ws.workspaceId,
          now: NOW,
          expectedVersion: 0,
          access,
          offer: ws.offerRef,
          openLimit: 100,
          entitlements: { create: [entitlement], update: [], end: [] },
          reconcile: [reconcileRow(ws)],
        },
        [event],
      ),
    ).resolves.toEqual({ ok: true });
    expect(await getManualAccess(db, { workspaceId: ws.workspaceId, id: access.id })).toEqual(
      access,
    );
    expect(await count("entitlements", "source_id = ?", access.id)).toBe(1);
    expect(
      await count(
        "outbox",
        "kind = 'reconcile_resource' AND subject_id = ?",
        `${ws.workspaceId}:${ws.resource.id}`,
      ),
    ).toBe(1);
    expect(
      await count("resources", "id = ? AND reconcile_requested_at = ?", ws.resource.id, T0),
    ).toBe(1);
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });

  it("refuses a second open access to the same offer for the same subject, writing nothing", async () => {
    const ws = await grantableWorkspace();
    await granted(ws);
    const event = workspaceEvent(ws.workspaceId);
    const access = accessRow(ws);
    await expect(
      applyManualAccessWrite(
        db,
        {
          workspaceId: ws.workspaceId,
          now: NOW,
          expectedVersion: 0,
          access,
          offer: ws.offerRef,
          openLimit: 100,
          entitlements: { create: [], update: [], end: [] },
          reconcile: [],
        },
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "already_open" });
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("refuses a new access once the workspace has openLimit open ones; revoked ones do not count", async () => {
    const ws = await grantableWorkspace();
    await granted(ws);
    const second = await seedSubject(ws.workspaceId);
    const revoked = await seedSubject(ws.workspaceId);
    await db.insert(schema.manualAccesses).values(
      accessRow(ws, {
        subjectId: revoked.id,
        revokedAt: NOW,
        revokeCause: "owner",
        nextEvaluationAt: null,
      }),
    );
    const write = (limit: number): ManualAccessWrite => ({
      workspaceId: ws.workspaceId,
      now: NOW,
      expectedVersion: 0,
      access: accessRow(ws, { subjectId: second.id }),
      offer: ws.offerRef,
      openLimit: limit,
      entitlements: { create: [], update: [], end: [] },
      reconcile: [],
    });
    await expect(
      applyManualAccessWrite(db, write(1), [workspaceEvent(ws.workspaceId)]),
    ).resolves.toEqual({ ok: false, reason: "limit_reached" });
    await expect(
      applyManualAccessWrite(db, write(2), [workspaceEvent(ws.workspaceId)]),
    ).resolves.toEqual({ ok: true });
  });

  it("is stale, writing nothing, when the offer changed since it was read", async () => {
    const ws = await grantableWorkspace();
    const event = workspaceEvent(ws.workspaceId);
    const access = accessRow(ws);
    await expect(
      applyManualAccessWrite(
        db,
        {
          workspaceId: ws.workspaceId,
          now: NOW,
          expectedVersion: 0,
          access,
          offer: { ...ws.offerRef, version: 2 },
          openLimit: 100,
          entitlements: { create: [manualEntitlement(ws, access)], update: [], end: [] },
          reconcile: [reconcileRow(ws)],
        },
        [event],
      ),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    expect(await getManualAccess(db, { workspaceId: ws.workspaceId, id: access.id })).toBeNull();
    expect(await count("entitlements", "source_id = ?", access.id)).toBe(0);
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("propagates errors that are not a duplicate open access", async () => {
    const ws = await grantableWorkspace();
    const other = await grantableWorkspace();
    await expect(
      applyManualAccessWrite(
        db,
        {
          workspaceId: ws.workspaceId,
          now: NOW,
          expectedVersion: 0,
          access: accessRow(ws, { subjectId: other.subject.id }),
          offer: ws.offerRef,
          openLimit: 100,
          entitlements: { create: [], update: [], end: [] },
          reconcile: [],
        },
        [workspaceEvent(ws.workspaceId)],
      ),
    ).rejects.toThrow();
  });
});

describe("applyManualAccessWrite: an existing access", () => {
  it("applies the plan and bumps the version, once", async () => {
    const ws = await grantableWorkspace();
    const { access, entitlement } = await granted(ws);
    const updated = { ...access, endsAt: NOW + 60 * DAY, nextEvaluationAt: NOW + 60 * DAY };
    const write = (version: number): ManualAccessWrite => ({
      workspaceId: ws.workspaceId,
      now: NOW + 1,
      expectedVersion: version,
      access: { ...updated, version: version + 1, updatedAt: NOW + 1 },
      offer: ws.offerRef,
      entitlements: {
        create: [],
        update: [{ id: entitlement.id, set: { validUntil: NOW + 60 * DAY } }],
        end: [],
      },
      reconcile: [reconcileRow(ws)],
    });
    const event = workspaceEvent(ws.workspaceId);
    await expect(applyManualAccessWrite(db, write(1), [event])).resolves.toEqual({ ok: true });
    await expect(
      applyManualAccessWrite(db, write(1), [workspaceEvent(ws.workspaceId)]),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    expect(await getManualAccess(db, { workspaceId: ws.workspaceId, id: access.id })).toEqual({
      ...updated,
      version: 2,
      updatedAt: NOW + 1,
    });
    expect(
      await listLiveEntitlementsForManualAccess(db, {
        workspaceId: ws.workspaceId,
        manualAccessId: access.id,
      }),
    ).toEqual([asRead({ ...entitlement, validUntil: NOW + 60 * DAY, updatedAt: NOW + 1 })]);
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });

  it("ends entitlements of the access only, and is stale when its offer changed", async () => {
    const ws = await grantableWorkspace();
    const { access, entitlement } = await granted(ws);
    const subscribed = await subscribedWorkspace();
    const revoke = (offerVersion: number, id: string): ManualAccessWrite => ({
      workspaceId: ws.workspaceId,
      now: NOW + 1,
      expectedVersion: 1,
      access: {
        ...access,
        revokedAt: NOW + 1,
        revokeCause: "owner",
        nextEvaluationAt: null,
        version: 2,
        updatedAt: NOW + 1,
      },
      offer: { ...ws.offerRef, version: offerVersion },
      entitlements: {
        create: [],
        update: [],
        end: [{ id, state: "revoked", reason: "manual_revoked" }],
      },
      reconcile: [],
    });
    await expect(
      applyManualAccessWrite(db, revoke(2, entitlement.id), [workspaceEvent(ws.workspaceId)]),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    expect(await count("entitlements", "id = ? AND state = 'active'", entitlement.id)).toBe(1);
    // Another source's entitlement is out of reach, even by ID.
    await applyManualAccessWrite(db, revoke(1, subscribed.entitlement.id), [
      workspaceEvent(ws.workspaceId),
    ]);
    expect(
      await count("entitlements", "id = ? AND state = 'active'", subscribed.entitlement.id),
    ).toBe(1);
    expect(await count("entitlements", "id = ? AND state = 'active'", entitlement.id)).toBe(1);
  });

  it("propagates storage errors", async () => {
    const ws = await grantableWorkspace();
    const other = await grantableWorkspace();
    const { access } = await granted(ws);
    await expect(
      applyManualAccessWrite(
        db,
        {
          workspaceId: ws.workspaceId,
          now: NOW + 1,
          expectedVersion: 1,
          access: { ...access, version: 2, updatedAt: NOW + 1 },
          offer: ws.offerRef,
          entitlements: {
            create: [manualEntitlement(ws, access, { resourceId: other.resource.id })],
            update: [],
            end: [],
          },
          reconcile: [],
        },
        [workspaceEvent(ws.workspaceId)],
      ),
    ).rejects.toThrow();
  });
});

describe("applyManualAccessWrite: programmer errors", () => {
  it.each([
    ["an access of another workspace", { workspaceId: "ws_other" }],
    ["a version other than expectedVersion + 1", { version: 3 }],
  ])("rejects %s before writing", async (_, override) => {
    const ws = await grantableWorkspace();
    await expect(
      applyManualAccessWrite(
        db,
        {
          workspaceId: ws.workspaceId,
          now: NOW,
          expectedVersion: 0,
          access: accessRow(ws, override),
          offer: ws.offerRef,
          openLimit: 100,
          entitlements: { create: [], update: [], end: [] },
          reconcile: [],
        },
        [workspaceEvent(ws.workspaceId)],
      ),
    ).rejects.toThrow("applyManualAccessWrite: rows must belong to the manual access");
  });

  it.each([
    ["another offer", { offerId: "off_other" }, {}],
    ["no open limit when creating", {}, { openLimit: undefined }],
  ])("rejects %s", async (_, offerOverride, writeOverride) => {
    const ws = await grantableWorkspace();
    await expect(
      applyManualAccessWrite(
        db,
        {
          workspaceId: ws.workspaceId,
          now: NOW,
          expectedVersion: 0,
          access: accessRow(ws),
          offer: { ...ws.offerRef, ...offerOverride },
          openLimit: 100,
          entitlements: { create: [], update: [], end: [] },
          reconcile: [],
          ...writeOverride,
        },
        [workspaceEvent(ws.workspaceId)],
      ),
    ).rejects.toThrow("applyManualAccessWrite");
  });

  it.each([
    ["of another workspace", { workspaceId: "ws_other" }],
    ["of a subscription", { sourceType: "subscription" as const }],
    ["of another source", { sourceId: "ma_other" }],
    ["for another subject", { subjectId: "sub_other" }],
  ])("rejects an entitlement %s", async (_, overrides) => {
    const ws = await grantableWorkspace();
    const access = accessRow(ws);
    await expect(
      applyManualAccessWrite(
        db,
        {
          workspaceId: ws.workspaceId,
          now: NOW,
          expectedVersion: 0,
          access,
          offer: ws.offerRef,
          openLimit: 100,
          entitlements: {
            create: [manualEntitlement(ws, access, overrides)],
            update: [],
            end: [],
          },
          reconcile: [],
        },
        [workspaceEvent(ws.workspaceId)],
      ),
    ).rejects.toThrow("applyManualAccessWrite");
  });

  it("rejects a reconcile row of another workspace", async () => {
    const ws = await grantableWorkspace();
    await expect(
      applyManualAccessWrite(
        db,
        {
          workspaceId: ws.workspaceId,
          now: NOW,
          expectedVersion: 0,
          access: accessRow(ws),
          offer: ws.offerRef,
          openLimit: 100,
          entitlements: { create: [], update: [], end: [] },
          reconcile: [outboxRow("reconcile_resource", "ws_other:res", "ws_other")],
        },
        [workspaceEvent(ws.workspaceId)],
      ),
    ).rejects.toThrow("applyManualAccessWrite: expected reconcile_resource rows of the workspace");
  });
});

describe("manual access reads", () => {
  it("lists the workspace's accesses newest first, with offer, account and live entitlements", async () => {
    const ws = await grantableWorkspace();
    const first = await granted(ws);
    const second = await seedSubject(ws.workspaceId, { loginSnapshot: "hubot" });
    const later = accessRow(ws, { subjectId: second.id, createdAt: NOW + 1, updatedAt: NOW + 1 });
    await db.insert(schema.manualAccesses).values(later);
    const other = await grantableWorkspace();
    await granted(other);
    expect(await listManualAccesses(db, ws.workspaceId)).toEqual([
      {
        access: later,
        offerName: "Pro",
        subjectLogin: "hubot",
        subjectExternalId: second.externalSubjectId,
        liveEntitlements: 0,
      },
      {
        access: first.access,
        offerName: "Pro",
        subjectLogin: "monalisa",
        subjectExternalId: ws.subject.externalSubjectId,
        liveEntitlements: 1,
      },
    ]);
  });

  it("isolation/cross-workspace-read-denied: finds no access of another workspace", async () => {
    const ws = await grantableWorkspace();
    const other = await grantableWorkspace();
    const { access } = await granted(other);
    await expect(
      getManualAccess(db, { workspaceId: ws.workspaceId, id: access.id }),
    ).resolves.toBeNull();
    await expect(
      listLiveEntitlementsForManualAccess(db, {
        workspaceId: ws.workspaceId,
        manualAccessId: access.id,
      }),
    ).resolves.toEqual([]);
  });

  it("names a manual access as the source in the access view", async () => {
    const ws = await grantableWorkspace();
    const { entitlement } = await granted(ws);
    const state = await readAccessState(db, ws.workspaceId, { endedSince: T0 });
    expect(state.entitlements).toEqual([{ ...asRead(entitlement), source: "manual" }]);
  });

  it("exports the workspace's manual accesses and each entitlement's source", async () => {
    const ws = await grantableWorkspace();
    const { access, entitlement } = await granted(ws);
    const exported = await readWorkspaceExport(db, ws.workspaceId);
    expect(exported.manualAccesses).toEqual([
      {
        id: access.id,
        offerId: access.offerId,
        subjectId: access.subjectId,
        endsAt: access.endsAt,
        note: "early buyer",
        revokedAt: null,
        revokeCause: null,
        createdAt: NOW,
      },
    ]);
    expect(exported.entitlements).toEqual([
      expect.objectContaining({
        id: entitlement.id,
        sourceType: "manual",
        subscriptionId: null,
        manualAccessId: access.id,
      }),
    ]);
  });
});

describe("manual access timers", () => {
  it("lists due accesses across workspaces, oldest first, up to the limit", async () => {
    const ws = await grantableWorkspace();
    const other = await grantableWorkspace();
    // Far in the future, so other tests' rows in this file are never due before these.
    const at = NOW + 10_000 * DAY;
    const a = await granted(ws, { nextEvaluationAt: at + 2, endsAt: at + 2 });
    const b = await granted(other, { nextEvaluationAt: at + 1, endsAt: at + 1 });
    const due = await listDueManualAccesses(db, { now: at + 2, limit: 1_000 });
    const ours = due.filter((d) => d.id === a.access.id || d.id === b.access.id);
    expect(ours).toEqual([
      { workspaceId: other.workspaceId, id: b.access.id },
      { workspaceId: ws.workspaceId, id: a.access.id },
    ]);
    expect(
      (await listDueManualAccesses(db, { now: at + 1, limit: 1_000 })).map((d) => d.id),
    ).not.toContain(a.access.id);
    expect(await listDueManualAccesses(db, { now: at + 2, limit: 1 })).toHaveLength(1);
  });

  it("marks a workspace's open accesses due now, bumping their version; revoked ones stay", async () => {
    const ws = await grantableWorkspace();
    const { access } = await granted(ws);
    const revoked = accessRow(ws, {
      subjectId: (await seedSubject(ws.workspaceId)).id,
      revokedAt: NOW,
      revokeCause: "owner",
      nextEvaluationAt: null,
    });
    await db.insert(schema.manualAccesses).values(revoked);
    const other = await grantableWorkspace();
    const untouched = await granted(other);
    await expect(
      markManualAccessesDue(db, { workspaceId: ws.workspaceId, now: NOW + 5 }),
    ).resolves.toBe(1);
    expect(await getManualAccess(db, { workspaceId: ws.workspaceId, id: access.id })).toEqual({
      ...access,
      nextEvaluationAt: NOW + 5,
      version: 2,
      updatedAt: NOW + 5,
    });
    expect(await getManualAccess(db, { workspaceId: ws.workspaceId, id: revoked.id })).toEqual(
      revoked,
    );
    expect(
      await getManualAccess(db, { workspaceId: other.workspaceId, id: untouched.access.id }),
    ).toEqual(untouched.access);
  });

  it("marks one offer's accesses only, and never moves updated_at back", async () => {
    const ws = await grantableWorkspace();
    const { access } = await granted(ws);
    const second = await seedOffer({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      resourceIds: [ws.resource.id],
    });
    await expect(
      markManualAccessesDue(db, {
        workspaceId: ws.workspaceId,
        offerId: second.offer.id,
        now: NOW + 5,
      }),
    ).resolves.toBe(0);
    await expect(
      markManualAccessesDue(db, {
        workspaceId: ws.workspaceId,
        offerId: access.offerId,
        now: NOW - 5,
      }),
    ).resolves.toBe(1);
    expect(await getManualAccess(db, { workspaceId: ws.workspaceId, id: access.id })).toEqual({
      ...access,
      nextEvaluationAt: NOW - 5,
      version: 2,
    });
  });

  it("counts a due manual access in the sweep's evaluation backlog", async () => {
    const ws = await grantableWorkspace();
    // Before anything else in this file's database is due.
    const due = T0 - 10_000 * DAY;
    await db.insert(schema.manualAccesses).values(
      accessRow(ws, {
        createdAt: due - 1,
        updatedAt: due - 1,
        endsAt: due,
        nextEvaluationAt: due,
      }),
    );
    const backlog = await readSweepBacklog(db, { now: due, maxAttempts: 10 });
    expect(backlog.evaluationDueAt).toBe(due);
    const subscribed = await subscribedWorkspace({
      subscription: { nextEvaluationAt: due - 1 },
    });
    expect(subscribed.subscription.nextEvaluationAt).toBe(due - 1);
    await expect(readSweepBacklog(db, { now: due, maxAttempts: 10 })).resolves.toMatchObject({
      evaluationDueAt: due - 1,
    });
  });
});

describe("workspace deletion and manual access", () => {
  it("a deletion and its cancellation each make the open accesses due, in their batch", async () => {
    const ws = await grantableWorkspace();
    const { access } = await granted(ws);
    const schedule = (now: number) =>
      scheduleWorkspaceDeletion(
        db,
        { workspaceId: ws.workspaceId, requestedBy: ws.userId, now, deleteAfter: NOW + DAY },
        [workspaceEvent(ws.workspaceId)],
      );
    const read = () => getManualAccess(db, { workspaceId: ws.workspaceId, id: access.id });
    await expect(schedule(NOW + 1)).resolves.toEqual({ ok: true });
    expect(await read()).toMatchObject({ nextEvaluationAt: NOW + 1, version: 2 });
    // Not active any more: a second request changes nothing.
    await expect(schedule(NOW + 2)).resolves.toEqual({ ok: false });
    expect(await read()).toMatchObject({ nextEvaluationAt: NOW + 1, version: 2 });
    await expect(
      cancelWorkspaceDeletion(db, { workspaceId: ws.workspaceId, now: NOW + 3, sources: [] }, [
        workspaceEvent(ws.workspaceId),
      ]),
    ).resolves.toEqual({ ok: true });
    expect(await read()).toMatchObject({ nextEvaluationAt: NOW + 3, version: 3 });
  });
});

describe("customer links (decision 0016)", () => {
  it("unlinks a customer with a null subject, guarded on its current link", async () => {
    const ws = await subscribedWorkspace();
    const key = { workspaceId: ws.workspaceId, customerId: ws.customer.id };
    const unlink = () =>
      applyCustomerLink(
        db,
        {
          ...key,
          expectedSubjectId: ws.subject.id,
          subjectId: null,
          now: NOW,
          makeRefreshRow: (subscription) =>
            outboxRow(
              "refresh_subscription",
              `${ws.workspaceId}:${subscription.source}:${subscription.externalSubscriptionId}`,
              ws.workspaceId,
            ),
        },
        [workspaceEvent(ws.workspaceId)],
      );
    await expect(unlink()).resolves.toEqual({ ok: true });
    expect(await getCustomer(db, key)).toMatchObject({ subjectId: null, updatedAt: NOW });
    await expect(unlink()).resolves.toEqual({ ok: false, reason: "stale" });
  });

  it("reads how each customer was last linked from its audit events", async () => {
    const ws = await commerceWorkspace();
    const rows = Array.from({ length: 6 }, () => customerRow(ws.workspaceId));
    for (const row of rows) await db.insert(schema.customers).values(row);
    const [checkout, email, manual, source, unlinked, removed] = rows.map((c) => c.id) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const event = (action: string, targetId: string, details: object, at = NOW) =>
      workspaceEvent(ws.workspaceId, {
        action,
        target: { type: "customer", id: targetId },
        details: details as Record<string, unknown>,
        occurredAt: at,
      });
    await appendAuditEvents(db, [
      event("customer.linked", checkout, { previousSubjectId: null, subjectId: "s1" }),
      event("claim.completed", checkout, { path: "checkout" }, NOW + 1),
      event("claim.completed", email, { path: "email" }),
      event("customer.relinked", email, { path: "email" }, NOW + 1),
      event("claim.completed", manual, { path: "checkout" }),
      event("customer.linked_manually", manual, {}, NOW + 1),
      event("customer.linked", source, { previousSubjectId: null, subjectId: "s1" }),
      event("claim.completed", unlinked, { path: "checkout" }),
      event("customer.linked", unlinked, { previousSubjectId: "s1", subjectId: null }, NOW + 1),
      event("claim.completed", removed, { path: "email" }),
      event("customer.unlinked_manually", removed, {}, NOW + 1),
      event("claim.rejected", source, { path: "checkout" }, NOW + 2),
    ]);
    const other = await commerceWorkspace();
    await appendAuditEvents(db, [
      workspaceEvent(other.workspaceId, {
        action: "customer.linked_manually",
        target: { type: "customer", id: source },
      }),
    ]);
    expect(await listCustomerLinkPaths(db, ws.workspaceId)).toEqual(
      new Map([
        [checkout, "checkout"],
        [email, "email"],
        [manual, "manual"],
        [source, "source"],
      ]),
    );
  });
});
