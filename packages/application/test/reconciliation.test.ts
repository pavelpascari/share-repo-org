import { env } from "cloudflare:workers";
import {
  claimOutbox,
  claimReconcileLease,
  type Grant,
  getResource,
  getSimulatedSubscription,
  listAuditEventsByCorrelationId,
  listAuditEventsForWorkspace,
  listGrantsForResource,
  reconcileKey,
} from "@sharerepo/db";
import { INVITATION_LIFETIME_MS, RECONCILE_IDLE_MS, RECONCILE_POLL_MS } from "@sharerepo/domain";
import { GitHubApiError, type GitHubAppPort } from "@sharerepo/integrations";
import { createFakeGitHubApp, type FakeGitHubApp } from "@sharerepo/integrations/testing";
import { ConflictError, ForbiddenError, NotFoundError } from "@sharerepo/platform";
import {
  changedTables,
  expectAuditedChange,
  expectNoChangeOnFailure,
  snapshotTables,
  UNAUDITED_TABLES,
} from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import { simulatedSnapshot } from "../src/entitlement-source.ts";
import {
  createSimulatedSubscriber,
  decodeReconcileKey,
  type EntitlementSourcePort,
  encodeReconcileKey,
  listAccess,
  MUTATION_LEASE_RESERVE_MS,
  queueDueReconciles,
  RECONCILE_LEASE_MS,
  reconcileResource,
  refreshSubscription,
  requestReconcileNow,
  resyncConnection,
  retryGrant,
  type ServiceContext,
  type SourceSubscription,
} from "../src/index.ts";
import { consecutiveAttempt } from "../src/reconciliation.ts";
import {
  act,
  drain,
  failingBatches,
  githubUser,
  memberOf,
  offer,
  refreshRef,
  type Shop,
  SIMULATION,
  shop,
  subscribe,
} from "./support/commerce.ts";
import { clock, db, serviceContext } from "./support/context.ts";

const MINUTE = 60_000;

// Reconciliation (phase-4 plan § Reconciliation job), against the in-memory GitHub App. Each
// shop sells its first repository for `sim_pro`; the fake's invitations use the test clock.

async function sold(repositories = 1): Promise<Shop> {
  const s = await shop(repositories, createFakeGitHubApp({ clock }));
  await offer(s, { items: ["sim_pro"], resources: s.resources.slice(0, 1) });
  return s;
}

const resourceOf = (s: Shop) => s.resources[0] as (typeof s.resources)[number];
const repoName = (s: Shop) => resourceOf(s).nameSnapshot;
const ref = (s: Shop) => ({ workspaceId: s.workspaceId, resourceId: resourceOf(s).id });

const reconcile = (s: Shop, github: GitHubAppPort = s.github, ctx = serviceContext()) =>
  reconcileResource(ctx, ref(s), github);

interface SubjectRow {
  id: string;
  external_subject_id: string;
  login_snapshot: string;
}

const subjectOf = async (s: Shop, login: string) =>
  (await env.DB.prepare("SELECT * FROM subjects WHERE workspace_id = ? AND login_snapshot = ?")
    .bind(s.workspaceId, login)
    .first<SubjectRow>()) as SubjectRow;

/**
 * A subscriber to `sim_pro` whose refresh has run. The clock then moves on, so a run that starts
 * next starts after the refresh's reconcile request (a run releases due now when a request was
 * stamped at or after its start).
 */
async function subscriber(s: Shop) {
  const sub = await subscribe(s, { items: ["sim_pro"] });
  await drain(s.workspaceId);
  clock.advance(1);
  const subject = await subjectOf(s, sub.login);
  return { ...sub, userId: subject.external_subject_id, subjectId: subject.id };
}

const grantsOf = (s: Shop) => listGrantsForResource(db, ref(s));
const grantFor = async (s: Shop, subjectId: string) =>
  (await grantsOf(s)).find((g) => g.subjectId === subjectId) as Grant;

interface MutationRow {
  id: string;
  operation: string;
  status: string;
  error_code: string | null;
  retry_class: string | null;
  external_id: string | null;
  correlation_id: string;
}

async function mutationsOf(s: Shop): Promise<MutationRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM provider_mutations WHERE workspace_id = ? ORDER BY started_at, rowid",
  )
    .bind(s.workspaceId)
    .all<MutationRow>();
  return results;
}

const callsOf = (github: FakeGitHubApp, operation: string) =>
  github.calls.filter((call) => call.startsWith(`${operation}:`)).length;

const accessOf = (s: Shop) => s.github.repositoryAccess(repoName(s));

const actions = async (correlationId: string) =>
  (await listAuditEventsByCorrelationId(db, correlationId)).map((e) => e.action);

const resourceRow = async (s: Shop) =>
  (await getResource(db, ref(s))) as NonNullable<Awaited<ReturnType<typeof getResource>>>;

async function pendingOutbox(kind: string, subjectId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM outbox WHERE kind = ? AND subject_id = ? AND sent_at IS NULL AND failed_at IS NULL",
  )
    .bind(kind, subjectId)
    .first<{ n: number }>();
  return Number(row?.n);
}

/** Marks every pending outbox row of the shop sent, so later counts start from zero. */
async function settleOutbox(s: Shop) {
  await env.DB.prepare(
    "UPDATE outbox SET sent_at = ? WHERE sent_at IS NULL AND (subject_id LIKE ? OR subject_id = ?)",
  )
    .bind(clock.now(), `${s.workspaceId}:%`, s.connection.id)
    .run();
}

const withHooks = (github: FakeGitHubApp, hooks: Partial<GitHubAppPort>): GitHubAppPort => ({
  ...github,
  ...hooks,
});

const githubError = (
  kind: ConstructorParameters<typeof GitHubApiError>[0],
  details: ConstructorParameters<typeof GitHubApiError>[2] = {},
) => new GitHubApiError(kind, `GitHub call failed (test ${kind})`, details);

/** Every mutation has an `attempted` event and a final or resolved one; no event leaks secrets. */
async function expectMutationAuditComplete(s: Shop) {
  const events = await listAuditEventsForWorkspace(db, s.workspaceId);
  // Rows seeded by `spendBudget` stand for invitations from earlier runs, outside this test.
  for (const mutation of (await mutationsOf(s)).filter((m) => m.correlation_id !== "seed")) {
    const about = events.filter((e) => e.details.mutationId === mutation.id).map((e) => e.action);
    expect(about).toContain("provider.mutation_attempted");
    if (mutation.status !== "started") {
      expect(about.filter((a) => a !== "provider.mutation_attempted")).toHaveLength(1);
    }
  }
  const text = JSON.stringify(events);
  for (const secret of ["token", "ghs_", "BEGIN", "secret"]) expect(text).not.toContain(secret);
}

describe("reconcile keys", () => {
  it("encode as the database's reconcile key and decode back", () => {
    const key = { workspaceId: "ws_1", resourceId: "res_1" };
    expect(encodeReconcileKey(key)).toBe(reconcileKey("ws_1", "res_1"));
    expect(decodeReconcileKey(encodeReconcileKey(key))).toEqual({ ok: true, value: key });
    for (const bad of ["", "ws_1", ":res_1", "ws_1:", "ws_1:res_1:x"]) {
      expect(decodeReconcileKey(bad)).toEqual({ ok: false, error: "key_invalid" });
    }
    expect(() => encodeReconcileKey({ workspaceId: "a:b", resourceId: "r" })).toThrow();
  });
});

