import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  applyResourceSync,
  applySubscriptionRefresh,
  claimDueReconciles,
  claimReconcileLease,
  enqueueReconcile,
  type NewOutboxRow,
  reconcileKey,
  reconcileKeyOfRow,
  releaseReconcileLease,
  requestReconcile,
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

const requestedAt = async (id: string) =>
  (
    await env.DB.prepare("SELECT reconcile_requested_at AS r FROM resources WHERE id = ?")
      .bind(id)
      .first<{ r: number | null }>()
  )?.r;

/** A reconcile row created at `at`, so its request stamp is recognisable. */
const requestRow = (workspaceId: string, resourceId: string, at: number): NewOutboxRow => ({
  ...reconcileRow(workspaceId, resourceId),
  createdAt: at,
  availableAt: at,
});

const makeOutboxRow = (resource: { workspaceId: string; id: string }) =>
  reconcileRow(resource.workspaceId, resource.id);

/** Queues every resource the repair path would pick up, so a test starts from a quiet sweep. */
async function quiet() {
  await claimDueReconciles(db, {
    perConnection: 10_000,
    now: T0 - 1,
    limit: 10_000,
    makeOutboxRow,
  });
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
      claimDueReconciles(db, {
        perConnection: 10_000,
        now: at,
        limit: 10,
        makeOutboxRow: recording,
      }),
    ).resolves.toBe(2);
    expect(made).toEqual([due.id, exactlyDue.id]);
    for (const r of [due, exactlyDue]) {
      expect(await nextReconcile(r.id)).toBeNull();
      expect(await queued(r.workspaceId, r.id)).toBe(1);
    }
    expect(await nextReconcile(notDue.id)).toBe(NOW + 1e9);
    expect(await queued(notDue.workspaceId, notDue.id)).toBe(0);
    await expect(
      claimDueReconciles(db, { perConnection: 10_000, now: at, limit: 10, makeOutboxRow }),
    ).resolves.toBe(0);
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
    await expect(
      claimDueReconciles(db, { perConnection: 10_000, now: at, limit: 10, makeOutboxRow }),
    ).resolves.toBe(0);
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
        perConnection: 10_000,
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

    await expect(
      claimDueReconciles(db, { perConnection: 10_000, now: at, limit: 100, makeOutboxRow }),
    ).resolves.toBe(3);
    expect(await queued(entitled.workspaceId, entitled.resource.id)).toBe(1);
    expect(await queued(expiredLease.workspaceId, expiredLease.resource.id)).toBe(1);
    expect(await queued(granted.workspaceId, grantedResource.id)).toBe(1);
    expect(await queued(leased.workspaceId, leased.resource.id)).toBe(0);
    expect(await queued(bare.workspaceId, bareResource.id)).toBe(0);
    expect(await queued(absent.workspaceId, absentResource.id)).toBe(0);

    await expect(
      claimDueReconciles(db, { perConnection: 10_000, now: at, limit: 100, makeOutboxRow }),
    ).resolves.toBe(0);
    // The run failed for good: the next sweep repairs it with a new row.
    await failAll(entitled.workspaceId, entitled.resource.id);
    await expect(
      claimDueReconciles(db, { perConnection: 10_000, now: at, limit: 100, makeOutboxRow }),
    ).resolves.toBe(1);
    expect(await queued(entitled.workspaceId, entitled.resource.id, "failed_at IS NULL")).toBe(1);
  });

  it("claims due resources first and repairs within what is left of the limit", async () => {
    await quiet();
    const at = NOW + 5_000;
    const due = await scheduled(at);
    const first = await subscribedWorkspace();
    const second = await subscribedWorkspace();
    await expect(
      claimDueReconciles(db, { perConnection: 10_000, now: at, limit: 2, makeOutboxRow }),
    ).resolves.toBe(2);
    expect(await queued(due.workspaceId, due.id)).toBe(1);
    const repaired =
      (await queued(first.workspaceId, first.resource.id)) +
      (await queued(second.workspaceId, second.resource.id));
    expect(repaired).toBe(1);
    await expect(
      claimDueReconciles(db, { perConnection: 10_000, now: at, limit: 1, makeOutboxRow }),
    ).resolves.toBe(1);
    expect(await queued(first.workspaceId, first.resource.id)).toBe(1);
    expect(await queued(second.workspaceId, second.resource.id)).toBe(1);
  });

  it("does not look for repairs when due resources fill the limit", async () => {
    await quiet();
    const at = NOW + 6_000;
    const due = await scheduled(at);
    const repairable = await subscribedWorkspace();
    await expect(
      claimDueReconciles(db, { perConnection: 10_000, now: at, limit: 1, makeOutboxRow }),
    ).resolves.toBe(1);
    expect(await queued(due.workspaceId, due.id)).toBe(1);
    expect(await queued(repairable.workspaceId, repairable.resource.id)).toBe(0);
  });

  it("does not repair a resource queued after the sweep read it", async () => {
    await quiet();
    const ws = await subscribedWorkspace();
    const races: Promise<unknown>[] = [];
    await expect(
      claimDueReconciles(db, {
        perConnection: 10_000,
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
        perConnection: 10_000,
        now: T0 - 1,
        limit: 10,
        makeOutboxRow: () => {
          throw new Error("not called");
        },
      }),
    ).resolves.toBe(0);
  });
});

