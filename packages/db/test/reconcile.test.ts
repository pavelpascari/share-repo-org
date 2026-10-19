import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyGrantObservation,
  beginMutation,
  claimReconcileLease,
  enqueueOutboxOnce,
  finishMutation,
  type Grant,
  getGrant,
  latestMutationOperations,
  listGrantsForResource,
  listInviteStarts,
  listLiveEntitlementsForResource,
  listOpenMutations,
  pendingOutboxId,
  releaseReconcileLease,
  requestReconcile,
  resetGrantRetry,
} from "../src/index.ts";
import { auditCount, workspaceEvent } from "./support/audit.ts";
import { outboxRow, seedSubject } from "./support/commerce.ts";
import { count, db } from "./support/connections.ts";
import {
  grantRow,
  leasedWorkspace,
  mutationRow,
  reconcileRow,
  seedGrant,
  seedMutation,
} from "./support/reconcile.ts";
import { T0, uniqueId } from "./support/rows.ts";

const NOW = T0 + 60_000;
const LEASE = 120_000;

type Ws = Awaited<ReturnType<typeof leasedWorkspace>>;

const resourceRow = (id: string) =>
  env.DB.prepare(
    "SELECT reconcile_token AS token, reconcile_lease_until AS until, last_reconciled_at AS last, next_reconcile_at AS next FROM resources WHERE id = ?",
  )
    .bind(id)
    .first<{
      token: string | null;
      until: number | null;
      last: number | null;
      next: number | null;
    }>();

const grantById = (id: string) =>
  env.DB.prepare("SELECT * FROM grants WHERE id = ?").bind(id).first<Record<string, unknown>>();

