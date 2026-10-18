import { env } from "cloudflare:workers";
import {
  findConnectionByInstallationId,
  getExternalEvent,
  listAuditEventsByCorrelationId,
  listResourcesForConnection,
} from "@sharerepo/db";
import { GitHubApiError } from "@sharerepo/integrations";
import {
  createFakeGitHubApp,
  type FakeGitHubApp,
  signWebhook,
} from "@sharerepo/integrations/testing";
import { ConflictError, ForbiddenError, NotFoundError } from "@sharerepo/platform";
import { expectAuditedChange, expectNoChangeOnFailure } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  addWorkspaceMember,
  CONNECTION_INTENT_TTL_MS,
  completeGitHubConnection,
  createWorkspace,
  ingestGitHubWebhook,
  listGitHubConnections,
  processExternalEvent,
  refreshInstallationForMember,
  resyncConnection,
  resyncWorkspaceConnections,
  startGitHubConnection,
  type UserActor,
} from "../src/index.ts";
import { clock, db, serviceContext, signedUpUser, uniqueSlug } from "./support/context.ts";

const SECRET = "webhook-secret-for-tests";
let nextInstallation = Math.floor(Math.random() * 1e8);

interface Creator extends UserActor {
  githubId: string;
  login: string;
  slug: string;
  workspaceId: string;
}

async function creator(): Promise<Creator> {
  const user = await signedUpUser();
  const created = await createWorkspace(serviceContext(), user, {
    name: "Creator",
    slug: uniqueSlug(),
  });
  if (!created.ok) throw new Error("setup failed");
  return {
    ...user,
    githubId: user.profile.externalUserId,
    login: user.profile.username,
    slug: created.workspace.slug,
    workspaceId: created.workspace.id,
  };
}

function repository(owner: Creator, overrides: Record<string, unknown> = {}) {
  const id = String(++nextInstallation);
  return {
    externalId: id,
    name: `${owner.login}/repo-${id}`,
    ownerExternalId: owner.githubId,
    ownerType: "User" as const,
    private: true,
    archived: false,
    ...overrides,
  };
}

/** Installs the fake App on the creator's account with the given repositories. */
function install(github: FakeGitHubApp, owner: Creator, repositories = [repository(owner)]) {
  const id = String(++nextInstallation);
  github.addInstallation({
    id,
    account: { id: owner.githubId, login: owner.login, type: "User" },
    repositories,
    permissions: { administration: "write", metadata: "read" },
  });
  return { installationId: id, repositories };
}

async function startedState(github: FakeGitHubApp, owner: Creator): Promise<string> {
  const started = await startGitHubConnection(
    serviceContext(),
    owner,
    owner.slug,
    { acknowledgeWriteAccess: true },
    github,
  );
  if (!started.ok) throw new Error("start failed");
  return new URL(started.installUrl).searchParams.get("state") ?? "";
}

async function connected(github = createFakeGitHubApp()) {
  const owner = await creator();
  const installed = install(github, owner);
  const state = await startedState(github, owner);
  const result = await completeGitHubConnection(
    serviceContext(),
    owner,
    { state, ...installed },
    github,
  );
  if (!result.ok) throw new Error(result.reason);
  const connection = { workspaceId: owner.workspaceId, id: result.connectionId };
  return { github, owner, connection, ...installed };
}

const resources = (connection: { workspaceId: string; id: string }) =>
  listResourcesForConnection(db, {
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
  });

