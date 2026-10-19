import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  applyResourceSync,
  applySubscriptionRefresh,
  claimDueReconciles,
  type NewOutboxRow,
  reconcileKey,
  reconcileKeyOfRow,
  type SubscriptionRefresh,
  schema,
} from "../src/index.ts";
import { workspaceEvent } from "./support/audit.ts";
import {
  commerceWorkspace,
  outboxRow,
  seedSubject,
  subscribedWorkspace,
} from "./support/commerce.ts";
import { count, db } from "./support/connections.ts";
import { grantRow, leasedWorkspace, reconcileRow, seedGrant } from "./support/reconcile.ts";
import { T0 } from "./support/rows.ts";

const NOW = T0 + 10 * 365 * 86_400_000;

type Ws = Awaited<ReturnType<typeof subscribedWorkspace>>;

const queued = (workspaceId: string, resourceId: string, where = "1") =>
  count(
    "outbox",
    `kind = 'reconcile_resource' AND subject_id = ? AND ${where}`,
    reconcileKey(workspaceId, resourceId),
  );

const nextReconcile = async (id: string) =>
  (
    await env.DB.prepare("SELECT next_reconcile_at AS n FROM resources WHERE id = ?")
      .bind(id)
      .first<{ n: number | null }>()
  )?.n;

const makeOutboxRow = (resource: { workspaceId: string; id: string }) =>
  reconcileRow(resource.workspaceId, resource.id);

/** Queues every resource the repair path would pick up, so a test starts from a quiet sweep. */
async function quiet() {
  await claimDueReconciles(db, { now: T0 - 1, limit: 10_000, makeOutboxRow });
}

const failAll = (workspaceId: string, resourceId: string) =>
  env.DB.prepare(
    "UPDATE outbox SET failed_at = ?, last_error_code = 'internal_error' WHERE kind = 'reconcile_resource' AND subject_id = ?",
  )
    .bind(NOW, reconcileKey(workspaceId, resourceId))
    .run();

describe("reconcile outbox key", () => {
  it("matches its SQL form over resources", async () => {
    const ws = await commerceWorkspace();
    const resource = ws.resources[0] as (typeof ws.resources)[number];
    const [row] = await db
      .select({ key: reconcileKeyOfRow })
      .from(schema.resources)
      .where(eq(schema.resources.id, resource.id));
    expect(row?.key).toBe(reconcileKey(ws.workspaceId, resource.id));
  });
});

describe("applySubscriptionRefresh: reconcile rows", () => {
  function refresh(ws: Ws, reconcile: NewOutboxRow[], expectedVersion = 1): SubscriptionRefresh {
    return {
      workspaceId: ws.workspaceId,
      now: NOW,
      expectedVersion,
      subscription: { ...ws.subscription, version: expectedVersion + 1, updatedAt: NOW },
      items: [ws.item],
      offers: [{ offerId: ws.offer.offer.id, version: 1 }],
      entitlements: { create: [], update: [], end: [] },
      reconcile,
    };
  }

  it("queues each touched resource once, in the same batch, deduplicated", async () => {
    const ws = await subscribedWorkspace();
    const rows = [
      reconcileRow(ws.workspaceId, ws.resource.id),
      reconcileRow(ws.workspaceId, ws.resource.id),
    ];
    await expect(
      applySubscriptionRefresh(db, refresh(ws, rows), [workspaceEvent(ws.workspaceId)]),
    ).resolves.toEqual({ ok: true });
    expect(await queued(ws.workspaceId, ws.resource.id)).toBe(1);

    // Pending: a later refresh does not queue it again.
    await applySubscriptionRefresh(
      db,
      refresh(ws, [reconcileRow(ws.workspaceId, ws.resource.id)], 2),
      [workspaceEvent(ws.workspaceId)],
    );
    expect(await queued(ws.workspaceId, ws.resource.id)).toBe(1);

    // Sent or failed rows do not count.
    await env.DB.prepare(
      "UPDATE outbox SET sent_at = ? WHERE kind = 'reconcile_resource' AND subject_id = ?",
    )
      .bind(NOW, reconcileKey(ws.workspaceId, ws.resource.id))
      .run();
    await applySubscriptionRefresh(
      db,
      refresh(ws, [reconcileRow(ws.workspaceId, ws.resource.id)], 3),
      [workspaceEvent(ws.workspaceId)],
    );
    expect(await queued(ws.workspaceId, ws.resource.id)).toBe(2);
    await failAll(ws.workspaceId, ws.resource.id);
    await applySubscriptionRefresh(
      db,
      refresh(ws, [reconcileRow(ws.workspaceId, ws.resource.id)], 4),
      [workspaceEvent(ws.workspaceId)],
    );
    expect(await queued(ws.workspaceId, ws.resource.id, "failed_at IS NULL")).toBe(1);
  });

  it("queues nothing when the refresh is stale", async () => {
    const ws = await subscribedWorkspace();
    await expect(
      applySubscriptionRefresh(db, refresh(ws, [reconcileRow(ws.workspaceId, ws.resource.id)], 7), [
        workspaceEvent(ws.workspaceId),
      ]),
    ).resolves.toEqual({ ok: false, reason: "stale" });
    expect(await queued(ws.workspaceId, ws.resource.id)).toBe(0);
  });

  it("rejects a reconcile row of another kind or workspace", async () => {
    const ws = await subscribedWorkspace();
    for (const row of [
      outboxRow("refresh_subscription", reconcileKey(ws.workspaceId, ws.resource.id)),
      reconcileRow("ws_other", ws.resource.id),
    ]) {
      await expect(
        applySubscriptionRefresh(db, refresh(ws, [row]), [workspaceEvent(ws.workspaceId)]),
      ).rejects.toThrow(/applySubscriptionRefresh/);
    }
  });
});