const mutationById = (id: string) =>
  env.DB.prepare("SELECT * FROM provider_mutations WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();

/** Another run takes the workspace's lease over after it expired. */
async function takeOver(ws: Ws) {
  const token = uniqueId("tok");
  const claimed = await claimReconcileLease(db, {
    workspaceId: ws.workspaceId,
    resourceId: ws.resource.id,
    token,
    now: T0 + LEASE,
    leaseMs: LEASE,
  });
  expect(claimed).toBe(true);
  return token;
}

/** One audit event with its own correlation ID, and a counter for it. */
function audited(workspaceId: string) {
  const correlationId = uniqueId("corr");
  const events = [workspaceEvent(workspaceId, { correlationId })] as const;
  return { events, written: () => auditCount(env.DB, correlationId) };
}

describe("reconcile lease", () => {
  it("is held by one token until it expires, then taken over", async () => {
    const ws = await leasedWorkspace();
    const key = { workspaceId: ws.workspaceId, resourceId: ws.resource.id };
    expect(await resourceRow(ws.resource.id)).toMatchObject({
      token: ws.token,
      until: T0 + LEASE,
    });

    const other = uniqueId("tok");
    await expect(
      claimReconcileLease(db, { ...key, token: other, now: T0 + LEASE - 1, leaseMs: LEASE }),
    ).resolves.toBe(false);
    expect((await resourceRow(ws.resource.id))?.token).toBe(ws.token);

    // Expired: the next run takes it over, and the first run can no longer release it.
    await expect(
      claimReconcileLease(db, { ...key, token: other, now: T0 + LEASE, leaseMs: LEASE }),
    ).resolves.toBe(true);
    await expect(
      releaseReconcileLease(db, { ...ws.lease, now: NOW, nextReconcileAt: NOW + 1 }),
    ).resolves.toBe(false);
    expect(await resourceRow(ws.resource.id)).toEqual({
      token: other,
      until: T0 + 2 * LEASE,
      last: null,
      next: null,
    });

    await expect(
      releaseReconcileLease(db, { ...key, token: other, now: NOW, nextReconcileAt: NOW + 5 }),
    ).resolves.toBe(true);
    expect(await resourceRow(ws.resource.id)).toEqual({
      token: null,
      until: null,
      last: NOW,
      next: NOW + 5,
    });
    // Released: a second release changes nothing, and any run may claim it again.
    await expect(
      releaseReconcileLease(db, { ...key, token: other, now: NOW + 1, nextReconcileAt: NOW + 9 }),
    ).resolves.toBe(false);
    await expect(
      claimReconcileLease(db, { ...key, token: uniqueId("tok"), now: NOW, leaseMs: LEASE }),
    ).resolves.toBe(true);
  });

  it("goes to exactly one of two runs racing for it", async () => {
    const ws = await leasedWorkspace();
    await releaseReconcileLease(db, { ...ws.lease, now: T0, nextReconcileAt: T0 });
    const key = { workspaceId: ws.workspaceId, resourceId: ws.resource.id };
    const results = await Promise.all(
      ["a", "b"].map((token) =>
        claimReconcileLease(db, { ...key, token, now: NOW, leaseMs: LEASE }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("never claims or releases another workspace's resource", async () => {
    const ws = await leasedWorkspace();
    const other = await leasedWorkspace();
    await releaseReconcileLease(db, { ...ws.lease, now: T0, nextReconcileAt: T0 });
    const foreign = { workspaceId: other.workspaceId, resourceId: ws.resource.id };
    await expect(
      claimReconcileLease(db, { ...foreign, token: "x", now: NOW, leaseMs: LEASE }),
    ).resolves.toBe(false);
    await expect(
      releaseReconcileLease(db, {
        workspaceId: ws.workspaceId,
        resourceId: other.resource.id,
        token: other.token,
        now: NOW,
        nextReconcileAt: NOW,
      }),
    ).resolves.toBe(false);
    expect((await resourceRow(ws.resource.id))?.token).toBeNull();
    expect((await resourceRow(other.resource.id))?.token).toBe(other.token);
  });
});

describe("reconcile reads", () => {
  it("lists the resource's grants by subject, scoped to the workspace", async () => {
    const ws = await leasedWorkspace();
    const second = await seedSubject(ws.workspaceId);
    const a = await seedGrant(grantRow(ws.identity));
    const b = await seedGrant(grantRow({ ...ws.identity, subjectId: second.id }));
    const c = await seedGrant(grantRow(ws.identity, { accessLevel: "read" }));
    const other = await leasedWorkspace();
    await seedGrant(grantRow(other.identity));

    const listed = await listGrantsForResource(db, ws.lease);
    const expected = [a, b, c].sort((x, y) =>
      x.subjectId === y.subjectId ? (x.id < y.id ? -1 : 1) : x.subjectId < y.subjectId ? -1 : 1,
    );
    expect(listed.map((g) => g.id)).toEqual(expected.map((g) => g.id));
    expect(listed.find((g) => g.id === a.id)).toEqual(a);
    await expect(
      listGrantsForResource(db, { workspaceId: other.workspaceId, resourceId: ws.resource.id }),
    ).resolves.toEqual([]);
  });

  it("lists the resource's live entitlements only, scoped to the workspace", async () => {
    const ws = await leasedWorkspace();
    await expect(listLiveEntitlementsForResource(db, ws.lease)).resolves.toEqual([ws.entitlement]);
    const other = await leasedWorkspace();
    await expect(
      listLiveEntitlementsForResource(db, {
        workspaceId: other.workspaceId,
        resourceId: ws.resource.id,
      }),
    ).resolves.toEqual([]);
    await env.DB.prepare("UPDATE entitlements SET state = 'expired', ended_at = ? WHERE id = ?")
      .bind(NOW, ws.entitlement.id)
      .run();
    await expect(listLiveEntitlementsForResource(db, ws.lease)).resolves.toEqual([]);
  });

  it("lists invitation starts after `since`, except those GitHub refused", async () => {
    const ws = await leasedWorkspace();
    const grant = await seedGrant(grantRow(ws.identity));
    const at = (startedAt: number, overrides = {}) =>
      seedMutation(mutationRow(grant, { startedAt, ...overrides }));
    const done = (startedAt: number) => ({ finishedAt: startedAt + 1 });
    await at(T0 + 5);
    await at(T0 + 40, { status: "resolved", ...done(T0 + 40) });
    await at(T0 + 10);
    await at(T0 + 20, { status: "succeeded", ...done(T0 + 20) });
    await at(T0 + 30, {
      status: "failed",
      errorCode: "invitation_rejected",
      retryClass: "user_action_required",
      ...done(T0 + 30),
    });
    // A retryable failure may have created the invitation before its response was lost.
    await at(T0 + 35, {
      status: "failed",
      errorCode: "provider_unavailable",
      retryClass: "retryable",
      ...done(T0 + 35),
    });
    await at(T0 + 36, {
      status: "failed",
      errorCode: "rate_limited",
      retryClass: "rate_limited",
      ...done(T0 + 36),
    });
    await at(T0 + 50, { operation: "remove_collaborator" });
    const other = await leasedWorkspace();
    await seedMutation(
      mutationRow(await seedGrant(grantRow(other.identity)), { startedAt: T0 + 60 }),
    );

    await expect(listInviteStarts(db, { ...ws.lease, since: T0 + 5 })).resolves.toEqual([
      T0 + 10,
      T0 + 20,
      T0 + 35,
      T0 + 40,
    ]);
    await expect(
      listInviteStarts(db, {
        workspaceId: ws.workspaceId,
        resourceId: other.resource.id,
        since: 0,
      }),
    ).resolves.toEqual([]);
  });

  it("lists the resource's started mutations, oldest first", async () => {
    const ws = await leasedWorkspace();
    const grant = await seedGrant(grantRow(ws.identity));
    const later = await seedMutation(mutationRow(grant, { startedAt: T0 + 2 }));
    const earlier = await seedMutation(mutationRow(grant, { startedAt: T0 + 1 }));
    await seedMutation(
      mutationRow(grant, { startedAt: T0, status: "succeeded", finishedAt: T0 + 1 }),
    );
    await expect(listOpenMutations(db, ws.lease)).resolves.toEqual([earlier, later]);
    const other = await leasedWorkspace();
    await expect(
      listOpenMutations(db, { workspaceId: other.workspaceId, resourceId: ws.resource.id }),
    ).resolves.toEqual([]);
  });

  it("maps each grant to its latest started or failed mutation's operation", async () => {
    const ws = await leasedWorkspace();
    const second = await seedSubject(ws.workspaceId);
    const a = await seedGrant(grantRow(ws.identity));
    const b = await seedGrant(grantRow(ws.identity, { accessLevel: "read" }));
    const c = await seedGrant(grantRow({ ...ws.identity, subjectId: second.id }));
    const failed = {
      status: "failed" as const,
      errorCode: "provider_unavailable",
      retryClass: "retryable" as const,
    };
    await seedMutation(mutationRow(a, { startedAt: T0 + 1, ...failed, finishedAt: T0 + 2 }));
    await seedMutation(mutationRow(a, { startedAt: T0 + 2, operation: "remove_collaborator" }));
    // A later settled mutation does not count.
    await seedMutation(
      mutationRow(a, {
        startedAt: T0 + 3,
        operation: "cancel_invitation",
        status: "succeeded",
        finishedAt: T0 + 3,
      }),
    );
    // Same instant: the larger ID wins.
    await seedMutation(
      mutationRow(b, { id: "mut_1", startedAt: T0 + 5, ...failed, finishedAt: T0 + 5 }),
    );
    await seedMutation(
      mutationRow(b, {
        id: "mut_2",
        startedAt: T0 + 5,
        operation: "cancel_invitation",
        ...failed,
        finishedAt: T0 + 5,
      }),
    );
    await seedMutation(mutationRow(c, { status: "resolved", finishedAt: T0 + 1 }));

    const latest = await latestMutationOperations(db, ws.lease);
    expect(Object.fromEntries(latest)).toEqual({
      [a.id]: "remove_collaborator",
      [b.id]: "cancel_invitation",
    });
    const other = await leasedWorkspace();
    await expect(
      latestMutationOperations(db, { workspaceId: other.workspaceId, resourceId: ws.resource.id }),
    ).resolves.toEqual(new Map());
  });
});

describe("applyGrantObservation", () => {
  async function observed() {
    const ws = await leasedWorkspace();
    const second = await seedSubject(ws.workspaceId);
    const third = await seedSubject(ws.workspaceId);
    const changed = await seedGrant(
      grantRow({ ...ws.identity, subjectId: second.id }, { state: "provisioning", managed: true }),
    );
    const unchanged = await seedGrant(grantRow({ ...ws.identity, subjectId: third.id }));
    const open = await seedMutation(mutationRow(changed));
    const failed = await seedMutation(
      mutationRow(changed, {
        status: "failed",
        errorCode: "provider_unavailable",
        retryClass: "retryable",
        finishedAt: T0,
      }),
    );
    const created = grantRow(ws.identity, { observedAt: NOW, createdAt: NOW, updatedAt: NOW });
    const input = {
      ...ws.lease,
      now: NOW,
      creates: [created],
      updates: [
        { id: changed.id, set: { state: "pending_invitation" as const, externalGrantId: "inv1" } },
      ],
      touch: [unchanged.id],
      resolve: { mutationIds: [open.id, failed.id] },
    };
    return { ws, changed, unchanged, open, failed, created, input };
  }

  it("writes grants, stamps observed grants, resolves mutations and audits in one batch", async () => {
    const { ws, changed, unchanged, open, failed, created, input } = await observed();
    const audit = audited(ws.workspaceId);
    await expect(applyGrantObservation(db, input, audit.events)).resolves.toEqual({ ok: true });

    expect(await grantById(created.id)).toMatchObject({ id: created.id, observed_at: NOW });
    expect(await grantById(changed.id)).toMatchObject({
      state: "pending_invitation",
      external_grant_id: "inv1",
      managed: 1,
      observed_at: NOW,
      updated_at: NOW,
    });
    expect(await grantById(unchanged.id)).toMatchObject({ observed_at: NOW, updated_at: T0 });
    expect(await mutationById(open.id)).toMatchObject({ status: "resolved", finished_at: NOW });
    // A mutation that already has an outcome is left as it is.
    expect(await mutationById(failed.id)).toMatchObject({ status: "failed", finished_at: T0 });
    expect(await audit.written()).toBe(1);
  });

  it("writes nothing once another run took the lease", async () => {
    const { ws, changed, unchanged, open, created, input } = await observed();
    await takeOver(ws);
    const audit = audited(ws.workspaceId);
    await expect(applyGrantObservation(db, input, audit.events)).resolves.toEqual({
      ok: false,
      reason: "lease_lost",
    });
    expect(await grantById(created.id)).toBeNull();
    expect(await grantById(changed.id)).toMatchObject({ state: "provisioning", observed_at: T0 });
    expect(await grantById(unchanged.id)).toMatchObject({ observed_at: T0 });
    expect(await mutationById(open.id)).toMatchObject({ status: "started" });
    expect(await audit.written()).toBe(0);
  });

  it("writes an update of details alone without an audit event", async () => {
    const ws = await leasedWorkspace();
    const grant = await seedGrant(
      grantRow(ws.identity, {
        state: "pending_invitation",
        externalGrantId: "inv1",
        expiresAt: T0,
      }),
    );
    await expect(
      applyGrantObservation(
        db,
        {
          ...ws.lease,
          now: NOW,
          creates: [],
          updates: [{ id: grant.id, set: { expiresAt: NOW } }],
          touch: [],
          resolve: { mutationIds: [] },
        },
        [],
      ),
    ).resolves.toEqual({ ok: true });
    expect(await grantById(grant.id)).toMatchObject({ expires_at: NOW, observed_at: NOW });
  });

  it("stamps more observed grants than one statement can bind, without an audit event", async () => {
    const ws = await leasedWorkspace();
    const grant = await seedGrant(grantRow(ws.identity));
    const filler = Array.from({ length: 150 }, (_, i) => `gra_missing_${i}`);
    await expect(
      applyGrantObservation(
        db,
        {
          ...ws.lease,
          now: NOW,
          creates: [],
          updates: [],
          touch: [...filler, grant.id],
          resolve: { mutationIds: [] },
        },
        [],
      ),
    ).resolves.toEqual({ ok: true });
    expect(await grantById(grant.id)).toMatchObject({ observed_at: NOW, updated_at: T0 });
  });

  it("resolves more mutations than one statement can bind", async () => {
    const ws = await leasedWorkspace();
    const grant = await seedGrant(grantRow(ws.identity));
    const open = await seedMutation(mutationRow(grant));
    const filler = Array.from({ length: 150 }, (_, i) => `mut_missing_${i}`);
    await expect(
      applyGrantObservation(
        db,
        {
          ...ws.lease,
          now: NOW,
          creates: [],
          updates: [],
          touch: [],
          resolve: { mutationIds: [...filler, open.id] },
        },
        audited(ws.workspaceId).events,
      ),
    ).resolves.toEqual({ ok: true });
    expect(await mutationById(open.id)).toMatchObject({ status: "resolved" });
  });

  it("never touches another workspace's grants or mutations", async () => {
    const ws = await leasedWorkspace();
    const other = await leasedWorkspace();
    const foreign = await seedGrant(grantRow(other.identity, { state: "provisioning" }));
    const foreignMutation = await seedMutation(mutationRow(foreign));
    await expect(
      applyGrantObservation(
        db,
        {
          ...ws.lease,
          now: NOW,
          creates: [],
          updates: [{ id: foreign.id, set: { state: "active" } }],
          touch: [foreign.id],
          resolve: { mutationIds: [foreignMutation.id] },
        },
        audited(ws.workspaceId).events,
      ),
    ).resolves.toEqual({ ok: true });
    expect(await grantById(foreign.id)).toMatchObject({ state: "provisioning", observed_at: T0 });
    expect(await mutationById(foreignMutation.id)).toMatchObject({ status: "started" });
  });

  it("rejects a grant of another resource and a change without an audit event", async () => {
    const ws = await leasedWorkspace();
    const other = await leasedWorkspace();
    const empty = {
      ...ws.lease,
      now: NOW,
      creates: [],
      updates: [],
      touch: [],
      resolve: { mutationIds: [] },
    };
    await expect(
      applyGrantObservation(
        db,
        { ...empty, creates: [grantRow({ ...ws.identity, resourceId: other.resource.id })] },
        audited(ws.workspaceId).events,
      ),
    ).rejects.toThrow(/leased resource/);
    await expect(
      applyGrantObservation(
        db,
        { ...empty, creates: [grantRow({ ...ws.identity, workspaceId: other.workspaceId })] },
        audited(ws.workspaceId).events,
      ),
    ).rejects.toThrow(/leased resource/);
    await expect(
      applyGrantObservation(db, { ...empty, resolve: { mutationIds: ["mut_x"] } }, []),
    ).rejects.toThrow(/requires an audit event/);
  });
});

describe("beginMutation and finishMutation", () => {
  it("records the intent, the started mutation and the audit, then the outcome", async () => {
    const ws = await leasedWorkspace();
    const grant = grantRow(ws.identity, {
      state: "provisioning",
      managed: true,
      entitlementId: ws.entitlement.id,
      observedAt: null,
      lastAttemptAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const mutation = mutationRow(grant, {
      startedAt: NOW,
      entitlementIds: JSON.stringify([ws.entitlement.id]),
    });
    const begun = audited(ws.workspaceId);
    await expect(
      beginMutation(
        db,
        { ...ws.lease, now: NOW, grant: { create: grant }, mutation },
        begun.events,
      ),
    ).resolves.toEqual({ ok: true });
    expect(await grantById(grant.id)).toMatchObject({ state: "provisioning", managed: 1 });
    expect(await mutationById(mutation.id)).toMatchObject({ status: "started" });
    expect(await begun.written()).toBe(1);

    const finished = audited(ws.workspaceId);
    await expect(
      finishMutation(
        db,
        {
          ...ws.lease,
          now: NOW + 5,
          mutationId: mutation.id,
          result: { status: "succeeded", errorCode: null, retryClass: null, externalId: "inv9" },
          grant: {
            id: grant.id,
            set: { state: "pending_invitation", externalGrantId: "inv9", expiresAt: NOW + 7 },
          },
        },
        finished.events,
      ),
    ).resolves.toEqual({ ok: true });
    expect(await mutationById(mutation.id)).toMatchObject({
      status: "succeeded",
      external_id: "inv9",
      finished_at: NOW + 5,
    });
    expect(await grantById(grant.id)).toMatchObject({
      state: "pending_invitation",
      external_grant_id: "inv9",
      expires_at: NOW + 7,
      updated_at: NOW + 5,
    });
    expect(await finished.written()).toBe(1);
  });

  it("moves an existing grant to revoking, then records a classified failure", async () => {
    const ws = await leasedWorkspace();
    const grant = await seedGrant(grantRow(ws.identity, { managed: true }));
    const mutation = mutationRow(grant, { operation: "remove_collaborator", startedAt: NOW });
    await expect(
      beginMutation(
        db,
        {
          ...ws.lease,
          now: NOW,
          grant: { update: { id: grant.id, set: { state: "revoking", lastAttemptAt: NOW } } },
          mutation,
        },
        audited(ws.workspaceId).events,
      ),
    ).resolves.toEqual({ ok: true });
    expect(await grantById(grant.id)).toMatchObject({
      state: "revoking",
      last_attempt_at: NOW,
      updated_at: NOW,
      observed_at: T0,
    });

    await expect(
      finishMutation(
        db,
        {
          ...ws.lease,
          now: NOW + 1,
          mutationId: mutation.id,
          result: {
            status: "failed",
            errorCode: "rate_limited",
            retryClass: "rate_limited",
            externalId: null,
          },
          grant: {
            id: grant.id,
            set: {
              state: "error",
              lastErrorCode: "rate_limited",
              retryClass: "rate_limited",
              nextAttemptAt: NOW + 60_000,
            },
          },
        },
        audited(ws.workspaceId).events,
      ),
    ).resolves.toEqual({ ok: true });
    expect(await mutationById(mutation.id)).toMatchObject({
      status: "failed",
      error_code: "rate_limited",
      retry_class: "rate_limited",
      finished_at: NOW + 1,
    });
    expect(await grantById(grant.id)).toMatchObject({
      state: "error",
      managed: 1,
      next_attempt_at: NOW + 60_000,
    });
  });

  it("leaves a mutation that is no longer started as it is", async () => {
    const ws = await leasedWorkspace();
    const grant = await seedGrant(grantRow(ws.identity));
    const resolved = await seedMutation(mutationRow(grant, { status: "resolved", finishedAt: T0 }));
    await expect(
      finishMutation(
        db,
        {
          ...ws.lease,
          now: NOW,
          mutationId: resolved.id,
          result: { status: "succeeded", errorCode: null, retryClass: null, externalId: null },
          grant: { id: grant.id, set: { state: "active" } },
        },
        audited(ws.workspaceId).events,
      ),
    ).resolves.toEqual({ ok: true });
    expect(await mutationById(resolved.id)).toMatchObject({ status: "resolved", finished_at: T0 });
  });

  it("writes nothing once another run took the lease", async () => {
    const ws = await leasedWorkspace();
    const existing = await seedGrant(grantRow(ws.identity, { managed: true }));
    const open = await seedMutation(mutationRow(existing));
    await takeOver(ws);

    const created = grantRow(ws.identity, { accessLevel: "read", state: "provisioning" });
    const begun = audited(ws.workspaceId);
    const mutation = mutationRow(created);
    await expect(
      beginMutation(
        db,
        { ...ws.lease, now: NOW, grant: { create: created }, mutation },
        begun.events,
      ),
    ).resolves.toEqual({ ok: false, reason: "lease_lost" });
    const revoking = mutationRow(existing);
    await expect(
      beginMutation(
        db,
        {
          ...ws.lease,
          now: NOW,
          grant: { update: { id: existing.id, set: { state: "revoking" } } },
          mutation: revoking,
        },
        begun.events,
      ),
    ).resolves.toEqual({ ok: false, reason: "lease_lost" });
    await expect(
      finishMutation(
        db,
        {
          ...ws.lease,
          now: NOW,
          mutationId: open.id,
          result: { status: "succeeded", errorCode: null, retryClass: null, externalId: null },
          grant: { id: existing.id, set: { state: "absent" } },
        },
        begun.events,
      ),
    ).resolves.toEqual({ ok: false, reason: "lease_lost" });

    expect(await grantById(created.id)).toBeNull();
    expect(await mutationById(mutation.id)).toBeNull();
    expect(await mutationById(revoking.id)).toBeNull();
    expect(await grantById(existing.id)).toMatchObject({ state: "active", updated_at: T0 });
    expect(await mutationById(open.id)).toMatchObject({ status: "started" });
    expect(await begun.written()).toBe(0);
  });

  it("never changes another workspace's grant or mutation", async () => {
    const ws = await leasedWorkspace();
    const other = await leasedWorkspace();
    const foreign = await seedGrant(grantRow(other.identity));
    const foreignOpen = await seedMutation(mutationRow(foreign));
    const own = await seedGrant(grantRow(ws.identity));
    await expect(
      finishMutation(
        db,
        {
          ...ws.lease,
          now: NOW,
          mutationId: foreignOpen.id,
          result: { status: "succeeded", errorCode: null, retryClass: null, externalId: null },
          grant: { id: foreign.id, set: { state: "absent" } },
        },
        audited(ws.workspaceId).events,
      ),
    ).resolves.toEqual({ ok: true });
    expect(await grantById(foreign.id)).toMatchObject({ state: "active" });
    expect(await mutationById(foreignOpen.id)).toMatchObject({ status: "started" });

    await expect(
      beginMutation(
        db,
        {
          ...ws.lease,
          now: NOW,
          grant: { update: { id: foreign.id, set: { state: "revoking" } } },
          mutation: mutationRow(own, { grantId: foreign.id }),
        },
        audited(ws.workspaceId).events,
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
    expect(await grantById(foreign.id)).toMatchObject({ state: "active" });
  });

  it("rejects a mutation that is not a started one for the grant of the leased resource", async () => {
    const ws = await leasedWorkspace();
    const other = await leasedWorkspace();
    const grant = grantRow(ws.identity, { state: "provisioning" });
    const begin = (mutation: ReturnType<typeof mutationRow>, create: Grant = grant) =>
      beginMutation(
        db,
        { ...ws.lease, now: NOW, grant: { create }, mutation },
        audited(ws.workspaceId).events,
      );
    await expect(
      begin(mutationRow(grant, { status: "succeeded", finishedAt: NOW })),
    ).rejects.toThrow(/leased resource/);
    await expect(begin(mutationRow(grant, { finishedAt: NOW }))).rejects.toThrow(/leased resource/);
    await expect(begin(mutationRow(grant, { grantId: "gra_other" }))).rejects.toThrow(
      /leased resource/,
    );
    await expect(begin(mutationRow(grant, { workspaceId: other.workspaceId }))).rejects.toThrow(
      /leased resource/,
    );
    await expect(begin(mutationRow(grant, { resourceId: other.resource.id }))).rejects.toThrow(
      /leased resource/,
    );
    const foreignGrant = grantRow(other.identity);
    await expect(
      begin(mutationRow(grant, { grantId: foreignGrant.id }), foreignGrant),
    ).rejects.toThrow(/leased resource/);
  });
});

describe("getGrant", () => {
  it("reads a grant of the workspace only", async () => {
    const ws = await leasedWorkspace();
    const grant = await seedGrant(grantRow(ws.identity));
    const other = await leasedWorkspace();
    await expect(getGrant(db, { workspaceId: ws.workspaceId, grantId: grant.id })).resolves.toEqual(
      grant,
    );
    await expect(
      getGrant(db, { workspaceId: other.workspaceId, grantId: grant.id }),
    ).resolves.toBeNull();
  });
});

describe("resetGrantRetry", () => {
  async function erroredGrant(retryClass: Grant["retryClass"]) {
    const ws = await leasedWorkspace();
    const grant = await seedGrant(
      grantRow(ws.identity, {
        state: "error",
        managed: true,
        lastErrorCode: "invitation_rejected",
        retryClass,
      }),
    );
    return { ws, grant };
  }

  it("makes a grant waiting for a person retryable and due now", async () => {
    for (const retryClass of ["user_action_required", "terminal"] as const) {
      const { ws, grant } = await erroredGrant(retryClass);
      const audit = audited(ws.workspaceId);
      const events = [
        ...audit.events,
        workspaceEvent(ws.workspaceId, { correlationId: audit.events[0].correlationId }),
      ] as const;
      await expect(
        resetGrantRetry(db, { workspaceId: ws.workspaceId, grantId: grant.id, now: NOW }, events),
      ).resolves.toEqual({ ok: true });
      expect(await grantById(grant.id)).toMatchObject({
        state: "error",
        retry_class: "retryable",
        last_error_code: "invitation_rejected",
        next_attempt_at: NOW,
        updated_at: NOW,
      });
      expect(await audit.written()).toBe(2);
    }
  });

  it("keeps a retryable or rate-limited class and only makes it due now", async () => {
    for (const retryClass of ["retryable", "rate_limited"] as const) {
      const { ws, grant } = await erroredGrant(retryClass);
      await resetGrantRetry(
        db,
        { workspaceId: ws.workspaceId, grantId: grant.id, now: NOW },
        audited(ws.workspaceId).events,
      );
      expect(await grantById(grant.id)).toMatchObject({
        retry_class: retryClass,
        next_attempt_at: NOW,
      });
    }
  });

  it("refuses a grant that is not in error, missing, or in another workspace, without audit", async () => {
    const { ws, grant } = await erroredGrant("terminal");
    const active = await seedGrant(grantRow(ws.identity, { accessLevel: "read" }));
    const other = await leasedWorkspace();
    const audit = audited(ws.workspaceId);
    const events = [
      ...audit.events,
      workspaceEvent(ws.workspaceId, { correlationId: audit.events[0].correlationId }),
    ] as const;
    await expect(
      resetGrantRetry(db, { workspaceId: ws.workspaceId, grantId: active.id, now: NOW }, events),
    ).resolves.toEqual({ ok: false, reason: "not_in_error" });
    await expect(
      resetGrantRetry(
        db,
        { workspaceId: ws.workspaceId, grantId: "gra_missing", now: NOW },
        events,
      ),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(
      resetGrantRetry(db, { workspaceId: other.workspaceId, grantId: grant.id, now: NOW }, events),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(await grantById(grant.id)).toMatchObject({
      retry_class: "terminal",
      next_attempt_at: null,
    });
    expect(await audit.written()).toBe(0);
  });
});

describe("requestReconcile", () => {
  it("queues one reconcile while one is pending, and audits every request", async () => {
    const ws = await leasedWorkspace();
    const key = { workspaceId: ws.workspaceId, resourceId: ws.resource.id };
    const first = reconcileRow(ws.workspaceId, ws.resource.id);
    const audit = audited(ws.workspaceId);
    await expect(requestReconcile(db, { ...key, outboxRow: first }, audit.events)).resolves.toEqual(
      { outboxId: first.id },
    );
    const second = audited(ws.workspaceId);
    await expect(
      requestReconcile(
        db,
        { ...key, outboxRow: reconcileRow(ws.workspaceId, ws.resource.id) },
        second.events,
      ),
    ).resolves.toEqual({ outboxId: null });
    expect(await audit.written()).toBe(1);
    expect(await second.written()).toBe(1);

    await env.DB.prepare("UPDATE outbox SET sent_at = ? WHERE id = ?").bind(NOW, first.id).run();
    const third = reconcileRow(ws.workspaceId, ws.resource.id);
    await expect(
      requestReconcile(db, { ...key, outboxRow: third }, audited(ws.workspaceId).events),
    ).resolves.toEqual({ outboxId: third.id });
    expect(await count("outbox", "subject_id = ?", first.subjectId)).toBe(2);
  });

  it("enqueueOutboxOnce queues work unless the same work is pending", async () => {
    const ws = await leasedWorkspace();
    const first = reconcileRow(ws.workspaceId, ws.resource.id);
    await expect(enqueueOutboxOnce(db, first)).resolves.toBe(true);
    await expect(enqueueOutboxOnce(db, reconcileRow(ws.workspaceId, ws.resource.id))).resolves.toBe(
      false,
    );
    expect(await count("outbox", "subject_id = ?", first.subjectId)).toBe(1);
  });

  it("pendingOutboxId finds the pending row of a kind and key, and only a pending one", async () => {
    const ws = await leasedWorkspace();
    const first = reconcileRow(ws.workspaceId, ws.resource.id);
    const pending = () => pendingOutboxId(db, first.kind, first.subjectId);
    await expect(pending()).resolves.toBeNull();
    await enqueueOutboxOnce(db, first);
    await expect(pending()).resolves.toBe(first.id);
    await expect(pendingOutboxId(db, "refresh_subscription", first.subjectId)).resolves.toBeNull();
    await env.DB.prepare("UPDATE outbox SET sent_at = ? WHERE id = ?").bind(NOW, first.id).run();
    await expect(pending()).resolves.toBeNull();
    const second = reconcileRow(ws.workspaceId, ws.resource.id);
    await enqueueOutboxOnce(db, second);
    await env.DB.prepare("UPDATE outbox SET failed_at = ?, last_error_code = 'x' WHERE id = ?")
      .bind(NOW, second.id)
      .run();
    await expect(pending()).resolves.toBeNull();
  });

  it("rejects a row of another kind, workspace or resource", async () => {
    const ws = await leasedWorkspace();
    const key = { workspaceId: ws.workspaceId, resourceId: ws.resource.id };
    const events = audited(ws.workspaceId).events;
    await expect(
      requestReconcile(
        db,
        {
          ...key,
          outboxRow: outboxRow("refresh_subscription", `${ws.workspaceId}:${ws.resource.id}`),
        },
        events,
      ),
    ).rejects.toThrow(/reconcile_resource rows/);
    await expect(
      requestReconcile(db, { ...key, outboxRow: reconcileRow("ws_other", ws.resource.id) }, events),
    ).rejects.toThrow(/reconcile_resource rows/);
    await expect(
      requestReconcile(
        db,
        { ...key, outboxRow: reconcileRow(ws.workspaceId, "res_other") },
        events,
      ),
    ).rejects.toThrow(/name the resource/);
  });
});
