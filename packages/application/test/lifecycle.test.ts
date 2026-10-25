import { env } from "cloudflare:workers";
import {
  getPaddleConnection,
  getWorkspace,
  listAuditEventsByCorrelationId,
  listGrantsForResource,
  PURGE_ORDER,
  purgeBlockedKey,
} from "@sharerepo/db";
import { WORKSPACE_DELETION_DELAY_MS } from "@sharerepo/domain";
import { createFakeGitHubApp } from "@sharerepo/integrations/testing";
import { ForbiddenError, NotFoundError } from "@sharerepo/platform";
import { expectAuditedChange } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  cancelWorkspaceDeletion,
  confirmClaim,
  createOffer,
  deleteAccount,
  getAccountView,
  getWorkspaceSettings,
  linkCustomerManually,
  purgeWorkspace,
  queueLifecycleJobs,
  reconcileResource,
  refreshSubscription,
  renameWorkspace,
  requestWorkspaceDeletion,
  type ServiceContext,
  type UserActor,
} from "../src/index.ts";
import {
  DAY,
  drain,
  entitlementsOf,
  live,
  memberOf,
  offer,
  type Shop,
  shop,
  source,
  subscribe,
} from "./support/commerce.ts";
import { clock, db, githubProfile, serviceContext, signedUpUser } from "./support/context.ts";
import {
  claimLinkToken,
  deliverSubscription,
  directSubscription,
  drainPaddle,
  liveFor,
  type PaddleShop,
  paddleCustomer,
  paddleShop,
} from "./support/paddle.ts";

// The data lifecycle (decision 0015): workspace deletion and its purge, and account deletion,
// through the services, against local D1 and the in-memory GitHub App.

const resourceOf = (s: Shop) => s.resources[0] as (typeof s.resources)[number];
const ref = (s: Shop) => ({ workspaceId: s.workspaceId, resourceId: resourceOf(s).id });
const repoName = (s: Shop) => resourceOf(s).nameSnapshot;
const reconcile = (s: Shop, ctx = serviceContext()) => reconcileResource(ctx, ref(s), s.github);
const grantsOf = (s: Shop) => listGrantsForResource(db, ref(s));

interface SubjectRow {
  id: string;
  external_subject_id: string;
  external_identity_id: string | null;
}

const subjectOf = async (s: Shop, login: string) =>
  (await env.DB.prepare("SELECT * FROM subjects WHERE workspace_id = ? AND login_snapshot = ?")
    .bind(s.workspaceId, login)
    .first<SubjectRow>()) as SubjectRow;

/** A shop selling its first repository, with a subscriber whose invitation they accepted. */
async function soldWithCollaborator() {
  const s = await shop(1, createFakeGitHubApp({ clock }));
  await offer(s, { items: ["sim_pro"], resources: s.resources.slice(0, 1) });
  const sub = await subscribe(s, { items: ["sim_pro"] });
  await drain(s.workspaceId);
  clock.advance(1);
  const subject = await subjectOf(s, sub.login);
  await reconcile(s);
  s.github.acceptInvitation(repoName(s), subject.external_subject_id);
  clock.advance(60_000);
  await reconcile(s);
  expect(await grantsOf(s)).toMatchObject([{ state: "active", managed: true }]);
  return { s, sub, subject };
}

const collaborators = (s: Shop) => s.github.repositoryAccess(repoName(s)).collaborators;

async function count(query: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(query)
    .bind(...params)
    .first<{ n: number }>();
  return Number(row?.n);
}

/** Rows each workspace-owned table holds for the workspace, by table. */
async function workspaceRows(workspaceId: string): Promise<Record<string, number>> {
  const rows: Record<string, number> = {};
  for (const table of PURGE_ORDER) {
    rows[table] =
      table === "external_events"
        ? await count(
            `SELECT count(*) AS n FROM external_events WHERE connection_id IN
              (SELECT id FROM paddle_connections WHERE workspace_id = ?)`,
            workspaceId,
          )
        : await count(`SELECT count(*) AS n FROM "${table}" WHERE workspace_id = ?`, workspaceId);
  }
  return rows;
}

const nonZero = (rows: Record<string, number>) =>
  Object.fromEntries(Object.entries(rows).filter(([, n]) => n > 0));

const requestDeletion = (s: Shop, ctx: ServiceContext = serviceContext()) =>
  requestWorkspaceDeletion(ctx, s, s.slug, { confirmation: s.slug }, null);