describe("reconcileResource", () => {
  it("invites, observes the acceptance, and removes the collaborator once the subscription ends", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    // The refresh that created the entitlement queued the repository's reconciliation.
    expect(await pendingOutbox("reconcile_resource", encodeReconcileKey(ref(s)))).toBe(1);

    const first = serviceContext();
    await expect(reconcile(s, s.github, first)).resolves.toBe("done");
    expect(accessOf(s).invitations).toMatchObject([{ inviteeId: sub.userId }]);
    const invited = await grantFor(s, sub.subjectId);
    expect(invited).toMatchObject({
      state: "pending_invitation",
      managed: true,
      externalGrantId: accessOf(s).invitations[0]?.id,
      expiresAt: clock.now() + INVITATION_LIFETIME_MS,
      lastAttemptAt: clock.now(),
    });
    expect(await mutationsOf(s)).toMatchObject([
      { operation: "invite", status: "succeeded", correlation_id: first.correlationId },
    ]);
    expect(await actions(first.correlationId)).toEqual([
      "provider.mutation_attempted",
      "provider.mutation_succeeded",
    ]);
    expect(await resourceRow(s)).toMatchObject({
      lastReconciledAt: clock.now(),
      nextReconcileAt: clock.now() + RECONCILE_POLL_MS,
      reconcileToken: null,
    });

    s.github.acceptInvitation(repoName(s), sub.userId);
    clock.advance(RECONCILE_POLL_MS);
    const second = serviceContext();
    await expect(reconcile(s, s.github, second)).resolves.toBe("done");
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "active", managed: true });
    expect(await actions(second.correlationId)).toEqual(["grant.observed"]);
    expect((await resourceRow(s)).nextReconcileAt).toBe(clock.now() + RECONCILE_IDLE_MS);

    await act(s, sub.id, "cancel_now");
    await drain(s.workspaceId);
    const third = serviceContext();
    await expect(reconcile(s, s.github, third)).resolves.toBe("done");
    expect(accessOf(s).collaborators).toEqual([]);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "absent", managed: false });
    expect(await actions(third.correlationId)).toEqual([
      "provider.mutation_attempted",
      "provider.mutation_succeeded",
      "grant.observed",
    ]);
    expect((await mutationsOf(s)).map((m) => [m.operation, m.status])).toEqual([
      ["invite", "succeeded"],
      ["remove_collaborator", "succeeded"],
    ]);
    await expectMutationAuditComplete(s);
  });

  it("invitation/pending-is-not-active", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    await reconcile(s);
    clock.advance(MINUTE);
    await reconcile(s);
    // The invitation is pending, not access: it is shown as waiting and never sent twice.
    expect(callsOf(s.github, "addCollaborator")).toBe(1);
    const [row] = (await listAccess(serviceContext(), s, s.slug)).rows;
    expect(row).toMatchObject({
      subjectId: sub.subjectId,
      grant: { state: "pending_invitation", managed: true },
      planned: { action: "wait", reason: "invitation_pending" },
    });
    // Ending the subscription cancels the pending invitation.
    await act(s, sub.id, "cancel_now");
    await drain(s.workspaceId);
    await reconcile(s);
    expect(accessOf(s).invitations).toEqual([]);
    expect((await mutationsOf(s)).map((m) => m.operation)).toEqual(["invite", "cancel_invitation"]);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "absent" });
  });

  it("provider/mutation-succeeds-response-lost", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    s.github.loseNextResponse("addCollaborator");
    await expect(reconcile(s)).resolves.toBe("done");
    // The invitation was created; the run's own observation settles the lost response.
    expect(accessOf(s).invitations).toHaveLength(1);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({
      state: "pending_invitation",
      managed: true,
      lastErrorCode: null,
    });
    expect(await mutationsOf(s)).toMatchObject([
      { operation: "invite", status: "failed", error_code: "provider_unavailable" },
    ]);
    clock.advance(RECONCILE_POLL_MS);
    await reconcile(s);
    expect(callsOf(s.github, "addCollaborator")).toBe(1);
    expect(accessOf(s).invitations).toHaveLength(1);
    await expectMutationAuditComplete(s);
  });

  it("crash/between-mutation-and-observation", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    // The invitation is sent, then the Worker dies before recording the outcome.
    const crashing = withHooks(s.github, {
      addCollaborator: async (...args) => {
        await s.github.addCollaborator(...args);
        throw new Error("worker crashed");
      },
    });
    await expect(reconcile(s, crashing)).rejects.toThrow("worker crashed");
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "provisioning" });
    expect(await mutationsOf(s)).toMatchObject([{ operation: "invite", status: "started" }]);
    // Until the lease expires, another run is turned away.
    await expect(reconcile(s)).resolves.toBe("busy");

    clock.advance(RECONCILE_LEASE_MS);
    const next = serviceContext();
    await expect(reconcile(s, s.github, next)).resolves.toBe("done");
    expect(callsOf(s.github, "addCollaborator")).toBe(1);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({
      state: "pending_invitation",
      managed: true,
    });
    expect(await mutationsOf(s)).toMatchObject([{ operation: "invite", status: "resolved" }]);
    expect(await actions(next.correlationId)).toEqual([
      "grant.observed",
      "provider.mutation_resolved",
    ]);
    await expectMutationAuditComplete(s);
  });

  it("crash/between-mutation-and-observation: an intent whose call never went out is provisioned again", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    const dying = withHooks(s.github, {
      getUserById: () => Promise.reject(new Error("worker crashed")),
    });
    await expect(reconcile(s, dying)).rejects.toThrow("worker crashed");
    // Within the observation grace the intent stands; after it, nothing listed means it never
    // landed, and the next run invites.
    clock.advance(RECONCILE_LEASE_MS);
    await reconcile(s);
    expect(callsOf(s.github, "addCollaborator")).toBe(0);
    clock.advance(5 * MINUTE);
    await reconcile(s);
    expect(accessOf(s).invitations).toHaveLength(1);
    expect((await mutationsOf(s)).map((m) => [m.operation, m.status])).toEqual([
      ["invite", "resolved"],
      ["invite", "succeeded"],
    ]);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "pending_invitation" });
  });

  it("propagates a failure that is not GitHub's while observing, leaving the lease to expire", async () => {
    const s = await sold();
    await subscriber(s);
    const broken = withHooks(s.github, {
      listInvitations: () => Promise.reject(new Error("bug")),
    });
    await expect(reconcile(s, broken)).rejects.toThrow("bug");
    expect((await resourceRow(s)).reconcileToken).not.toBeNull();
  });

  it("identity/unlink-relink-moves-subject-safely", async () => {
    const s = await sold();
    const old = await subscriber(s);
    await reconcile(s);
    s.github.acceptInvitation(repoName(s), old.userId);
    clock.advance(MINUTE);
    await reconcile(s);

    // The customer is relinked to another GitHub account.
    const row = await getSimulatedSubscription(db, { workspaceId: s.workspaceId, id: old.id });
    if (row === null) throw new Error("setup");
    const answer = simulatedSnapshot(row);
    if (!answer.found) throw new Error("setup");
    const next = githubUser(s);
    const relinked: SourceSubscription = {
      ...answer,
      snapshot: { ...answer.snapshot, sourceUpdatedAt: answer.snapshot.sourceUpdatedAt + 1 },
      customerLink: { provider: "github", externalSubjectId: next.id, login: next.login },
    };
    const replaying: EntitlementSourcePort = {
      source: "simulated",
      refreshSubscription: async () => relinked,
    };
    await refreshSubscription(serviceContext(), refreshRef(s, old.id), replaying);
    expect(await pendingOutbox("reconcile_resource", encodeReconcileKey(ref(s)))).toBe(1);

    clock.advance(MINUTE);
    await reconcile(s);
    const newSubject = await subjectOf(s, next.login);
    expect(accessOf(s)).toMatchObject({
      collaborators: [],
      invitations: [{ inviteeId: next.id }],
    });
    expect(await grantFor(s, old.subjectId)).toMatchObject({ state: "absent", managed: false });
    expect(await grantFor(s, newSubject.id)).toMatchObject({
      state: "pending_invitation",
      managed: true,
    });
  });

  it("resource/selection-removed-blocks-new-provisioning", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    await settleOutbox(s);
    s.github.removeRepository(s.installationId, resourceOf(s).externalId);
    await resyncConnection(serviceContext(), s.connection, s.github, "test");
    expect(await pendingOutbox("reconcile_resource", encodeReconcileKey(ref(s)))).toBe(1);

    const before = s.github.calls.length;
    await expect(reconcile(s)).resolves.toBe("done");
    // Not selected: GitHub is not even asked, and nothing is sent.
    expect(s.github.calls.length).toBe(before);
    const [row] = (await listAccess(serviceContext(), s, s.slug)).rows;
    expect(row).toMatchObject({
      subjectId: sub.subjectId,
      grant: null,
      planned: { action: "blocked", reason: "resource_unavailable" },
      resourceLastReconciledAt: clock.now(),
    });
  });

  it("connection/suspended-installation-surfaces-error", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    await settleOutbox(s);
    s.github.suspend(s.installationId, clock.now());
    await expect(reconcile(s)).resolves.toBe("done");
    expect(callsOf(s.github, "addCollaborator")).toBe(0);
    // The run stops and queues a resync, which records the suspension and queues reconciliation.
    expect(await pendingOutbox("resync_connection", s.connection.id)).toBe(1);
    expect((await resourceRow(s)).nextReconcileAt).toBe(clock.now() + RECONCILE_IDLE_MS);
    await resyncConnection(serviceContext(), s.connection, s.github, "outbox");
    expect(await pendingOutbox("reconcile_resource", encodeReconcileKey(ref(s)))).toBe(1);
    await reconcile(s);
    const [row] = (await listAccess(serviceContext(), s, s.slug)).rows;
    expect(row).toMatchObject({
      subjectId: sub.subjectId,
      planned: { action: "blocked", reason: "connection_inactive" },
    });
  });

  it("connection/suspended-installation-surfaces-error: a suspension mid-run leaves the grant as it was", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    await settleOutbox(s);
    s.github.failNext("addCollaborator", githubError("suspended", { status: 403 }));
    const ctx = serviceContext();
    await reconcile(s, s.github, ctx);
    expect(await mutationsOf(s)).toMatchObject([
      { operation: "invite", status: "failed", error_code: "suspended", retry_class: "retryable" },
    ]);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "absent", managed: false });
    expect(await pendingOutbox("resync_connection", s.connection.id)).toBe(1);
    const failed = (await listAuditEventsByCorrelationId(db, ctx.correlationId)).find(
      (e) => e.action === "provider.mutation_failed",
    );
    expect(failed?.details).toMatchObject({ errorCode: "suspended", retryClass: null });

    // An active grant being revoked is restored as it was, too.
    clock.advance(MINUTE);
    await reconcile(s);
    s.github.acceptInvitation(repoName(s), sub.userId);
    clock.advance(MINUTE);
    await reconcile(s);
    await act(s, sub.id, "cancel_now");
    await drain(s.workspaceId);
    s.github.failNext("removeCollaborator", githubError("suspended", { status: 403 }));
    await reconcile(s);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "active", managed: true });
    await expectMutationAuditComplete(s);
  });

  it("queues a resync when the repository is gone or renamed", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    await settleOutbox(s);
    s.github.renameRepository(s.installationId, resourceOf(s).externalId, `${repoName(s)}-new`);
    await expect(reconcile(s)).resolves.toBe("done");
    expect(await pendingOutbox("resync_connection", s.connection.id)).toBe(1);
    expect((await resourceRow(s)).nextReconcileAt).toBe(clock.now() + RECONCILE_POLL_MS);

    // Renamed between the observation and the invitation: the run stops and resyncs too.
    await settleOutbox(s);
    clock.advance(RECONCILE_POLL_MS);
    await resyncConnection(serviceContext(), s.connection, s.github, "outbox");
    const renamed = withHooks(s.github, {
      addCollaborator: () =>
        Promise.reject(githubError("not_found", { status: 404, target: "repository" })),
    });
    await reconcileResource(serviceContext(), ref(s), renamed);
    expect(await mutationsOf(s)).toMatchObject([
      { operation: "invite", status: "failed", error_code: "repository_not_found" },
    ]);
    expect(await pendingOutbox("resync_connection", s.connection.id)).toBe(1);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "absent" });
  });

  it("invitation/expired-is-reissued-or-surfaced", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    await reconcile(s);
    const [first] = accessOf(s).invitations;
    s.github.expireInvitation(repoName(s), first?.id as string);
    clock.advance(MINUTE);
    await reconcile(s);
    // The lapsed invitation is cancelled, then a new one is sent.
    const [second] = accessOf(s).invitations;
    expect(accessOf(s).invitations).toHaveLength(1);
    expect(second?.id).not.toBe(first?.id);
    expect((await mutationsOf(s)).map((m) => [m.operation, m.status, m.external_id])).toEqual([
      ["invite", "succeeded", first?.id],
      ["cancel_invitation", "succeeded", first?.id],
      ["invite", "succeeded", second?.id],
    ]);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({
      state: "pending_invitation",
      managed: true,
      externalGrantId: second?.id,
    });

    // With the invitation budget spent, a lapsed invitation is surfaced and waits.
    await spendBudget(s, sub.subjectId);
    s.github.expireInvitation(repoName(s), second?.id as string);
    clock.advance(MINUTE);
    await reconcile(s);
    expect(callsOf(s.github, "cancelInvitation")).toBe(1);
    const [row] = (await listAccess(serviceContext(), s, s.slug)).rows;
    expect(row).toMatchObject({
      grant: { state: "pending_invitation", expiresAt: clock.now() },
      planned: { action: "wait", reason: "invitation_quota" },
    });
    await expectMutationAuditComplete(s);
  });

  it("provider/rate-limit-backs-off-and-retries", async () => {
    const s = await sold();
    const one = await subscriber(s);
    const two = await subscriber(s);
    const [first, second] = [one, two].sort((a, b) => (a.subjectId < b.subjectId ? -1 : 1));
    s.github.failNext(
      "addCollaborator",
      githubError("rate_limited", { status: 429, retryAfterMs: 2 * MINUTE }),
    );
    await reconcile(s);
    // The limit stops the run: the second subscriber is not tried.
    expect(callsOf(s.github, "addCollaborator")).toBe(1);
    expect(await grantFor(s, first?.subjectId as string)).toMatchObject({
      state: "error",
      lastErrorCode: "rate_limited",
      retryClass: "rate_limited",
      nextAttemptAt: clock.now() + 2 * MINUTE,
    });
    expect((await resourceRow(s)).nextReconcileAt).toBe(clock.now() + 2 * MINUTE);
    const rows = (await listAccess(serviceContext(), s, s.slug)).rows;
    expect(rows.find((r) => r.subjectId === first?.subjectId)).toMatchObject({
      grant: { retryClass: "rate_limited", nextAttemptAt: clock.now() + 2 * MINUTE },
      planned: { action: "wait", reason: "rate_limited" },
    });

    // Not before GitHub's reset.
    clock.advance(MINUTE);
    await reconcile(s);
    expect(callsOf(s.github, "addCollaborator")).toBe(2);
    expect(await grantFor(s, second?.subjectId as string)).toMatchObject({
      state: "pending_invitation",
    });
    clock.advance(MINUTE);
    await reconcile(s);
    expect(accessOf(s).invitations).toHaveLength(2);
    await expectMutationAuditComplete(s);
  });

  it("provider/rate-limit-backs-off-and-retries: an observation that is limited waits for the reset", async () => {
    const s = await sold();
    await subscriber(s);
    const lastError = async () =>
      (await listAccess(serviceContext(), s, s.slug)).rows[0]?.resourceLastReconcileError;
    expect(await lastError()).toBeNull();
    s.github.failNext(
      "listInvitations",
      githubError("rate_limited", { status: 403, retryAfterMs: 3 * MINUTE }),
    );
    await expect(reconcile(s)).resolves.toBe("done");
    expect(await grantsOf(s)).toEqual([]);
    expect(await resourceRow(s)).toMatchObject({
      nextReconcileAt: clock.now() + 3 * MINUTE,
      reconcileFailures: 1,
      lastReconcileError: "rate_limited",
    });
    expect(await lastError()).toBe("rate_limited");

    // Consecutive failures back off (1, 5, 15, 60 minutes), however GitHub fails.
    clock.advance(3 * MINUTE);
    s.github.failNext("listCollaborators", githubError("malformed_response"));
    await reconcile(s);
    expect(await resourceRow(s)).toMatchObject({
      nextReconcileAt: clock.now() + 5 * MINUTE,
      reconcileFailures: 2,
      lastReconcileError: "malformed_response",
    });
    clock.advance(5 * MINUTE);
    s.github.failNext("listCollaborators", githubError("rejected", { status: 401 }));
    await reconcile(s);
    expect(await resourceRow(s)).toMatchObject({
      nextReconcileAt: clock.now() + 15 * MINUTE,
      reconcileFailures: 3,
      lastReconcileError: "provider_rejected",
    });
    expect(await lastError()).toBe("provider_rejected");

    // A rate limit waits at least the backoff its failure count has reached.
    clock.advance(15 * MINUTE);
    s.github.failNext("listInvitations", githubError("rate_limited", { retryAfterMs: MINUTE }));
    await reconcile(s);
    expect((await resourceRow(s)).nextReconcileAt).toBe(clock.now() + 60 * MINUTE);

    // A successful observation clears both.
    clock.advance(60 * MINUTE);
    await reconcile(s);
    expect(await resourceRow(s)).toMatchObject({ reconcileFailures: 0, lastReconcileError: null });
    expect(await lastError()).toBeNull();
  });

  it("connection/suspended-installation-surfaces-error: an installation that is gone resyncs and waits", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    await settleOutbox(s);
    s.github.failNext(
      "listCollaborators",
      githubError("not_found", { status: 404, target: "installation" }),
    );
    await reconcile(s);
    expect(await resourceRow(s)).toMatchObject({
      nextReconcileAt: clock.now() + RECONCILE_IDLE_MS,
      lastReconcileError: "installation_missing",
    });
    expect(await pendingOutbox("resync_connection", s.connection.id)).toBe(1);

    // Gone between the observation and the invitation: the run stops and resyncs too.
    await settleOutbox(s);
    clock.advance(MINUTE);
    s.github.failNext(
      "addCollaborator",
      githubError("not_found", { status: 404, target: "installation" }),
    );
    await reconcile(s);
    expect(await mutationsOf(s)).toMatchObject([
      { operation: "invite", status: "failed", error_code: "installation_missing" },
    ]);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "absent", managed: false });
    expect(await pendingOutbox("resync_connection", s.connection.id)).toBe(1);
    expect((await resourceRow(s)).lastReconcileError).toBeNull();
  });

  it("provider/transient-error-retries", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    s.github.failNext("addCollaborator", githubError("transient", { status: 502 }));
    await reconcile(s);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({
      state: "error",
      lastErrorCode: "provider_unavailable",
      retryClass: "retryable",
      nextAttemptAt: clock.now() + MINUTE,
    });
    // Waiting: nothing is sent before the retry time.
    await reconcile(s);
    expect(callsOf(s.github, "addCollaborator")).toBe(1);

    // The second consecutive failure waits five minutes.
    clock.advance(MINUTE);
    s.github.failNext("addCollaborator", githubError("transient", { status: 503 }));
    await reconcile(s);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({
      state: "error",
      nextAttemptAt: clock.now() + 5 * MINUTE,
    });
    clock.advance(5 * MINUTE);
    await reconcile(s);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({
      state: "pending_invitation",
      lastErrorCode: null,
      retryClass: null,
      nextAttemptAt: null,
    });
    await expectMutationAuditComplete(s);
  });

  it("provider/outage-recovers-on-scheduled-reconcile", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    let down = true;
    const outage = (fn: (...args: never[]) => Promise<unknown>) =>
      ((...args: never[]) =>
        down ? Promise.reject(githubError("transient", { status: 503 })) : fn(...args)) as never;
    const flaky = withHooks(s.github, {
      listCollaborators: outage(s.github.listCollaborators),
      listInvitations: outage(s.github.listInvitations),
      getUserById: outage(s.github.getUserById),
      addCollaborator: outage(s.github.addCollaborator),
    });
    await reconcile(s, flaky);
    expect((await resourceRow(s)).nextReconcileAt).toBe(clock.now() + MINUTE);

    // GitHub is back; the minute sweep queues the due repository, and its run converges.
    down = false;
    await settleOutbox(s);
    clock.advance(MINUTE);
    expect(await queueDueReconciles(serviceContext(), { limit: 1000 })).toBeGreaterThan(0);
    expect(await pendingOutbox("reconcile_resource", encodeReconcileKey(ref(s)))).toBe(1);
    await reconcile(s, flaky);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "pending_invitation" });
  });

  it("drift/manual-removal-is-repaired", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    await reconcile(s);
    s.github.acceptInvitation(repoName(s), sub.userId);
    clock.advance(MINUTE);
    await reconcile(s);
    s.github.removeCollaboratorByHand(repoName(s), sub.userId);
    clock.advance(MINUTE);
    const ctx = serviceContext();
    await reconcile(s, s.github, ctx);
    // Observed gone (no longer managed), and invited again (managed again).
    expect(accessOf(s).invitations).toMatchObject([{ inviteeId: sub.userId }]);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({
      state: "pending_invitation",
      managed: true,
    });
    expect(await actions(ctx.correlationId)).toEqual([
      "grant.observed",
      "provider.mutation_attempted",
      "provider.mutation_succeeded",
    ]);
  });

  it("drift/unmanaged-access-is-not-revoked", async () => {
    const s = await sold();
    const user = githubUser(s);
    // The creator added the subscriber by hand (read access) before they subscribed.
    s.github.addCollaboratorByHand(repoName(s), user, "read");
    const created = await createSimulatedSubscriber(
      serviceContext(),
      s,
      s.slug,
      { login: user.login, items: ["sim_pro"], state: "active", periodDays: 30 },
      { github: s.github, ...SIMULATION },
    );
    if (!created.ok) throw new Error(created.error);
    await drain(s.workspaceId);
    const subject = await subjectOf(s, user.login);
    await reconcile(s);
    expect(callsOf(s.github, "addCollaborator")).toBe(0);
    expect(await grantFor(s, subject.id)).toMatchObject({
      state: "active",
      managed: false,
      accessLevel: "read",
    });
    expect((await listAccess(serviceContext(), s, s.slug)).rows[0]?.planned).toEqual({
      action: "blocked",
      reason: "unmanaged_lower_access",
    });

    await act(s, created.subscription.id, "cancel_now");
    await drain(s.workspaceId);
    await reconcile(s);
    expect(callsOf(s.github, "removeCollaborator")).toBe(0);
    expect(accessOf(s).collaborators).toMatchObject([{ id: user.id }]);
    expect((await listAccess(serviceContext(), s, s.slug)).rows[0]?.planned).toEqual({
      action: "noop",
      reason: "unmanaged_access",
    });
  });

  it("drift/indirect-access-reported-accurately", async () => {
    const s = await sold();
    // The creator subscribes to their own repository: GitHub lists them as its owner only.
    const created = await createSimulatedSubscriber(
      serviceContext(),
      s,
      s.slug,
      {
        login: repoName(s).split("/")[0] as string,
        items: ["sim_pro"],
        state: "active",
        periodDays: 30,
      },
      { github: s.github, ...SIMULATION },
    );
    if (!created.ok) throw new Error(created.error);
    await drain(s.workspaceId);
    await reconcile(s);
    expect(callsOf(s.github, "addCollaborator")).toBe(0);
    const [row] = (await listAccess(serviceContext(), s, s.slug)).rows;
    expect(row).toMatchObject({
      grant: { state: "active", managed: false, indirect: true, accessLevel: "write" },
      planned: { action: "verify", reason: "grant_active" },
    });

    await act(s, created.subscription.id, "cancel_now");
    await drain(s.workspaceId);
    await reconcile(s);
    expect(callsOf(s.github, "removeCollaborator")).toBe(0);
    expect((await listAccess(serviceContext(), s, s.slug)).rows[0]?.planned).toEqual({
      action: "noop",
      reason: "indirect_access",
    });
  });

  it("records a collaborator added by hand between the observation and the invitation as unmanaged", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    const racing = withHooks(s.github, {
      addCollaborator: async (...args) => {
        s.github.addCollaboratorByHand(repoName(s), { id: sub.userId, login: sub.login });
        return s.github.addCollaborator(...args);
      },
    });
    await reconcile(s, racing);
    // GitHub answered 204: it created nothing, so the access is the creator's (decision 0010).
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "active", managed: false });
    expect(await mutationsOf(s)).toMatchObject([{ operation: "invite", status: "succeeded" }]);

    // When the subscription ends, ShareRepo leaves it alone.
    await act(s, sub.id, "cancel_now");
    await drain(s.workspaceId);
    clock.advance(MINUTE);
    await reconcile(s);
    expect(callsOf(s.github, "removeCollaborator")).toBe(0);
    expect(accessOf(s).collaborators.map((c) => c.id)).toContain(sub.userId);
    await expectMutationAuditComplete(s);
  });

  it("leaves access the creator gives back by hand after ShareRepo removed it", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    await reconcile(s);
    s.github.acceptInvitation(repoName(s), sub.userId);
    clock.advance(MINUTE);
    await reconcile(s);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "active", managed: true });
    await act(s, sub.id, "cancel_now");
    await drain(s.workspaceId);
    // The removal lands, then the creator adds the person back before GitHub's lists are read.
    const readded = withHooks(s.github, {
      removeCollaborator: async (...args) => {
        const removed = await s.github.removeCollaborator(...args);
        s.github.addCollaboratorByHand(repoName(s), { id: sub.userId, login: sub.login });
        return removed;
      },
    });
    clock.advance(MINUTE);
    await reconcile(s, readded);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "revoking" });
    // Past the grace window, the access listed is the creator's: never removed again.
    clock.advance(RECONCILE_POLL_MS);
    await reconcile(s);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "active", managed: false });
    expect(callsOf(s.github, "removeCollaborator")).toBe(1);
    clock.advance(RECONCILE_POLL_MS);
    await reconcile(s);
    expect(callsOf(s.github, "removeCollaborator")).toBe(1);
    expect(accessOf(s).collaborators.map((c) => c.id)).toContain(sub.userId);
  });

  it("leaves an invitation GitHub accepted after refusing ShareRepo's unmanaged", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    s.github.failNext("addCollaborator", githubError("rejected", { status: 422 }));
    await reconcile(s);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({
      state: "error",
      lastErrorCode: "invitation_rejected",
    });
    // The creator invites the person by hand.
    await s.github.addCollaborator(s.installationId, repoName(s), sub.login);
    clock.advance(MINUTE);
    await reconcile(s);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({
      state: "pending_invitation",
      managed: false,
    });
  });

  it("does not cancel a lapsed invitation the creator sent by hand", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    await s.github.addCollaborator(s.installationId, repoName(s), sub.login);
    const [byHand] = accessOf(s).invitations;
    s.github.expireInvitation(repoName(s), byHand?.id as string);
    await reconcile(s);
    expect(callsOf(s.github, "cancelInvitation")).toBe(0);
    expect((await mutationsOf(s)).map((m) => m.operation)).toEqual(["invite"]);
  });

  it("a subscription that ends while a run holds the repository is reconciled again at once", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    const key = encodeReconcileKey(ref(s));
    // The run's own row stays pending until its delivery completes.
    expect(await pendingOutbox("reconcile_resource", key)).toBe(1);
    let ended = false;
    const midRun = withHooks(s.github, {
      addCollaborator: async (...args) => {
        const result = await s.github.addCollaborator(...args);
        if (!ended) {
          ended = true;
          clock.advance(1);
          await act(s, sub.id, "cancel_now");
          await drain(s.workspaceId);
        }
        return result;
      },
    });
    await reconcile(s, midRun);
    // The refresh's reconcile row was deduplicated behind the run's ...
    expect(await pendingOutbox("reconcile_resource", key)).toBe(1);
    expect(accessOf(s).invitations).toHaveLength(1);
    // ... but the run, which planned before it, schedules the repository now, not in 15 minutes.
    expect((await resourceRow(s)).nextReconcileAt).toBe(clock.now());
    await settleOutbox(s);
    expect(await queueDueReconciles(serviceContext(), { limit: 1000 })).toBeGreaterThan(0);
    expect(await pendingOutbox("reconcile_resource", key)).toBe(1);
    await reconcile(s);
    expect(accessOf(s).invitations).toEqual([]);
  });

  it("a request acked behind a run that crashed is swept once the lease expires", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    await reconcile(s);
    await settleOutbox(s);
    const key = encodeReconcileKey(ref(s));
    // The next run is scheduled ahead; a run starts (early, by "Check now") and crashes.
    expect((await resourceRow(s)).nextReconcileAt).toBeGreaterThan(clock.now());
    clock.advance(1);
    const crashing = withHooks(s.github, {
      listCollaborators: async () => {
        throw new Error("worker crashed");
      },
    });
    await expect(reconcile(s, crashing)).rejects.toThrow("worker crashed");
    // The subscription ends meanwhile; its reconcile is delivered, finds the lease, and is acked.
    clock.advance(1);
    await act(s, sub.id, "cancel_now");
    await drain(s.workspaceId);
    await expect(reconcile(s)).resolves.toBe("busy");
    await settleOutbox(s);
    await queueDueReconciles(serviceContext(), { limit: 1000 });
    expect(await pendingOutbox("reconcile_resource", key)).toBe(0);
    // Once the crashed run's lease expires, the sweep queues the repository.
    clock.advance(RECONCILE_LEASE_MS);
    await queueDueReconciles(serviceContext(), { limit: 1000 });
    expect(await pendingOutbox("reconcile_resource", key)).toBe(1);
    await reconcile(s);
    expect(accessOf(s).invitations).toEqual([]);
  });

  it("stamps each mutation with the time it is sent and finished", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    // The observation takes a second, the invitation five.
    const start = clock.now() + 1_000;
    const slow = withHooks(s.github, {
      listInvitations: async (...args) => {
        clock.advance(1_000);
        return s.github.listInvitations(...args);
      },
      addCollaborator: async (...args) => {
        clock.advance(5_000);
        return s.github.addCollaborator(...args);
      },
    });
    await reconcile(s, slow);
    const mutation = await env.DB.prepare(
      "SELECT started_at AS startedAt, finished_at AS finishedAt FROM provider_mutations WHERE workspace_id = ?",
    )
      .bind(s.workspaceId)
      .first<{ startedAt: number; finishedAt: number }>();
    expect(mutation).toEqual({ startedAt: start, finishedAt: start + 5_000 });
    const grant = await grantFor(s, sub.subjectId);
    expect(grant.lastAttemptAt).toBe(start);
    const events = await listAuditEventsForWorkspace(db, s.workspaceId);
    const at = (action: string) => events.find((e) => e.action === action)?.occurredAt;
    expect(at("provider.mutation_attempted")).toBe(start);
    expect(at("provider.mutation_succeeded")).toBe(start + 5_000);

    // A failure's backoff counts from the attempt, so consecutive failures still escalate.
    const other = await subscriber(s);
    const failing = withHooks(s.github, {
      addCollaborator: async () => {
        clock.advance(5_000);
        throw githubError("transient", { status: 502 });
      },
    });
    const attempt = clock.now();
    await reconcile(s, failing);
    expect(await grantFor(s, other.subjectId)).toMatchObject({
      state: "error",
      lastAttemptAt: attempt,
      nextAttemptAt: attempt + MINUTE,
    });
    clock.advance(MINUTE);
    const second = clock.now();
    await reconcile(s, failing);
    expect(await grantFor(s, other.subjectId)).toMatchObject({
      lastAttemptAt: second,
      nextAttemptAt: second + 5 * MINUTE,
    });
  });

  it("sends nothing once too little of the lease is left, and schedules the rest now", async () => {
    const s = await sold();
    for (let i = 0; i < 3; i += 1) await subscriber(s);
    const start = clock.now();
    // After one slow invitation enough of the lease is left for another; after two, not.
    const step = (RECONCILE_LEASE_MS - MUTATION_LEASE_RESERVE_MS) * 0.6;
    const slow = withHooks(s.github, {
      addCollaborator: async (...args) => {
        clock.advance(step);
        return s.github.addCollaborator(...args);
      },
    });
    expect(start + 2 * step + MUTATION_LEASE_RESERVE_MS).toBeGreaterThan(
      start + RECONCILE_LEASE_MS,
    );
    expect(start + step + MUTATION_LEASE_RESERVE_MS).toBeLessThanOrEqual(
      start + RECONCILE_LEASE_MS,
    );
    await reconcile(s, slow);
    expect(callsOf(s.github, "addCollaborator")).toBe(2);
    expect((await mutationsOf(s)).map((m) => m.status)).toEqual(["succeeded", "succeeded"]);
    // Due already: the run's own start.
    expect((await resourceRow(s)).nextReconcileAt).toBe(start);
    await reconcile(s);
    expect(accessOf(s).invitations).toHaveLength(3);
  });

  it("re-resolves the login before inviting, recording a rename", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    const renamed = `${sub.login}-renamed`;
    s.github.addUser({ id: sub.userId, login: renamed, type: "User" });
    const github = withHooks(s.github, {
      getUserById: async (_installationId, id) => ({ id, login: renamed, type: "User" }),
    });
    const ctx = serviceContext();
    await reconcile(s, github, ctx);
    expect(accessOf(s).invitations).toMatchObject([{ inviteeLogin: renamed }]);
    expect((await subjectOf(s, renamed)).id).toBe(sub.subjectId);
    expect(await actions(ctx.correlationId)).toContain("subject.login_updated");
  });

  it("surfaces an account that is gone, and a rejected invitation, for a person to act on", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    s.github.failNext("getUserById", githubError("not_found", { status: 404 }));
    await reconcile(s);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({
      state: "error",
      lastErrorCode: "account_not_found",
      retryClass: "user_action_required",
      nextAttemptAt: null,
    });
    expect((await listAccess(serviceContext(), s, s.slug)).rows[0]?.planned).toEqual({
      action: "request_action",
      reason: "user_action_required",
    });

    // Once the subscription ends, the errored grant is settled: nothing to remove.
    await act(s, sub.id, "cancel_now");
    await drain(s.workspaceId);
    clock.advance(MINUTE);
    await reconcile(s);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "absent", managed: false });
    expect((await mutationsOf(s)).map((m) => [m.operation, m.status])).toEqual([
      ["invite", "failed"],
      ["remove_collaborator", "succeeded"],
    ]);
  });

  it("counts removing an account that is gone as done", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    await reconcile(s);
    s.github.acceptInvitation(repoName(s), sub.userId);
    clock.advance(MINUTE);
    await reconcile(s);
    await act(s, sub.id, "cancel_now");
    await drain(s.workspaceId);
    s.github.failNext("getUserById", githubError("not_found", { status: 404 }));
    await reconcile(s);
    expect(callsOf(s.github, "removeCollaborator")).toBe(0);
    expect((await mutationsOf(s)).at(-1)).toMatchObject({
      operation: "remove_collaborator",
      status: "succeeded",
    });
    // GitHub still lists them for now; observation settles the grant once its lists agree.
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "revoking", managed: true });
  });

  it("resync queues reconciliation of repositories whose eligibility changed", async () => {
    const s = await shop(2, createFakeGitHubApp({ clock }));
    const [opened, renamed] = s.resources as [Shop["resources"][0], Shop["resources"][0]];
    const key = (id: string) => encodeReconcileKey({ workspaceId: s.workspaceId, resourceId: id });
    s.github.setRepositories(
      s.installationId,
      s.resources.map((r) => ({
        externalId: r.externalId,
        name: r.id === renamed.id ? `${r.nameSnapshot}-new` : r.nameSnapshot,
        ownerExternalId: r.ownerExternalId,
        ownerType: "User" as const,
        private: r.id !== opened.id,
        archived: false,
      })),
    );
    await resyncConnection(serviceContext(), s.connection, s.github, "test");
    // A rename changes nothing about who may have access.
    expect(await pendingOutbox("reconcile_resource", key(opened.id))).toBe(1);
    expect(await pendingOutbox("reconcile_resource", key(renamed.id))).toBe(0);

    await settleOutbox(s);
    s.github.suspend(s.installationId, clock.now());
    await resyncConnection(serviceContext(), s.connection, s.github, "test");
    expect(await pendingOutbox("reconcile_resource", key(opened.id))).toBe(1);
    expect(await pendingOutbox("reconcile_resource", key(renamed.id))).toBe(1);
  });

  it("backs off a failed revocation, then retries it", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    await reconcile(s);
    s.github.acceptInvitation(repoName(s), sub.userId);
    clock.advance(MINUTE);
    await reconcile(s);
    await act(s, sub.id, "cancel_now");
    await drain(s.workspaceId);
    s.github.failNext("removeCollaborator", githubError("transient", { status: 500 }));
    await reconcile(s);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({
      state: "error",
      managed: true,
      retryClass: "retryable",
    });
    await reconcile(s);
    expect(callsOf(s.github, "removeCollaborator")).toBe(1);
    clock.advance(MINUTE);
    await reconcile(s);
    expect(accessOf(s).collaborators).toEqual([]);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "absent" });
  });

  it("sends at most ten changes per run and schedules the rest now", async () => {
    const s = await sold();
    const subs = [];
    for (let i = 0; i < 11; i += 1) subs.push(await subscriber(s));
    await reconcile(s);
    expect(callsOf(s.github, "addCollaborator")).toBe(10);
    expect((await resourceRow(s)).nextReconcileAt).toBe(clock.now());
    await reconcile(s);
    expect(accessOf(s).invitations).toHaveLength(11);

    for (const sub of subs) await act(s, sub.id, "cancel_now");
    await drain(s.workspaceId);
    await reconcile(s);
    expect(callsOf(s.github, "cancelInvitation")).toBe(10);
    expect((await resourceRow(s)).nextReconcileAt).toBe(clock.now());
    await reconcile(s);
    expect(accessOf(s).invitations).toEqual([]);
  }, 60_000);

  it("waits for the invitation budget, and stops inviting when it runs out mid-run", async () => {
    const s = await sold();
    const first = await subscriber(s);
    await spendBudget(s, first.subjectId, 39);
    const second = await subscriber(s);
    await reconcile(s);
    // One invitation fits; the other is left over for the next run.
    expect(callsOf(s.github, "addCollaborator")).toBe(1);
    expect((await resourceRow(s)).nextReconcileAt).toBe(clock.now());
    await reconcile(s);
    expect(callsOf(s.github, "addCollaborator")).toBe(1);
    const waiting = (await listAccess(serviceContext(), s, s.slug)).rows.find(
      (row) => row.grant?.state !== "pending_invitation",
    );
    expect([first.subjectId, second.subjectId]).toContain(waiting?.subjectId);
    expect(waiting?.planned).toEqual({ action: "wait", reason: "invitation_quota" });
  });

  it("invitation/expired-is-reissued-or-surfaced: a failed cancellation holds the reissue", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    await reconcile(s);
    const [first] = accessOf(s).invitations;
    s.github.expireInvitation(repoName(s), first?.id as string);
    s.github.failNext("cancelInvitation", githubError("transient", { status: 502 }));
    clock.advance(MINUTE);
    await reconcile(s);
    expect(callsOf(s.github, "addCollaborator")).toBe(1);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({
      state: "error",
      lastErrorCode: "provider_unavailable",
    });
  });

  it("lets one run hold a repository at a time", async () => {
    const s = await sold();
    await subscriber(s);
    await claimReconcileLease(db, {
      ...ref(s),
      token: "other-run",
      now: clock.now(),
      leaseMs: RECONCILE_LEASE_MS,
    });
    const before = s.github.calls.length;
    await expect(reconcile(s)).resolves.toBe("busy");
    expect(s.github.calls.length).toBe(before);
  });

  it("stops writing as soon as another run takes the repository over", async () => {
    // Each case lets another run take the lease during one GitHub call.
    const cases: {
      name: string;
      setup?: (s: Shop, sub: Awaited<ReturnType<typeof subscriber>>) => Promise<void>;
      hook: (s: Shop, steal: () => Promise<void>) => Partial<GitHubAppPort>;
    }[] = [
      {
        name: "observation write",
        setup: async (s) => {
          await reconcile(s);
          clock.advance(MINUTE);
        },
        hook: (s, steal) => ({
          listInvitations: async (...args) => {
            await steal();
            return s.github.listInvitations(...args);
          },
        }),
      },
      {
        name: "write-ahead",
        hook: (s, steal) => ({
          listInvitations: async (...args) => {
            await steal();
            return s.github.listInvitations(...args);
          },
        }),
      },
      {
        name: "success",
        hook: (s, steal) => ({
          addCollaborator: async (...args) => {
            await steal();
            return s.github.addCollaborator(...args);
          },
        }),
      },
      {
        name: "failure",
        hook: (_s, steal) => ({
          addCollaborator: async () => {
            await steal();
            throw githubError("transient");
          },
        }),
      },
      {
        name: "stop",
        hook: (_s, steal) => ({
          addCollaborator: async () => {
            await steal();
            throw githubError("suspended");
          },
        }),
      },
      {
        name: "release after a failed observation",
        hook: (_s, steal) => ({
          listInvitations: async () => {
            await steal();
            throw githubError("transient");
          },
        }),
      },
    ];
    for (const { name, setup, hook } of cases) {
      const s = await sold();
      const sub = await subscriber(s);
      await setup?.(s, sub);
      const steal = async () => {
        await env.DB.prepare("UPDATE resources SET reconcile_token = 'thief' WHERE id = ?")
          .bind(resourceOf(s).id)
          .run();
      };
      await expect(reconcile(s, withHooks(s.github, hook(s, steal))), name).resolves.toBe("busy");
    }
  }, 60_000);

  it("stops when the lease is taken during the closing observation", async () => {
    const s = await sold();
    await subscriber(s);
    let lists = 0;
    const github = withHooks(s.github, {
      listInvitations: async (...args) => {
        lists += 1;
        if (lists === 2) {
          await env.DB.prepare("UPDATE resources SET reconcile_token = 'thief' WHERE id = ?")
            .bind(resourceOf(s).id)
            .run();
        }
        return s.github.listInvitations(...args);
      },
    });
    await expect(reconcile(s, github)).resolves.toBe("busy");
  });

  it("observes indirect, read and direct-only listings", async () => {
    const s = await sold();
    const reader = githubUser(s);
    const writer = githubUser(s);
    for (const user of [reader, writer]) {
      const created = await createSimulatedSubscriber(
        serviceContext(),
        s,
        s.slug,
        { login: user.login, items: ["sim_pro"], state: "active", periodDays: 30 },
        { github: s.github, ...SIMULATION },
      );
      if (!created.ok) throw new Error(created.error);
    }
    await drain(s.workspaceId);
    s.github.addCollaboratorByHand(repoName(s), reader, "read");
    // GitHub's full list may lag behind the direct one.
    const lagging = withHooks(s.github, {
      listCollaborators: async (installationId, repo, affiliation) => [
        ...(await s.github.listCollaborators(installationId, repo, affiliation)),
        ...(affiliation === "direct"
          ? [{ id: writer.id, login: writer.login, permission: "admin" as const }]
          : []),
      ],
    });
    await reconcile(s, lagging);
    expect(await grantFor(s, (await subjectOf(s, reader.login)).id)).toMatchObject({
      accessLevel: "read",
      managed: false,
    });
    expect(await grantFor(s, (await subjectOf(s, writer.login)).id)).toMatchObject({
      state: "active",
      accessLevel: "write",
      indirect: false,
    });
  });

  it("isolation/cross-workspace-mutation-denied: a key naming another workspace's repository is out of scope", async () => {
    const alice = await sold();
    await subscriber(alice);
    const bob = await sold();
    const before = await snapshotTables(env.DB, {});
    const outcome = await reconcileResource(
      serviceContext(),
      { workspaceId: bob.workspaceId, resourceId: resourceOf(alice).id },
      alice.github,
    );
    expect(outcome).toBe("out_of_scope");
    expect(changedTables(before, await snapshotTables(env.DB, {}))).toEqual([]);
    expect(callsOf(alice.github, "listCollaborators")).toBe(0);
  });
});