describe("applyResourceSync: reconcile rows", () => {
  async function sync(ws: Ws, expectedVersion: number, reconcile: NewOutboxRow[]) {
    return applyResourceSync(
      db,
      {
        workspaceId: ws.workspaceId,
        connectionId: ws.connection.id,
        now: NOW,
        expectedVersion,
        syncToken: crypto.randomUUID(),
        inserts: [],
        updates: [{ id: ws.resource.id, set: { selection: "removed" } }],
        connection: {},
        reconcile,
      },
      [workspaceEvent(ws.workspaceId)],
    );
  }

  it("queues the changed resources, deduplicated, only when the resync wins", async () => {
    const ws = await subscribedWorkspace();
    await expect(
      sync(ws, 0, [
        reconcileRow(ws.workspaceId, ws.resource.id),
        reconcileRow(ws.workspaceId, ws.resource.id),
      ]),
    ).resolves.toEqual({ ok: true });
    expect(await queued(ws.workspaceId, ws.resource.id)).toBe(1);
    await failAll(ws.workspaceId, ws.resource.id);
    await expect(sync(ws, 0, [reconcileRow(ws.workspaceId, ws.resource.id)])).resolves.toEqual({
      ok: false,
      reason: "stale",
    });
    expect(await queued(ws.workspaceId, ws.resource.id, "failed_at IS NULL")).toBe(0);
  });

  it("rejects a reconcile row of another kind or workspace", async () => {
    const ws = await subscribedWorkspace();
    for (const row of [
      outboxRow("resync_connection", reconcileKey(ws.workspaceId, ws.resource.id)),
      reconcileRow("ws_other", ws.resource.id),
    ]) {
      await expect(sync(ws, 0, [row])).rejects.toThrow(/applyResourceSync/);
    }
  });
});