describe("startGitHubConnection", () => {
  it("records an audited intent and returns the App's install URL with a fresh state", async () => {
    const owner = await creator();
    const ctx = serviceContext();
    const github = createFakeGitHubApp();
    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      startGitHubConnection(ctx, owner, owner.slug, { acknowledgeWriteAccess: true }, github),
    );
    if (!result.ok) throw new Error("expected ok");
    const url = new URL(result.installUrl);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await listAuditEventsByCorrelationId(db, ctx.correlationId)).toMatchObject([
      { action: "connection.intent_created", details: { provider: "github" } },
    ]);
  });

  it("requires acknowledging that subscribers get write access", async () => {
    const owner = await creator();
    const ctx = serviceContext();
    const { result, changedTables } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      startGitHubConnection(
        ctx,
        owner,
        owner.slug,
        { acknowledgeWriteAccess: false },
        createFakeGitHubApp(),
      ),
    );
    expect(result).toEqual({ ok: false, reason: "acknowledgement_required" });
    expect(changedTables).toEqual([]);
  });

  it("is refused for members and non-members", async () => {
    const owner = await creator();
    const member = await signedUpUser();
    await addWorkspaceMember(serviceContext(), owner, owner.slug, {
      userId: member.userId,
      role: "member",
    });
    const stranger = await signedUpUser();
    const github = createFakeGitHubApp();
    const start = (actor: UserActor) =>
      startGitHubConnection(
        serviceContext(),
        actor,
        owner.slug,
        { acknowledgeWriteAccess: true },
        github,
      );
    await expect(start(member)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(start(stranger)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("connection/install-callback-bound-to-intent", () => {
  it("attaches the creator's own installation to the intent's workspace, audited", async () => {
    const github = createFakeGitHubApp();
    const owner = await creator();
    const installed = install(github, owner);
    const state = await startedState(github, owner);
    const ctx = serviceContext();
    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      completeGitHubConnection(ctx, owner, { state, ...installed }, github),
    );
    expect(result).toMatchObject({ ok: true, workspaceSlug: owner.slug });
    expect(await findConnectionByInstallationId(db, installed.installationId)).toMatchObject({
      workspaceId: owner.workspaceId,
      accountExternalId: owner.githubId,
      accountType: "user",
      status: "active",
      createdByUserId: owner.userId,
    });
    expect(await listAuditEventsByCorrelationId(db, ctx.correlationId)).toMatchObject([
      { action: "connection.created", details: { installationId: installed.installationId } },
    ]);
  });

  it("answers a repeated setup callback for the same workspace without a new connection", async () => {
    const { github, owner, connection, installationId } = await connected();
    const state = await startedState(github, owner);
    await expect(
      completeGitHubConnection(serviceContext(), owner, { state, installationId }, github),
    ).resolves.toEqual({
      ok: true,
      workspaceId: owner.workspaceId,
      workspaceSlug: owner.slug,
      connectionId: connection.id,
    });
  });

  it.each([
    ["an unknown state", async (_g: FakeGitHubApp, _o: Creator) => "forged-state"],
    [
      "an already used state",
      async (g: FakeGitHubApp, o: Creator) => {
        const state = await startedState(g, o);
        const other = install(g, o);
        await completeGitHubConnection(serviceContext(), o, { state, ...other }, g);
        return state;
      },
    ],
    [
      "an expired state",
      async (g: FakeGitHubApp, o: Creator) => {
        const state = await startedState(g, o);
        clock.advance(CONNECTION_INTENT_TTL_MS);
        return state;
      },
    ],
  ])("refuses %s and writes nothing", async (_, makeState) => {
    const github = createFakeGitHubApp();
    const owner = await creator();
    const state = await makeState(github, owner);
    const installed = install(github, owner);
    const ctx = serviceContext();
    const { result, changedTables } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      completeGitHubConnection(ctx, owner, { state, ...installed }, github),
    );
    expect(result).toEqual({ ok: false, reason: "invalid_state" });
    expect(changedTables).toEqual([]);
  });

  it("refuses a state started by another user (a stolen callback URL)", async () => {
    const github = createFakeGitHubApp();
    const victim = await creator();
    const state = await startedState(github, victim);
    const attacker = await creator();
    const installed = install(github, attacker);
    await expect(
      completeGitHubConnection(serviceContext(), attacker, { state, ...installed }, github),
    ).resolves.toEqual({ ok: false, reason: "invalid_state" });
  });

  it("refuses a malformed installation ID without calling GitHub", async () => {
    const github = createFakeGitHubApp();
    const owner = await creator();
    const state = await startedState(github, owner);
    await expect(
      completeGitHubConnection(serviceContext(), owner, { state, installationId: "../1" }, github),
    ).resolves.toEqual({ ok: false, reason: "invalid_state" });
    expect(github.calls.filter((call) => !call.startsWith("installUrl"))).toEqual([]);
  });

  it("refuses when the actor no longer manages the workspace", async () => {
    const github = createFakeGitHubApp();
    const owner = await creator();
    const state = await startedState(github, owner);
    await env.DB.prepare("UPDATE workspace_memberships SET role = 'member' WHERE user_id = ?")
      .bind(owner.userId)
      .run();
    await expect(
      completeGitHubConnection(
        serviceContext(),
        owner,
        { state, ...install(github, owner) },
        github,
      ),
    ).resolves.toEqual({ ok: false, reason: "not_owner" });
  });

  it("refuses an installation that does not exist", async () => {
    const github = createFakeGitHubApp();
    const owner = await creator();
    const state = await startedState(github, owner);
    await expect(
      completeGitHubConnection(
        serviceContext(),
        owner,
        { state, installationId: "999999999" },
        github,
      ),
    ).resolves.toEqual({ ok: false, reason: "installation_not_found" });
  });

  it("propagates other GitHub failures for the caller to retry", async () => {
    const github = createFakeGitHubApp();
    const owner = await creator();
    const state = await startedState(github, owner);
    const installed = install(github, owner);
    github.failNext("transient");
    await expect(
      completeGitHubConnection(serviceContext(), owner, { state, ...installed }, github),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });

  it.each(["Organization", "Enterprise"] as const)(
    "refuses an %s installation (decision 0008)",
    async (type) => {
      const github = createFakeGitHubApp();
      const owner = await creator();
      const state = await startedState(github, owner);
      const installationId = String(++nextInstallation);
      github.addInstallation({
        id: installationId,
        account: { id: "424242", login: "acme", type },
      });
      await expect(
        completeGitHubConnection(serviceContext(), owner, { state, installationId }, github),
      ).resolves.toEqual({ ok: false, reason: "account_not_supported" });
    },
  );

  it("refuses an installation on someone else's personal account", async () => {
    const github = createFakeGitHubApp();
    const owner = await creator();
    const someoneElse = await creator();
    const state = await startedState(github, owner);
    const installed = install(github, someoneElse);
    await expect(
      completeGitHubConnection(serviceContext(), owner, { state, ...installed }, github),
    ).resolves.toEqual({ ok: false, reason: "account_mismatch" });
  });

  it("refuses an installation already attached to another workspace", async () => {
    const { github, owner, installationId } = await connected();
    const second = await createWorkspace(serviceContext(), owner, {
      name: "Second",
      slug: uniqueSlug(),
    });
    if (!second.ok) throw new Error("setup");
    const started = await startGitHubConnection(
      serviceContext(),
      owner,
      second.workspace.slug,
      { acknowledgeWriteAccess: true },
      github,
    );
    if (!started.ok) throw new Error("setup");
    const state = new URL(started.installUrl).searchParams.get("state") ?? "";
    await expect(
      completeGitHubConnection(serviceContext(), owner, { state, installationId }, github),
    ).resolves.toEqual({ ok: false, reason: "installation_taken" });
  });

  it("reports a concurrent duplicate completion as an unavailable intent", async () => {
    const github = createFakeGitHubApp();
    const owner = await creator();
    const state = await startedState(github, owner);
    const installed = install(github, owner);
    const results = await Promise.all([
      completeGitHubConnection(serviceContext(), owner, { state, ...installed }, github),
      completeGitHubConnection(serviceContext(), owner, { state, ...installed }, github),
    ]);
    // One wins; the other either sees the used intent or the connection the winner created.
    const ids = new Set(results.flatMap((r) => (r.ok ? [r.connectionId] : [])));
    expect(ids.size).toBe(1);
    for (const r of results) if (!r.ok) expect(r.reason).toBe("invalid_state");
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM connections WHERE installation_id = ?",
    )
      .bind(installed.installationId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

describe("refreshInstallationForMember", () => {
  it("resyncs an installation connected to one of the actor's workspaces", async () => {
    const { github, owner, connection, installationId, repositories } = await connected();
    github.setRepositories(installationId, [...repositories, repository(owner)]);
    await expect(
      refreshInstallationForMember(serviceContext(), owner, installationId, github),
    ).resolves.toEqual({ workspaceSlug: owner.slug });
    expect(await resources(connection)).toHaveLength(2);
  });

  it("returns null for members who cannot manage the workspace, without resyncing", async () => {
    const { github, owner, installationId } = await connected();
    const member = await signedUpUser();
    await addWorkspaceMember(serviceContext(), owner, owner.slug, {
      userId: member.userId,
      role: "member",
    });
    const before = github.calls.length;
    await expect(
      refreshInstallationForMember(serviceContext(), member, installationId, github),
    ).resolves.toBeNull();
    expect(github.calls.length).toBe(before);
  });

  it("returns null for strangers, unknown installations and malformed IDs", async () => {
    const { github, installationId } = await connected();
    const stranger = await signedUpUser();
    for (const id of [installationId, "123456789", "../1"]) {
      await expect(
        refreshInstallationForMember(serviceContext(), stranger, id, github),
      ).resolves.toBeNull();
    }
  });
});

describe("resyncConnection", () => {
  it("discovers selected repositories with personal-account capabilities, audited", async () => {
    const { github, connection, repositories } = await connected();
    const ctx = serviceContext();
    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      resyncConnection(ctx, connection, github, "test"),
    );
    expect(result).toEqual({ status: "active", discovered: 1, updated: 0, removed: 0 });
    const [resource] = await resources(connection);
    expect(resource).toMatchObject({
      externalId: repositories[0]?.externalId,
      nameSnapshot: repositories[0]?.name,
      selection: "selected",
    });
    expect(JSON.parse(resource?.capabilities ?? "{}")).toMatchObject({ readOnlyGrant: false });
    const actions = (await listAuditEventsByCorrelationId(db, ctx.correlationId)).map(
      (e) => e.action,
    );
    expect(actions).toEqual(["resource.discovered", "connection.synced"]);
  });

  it("resource/rename-transfer-keeps-identity", async () => {
    const { github, owner, connection, installationId, repositories } = await connected();
    await resyncConnection(serviceContext(), connection, github, "first");
    const [before] = await resources(connection);
    const externalId = repositories[0]?.externalId ?? "";
    github.renameRepository(installationId, externalId, `${owner.login}/renamed`);
    const summary = await resyncConnection(serviceContext(), connection, github, "rename");
    expect(summary).toMatchObject({ discovered: 0, updated: 1 });
    expect(await resources(connection)).toMatchObject([
      { id: before?.id, externalId, nameSnapshot: `${owner.login}/renamed` },
    ]);
  });

  it("records archive and visibility changes and stops selling such repositories", async () => {
    const { github, owner, connection, installationId, repositories } = await connected();
    await resyncConnection(serviceContext(), connection, github, "first");
    const [first] = repositories;
    if (first === undefined) throw new Error("setup");
    github.setRepositories(installationId, [{ ...first, private: false, archived: true }]);
    const ctx = serviceContext();
    expect(await resyncConnection(ctx, connection, github, "changed")).toMatchObject({
      updated: 1,
    });
    const [updated] = await listAuditEventsByCorrelationId(db, ctx.correlationId);
    expect(updated?.details).toEqual({
      externalId: first.externalId,
      changes: { private: { from: true, to: false }, archived: { from: false, to: true } },
    });
    const [listed] = await listGitHubConnections(serviceContext(), owner, owner.slug);
    expect(listed?.repositories).toMatchObject([
      { private: false, archived: true, sellable: false },
    ]);
  });

  /** A port whose repository listing lets `during` run between the resync's read and write. */
  function racing(github: FakeGitHubApp, during: () => Promise<void>, times = 1) {
    let remaining = times;
    return {
      ...github,
      listInstallationRepositories: async (id: string) => {
        const repositories = await github.listInstallationRepositories(id);
        if (remaining > 0) {
          remaining -= 1;
          await during();
        }
        return repositories;
      },
    };
  }

  it("retries from fresh state when another resync wrote in between", async () => {
    const { github, connection } = await connected();
    const port = racing(github, async () => {
      await resyncConnection(serviceContext(), connection, github, "concurrent");
    });
    await expect(
      resyncConnection(serviceContext(), connection, port, "slow"),
    ).resolves.toMatchObject({ status: "active", discovered: 0 });
    expect(await resources(connection)).toHaveLength(1);
  });

  it("never lets an older reading revive a connection deleted meanwhile", async () => {
    const { github, owner, connection, installationId } = await connected();
    await resyncConnection(serviceContext(), connection, github, "first");
    // The slow resync read "active"; meanwhile the App is uninstalled and a webhook resync runs.
    const port = racing(github, async () => {
      github.deleteInstallation(installationId);
      await resyncConnection(serviceContext(), connection, github, "uninstalled");
    });
    await expect(
      resyncConnection(serviceContext(), connection, port, "slow"),
    ).resolves.toMatchObject({ status: "deleted" });
    const [listed] = await listGitHubConnections(serviceContext(), owner, owner.slug);
    expect(listed).toMatchObject({ status: "deleted", repositories: [{ selection: "removed" }] });
  });

  it("gives up with a retryable conflict when the connection keeps changing", async () => {
    const { github, connection } = await connected();
    const port = racing(
      github,
      async () => {
        await resyncConnection(serviceContext(), connection, github, "concurrent");
      },
      3,
    );
    const error = await resyncConnection(serviceContext(), connection, port, "slow").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConflictError);
  });

  it("resource/selection-removed-blocks-new-provisioning", async () => {
    const { github, owner, connection, installationId, repositories } = await connected();
    await resyncConnection(serviceContext(), connection, github, "first");
    github.removeRepository(installationId, repositories[0]?.externalId ?? "");
    expect(await resyncConnection(serviceContext(), connection, github, "removed")).toMatchObject({
      removed: 1,
    });
    const [listed] = await listGitHubConnections(serviceContext(), owner, owner.slug);
    expect(listed?.repositories).toMatchObject([{ selection: "removed", sellable: false }]);
    // Reselecting brings the same resource back.
    github.setRepositories(installationId, repositories);
    await resyncConnection(serviceContext(), connection, github, "reselected");
    const [again] = await listGitHubConnections(serviceContext(), owner, owner.slug);
    expect(again?.repositories).toMatchObject([{ selection: "selected", sellable: true }]);
  });

  it("connection/suspended-installation-surfaces-error", async () => {
    const { github, owner, connection, installationId } = await connected();
    await resyncConnection(serviceContext(), connection, github, "first");
    github.suspend(installationId, clock.now());
    const ctx = serviceContext();
    await resyncConnection(ctx, connection, github, "suspended");
    const [listed] = await listGitHubConnections(serviceContext(), owner, owner.slug);
    expect(listed).toMatchObject({
      status: "suspended",
      repositories: [{ selection: "selected", sellable: false }],
    });
    expect(
      (await listAuditEventsByCorrelationId(db, ctx.correlationId)).map((e) => e.action),
    ).toContain("connection.status_changed");
    github.unsuspend(installationId);
    await resyncConnection(serviceContext(), connection, github, "resumed");
    const [resumed] = await listGitHubConnections(serviceContext(), owner, owner.slug);
    expect(resumed).toMatchObject({ status: "active", repositories: [{ sellable: true }] });
  });

  it("marks a deleted installation's connection deleted and its repositories removed", async () => {
    const { github, owner, connection, installationId } = await connected();
    await resyncConnection(serviceContext(), connection, github, "first");
    github.deleteInstallation(installationId);
    expect(await resyncConnection(serviceContext(), connection, github, "deleted")).toEqual({
      status: "deleted",
      discovered: 0,
      updated: 0,
      removed: 1,
    });
    // Further resyncs are no-ops.
    expect(await resyncConnection(serviceContext(), connection, github, "again")).toEqual({
      status: "deleted",
      discovered: 0,
      updated: 0,
      removed: 0,
    });
    const [listed] = await listGitHubConnections(serviceContext(), owner, owner.slug);
    expect(listed).toMatchObject({ status: "deleted", repositories: [{ selection: "removed" }] });
  });

  it("ignores repositories not owned by the installation's account", async () => {
    const github = createFakeGitHubApp();
    const owner = await creator();
    const foreign = { ...repository(owner), ownerExternalId: "1" };
    const { connection } = await connected(github).then(async (c) => {
      github.setRepositories(c.installationId, [...c.repositories, foreign]);
      return c;
    });
    expect(await resyncConnection(serviceContext(), connection, github, "t")).toMatchObject({
      discovered: 1,
    });
  });

  it("fails loudly for an unknown connection and propagates GitHub failures", async () => {
    const { github, connection } = await connected();
    await expect(
      resyncConnection(serviceContext(), { ...connection, id: "missing" }, github, "t"),
    ).rejects.toBeInstanceOf(ConflictError);
    github.failNext("transient");
    const error = await expectNoChangeOnFailure(env.DB, () =>
      resyncConnection(serviceContext(), connection, github, "t"),
    );
    expect(error).toBeInstanceOf(GitHubApiError);
  });
});

describe("webhooks", () => {
  async function delivery(body: object, deliveryId = crypto.randomUUID(), secret = SECRET) {
    const raw = JSON.stringify(body);
    const headers = new Headers({
      "x-github-delivery": deliveryId,
      "x-github-event": "installation_repositories",
      "x-hub-signature-256": await signWebhook(secret, raw),
    });
    return { rawBody: new TextEncoder().encode(raw).buffer as ArrayBuffer, headers, deliveryId };
  }

  it("webhook/invalid-signature-rejected-before-persist", async () => {
    const { rawBody, headers } = await delivery({ action: "added" }, undefined, "wrong-secret");
    const ctx = serviceContext();
    const { result, changedTables } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      ingestGitHubWebhook(ctx, { secret: SECRET, rawBody, headers }),
    );
    expect(result).toEqual({ status: "rejected" });
    const receipts = await env.DB.prepare("SELECT count(*) AS n FROM external_events").first<{
      n: number;
    }>();
    expect([changedTables, receipts?.n]).toEqual([[], receipts?.n]);
  });

  it("rejects a correctly signed body that is not a GitHub webhook", async () => {
    const raw = "not json";
    const headers = new Headers({ "x-hub-signature-256": await signWebhook(SECRET, raw) });
    const rawBody = new TextEncoder().encode(raw).buffer as ArrayBuffer;
    await expect(
      ingestGitHubWebhook(serviceContext(), { secret: SECRET, rawBody, headers }),
    ).resolves.toEqual({ status: "rejected" });
    const signedJson = await delivery({});
    signedJson.headers.delete("x-github-event");
    await expect(
      ingestGitHubWebhook(serviceContext(), { secret: SECRET, ...signedJson }),
    ).resolves.toEqual({ status: "rejected" });
  });

  it("webhook/duplicate-delivery-is-noop", async () => {
    const { github, connection, installationId } = await connected();
    const body = { action: "added", installation: { id: Number(installationId) } };
    const first = await delivery(body);
    const accepted = await ingestGitHubWebhook(serviceContext(), { secret: SECRET, ...first });
    expect(accepted.status).toBe("accepted");

    const again = await delivery(body, first.deliveryId);
    const outboxBefore = await env.DB.prepare("SELECT count(*) AS n FROM outbox").first<{
      n: number;
    }>();
    const duplicate = await ingestGitHubWebhook(serviceContext(), { secret: SECRET, ...again });
    expect(duplicate).toEqual({
      status: "duplicate",
      eventId: (accepted as { eventId: string }).eventId,
    });
    const outboxAfter = await env.DB.prepare("SELECT count(*) AS n FROM outbox").first<{
      n: number;
    }>();
    expect(outboxAfter?.n).toBe(outboxBefore?.n);

    // Processing the event twice converges to the same state.
    const eventId = (accepted as { eventId: string }).eventId;
    await expect(processExternalEvent(serviceContext(), eventId, github)).resolves.toBe(
      "processed",
    );
    const after = await resources(connection);
    await expect(processExternalEvent(serviceContext(), eventId, github)).resolves.toBe(
      "already_done",
    );
    expect(await resources(connection)).toEqual(after);
  });

  it("ignores events for unknown installations and unrelated event types", async () => {
    const github = createFakeGitHubApp();
    const unknown = await delivery({ action: "created", installation: { id: 123 } });
    const result = await ingestGitHubWebhook(serviceContext(), { secret: SECRET, ...unknown });
    const eventId = (result as { eventId: string }).eventId;
    await expect(processExternalEvent(serviceContext(), eventId, github)).resolves.toBe("ignored");
    expect((await getExternalEvent(db, eventId))?.processingState).toBe("ignored");
    await expect(processExternalEvent(serviceContext(), "no-such-event", github)).resolves.toBe(
      "already_done",
    );
    // An installation event without an installation (malformed but signed) is ignored too.
    const bare = await delivery({ action: "created" });
    const bareResult = await ingestGitHubWebhook(serviceContext(), { secret: SECRET, ...bare });
    await expect(
      processExternalEvent(serviceContext(), (bareResult as { eventId: string }).eventId, github),
    ).resolves.toBe("ignored");
  });

  it("records a failed attempt with a classification and rethrows for the queue to retry", async () => {
    const { github, installationId } = await connected();
    const signed = await delivery({
      action: "added",
      installation: { id: Number(installationId) },
    });
    const result = await ingestGitHubWebhook(serviceContext(), { secret: SECRET, ...signed });
    const eventId = (result as { eventId: string }).eventId;
    github.failNext("rate_limited");
    await expect(processExternalEvent(serviceContext(), eventId, github)).rejects.toBeInstanceOf(
      GitHubApiError,
    );
    expect(await getExternalEvent(db, eventId)).toMatchObject({
      processingState: "failed",
      lastErrorCode: "rate_limited",
      attempts: 1,
    });
    // A later attempt succeeds.
    await expect(processExternalEvent(serviceContext(), eventId, github)).resolves.toBe(
      "processed",
    );
  });

  it("classifies non-GitHub failures as internal errors", async () => {
    const { github, installationId } = await connected();
    const signed = await delivery({
      action: "added",
      installation: { id: Number(installationId) },
    });
    const result = await ingestGitHubWebhook(serviceContext(), { secret: SECRET, ...signed });
    const eventId = (result as { eventId: string }).eventId;
    const broken = { ...github, getInstallation: () => Promise.reject(new Error("boom")) };
    await expect(processExternalEvent(serviceContext(), eventId, broken)).rejects.toThrow("boom");
    expect((await getExternalEvent(db, eventId))?.lastErrorCode).toBe("internal_error");
  });
});

describe("listGitHubConnections and resyncWorkspaceConnections", () => {
  it("lets members read and owners resync; strangers see nothing", async () => {
    const { github, owner, connection } = await connected();
    const ctx = serviceContext();
    await resyncWorkspaceConnections(ctx, owner, owner.slug, github);
    // A resync someone asked for is attributed to them.
    const [synced] = (await listAuditEventsByCorrelationId(db, ctx.correlationId)).filter(
      (event) => event.action === "connection.synced",
    );
    expect(synced?.actor).toEqual({ type: "user", id: owner.userId });
    const member = await signedUpUser();
    await addWorkspaceMember(serviceContext(), owner, owner.slug, {
      userId: member.userId,
      role: "member",
    });
    expect(await listGitHubConnections(serviceContext(), member, owner.slug)).toMatchObject([
      { id: connection.id, status: "active", repositories: [{ sellable: true }] },
    ]);
    await expect(
      resyncWorkspaceConnections(serviceContext(), member, owner.slug, github),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const stranger = await signedUpUser();
    await expect(
      listGitHubConnections(serviceContext(), stranger, owner.slug),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("skips deleted connections when resyncing a workspace", async () => {
    const { github, owner, connection, installationId } = await connected();
    github.deleteInstallation(installationId);
    await resyncConnection(serviceContext(), connection, github, "deleted");
    const callsBefore = github.calls.length;
    await resyncWorkspaceConnections(serviceContext(), owner, owner.slug, github);
    expect(github.calls.length).toBe(callsBefore);
  });
});