describe("reconcile requests", () => {
  it("every trigger stamps the request in its batch, even when the insert is deduplicated", async () => {
    const ws = await subscribedWorkspace();
    const key = { workspaceId: ws.workspaceId, resourceId: ws.resource.id };
    expect(await requestedAt(ws.resource.id)).toBeNull();

    await requestReconcile(
      db,
      { ...key, outboxRow: requestRow(ws.workspaceId, ws.resource.id, NOW + 1) },
      [workspaceEvent(ws.workspaceId)],
    );
    expect(await requestedAt(ws.resource.id)).toBe(NOW + 1);
    // Pending: the insert is skipped, the stamp is not.
    await expect(
      enqueueReconcile(db, {
        ...key,
        outboxRow: requestRow(ws.workspaceId, ws.resource.id, NOW + 2),
      }),
    ).resolves.toBe(false);
    expect(await requestedAt(ws.resource.id)).toBe(NOW + 2);
    await applySubscriptionRefresh(
      db,
      {
        workspaceId: ws.workspaceId,
        now: NOW,
        expectedVersion: 1,
        subscription: { ...ws.subscription, version: 2, updatedAt: NOW },
        items: [ws.item],
        offers: [{ offerId: ws.offer.offer.id, version: 1 }],
        entitlements: { create: [], update: [], end: [] },
        reconcile: [requestRow(ws.workspaceId, ws.resource.id, NOW + 3)],
      },
      [workspaceEvent(ws.workspaceId)],
    );
    expect(await requestedAt(ws.resource.id)).toBe(NOW + 3);
    const sync = (at: number) =>
      applyResourceSync(
        db,
        {
          workspaceId: ws.workspaceId,
          connectionId: ws.connection.id,
          now: NOW,
          expectedVersion: 0,
          syncToken: crypto.randomUUID(),
          inserts: [],
          updates: [],
          connection: {},
          reconcile: [requestRow(ws.workspaceId, ws.resource.id, at)],
        },
        [workspaceEvent(ws.workspaceId)],
      );
    await expect(sync(NOW + 4)).resolves.toEqual({ ok: true });
    expect(await requestedAt(ws.resource.id)).toBe(NOW + 4);
    expect(await queued(ws.workspaceId, ws.resource.id)).toBe(1);

    // A stale resync stamps nothing.
    await expect(sync(NOW + 5)).resolves.toEqual({ ok: false, reason: "stale" });
    expect(await requestedAt(ws.resource.id)).toBe(NOW + 4);
  });

  it("enqueueReconcile queues once while pending and rejects a row of another resource", async () => {
    const ws = await subscribedWorkspace();
    const key = { workspaceId: ws.workspaceId, resourceId: ws.resource.id };
    await expect(
      enqueueReconcile(db, { ...key, outboxRow: reconcileRow(ws.workspaceId, ws.resource.id) }),
    ).resolves.toBe(true);
    expect(await queued(ws.workspaceId, ws.resource.id)).toBe(1);
    await expect(
      enqueueReconcile(db, { ...key, outboxRow: reconcileRow(ws.workspaceId, "res_other") }),
    ).rejects.toThrow(/name the resource/);
    await expect(
      enqueueReconcile(db, { ...key, outboxRow: reconcileRow("ws_other", ws.resource.id) }),
    ).rejects.toThrow(/reconcile_resource rows/);
  });

  it("a run that started before a request is released due now", async () => {
    const ws = await leasedWorkspace(NOW);
    const key = { workspaceId: ws.workspaceId, resourceId: ws.resource.id };
    // The run's own row is still pending, so a request mid-run is deduplicated away.
    await requestReconcile(
      db,
      { ...key, outboxRow: requestRow(ws.workspaceId, ws.resource.id, NOW) },
      [workspaceEvent(ws.workspaceId)],
    );
    await requestReconcile(
      db,
      { ...key, outboxRow: requestRow(ws.workspaceId, ws.resource.id, NOW + 10) },
      [workspaceEvent(ws.workspaceId)],
    );
    expect(await queued(ws.workspaceId, ws.resource.id)).toBe(1);
    await expect(
      releaseReconcileLease(db, {
        ...ws.lease,
        runStart: NOW + 10,
        now: NOW + 50,
        nextReconcileAt: NOW + 6 * 3_600_000,
      }),
    ).resolves.toBe(true);
    expect(await nextReconcile(ws.resource.id)).toBe(NOW + 50);

    // A run that started after the request schedules as it computed.
    await claimReconcileLease(db, { ...key, token: "later", now: NOW + 60, leaseMs: 120_000 });
    await releaseReconcileLease(db, {
      ...key,
      token: "later",
      runStart: NOW + 11,
      now: NOW + 70,
      nextReconcileAt: NOW + 9_000,
    });
    expect(await nextReconcile(ws.resource.id)).toBe(NOW + 9_000);
  });

  it("the sweep queues a resource requested after its last run once no lease is live", async () => {
    await quiet();
    const at = NOW + 7_000;
    // A run holds the lease (and will crash); the resource is scheduled far ahead.
    const ws = await leasedWorkspace(at);
    const key = { workspaceId: ws.workspaceId, resourceId: ws.resource.id };
    await env.DB.prepare(
      "UPDATE resources SET next_reconcile_at = ?, last_reconciled_at = ? WHERE id = ?",
    )
      .bind(at + 6 * 3_600_000, at - 1_000, ws.resource.id)
      .run();
    // A request while the lease is live; its row is delivered (the run is busy) and acked.
    const mid = requestRow(ws.workspaceId, ws.resource.id, at + 1);
    await requestReconcile(db, { ...key, outboxRow: mid }, [workspaceEvent(ws.workspaceId)]);
    await env.DB.prepare("UPDATE outbox SET sent_at = ? WHERE subject_id = ?")
      .bind(at + 2, mid.subjectId)
      .run();

    // Other tests' leases expire meanwhile, so only this resource's rows are counted.
    const pending = () => queued(ws.workspaceId, ws.resource.id, "sent_at IS NULL");
    const sweep = (now: number) =>
      claimDueReconciles(db, { perConnection: 10_000, now, limit: 10_000, makeOutboxRow });
    // The lease is live: not yet.
    await sweep(at + 60_000);
    expect(await pending()).toBe(0);
    // The holder crashed; once its lease expires, the request is honoured.
    await sweep(at + 120_000);
    expect(await pending()).toBe(1);
    // Pending now: not twice.
    await sweep(at + 120_000);
    expect(await pending()).toBe(1);
    // The request is kept; a completed run supersedes it.
    expect(await requestedAt(ws.resource.id)).toBe(at + 1);
    await env.DB.prepare("UPDATE outbox SET sent_at = ? WHERE subject_id = ?")
      .bind(at + 3, mid.subjectId)
      .run();
    await claimReconcileLease(db, { ...key, token: "next", now: at + 130_000, leaseMs: 120_000 });
    await releaseReconcileLease(db, {
      ...key,
      token: "next",
      runStart: at + 130_000,
      now: at + 130_000,
      nextReconcileAt: at + 6 * 3_600_000,
    });
    await sweep(at + 140_000);
    expect(await pending()).toBe(0);
  });
});