/** The tombstones written for a workspace (account-scoped, so they outlive it). */
async function tombstones(workspaceId: string) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM audit_events WHERE action = 'workspace.purged' AND target_id = ?`,
  )
    .bind(workspaceId)
    .all<{ scope: string; workspace_id: string | null; details: string; actor_type: string }>();
  return results;
}

/** Runs the purge until it finishes, as the outbox would run its continuations. */
async function purgeToEnd(workspaceId: string, ctx = () => serviceContext(), batchesPerRun = 3) {
  for (let run = 0; run < 100; run += 1) {
    const outcome = await purgeWorkspace(ctx(), workspaceId, { batchesPerRun });
    if (outcome !== "continuing") return outcome;
  }
  throw new Error("purge did not finish");
}

/**
 * A service context whose `n`th D1 batch fails: `before` it runs (nothing commits) or `after`
 * it committed (the response is lost), as a Worker crash between batches would.
 */
function crashingAt(n: number, when: "before" | "after"): ServiceContext {
  let calls = 0;
  const crashing = new Proxy(db, {
    get: (target, property, receiver) =>
      property === "batch"
        ? async (statements: Parameters<typeof db.batch>[0]) => {
            calls += 1;
            if (calls !== n) return target.batch(statements);
            if (when === "after") await target.batch(statements);
            throw new Error("worker crashed");
          }
        : Reflect.get(target, property, receiver),
  });
  return { ...serviceContext(), db: crashing };
}

describe("deletion/workspace-revokes-before-purge", { timeout: 60_000 }, () => {
  it("ends every entitlement, waits for revocation, then purges after 30 days", async () => {
    const { s, sub } = await soldWithCollaborator();
    const ctx = serviceContext();
    const requested = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      requestDeletion(s, ctx),
    );
    const deleteAfter = clock.now() + WORKSPACE_DELETION_DELAY_MS;
    expect(requested.result).toEqual({ ok: true, deleteAfter, orphanedDestinationId: null });
    expect(await getWorkspace(db, s.workspaceId)).toMatchObject({
      status: "deleting",
      deleteAfter,
      deletionRequestedBy: s.userId,
    });
    expect(
      (await listAuditEventsByCorrelationId(db, ctx.correlationId)).map((e) => [
        e.action,
        e.details,
      ]),
    ).toEqual([["workspace.deletion_requested", { deleteAfter }]]);

    // The queued refresh ends the entitlement; the refresh reads no source.
    await drain(s.workspaceId);
    expect(live(await entitlementsOf(s.workspaceId, sub.id))).toEqual([]);
    expect(await entitlementsOf(s.workspaceId, sub.id)).toMatchObject([
      { state: "revoked", decisionReason: "workspace_deleted" },
    ]);

    // Not before delete_after.
    clock.advance(WORKSPACE_DELETION_DELAY_MS - 1);
    expect(await purgeWorkspace(serviceContext(), s.workspaceId)).toBe("not_due");
    clock.advance(1);

    // Due, but the collaborator ShareRepo invited is still there: the purge waits and says why.
    expect(await purgeWorkspace(serviceContext(), s.workspaceId)).toBe("waiting");
    expect(await getWorkspace(db, s.workspaceId)).toMatchObject({ status: "deleting" });
    expect(await getWorkspaceSettings(serviceContext(), s, s.slug)).toMatchObject({
      deletion: {
        deleteAfter,
        blocked: { reason: "managed_access_remaining", since: clock.now() },
      },
    });

    // Reconciliation revokes it; the purge then deletes everything, history included.
    await reconcile(s);
    expect(collaborators(s)).toEqual([]);
    const before = nonZero(await workspaceRows(s.workspaceId));
    expect(before.audit_events).toBeGreaterThan(0);
    expect(await purgeToEnd(s.workspaceId)).toBe("purged");
    expect(await getWorkspace(db, s.workspaceId)).toBeNull();
    expect(nonZero(await workspaceRows(s.workspaceId))).toEqual({});
    const [tombstone, ...more] = await tombstones(s.workspaceId);
    expect(more).toEqual([]);
    expect(tombstone).toMatchObject({ scope: "account", workspace_id: null, actor_type: "system" });
    expect(JSON.parse(tombstone?.details ?? "{}")).toEqual({
      deleted: { ...before, workspaces: 1 },
    });
    expect(
      await count("SELECT count(*) AS n FROM system_state WHERE key LIKE ?", `%${s.workspaceId}`),
    ).toBe(0);
    // Purged already: nothing to do.
    expect(await purgeWorkspace(serviceContext(), s.workspaceId)).toBe("gone");
  });

  it("waits for live entitlements, and queues their refreshes again", async () => {
    const s = await shop();
    await offer(s, { items: ["sim_pro"] });
    const sub = await subscribe(s, { items: ["sim_pro"] });
    await drain(s.workspaceId);
    await requestDeletion(s);
    // The deletion's refreshes were lost (marked sent without running).
    await env.DB.prepare(
      "UPDATE outbox SET sent_at = ? WHERE workspace_id = ? AND kind = 'refresh_subscription'",
    )
      .bind(clock.now(), s.workspaceId)
      .run();
    clock.advance(WORKSPACE_DELETION_DELAY_MS);
    expect(await purgeWorkspace(serviceContext(), s.workspaceId)).toBe("waiting");
    const state = await env.DB.prepare("SELECT value FROM system_state WHERE key = ?")
      .bind(purgeBlockedKey(s.workspaceId))
      .first<{ value: string }>();
    expect(JSON.parse(state?.value ?? "{}")).toEqual({
      reason: "entitlements_remaining",
      since: clock.now(),
      checkedAt: clock.now(),
    });
    // Waiting again later keeps when it started waiting.
    clock.advance(DAY);
    expect(await purgeWorkspace(serviceContext(), s.workspaceId)).toBe("waiting");
    expect((await getWorkspaceSettings(serviceContext(), s, s.slug)).deletion?.blocked).toEqual({
      reason: "entitlements_remaining",
      since: clock.now() - DAY,
    });
    await drain(s.workspaceId);
    expect(live(await entitlementsOf(s.workspaceId, sub.id))).toEqual([]);
    expect(await purgeToEnd(s.workspaceId)).toBe("purged");
  });

  it("refuses a confirmation that is not the slug, and changes nothing", async () => {
    const s = await shop();
    const result = await requestWorkspaceDeletion(
      serviceContext(),
      s,
      s.slug,
      { confirmation: "not-the-slug" },
      null,
    );
    expect(result).toEqual({ ok: false, reason: "confirmation_mismatch" });
    expect(await getWorkspace(db, s.workspaceId)).toMatchObject({ status: "active" });
  });

  it("is the owner's: members are forbidden and other workspaces are not found", async () => {
    const s = await shop();
    const member = await memberOf(s);
    const stranger = await signedUpUser();
    await expect(
      requestWorkspaceDeletion(serviceContext(), member, s.slug, { confirmation: s.slug }, null),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      requestWorkspaceDeletion(serviceContext(), stranger, s.slug, { confirmation: s.slug }, null),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelWorkspaceDeletion(serviceContext(), member, s.slug)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("makes the workspace read-only while it is deleting", async () => {
    const s = await shop();
    await requestDeletion(s);
    await expect(
      renameWorkspace(serviceContext(), s, s.slug, { name: "Renamed" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createOffer(serviceContext(), s, s.slug, {
        name: "Pro",
        gracePeriodDays: 7,
        items: [{ source: "simulated", externalItemId: "sim_x" }],
        accesses: [],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // A second request finds it no longer active.
    await expect(requestDeletion(s)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("can be cancelled: the workspace is active again and access comes back", async () => {
    const s = await shop();
    await offer(s, { items: ["sim_pro"] });
    const sub = await subscribe(s, { items: ["sim_pro"] });
    await drain(s.workspaceId);
    await requestDeletion(s);
    await drain(s.workspaceId);
    expect(live(await entitlementsOf(s.workspaceId, sub.id))).toEqual([]);

    const ctx = serviceContext();
    const cancelled = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      cancelWorkspaceDeletion(ctx, s, s.slug),
    );
    expect(cancelled.result).toEqual({ ok: true });
    expect(await getWorkspace(db, s.workspaceId)).toMatchObject({
      status: "active",
      deleteAfter: null,
      deletionRequestedBy: null,
    });
    expect(
      (await listAuditEventsByCorrelationId(db, ctx.correlationId)).map((e) => e.action),
    ).toEqual(["workspace.deletion_cancelled"]);
    await drain(s.workspaceId);
    // A reactivation creates a new row, so the gap stays visible.
    expect(live(await entitlementsOf(s.workspaceId, sub.id))).toHaveLength(1);
    expect(await getWorkspaceSettings(serviceContext(), s, s.slug)).toMatchObject({
      deletion: null,
    });
    // Not deleting any more: a second cancel changes nothing.
    expect(await cancelWorkspaceDeletion(serviceContext(), s, s.slug)).toEqual({ ok: false });
    // And a cancelled deletion is never purged.
    clock.advance(WORKSPACE_DELETION_DELAY_MS);
    expect(await purgeWorkspace(serviceContext(), s.workspaceId)).toBe("not_due");
  });

  it("disconnects Paddle as a disconnect does, erasing the credentials", async () => {
    const s = await paddleShop();
    const result = await requestWorkspaceDeletion(
      serviceContext(),
      s,
      s.slug,
      { confirmation: s.slug },
      s.deps,
    );
    expect(result).toMatchObject({ ok: true, orphanedDestinationId: null });
    expect(await getPaddleConnection(db, { workspaceId: s.workspaceId })).toBeNull();
    const row = await env.DB.prepare("SELECT * FROM paddle_connections WHERE id = ?")
      .bind(s.connectionId)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      status: "disconnected",
      api_key_envelope: null,
      webhook_secret_envelope: null,
      destination_id: null,
    });
  });

  it("keeps the destination to delete in Paddle when Paddle cannot be asked", async () => {
    const s = await paddleShop();
    const destinationId = (await getPaddleConnection(db, { workspaceId: s.workspaceId }))
      ?.destinationId;
    const result = await requestWorkspaceDeletion(
      serviceContext(),
      s,
      s.slug,
      { confirmation: s.slug },
      null,
    );
    expect(result).toMatchObject({ ok: true, orphanedDestinationId: destinationId });
    const row = await env.DB.prepare("SELECT * FROM paddle_connections WHERE id = ?")
      .bind(s.connectionId)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      status: "disconnected",
      api_key_envelope: null,
      destination_id: destinationId,
    });
  });
});

describe("deletion/purge-touches-only-its-workspace", { timeout: 60_000 }, () => {
  it("deletes every row of the purged workspace and none of another's", async () => {
    const { s: doomed } = await soldWithCollaborator();
    const { s: other } = await soldWithCollaborator();
    await requestDeletion(doomed);
    await drain(doomed.workspaceId);
    await reconcile(doomed);
    clock.advance(WORKSPACE_DELETION_DELAY_MS);
    const otherBefore = await workspaceRows(other.workspaceId);
    const ownerIdentity = await count(
      "SELECT count(*) AS n FROM external_identities WHERE user_id = ?",
      doomed.userId,
    );

    expect(await purgeToEnd(doomed.workspaceId, () => serviceContext(), 2)).toBe("purged");
    expect(await workspaceRows(other.workspaceId)).toEqual(otherBefore);
    expect(await getWorkspace(db, other.workspaceId)).toMatchObject({ status: "active" });
    // The owner's account is not workspace data: it stays.
    expect(
      await count("SELECT count(*) AS n FROM external_identities WHERE user_id = ?", doomed.userId),
    ).toBe(ownerIdentity);
    expect(await count("SELECT count(*) AS n FROM users WHERE id = ?", doomed.userId)).toBe(1);
  });

  it("purges nothing of a workspace that is not being deleted, whatever the job says", async () => {
    const { s } = await soldWithCollaborator();
    const before = await workspaceRows(s.workspaceId);
    expect(await purgeWorkspace(serviceContext(), s.workspaceId)).toBe("not_due");
    expect(await purgeWorkspace(serviceContext(), "no-such-workspace")).toBe("gone");
    expect(await workspaceRows(s.workspaceId)).toEqual(before);
  });
});

describe("crash/every-batch-boundary-converges: workspace purge", { timeout: 60_000 }, () => {
  async function purgeable() {
    const s = await shop();
    await offer(s, { items: ["sim_pro"] });
    await subscribe(s, { items: ["sim_pro"] });
    await drain(s.workspaceId);
    await requestDeletion(s);
    await drain(s.workspaceId);
    clock.advance(WORKSPACE_DELETION_DELAY_MS);
    return s;
  }

  it.each([1, 2, 3, 5, 8, 13])(
    "converges when batch %i fails before or after it commits",
    async (n) => {
      for (const when of ["before", "after"] as const) {
        const s = await purgeable();
        const before = nonZero(await workspaceRows(s.workspaceId));
        const crashing = crashingAt(n, when);
        await purgeToEnd(s.workspaceId, () => crashing, 1).catch((error: unknown) => {
          expect(String(error)).toContain("worker crashed");
        });
        expect(await purgeToEnd(s.workspaceId)).toMatch(/^(purged|gone)$/);
        expect(await getWorkspace(db, s.workspaceId)).toBeNull();
        expect(nonZero(await workspaceRows(s.workspaceId))).toEqual({});
        const written = await tombstones(s.workspaceId);
        expect(written).toHaveLength(1);
        expect(JSON.parse(written[0]?.details ?? "{}")).toEqual({
          deleted: { ...before, workspaces: 1 },
        });
      }
    },
  );
});

/** SQL text of each statement in a D1 batch, to recognise a batch in a test proxy. */
const batchSql = (statements: readonly unknown[]) =>
  statements.map((statement) => (statement as { toSQL(): { sql: string } }).toSQL().sql).join(";");

/** A service context that runs `before` once, just before the first batch whose SQL matches. */
function beforeBatch(pattern: RegExp, before: () => Promise<unknown>): ServiceContext {
  let done = false;
  const intercepting = new Proxy(db, {
    get: (target, property, receiver) =>
      property === "batch"
        ? async (statements: Parameters<typeof db.batch>[0]) => {
            if (!done && pattern.test(batchSql(statements))) {
              done = true;
              await before();
            }
            return target.batch(statements);
          }
        : Reflect.get(target, property, receiver),
  });
  return { ...serviceContext(), db: intercepting };
}

describe("lifecycle races", { timeout: 60_000 }, () => {
  async function due() {
    const s = await shop();
    await offer(s, { items: ["sim_pro"] });
    await subscribe(s, { items: ["sim_pro"] });
    await drain(s.workspaceId);
    await requestDeletion(s);
    await drain(s.workspaceId);
    clock.advance(WORKSPACE_DELETION_DELAY_MS);
    return s;
  }

  it("does not start a purge when access appears after the check", async () => {
    const s = await due();
    // The check reads no remaining access, but an entitlement is live again when the first
    // batch runs: the batch's own guard refuses to start.
    let first = true;
    const stale = new Proxy(db, {
      get: (target, property, receiver) =>
        property === "all" && first
          ? async () => {
              first = false;
              return [{ live: 0, managed: 0 }];
            }
          : Reflect.get(target, property, receiver),
    });
    await env.DB.prepare(
      "UPDATE entitlements SET state = 'active', ended_at = NULL WHERE workspace_id = ?",
    )
      .bind(s.workspaceId)
      .run();
    expect(await purgeWorkspace({ ...serviceContext(), db: stale }, s.workspaceId)).toBe("waiting");
    expect(await getWorkspace(db, s.workspaceId)).toMatchObject({ status: "deleting" });
  });

  it("runs again when a job wrote a row for the workspace after its table was emptied", async () => {
    const s = await due();
    const stray = beforeBatch(/delete from "workspaces"/i, () =>
      env.DB.prepare(
        `INSERT INTO subjects (id, workspace_id, provider, type, external_subject_id, login_snapshot, created_at, updated_at)
         VALUES (?, ?, 'github', 'user', 'late', 'late', ?, ?)`,
      )
        .bind(`late-${s.workspaceId}`, s.workspaceId, clock.now(), clock.now())
        .run(),
    );
    expect(await purgeWorkspace(stray, s.workspaceId)).toBe("continuing");
    expect(await getWorkspace(db, s.workspaceId)).toMatchObject({ status: "purging" });
    expect(await purgeToEnd(s.workspaceId)).toBe("purged");
    expect(await tombstones(s.workspaceId)).toHaveLength(1);
  });

  it("empties a table larger than one batch in several batches", async () => {
    const s = await due();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1001)
       INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts, workspace_id)
       SELECT ?1 || '-' || i, 'resync_connection', 'c', ?2, ?2, 0, ?1 FROM n`,
    )
      .bind(s.workspaceId, clock.now())
      .run();
    expect(await purgeWorkspace(serviceContext(), s.workspaceId, { batchesPerRun: 2 })).toBe(
      "continuing",
    );
    expect(
      await count("SELECT count(*) AS n FROM outbox WHERE workspace_id = ?", s.workspaceId),
    ).toBeGreaterThan(0);
    expect(await purgeToEnd(s.workspaceId)).toBe("purged");
    const [tombstone] = await tombstones(s.workspaceId);
    expect(JSON.parse(tombstone?.details ?? "{}").deleted.outbox).toBeGreaterThanOrEqual(1001);
  });

  it("fails, and changes nothing more, when its last batch fails for another reason", async () => {
    const s = await due();
    const failing = beforeBatch(/delete from "workspaces"/i, () =>
      Promise.reject(new Error("d1 down")),
    );
    await expect(purgeWorkspace(failing, s.workspaceId)).rejects.toThrow("d1 down");
    expect(await getWorkspace(db, s.workspaceId)).toMatchObject({ status: "purging" });
    expect(await purgeToEnd(s.workspaceId)).toBe("purged");
  });

  it("reports a deletion requested concurrently, and writes nothing more", async () => {
    const s = await shop();
    const concurrent = beforeBatch(/update "workspaces"/i, () =>
      env.DB.prepare(
        "UPDATE workspaces SET status = 'deleting', delete_after = ?, deletion_requested_by = 'other' WHERE id = ?",
      )
        .bind(clock.now() + 1, s.workspaceId)
        .run(),
    );
    expect(await requestDeletion(s, concurrent)).toEqual({ ok: false, reason: "not_active" });
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_events WHERE action = 'workspace.deletion_requested' AND workspace_id = ?",
        s.workspaceId,
      ),
    ).toBe(0);
  });

  it("finds nothing to refresh in a workspace that no longer exists", async () => {
    expect(
      await refreshSubscription(
        serviceContext(),
        { workspaceId: "no-such-workspace", source: "simulated", externalSubscriptionId: "x" },
        source,
      ),
    ).toEqual({ outcome: "absent", created: 0, updated: 0, ended: 0 });
  });
});