describe("claimDueReconciles", () => {
  async function scheduled(nextReconcileAt: number | null) {
    const ws = await commerceWorkspace();
    const resource = ws.resources[0] as (typeof ws.resources)[number];
    await env.DB.prepare("UPDATE resources SET next_reconcile_at = ? WHERE id = ?")
      .bind(nextReconcileAt, resource.id)
      .run();
    return { workspaceId: ws.workspaceId, id: resource.id };
  }

  it("queues each due resource in any workspace and clears its schedule, once", async () => {
    await quiet();
    const at = NOW + 1_000;
    const due = await scheduled(at - 10);
    const exactlyDue = await scheduled(at);
    const notDue = await scheduled(NOW + 1e9);
    const made: string[] = [];
    const recording = (resource: { workspaceId: string; id: string }) => {
      made.push(resource.id);
      return makeOutboxRow(resource);
    };
    await expect(
      claimDueReconciles(db, { now: at, limit: 10, makeOutboxRow: recording }),
    ).resolves.toBe(2);
    expect(made).toEqual([due.id, exactlyDue.id]);
    for (const r of [due, exactlyDue]) {
      expect(await nextReconcile(r.id)).toBeNull();
      expect(await queued(r.workspaceId, r.id)).toBe(1);
    }
    expect(await nextReconcile(notDue.id)).toBe(NOW + 1e9);
    expect(await queued(notDue.workspaceId, notDue.id)).toBe(0);
    await expect(claimDueReconciles(db, { now: at, limit: 10, makeOutboxRow })).resolves.toBe(0);
  });

  it("clears a due schedule without queueing twice when a reconcile is pending", async () => {
    await quiet();
    const at = NOW + 2_000;
    const r = await scheduled(at);
    await db.insert(schema.outbox).values({
      ...reconcileRow(r.workspaceId, r.id),
      attempts: 0,
      sentAt: null,
      failedAt: null,
      lastErrorCode: null,
    });
    await expect(claimDueReconciles(db, { now: at, limit: 10, makeOutboxRow })).resolves.toBe(0);
    expect(await nextReconcile(r.id)).toBeNull();
    expect(await queued(r.workspaceId, r.id)).toBe(1);
  });

  it("does not queue a resource whose schedule changed after the sweep read it", async () => {
    await quiet();
    const at = NOW + 3_000;
    const r = await scheduled(at);
    const races: Promise<unknown>[] = [];
    await expect(
      claimDueReconciles(db, {
        now: at,
        limit: 10,
        makeOutboxRow: (resource) => {
          races.push(
            env.DB.prepare("UPDATE resources SET next_reconcile_at = ? WHERE id = ?")
              .bind(NOW + 9e9, resource.id)
              .run(),
          );
          return makeOutboxRow(resource);
        },
      }),
    ).resolves.toBe(0);
    await Promise.all(races);
    expect(await nextReconcile(r.id)).toBe(NOW + 9e9);
    expect(await queued(r.workspaceId, r.id)).toBe(0);
  });

  it("repairs unscheduled resources with access to converge, once while pending", async () => {
    await quiet();
    const at = NOW + 4_000;
    const entitled = await subscribedWorkspace();
    const leased = await leasedWorkspace(at);
    const expiredLease = await leasedWorkspace(at - 120_000);
    const bare = await commerceWorkspace();
    const bareResource = bare.resources[0] as (typeof bare.resources)[number];
    const granted = await commerceWorkspace();
    const grantedResource = granted.resources[0] as (typeof granted.resources)[number];
    const absent = await commerceWorkspace();
    const absentResource = absent.resources[0] as (typeof absent.resources)[number];
    for (const [ws, resource, state] of [
      [granted, grantedResource, "active"],
      [absent, absentResource, "absent"],
    ] as const) {
      const subject = await seedSubject(ws.workspaceId);
      await seedGrant(
        grantRow(
          {
            workspaceId: ws.workspaceId,
            connectionId: ws.connection.id,
            subjectId: subject.id,
            resourceId: resource.id,
          },
          { state },
        ),
      );
    }

    await expect(claimDueReconciles(db, { now: at, limit: 100, makeOutboxRow })).resolves.toBe(3);
    expect(await queued(entitled.workspaceId, entitled.resource.id)).toBe(1);
    expect(await queued(expiredLease.workspaceId, expiredLease.resource.id)).toBe(1);
    expect(await queued(granted.workspaceId, grantedResource.id)).toBe(1);
    expect(await queued(leased.workspaceId, leased.resource.id)).toBe(0);
    expect(await queued(bare.workspaceId, bareResource.id)).toBe(0);
    expect(await queued(absent.workspaceId, absentResource.id)).toBe(0);

    await expect(claimDueReconciles(db, { now: at, limit: 100, makeOutboxRow })).resolves.toBe(0);
    // The run failed for good: the next sweep repairs it with a new row.
    await failAll(entitled.workspaceId, entitled.resource.id);
    await expect(claimDueReconciles(db, { now: at, limit: 100, makeOutboxRow })).resolves.toBe(1);
    expect(await queued(entitled.workspaceId, entitled.resource.id, "failed_at IS NULL")).toBe(1);
  });

  it("claims due resources first and repairs within what is left of the limit", async () => {
    await quiet();
    const at = NOW + 5_000;
    const due = await scheduled(at);
    const first = await subscribedWorkspace();
    const second = await subscribedWorkspace();
    await expect(claimDueReconciles(db, { now: at, limit: 2, makeOutboxRow })).resolves.toBe(2);
    expect(await queued(due.workspaceId, due.id)).toBe(1);
    const repaired =
      (await queued(first.workspaceId, first.resource.id)) +
      (await queued(second.workspaceId, second.resource.id));
    expect(repaired).toBe(1);
    await expect(claimDueReconciles(db, { now: at, limit: 1, makeOutboxRow })).resolves.toBe(1);
    expect(await queued(first.workspaceId, first.resource.id)).toBe(1);
    expect(await queued(second.workspaceId, second.resource.id)).toBe(1);
  });

  it("does not look for repairs when due resources fill the limit", async () => {
    await quiet();
    const at = NOW + 6_000;
    const due = await scheduled(at);
    const repairable = await subscribedWorkspace();
    await expect(claimDueReconciles(db, { now: at, limit: 1, makeOutboxRow })).resolves.toBe(1);
    expect(await queued(due.workspaceId, due.id)).toBe(1);
    expect(await queued(repairable.workspaceId, repairable.resource.id)).toBe(0);
  });

  it("does not repair a resource queued after the sweep read it", async () => {
    await quiet();
    const ws = await subscribedWorkspace();
    const races: Promise<unknown>[] = [];
    await expect(
      claimDueReconciles(db, {
        now: NOW,
        limit: 10,
        makeOutboxRow: (resource) => {
          const row = makeOutboxRow(resource);
          races.push(
            env.DB.prepare(
              "INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts) VALUES (?, 'reconcile_resource', ?, 0, 0, 0)",
            )
              .bind(`${row.id}-race`, row.subjectId)
              .run(),
          );
          return row;
        },
      }),
    ).resolves.toBe(0);
    await Promise.all(races);
    expect(await queued(ws.workspaceId, ws.resource.id)).toBe(1);
  });

  it("returns 0 without writing when nothing is due or to repair", async () => {
    await quiet();
    await expect(
      claimDueReconciles(db, {
        now: T0 - 1,
        limit: 10,
        makeOutboxRow: () => {
          throw new Error("not called");
        },
      }),
    ).resolves.toBe(0);
  });
});