/** Seeds invitations ShareRepo started at the current instant, so the budget has `n` fewer. */
async function spendBudget(s: Shop, subjectId: string, n = 40) {
  const grant = await grantFor(s, subjectId);
  const grantId = grant?.id ?? (await seedGrant(s, subjectId));
  for (let i = 0; i < n; i += 1) {
    await env.DB.prepare(
      `INSERT INTO provider_mutations (id, workspace_id, connection_id, grant_id, subject_id,
         resource_id, operation, access_level, status, entitlement_ids, correlation_id, started_at,
         finished_at)
       VALUES (?, ?, ?, ?, ?, ?, 'invite', 'write', 'succeeded', '[]', 'seed', ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        s.workspaceId,
        s.connection.id,
        grantId,
        subjectId,
        resourceOf(s).id,
        clock.now(),
        clock.now(),
      )
      .run();
  }
}

async function seedGrant(s: Shop, subjectId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO grants (id, workspace_id, connection_id, subject_id, resource_id, access_level,
       state, managed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'write', 'absent', 0, ?, ?)`,
  )
    .bind(id, s.workspaceId, s.connection.id, subjectId, resourceOf(s).id, clock.now(), clock.now())
    .run();
  return id;
}

describe("outbox recovery (reconciliation)", () => {
  it("crash/between-event-commit-and-enqueue: a committed reconcile row is run by the drain", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    // The refresh committed its reconcile row; the queue send after it never happened.
    const claimed = await claimOutbox(db, {
      now: clock.now(),
      limit: 1000,
      leaseMs: MINUTE,
      maxAttempts: 10,
    });
    const ours = claimed.filter((row) => row.subjectId === encodeReconcileKey(ref(s)));
    expect(ours.map((row) => row.kind)).toEqual(["reconcile_resource"]);
    const key = decodeReconcileKey((ours[0] as (typeof ours)[number]).subjectId);
    if (!key.ok) throw new Error("bad key");
    await reconcileResource(serviceContext(), key.value, s.github);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "pending_invitation" });
    // Redelivering the row (the claimer crashed before marking it sent) sends nothing more.
    clock.advance(MINUTE);
    await reconcileResource(serviceContext(), key.value, s.github);
    expect(callsOf(s.github, "addCollaborator")).toBe(1);
  });
});