describe("queueLifecycleJobs", { timeout: 60_000 }, () => {
  it("queues one pruning run and a purge per due workspace, each once", async () => {
    const s = await shop();
    await requestDeletion(s);
    const notYet = await shop();
    clock.advance(WORKSPACE_DELETION_DELAY_MS);
    await requestDeletion(notYet);
    await queueLifecycleJobs(serviceContext());
    await queueLifecycleJobs(serviceContext());
    const pending = async (kind: string, subjectId: string) =>
      env.DB.prepare(
        `SELECT workspace_id, available_at, created_at FROM outbox
         WHERE kind = ? AND subject_id = ? AND sent_at IS NULL AND failed_at IS NULL`,
      )
        .bind(kind, subjectId)
        .all<{ workspace_id: string | null; available_at: number; created_at: number }>();
    const purges = (await pending("purge_workspace", s.workspaceId)).results;
    expect(purges).toHaveLength(1);
    expect(purges[0]?.workspace_id).toBeNull();
    expect(purges[0]?.available_at).toBeGreaterThanOrEqual(clock.now());
    expect(purges[0]?.available_at).toBeLessThan(clock.now() + DAY);
    expect((await pending("purge_workspace", notYet.workspaceId)).results).toEqual([]);
    expect((await pending("prune_data", "retention")).results).toHaveLength(1);
  });
});