describe("audit/every-state-change-has-audit-event (reconciliation)", () => {
  const ignore = {
    ...UNAUDITED_TABLES,
    resources: "the reconcile lease and schedule are bookkeeping (releaseReconcileLease)",
  };

  it("audits every provider change and owner request; an unchanged check only stamps grants", async () => {
    const s = await sold();
    const sub = await subscriber(s);
    const audited = async <T>(
      run: (ctx: ServiceContext) => Promise<T>,
      ignored: Record<string, string> = ignore,
    ) => {
      const ctx = serviceContext();
      return expectAuditedChange(env.DB, ctx.correlationId, () => run(ctx), ignored);
    };
    const invited = await audited((ctx) => reconcile(s, s.github, ctx));
    expect(invited.changedTables).toEqual(["grants", "provider_mutations"]);
    s.github.acceptInvitation(repoName(s), sub.userId);
    clock.advance(MINUTE);
    expect((await audited((ctx) => reconcile(s, s.github, ctx))).auditEventCount).toBe(1);
    // Nothing changed: only `observed_at` is stamped, which is bookkeeping.
    clock.advance(MINUTE);
    const unchanged = await audited((ctx) => reconcile(s, s.github, ctx), {
      ...ignore,
      grants: "an unchanged observation only stamps observed_at",
    });
    expect(unchanged).toMatchObject({ changedTables: [], auditEventCount: 0 });
    await audited((ctx) => requestReconcileNow(ctx, s, s.slug, resourceOf(s).id));
    await act(s, sub.id, "cancel_now");
    await drain(s.workspaceId);
    const removed = await audited((ctx) => reconcile(s, s.github, ctx));
    expect(removed.auditEventCount).toBe(3);
    await expectMutationAuditComplete(s);
  });

  it("a failed run leaves no audit event without its change", async () => {
    const s = await sold();
    await subscriber(s);
    // The database fails every write: the run cannot even take the lease.
    await expectNoChangeOnFailure(env.DB, () => reconcile(s, s.github, failingBatches()), ignore);
  });
});