describe("account deletion finds every subject of the GitHub account", { timeout: 60_000 }, () => {
  /** A buyer who claims the shop's unclaimed Paddle subscription by email, with live access. */
  async function claimed(
    p: PaddleShop,
    user: Awaited<ReturnType<typeof signedUpUser>>,
    email: string,
  ) {
    const token = await claimLinkToken(p, user, email);
    expect((await confirmClaim(serviceContext(), { token, user })).ok).toBe(true);
    await drainPaddle(p);
  }

  const customerSubject = async (p: PaddleShop, externalCustomerId: string) =>
    (
      await env.DB.prepare(
        "SELECT subject_id FROM customers WHERE workspace_id = ? AND external_customer_id = ?",
      )
        .bind(p.workspaceId, externalCustomerId)
        .first<{ subject_id: string | null }>()
    )?.subject_id;

  it("revokes access claimed again after a re-sign-up, on the second deletion", async () => {
    const p = await paddleShop();
    const customer = paddleCustomer(p);
    await deliverSubscription(p, "subscription.created", directSubscription(p, customer.id).id);
    const first = await signedUpUser();
    await claimed(p, first, customer.email);
    const githubId = first.profile.externalUserId;
    expect(await liveFor(p.workspaceId, githubId)).toHaveLength(1);
    const login = first.profile.username;
    expect(await deleteAccount(serviceContext(), first, { confirmation: login })).toMatchObject({
      ok: true,
    });
    expect(await liveFor(p.workspaceId, githubId)).toEqual([]);

    // The same GitHub account signs up again and claims again: the subject is the old one, which
    // names no user.
    const again = await signedUpUser(githubProfile({ externalUserId: githubId, username: login }));
    await claimed(p, again, customer.email);
    expect(await liveFor(p.workspaceId, githubId)).toHaveLength(1);

    const deleted = await deleteAccount(serviceContext(), again, { confirmation: login });
    expect(deleted).toMatchObject({ ok: true, unlinkedSubjects: 1 });
    expect(await liveFor(p.workspaceId, githubId)).toEqual([]);
    expect(await customerSubject(p, customer.id)).toBeNull();
  });

  it("revokes access a creator linked by hand to the account's GitHub login", async () => {
    const p = await paddleShop();
    const customer = paddleCustomer(p);
    await deliverSubscription(p, "subscription.created", directSubscription(p, customer.id).id);
    const user = await signedUpUser();
    p.github.addUser({
      id: user.profile.externalUserId,
      login: user.profile.username,
      type: "User",
    });
    const stored = await customerSubjectRow(p, customer.id);
    const linked = await linkCustomerManually(
      serviceContext(),
      p,
      p.slug,
      { customerId: stored.id, githubLogin: user.profile.username, reason: "Support ticket 42" },
      { github: p.github },
    );
    expect(linked).toMatchObject({ ok: true });
    await drainPaddle(p);
    expect(await liveFor(p.workspaceId, user.profile.externalUserId)).toHaveLength(1);

    await deleteAccount(serviceContext(), user, { confirmation: user.profile.username });
    expect(await liveFor(p.workspaceId, user.profile.externalUserId)).toEqual([]);
    expect(await customerSubject(p, customer.id)).toBeNull();
  });

  async function customerSubjectRow(p: PaddleShop, externalCustomerId: string) {
    return (await env.DB.prepare(
      "SELECT id FROM customers WHERE workspace_id = ? AND external_customer_id = ?",
    )
      .bind(p.workspaceId, externalCustomerId)
      .first<{ id: string }>()) as { id: string };
  }
});