describe("owner controls", () => {
  async function errored() {
    const s = await sold();
    const sub = await subscriber(s);
    s.github.failNext("addCollaborator", githubError("rejected", { status: 422 }));
    await reconcile(s);
    await settleOutbox(s);
    return { s, sub, grant: await grantFor(s, sub.subjectId) };
  }

  it("'Check now' queues one reconciliation, hands over a pending one, and audits every request", async () => {
    const s = await sold();
    await settleOutbox(s);
    const ctx = serviceContext();
    const first = await requestReconcileNow(ctx, s, s.slug, resourceOf(s).id);
    expect(first).toEqual({ outboxId: expect.any(String), subjectId: encodeReconcileKey(ref(s)) });
    // Already pending: the same row is handed to the queue again, rather than a second one.
    const second = await requestReconcileNow(ctx, s, s.slug, resourceOf(s).id);
    expect(second).toEqual(first);
    const queued = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbox WHERE subject_id = ? AND sent_at IS NULL",
    )
      .bind(first.subjectId)
      .first<{ n: number }>();
    expect(queued?.n).toBe(1);
    const events = await listAuditEventsByCorrelationId(db, ctx.correlationId);
    expect(events.map((e) => [e.action, e.actor.id, e.details])).toEqual([
      ["reconciliation.requested", s.userId, { resourceId: resourceOf(s).id, kind: "check" }],
      ["reconciliation.requested", s.userId, { resourceId: resourceOf(s).id, kind: "check" }],
    ]);
  });

  it("'Retry' makes an errored grant due and queues its repository", async () => {
    const { s, sub, grant } = await errored();
    expect(grant).toMatchObject({ lastErrorCode: "invitation_rejected", nextAttemptAt: null });
    const ctx = serviceContext();
    const result = await retryGrant(ctx, s, s.slug, grant.id);
    expect(result).toEqual({ outboxId: expect.any(String), subjectId: encodeReconcileKey(ref(s)) });
    expect(await retryGrant(serviceContext(), s, s.slug, grant.id)).toEqual(result);
    expect((await listAuditEventsByCorrelationId(db, ctx.correlationId))[0]?.details).toEqual({
      resourceId: resourceOf(s).id,
      grantId: grant.id,
      kind: "retry",
    });
    await reconcile(s);
    expect(await grantFor(s, sub.subjectId)).toMatchObject({ state: "pending_invitation" });
    await expect(retryGrant(serviceContext(), s, s.slug, grant.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("refuses members, and another workspace's repositories and grants", async () => {
    const { s, grant } = await errored();
    const member = await memberOf(s);
    const other = await sold();
    for (const [run, error] of [
      [
        () => requestReconcileNow(serviceContext(), member, s.slug, resourceOf(s).id),
        ForbiddenError,
      ],
      [() => retryGrant(serviceContext(), member, s.slug, grant.id), ForbiddenError],
      [
        () => requestReconcileNow(serviceContext(), other, other.slug, resourceOf(s).id),
        NotFoundError,
      ],
      [() => retryGrant(serviceContext(), other, other.slug, grant.id), NotFoundError],
      [() => retryGrant(serviceContext(), s, s.slug, "gra_missing"), NotFoundError],
    ] as const) {
      expect(await expectNoChangeOnFailure(env.DB, run)).toBeInstanceOf(error);
    }
    expect((await listAccess(serviceContext(), member, s.slug)).canManage).toBe(false);
    expect((await listAccess(serviceContext(), s, s.slug)).canManage).toBe(true);
  });
});

describe("consecutiveAttempt", () => {
  const grant = (fields: Partial<Grant>) => ({ state: "error", ...fields }) as Grant;
  it("counts the backoff the last failure used, starting again for any other wait", () => {
    expect(consecutiveAttempt(null)).toBe(1);
    expect(consecutiveAttempt(grant({ state: "absent" }))).toBe(1);
    expect(consecutiveAttempt(grant({ nextAttemptAt: null, lastAttemptAt: 1 }))).toBe(1);
    expect(consecutiveAttempt(grant({ nextAttemptAt: 5, lastAttemptAt: null }))).toBe(1);
    expect(consecutiveAttempt(grant({ lastAttemptAt: 0, nextAttemptAt: MINUTE }))).toBe(2);
    expect(consecutiveAttempt(grant({ lastAttemptAt: 0, nextAttemptAt: 60 * MINUTE }))).toBe(5);
    expect(consecutiveAttempt(grant({ lastAttemptAt: 0, nextAttemptAt: 2 * MINUTE }))).toBe(1);
  });
});