describe("deletion/account-revokes-and-removes-identity", { timeout: 60_000 }, () => {
  /** A buyer whose subject in the shop is linked to their GitHub identity. */
  async function linkedBuyer(s: Shop, subject: SubjectRow, login: string) {
    const buyer = await signedUpUser(
      githubProfile({
        externalUserId: subject.external_subject_id as never,
        username: login as never,
      }),
    );
    await env.DB.prepare(
      `UPDATE subjects SET external_identity_id =
         (SELECT id FROM external_identities WHERE user_id = ?) WHERE id = ?`,
    )
      .bind(buyer.userId, subject.id)
      .run();
    // A claim request and a used checkout claim of theirs.
    await env.DB.prepare(
      `INSERT INTO claim_requests (id, workspace_id, user_id, email_hash, created_at, processed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        s.workspaceId,
        buyer.userId,
        "a".repeat(64),
        clock.now(),
        clock.now(),
      )
      .run();
    return buyer;
  }

  it("unlinks the buyer's subjects, revokes their access and deletes their identity", async () => {
    const { s, sub, subject } = await soldWithCollaborator();
    const buyer = await linkedBuyer(s, subject, sub.login);
    const ctx = serviceContext();
    const result = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      deleteAccount(ctx, buyer, { confirmation: sub.login.toUpperCase() }),
    );
    expect(result.result).toMatchObject({ ok: true, unlinkedSubjects: 1 });

    // The subject stays as the workspace's record of the GitHub account, linked to no user.
    expect(await subjectOf(s, sub.login)).toMatchObject({
      id: subject.id,
      external_identity_id: null,
    });
    expect(
      await count("SELECT count(*) AS n FROM customers WHERE subject_id = ?", subject.id),
    ).toBe(0);
    expect(await entitlementsOf(s.workspaceId, sub.id)).toMatchObject([
      { state: "revoked", decisionReason: "account_deleted" },
    ]);
    for (const [table, column] of [
      ["users", "id"],
      ["external_identities", "user_id"],
      ["claim_requests", "user_id"],
      ["workspace_memberships", "user_id"],
    ] as const) {
      expect(
        await count(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`, buyer.userId),
      ).toBe(0);
    }
    const events = await listAuditEventsByCorrelationId(db, ctx.correlationId);
    expect(events.map((e) => e.action)).toEqual([
      "subject.identity_unlinked",
      "customer.linked",
      "entitlement.ended",
      "user.deleted",
    ]);
    const deleted = events.at(-1);
    expect(deleted).toMatchObject({ scope: "account", target: { id: buyer.userId } });
    expect(deleted?.details).toMatchObject({
      unlinkedSubjects: 1,
      deleted: { users: 1, external_identities: 1, claim_requests: 1 },
    });
    // Counts and IDs only: never the login.
    expect(JSON.stringify(deleted?.details)).not.toContain(sub.login);

    // Reconciliation, queued with the unlinking, removes the collaborator.
    await reconcile(s);
    expect(collaborators(s)).toEqual([]);
    // The refresh that follows the unlinking keeps the access ended.
    await drain(s.workspaceId);
    expect(live(await entitlementsOf(s.workspaceId, sub.id))).toEqual([]);
  });

  it("is refused while the user owns a workspace that is not being deleted", async () => {
    const s = await shop();
    const view = await getAccountView(serviceContext(), s);
    expect(view.blockingWorkspaces).toEqual([{ slug: s.slug, name: "Shop", status: "active" }]);
    const login = view.login as string;
    expect(await deleteAccount(serviceContext(), s, { confirmation: login })).toEqual({
      ok: false,
      reason: "owns_workspaces",
      workspaces: [{ slug: s.slug, name: "Shop", status: "active" }],
    });
    // Once the workspace is being deleted, it no longer blocks; the purge outlives the owner.
    await requestDeletion(s);
    expect((await getAccountView(serviceContext(), s)).blockingWorkspaces).toEqual([]);
    const deleted = await deleteAccount(serviceContext(), s, { confirmation: login });
    expect(deleted).toMatchObject({ ok: true, deleted: { workspace_memberships: 1 } });
    // The workspace's history still names the owner (its connection), so the ID-only users row
    // stays until the purge; nothing else of the account does.
    expect(deleted.ok && deleted.deleted.users).toBe(0);
    expect(await count("SELECT count(*) AS n FROM users WHERE id = ?", s.userId)).toBe(1);
    expect(
      await count("SELECT count(*) AS n FROM external_identities WHERE user_id = ?", s.userId),
    ).toBe(0);
    clock.advance(WORKSPACE_DELETION_DELAY_MS);
    expect(await purgeToEnd(s.workspaceId)).toBe("purged");
  });

  it("refuses a confirmation that is not the user's login", async () => {
    const user = await signedUpUser();
    expect(await deleteAccount(serviceContext(), user, { confirmation: "someone-else" })).toEqual({
      ok: false,
      reason: "confirmation_mismatch",
    });
    const nobody: UserActor = { userId: "no-such-user" };
    expect(await deleteAccount(serviceContext(), nobody, { confirmation: "" })).toEqual({
      ok: false,
      reason: "confirmation_mismatch",
    });
    expect(await getAccountView(serviceContext(), nobody)).toEqual({
      login: null,
      blockingWorkspaces: [],
    });
  });

  it.each([1, 2])("converges when batch %i fails before or after it commits", async (n) => {
    for (const when of ["before", "after"] as const) {
      const { s, sub, subject } = await soldWithCollaborator();
      const buyer = await linkedBuyer(s, subject, sub.login);
      await expect(
        deleteAccount(crashingAt(n, when), buyer, { confirmation: sub.login }),
      ).rejects.toThrow("worker crashed");
      const rerun = await deleteAccount(serviceContext(), buyer, { confirmation: sub.login });
      // After a committed final batch the account is already gone: nothing is left to confirm.
      if (n === 2 && when === "after") {
        expect(rerun).toEqual({ ok: false, reason: "confirmation_mismatch" });
      } else {
        expect(rerun).toMatchObject({ ok: true });
      }
      expect(await count("SELECT count(*) AS n FROM users WHERE id = ?", buyer.userId)).toBe(0);
      expect(await subjectOf(s, sub.login)).toMatchObject({ external_identity_id: null });
      expect(await entitlementsOf(s.workspaceId, sub.id)).toMatchObject([
        { state: "revoked", decisionReason: "account_deleted" },
      ]);
      expect(
        await count(
          "SELECT count(*) AS n FROM audit_events WHERE action = 'user.deleted' AND target_id = ?",
          buyer.userId,
        ),
      ).toBe(1);
    }
  });
});
