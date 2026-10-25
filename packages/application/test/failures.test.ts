import { env } from "cloudflare:workers";
import {
  enqueueOutbox,
  listAuditEventsByCorrelationId,
  markOutboxSent,
  recordExternalEvent,
} from "@sharerepo/db";
import { type OutboxKind, parseWorkspaceSlug } from "@sharerepo/domain";
import { GitHubApiError } from "@sharerepo/integrations";
import { createFakeGitHubApp } from "@sharerepo/integrations/testing";
import { createLogger, ForbiddenError, type Logger, NotFoundError } from "@sharerepo/platform";
import { expectAuditedChange, UNAUDITED_TABLES } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  authorizeOperator,
  checkPaddleConnection,
  createUserForSignIn,
  DISMISS_REASON_MAX_LENGTH,
  dismissFailure,
  encodeOfferKey,
  encodePaddleConnectionKey,
  encodeReconcileKey,
  encodeRefreshKey,
  listAllOpenFailures,
  listOpenFailures,
  RECONCILE_FAILING_THRESHOLD,
  reconcileResource,
  recordJobFailure,
  resyncConnection,
  retryFailure,
  retryFailureAsOperator,
  type ServiceContext,
  viewWorkspaceAsOperator,
} from "../src/index.ts";
import {
  drain,
  memberOf,
  offer,
  refreshRef,
  type Shop,
  shop,
  subscribe,
} from "./support/commerce.ts";
import { clock, db, serviceContext, signedUpUser } from "./support/context.ts";
import { beforeFirstBatch, paddleShop } from "./support/paddle.ts";

// Failures and operators (decision 0014, operations threat model O1–O5 and O19).

/** Every table but the outbox is checked as usual; a failure's own changes must be audited too. */
const { outbox: _outbox, ...WITH_OUTBOX } = UNAUDITED_TABLES;

/** A service context whose alert lines are captured. */
function logged(): { ctx: ServiceContext; lines: () => Record<string, unknown>[] } {
  const ctx = serviceContext();
  const lines: string[] = [];
  const record = (line: string) => {
    lines.push(line);
  };
  const logger = createLogger(
    { correlationId: ctx.correlationId },
    { sink: { debug: record, info: record, warn: record, error: record } },
  );
  return {
    ctx: { ...ctx, logger },
    lines: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** A queued job of the workspace (null: system-wide), then failed for good. */
async function failedJob(
  workspaceId: string | null,
  kind: OutboxKind,
  subjectId: string,
  errorCode = "rejected",
): Promise<string> {
  const id = `obx-${crypto.randomUUID()}`;
  await enqueueOutbox(db, {
    id,
    kind,
    subjectId,
    createdAt: clock.now(),
    availableAt: clock.now(),
    workspaceId,
  });
  expect(await recordJobFailure(serviceContext(), { outboxId: id, errorCode })).toBe(true);
  return id;
}

async function operatorFor(user: { userId: string; profile: { externalUserId: string } }) {
  const operator = await authorizeOperator(
    serviceContext(),
    user,
    new Set([user.profile.externalUserId]),
  );
  if (operator === null) throw new Error("setup: not an operator");
  return operator;
}

const anOperator = async () => operatorFor(await signedUpUser());

const row = (id: string) =>
  env.DB.prepare(
    "SELECT failed_at, last_error_code, attempts, available_at, dismissed_at, dismissed_by, dismiss_reason FROM outbox WHERE id = ?",
  )
    .bind(id)
    .first();

const resourceKey = (s: Shop) =>
  encodeReconcileKey({ workspaceId: s.workspaceId, resourceId: s.resources[0]?.id as string });

describe("authorizeOperator", () => {
  it("operator/non-operator-gets-404: only a listed GitHub ID makes an operator", async () => {
    const user = await signedUpUser();
    const ctx = serviceContext();
    const id = user.profile.externalUserId;
    expect(await authorizeOperator(ctx, user, new Set())).toBeNull();
    expect(await authorizeOperator(ctx, user, new Set(["1", "2"]))).toBeNull();
    // A user without a linked GitHub identity is never an operator.
    const { userId } = await createUserForSignIn(serviceContext());
    expect(await authorizeOperator(ctx, { userId }, new Set([id]))).toBeNull();
    expect(await authorizeOperator(ctx, user, new Set(["1", id]))).toEqual({
      userId: user.userId,
      githubUserId: id,
    });
  });
});

describe("recordJobFailure", () => {
  it("audits the failure it records, in the row's workspace", async () => {
    const s = await shop();
    const id = `obx-${crypto.randomUUID()}`;
    await enqueueOutbox(db, {
      id,
      kind: "resync_connection",
      subjectId: s.connection.id,
      createdAt: clock.now(),
      availableAt: clock.now(),
      workspaceId: s.workspaceId,
    });
    const ctx = serviceContext();
    const recorded = await expectAuditedChange(
      env.DB,
      ctx.correlationId,
      () => recordJobFailure(ctx, { outboxId: id, errorCode: "rejected" }),
      WITH_OUTBOX,
    );
    expect(recorded).toMatchObject({ result: true, changedTables: ["outbox"], auditEventCount: 1 });
  });

  it("writes nothing when the row was sent between its read and its write", async () => {
    const s = await shop();
    const id = `obx-${crypto.randomUUID()}`;
    await enqueueOutbox(db, {
      id,
      kind: "resync_connection",
      subjectId: s.connection.id,
      createdAt: clock.now(),
      availableAt: clock.now(),
      workspaceId: s.workspaceId,
    });
    const { ctx: base, lines } = logged();
    const ctx = {
      ...beforeFirstBatch(() => markOutboxSent(db, [id], clock.now())),
      logger: base.logger as Logger,
    };
    expect(await recordJobFailure(ctx, { outboxId: id, errorCode: "rejected" })).toBe(false);
    expect(await row(id)).toMatchObject({ failed_at: null });
    expect(await listAuditEventsByCorrelationId(db, ctx.correlationId)).toEqual([]);
    expect(lines()).toEqual([]);
  });
});

describe("listOpenFailures", () => {
  it("failure/owner-sees-only-own-failures", async () => {
    const mine = await shop();
    const theirs = await shop();
    const own = await failedJob(mine.workspaceId, "reconcile_resource", resourceKey(mine));
    const other = await failedJob(theirs.workspaceId, "reconcile_resource", resourceKey(theirs));
    const system = await failedJob(null, "prune_data", "daily");
    // A row in my workspace whose key names theirs resolves nothing of theirs. Failed later.
    clock.advance(1);
    const crossKey = await failedJob(mine.workspaceId, "reconcile_resource", resourceKey(theirs));

    const failures = await listOpenFailures(serviceContext(), mine, mine.slug);
    expect(failures.jobs.map((job) => job.id)).toEqual([own, crossKey]);
    expect(failures.jobs[0]).toMatchObject({
      workspaceId: mine.workspaceId,
      workspaceSlug: mine.slug,
      kind: "reconcile_resource",
      errorCode: "rejected",
      attempts: 0,
      failedAt: clock.now() - 1,
      affected: { repositories: [mine.resources[0]?.nameSnapshot] },
    });
    expect(failures.jobs[1]?.affected.repositories).toEqual([]);
    expect(failures.canRetry).toBe(true);
    const ids = failures.jobs.map((job) => job.id);
    expect(ids).not.toContain(other);
    expect(ids).not.toContain(system);

    // Members see them but cannot retry; non-members do not see the workspace at all.
    const member = await memberOf(mine);
    expect((await listOpenFailures(serviceContext(), member, mine.slug)).canRetry).toBe(false);
    await expect(listOpenFailures(serviceContext(), theirs, mine.slug)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // Retrying another workspace's failure, or a system-wide one, through my workspace finds none.
    for (const id of [other, system]) {
      await expect(retryFailure(serviceContext(), mine, mine.slug, id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }
    expect(await row(other)).toMatchObject({ failed_at: clock.now() - 1 });
    await expect(retryFailure(serviceContext(), member, mine.slug, own)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("lists repositories that keep failing to check, from the threshold", async () => {
    const s = await shop(2);
    const [first, second] = s.resources;
    await env.DB.prepare("UPDATE resources SET reconcile_failures = ? WHERE id = ?")
      .bind(RECONCILE_FAILING_THRESHOLD, first?.id)
      .run();
    await env.DB.prepare("UPDATE resources SET reconcile_failures = ? WHERE id = ?")
      .bind(RECONCILE_FAILING_THRESHOLD - 1, second?.id)
      .run();
    const failures = await listOpenFailures(serviceContext(), s, s.slug);
    expect(failures.repositories.map((r) => r.resourceId)).toEqual([first?.id]);
  });
});

describe("affected access", () => {
  async function affectedOf(workspaceId: string | null, kind: OutboxKind, subjectId: string) {
    const id = await failedJob(workspaceId, kind, subjectId);
    const all = await listAllOpenFailures(serviceContext(), await anOperator());
    return all.jobs.find((job) => job.id === id)?.affected;
  }
  const nothing = {
    repositories: [],
    subscribers: [],
    offers: [],
    connection: null,
    event: null,
  };

  it("names the repositories, subscriber and offer of a subscription or offer", async () => {
    const s = await shop();
    const sold = await offer(s, { items: ["sim_fail"], name: "Pro" });
    const sub = await subscribe(s, { items: ["sim_fail"] });
    await drain(s.workspaceId);
    const repository = s.resources[0]?.nameSnapshot;
    expect(
      await affectedOf(
        s.workspaceId,
        "refresh_subscription",
        encodeRefreshKey(refreshRef(s, sub.id)),
      ),
    ).toEqual({
      ...nothing,
      repositories: [repository],
      subscribers: [sub.login],
      offers: ["Pro"],
    });
    expect(
      await affectedOf(
        s.workspaceId,
        "recompute_offer",
        encodeOfferKey({ workspaceId: s.workspaceId, offerId: sold.id }),
      ),
    ).toEqual({ ...nothing, repositories: [repository], offers: ["Pro"] });
    expect(await affectedOf(s.workspaceId, "resync_connection", s.connection.id)).toEqual({
      ...nothing,
      connection: { provider: "github", name: expect.any(String) },
    });
  });

  it("names a Paddle connection only while it is the workspace's live one", async () => {
    const s = await paddleShop();
    const key = encodePaddleConnectionKey({
      workspaceId: s.workspaceId,
      connectionId: s.connectionId,
    });
    for (const kind of ["check_paddle_connection", "sweep_paddle_subscriptions"] as const) {
      expect(await affectedOf(s.workspaceId, kind, key)).toEqual({
        ...nothing,
        connection: { provider: "paddle", name: expect.any(String) },
      });
    }
    await env.DB.prepare("UPDATE paddle_connections SET seller_name = NULL WHERE id = ?")
      .bind(s.connectionId)
      .run();
    expect((await affectedOf(s.workspaceId, "check_paddle_connection", key))?.connection).toEqual({
      provider: "paddle",
      name: expect.stringMatching(/^slr_/),
    });
    const stale = encodePaddleConnectionKey({
      workspaceId: s.workspaceId,
      connectionId: "pdc_old",
    });
    expect(await affectedOf(s.workspaceId, "check_paddle_connection", stale)).toEqual(nothing);
  });

  it("names a webhook by provider and type, even without a workspace", async () => {
    const eventId = `evt-${crypto.randomUUID()}`;
    await recordExternalEvent(
      db,
      {
        id: eventId,
        provider: "github",
        connectionId: null,
        externalEventId: crypto.randomUUID(),
        eventType: "installation",
        action: "deleted",
        installationId: "1",
        externalSubscriptionId: null,
        payloadDigest: "sha256:abc",
        occurredAt: null,
        receivedAt: clock.now(),
      },
      [],
    );
    expect(await affectedOf(null, "process_external_event", eventId)).toEqual({
      ...nothing,
      event: { provider: "github", type: "installation" },
    });
    expect(await affectedOf(null, "process_external_event", "evt-missing")).toEqual(nothing);
  });

  it("names nothing it cannot resolve within the failure's own workspace", async () => {
    const s = await shop();
    const ws = s.workspaceId;
    const cases: [string | null, OutboxKind, string][] = [
      // System-wide: nothing tenant-scoped is resolved, whatever the key says.
      [null, "reconcile_resource", resourceKey(s)],
      [ws, "reconcile_resource", "not-a-key"],
      [ws, "reconcile_resource", encodeReconcileKey({ workspaceId: ws, resourceId: "res_gone" })],
      [ws, "refresh_subscription", "not-a-key"],
      [ws, "recompute_offer", "not-a-key"],
      [ws, "resync_connection", "con_gone"],
      [ws, "check_paddle_connection", "not-a-key"],
      [
        ws,
        "check_paddle_connection",
        encodePaddleConnectionKey({ workspaceId: ws, connectionId: "p" }),
      ],
      [ws, "send_claim_email", `${ws}:clr_1`],
    ];
    for (const [workspaceId, kind, subjectId] of cases) {
      expect(await affectedOf(workspaceId, kind, subjectId)).toEqual(nothing);
    }
  });
});

describe("operators", () => {
  it("lists every workspace's failures, failing repositories, unhealthy connections and sweep health", async () => {
    const a = await shop();
    const b = await shop();
    const ja = await failedJob(a.workspaceId, "resync_connection", a.connection.id);
    const jb = await failedJob(b.workspaceId, "resync_connection", b.connection.id);
    const js = await failedJob(null, "prune_data", "daily");
    await env.DB.prepare("UPDATE resources SET reconcile_failures = 4 WHERE id = ?")
      .bind(b.resources[0]?.id)
      .run();
    b.github.suspend(b.installationId, clock.now());
    await resyncConnection(serviceContext(), b.connection, b.github, "test");

    const all = await listAllOpenFailures(serviceContext(), await anOperator());
    const ids = all.jobs.map((job) => job.id);
    expect(ids).toEqual(expect.arrayContaining([ja, jb, js]));
    expect(all.jobs.find((job) => job.id === js)).toMatchObject({
      workspaceId: null,
      workspaceSlug: null,
    });
    expect(all.repositories.map((r) => r.resourceId)).toContain(b.resources[0]?.id);
    expect(all.connections.map((c) => c.connectionId)).toContain(b.connection.id);
    expect(Object.keys(all.sweep).sort()).toEqual([
      "lastHeartbeatAt",
      "oldestDueEvaluationAt",
      "oldestDueOutboxAt",
      "oldestDueReconcileAt",
    ]);
  });

  it("operator/actions-audited", async () => {
    const s = await shop();
    const operator = await anOperator();
    const workspaceJob = await failedJob(s.workspaceId, "resync_connection", s.connection.id);
    const systemJob = await failedJob(null, "prune_data", "daily", "not_implemented");

    // Dismiss, with a reason: audited in the workspace, actor the operator.
    const dismissing = serviceContext();
    const dismissed = await expectAuditedChange(
      env.DB,
      dismissing.correlationId,
      () =>
        dismissFailure(dismissing, operator, {
          workspaceId: s.workspaceId,
          outboxId: workspaceJob,
          reason: "  GitHub outage, retried by hand  ",
        }),
      WITH_OUTBOX,
    );
    expect(dismissed.result).toEqual({ ok: true });
    expect(dismissed.changedTables).toEqual(["outbox"]);
    expect(await row(workspaceJob)).toMatchObject({
      dismissed_by: operator.userId,
      dismiss_reason: "GitHub outage, retried by hand",
    });
    expect(await listAuditEventsByCorrelationId(db, dismissing.correlationId)).toEqual([
      expect.objectContaining({
        action: "job.dismissed",
        scope: "workspace",
        workspaceId: s.workspaceId,
        actor: { type: "operator", id: operator.userId },
        target: { type: "outbox", id: workspaceJob },
        reason: "GitHub outage, retried by hand",
        details: { kind: "resync_connection", errorCode: "rejected" },
      }),
    ]);
    // A dismissed failure is no longer open: not listed, not dismissed again.
    expect((await listOpenFailures(serviceContext(), s, s.slug)).jobs).toEqual([]);
    await expect(
      dismissFailure(serviceContext(), operator, {
        workspaceId: s.workspaceId,
        outboxId: workspaceJob,
        reason: "again",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Retrying the dismissed failure clears its failure and dismissal.
    const retrying = serviceContext();
    const retried = await expectAuditedChange(
      env.DB,
      retrying.correlationId,
      () =>
        retryFailureAsOperator(retrying, operator, {
          workspaceId: s.workspaceId,
          outboxId: workspaceJob,
        }),
      WITH_OUTBOX,
    );
    expect(retried.result).toEqual({
      outboxId: workspaceJob,
      kind: "resync_connection",
      subjectId: s.connection.id,
    });
    expect(await row(workspaceJob)).toEqual({
      failed_at: null,
      last_error_code: null,
      attempts: 0,
      available_at: clock.now(),
      dismissed_at: null,
      dismissed_by: null,
      dismiss_reason: null,
    });
    expect(await listAuditEventsByCorrelationId(db, retrying.correlationId)).toEqual([
      expect.objectContaining({
        action: "job.retried",
        actor: { type: "operator", id: operator.userId },
        details: { kind: "resync_connection", previousErrorCode: "rejected" },
      }),
    ]);

    // A system-wide failure is addressed with an explicit null workspace, account-scoped.
    await expect(
      retryFailureAsOperator(serviceContext(), operator, {
        workspaceId: s.workspaceId,
        outboxId: systemJob,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const system = serviceContext();
    await expectAuditedChange(
      env.DB,
      system.correlationId,
      () => retryFailureAsOperator(system, operator, { workspaceId: null, outboxId: systemJob }),
      WITH_OUTBOX,
    );
    expect(await listAuditEventsByCorrelationId(db, system.correlationId)).toEqual([
      expect.objectContaining({ action: "job.retried", scope: "account", workspaceId: null }),
    ]);

    // Reading a workspace is audited too.
    const viewing = serviceContext();
    const viewed = await expectAuditedChange(
      env.DB,
      viewing.correlationId,
      () => viewWorkspaceAsOperator(viewing, operator, s.slug),
      WITH_OUTBOX,
    );
    expect(viewed.changedTables).toEqual([]);
    expect(await listAuditEventsByCorrelationId(db, viewing.correlationId)).toEqual([
      expect.objectContaining({
        action: "operator.viewed_workspace",
        workspaceId: s.workspaceId,
        actor: { type: "operator", id: operator.userId },
        target: { type: "workspace", id: s.workspaceId },
      }),
    ]);
  });

  it("refuses a dismissal without a usable reason, writing nothing", async () => {
    const s = await shop();
    const operator = await anOperator();
    const id = await failedJob(s.workspaceId, "resync_connection", s.connection.id);
    const key = { workspaceId: s.workspaceId, outboxId: id };
    expect(await dismissFailure(serviceContext(), operator, { ...key, reason: "  " })).toEqual({
      ok: false,
      error: "reason_required",
    });
    const long = "x".repeat(DISMISS_REASON_MAX_LENGTH + 1);
    expect(await dismissFailure(serviceContext(), operator, { ...key, reason: long })).toEqual({
      ok: false,
      error: "reason_too_long",
    });
    expect(
      await dismissFailure(serviceContext(), operator, {
        ...key,
        reason: "x".repeat(DISMISS_REASON_MAX_LENGTH),
      }),
    ).toEqual({ ok: true });
    await expect(
      dismissFailure(serviceContext(), operator, { ...key, workspaceId: null, reason: "r" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("gives up when the failure changed between its read and its write", async () => {
    const s = await shop();
    const operator = await anOperator();
    const retriedMeanwhile = async (id: string) =>
      env.DB.prepare("UPDATE outbox SET failed_at = NULL WHERE id = ?").bind(id).run();

    const one = await failedJob(s.workspaceId, "resync_connection", s.connection.id);
    await expect(
      retryFailure(
        beforeFirstBatch(() => retriedMeanwhile(one)),
        s,
        s.slug,
        one,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    const two = await failedJob(s.workspaceId, "resync_connection", s.connection.id);
    const dismissedMeanwhile = () =>
      dismissFailure(serviceContext(), operator, {
        workspaceId: s.workspaceId,
        outboxId: two,
        reason: "first",
      });
    const ctx = beforeFirstBatch(dismissedMeanwhile);
    await expect(
      dismissFailure(ctx, operator, {
        workspaceId: s.workspaceId,
        outboxId: two,
        reason: "second",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await listAuditEventsByCorrelationId(db, ctx.correlationId)).toEqual([]);
  });

  it("records an unknown previous error code as unknown", async () => {
    const s = await shop();
    const id = await failedJob(s.workspaceId, "resync_connection", s.connection.id);
    await env.DB.prepare("UPDATE outbox SET last_error_code = NULL WHERE id = ?").bind(id).run();
    const ctx = serviceContext();
    const retried = await expectAuditedChange(
      env.DB,
      ctx.correlationId,
      () => retryFailure(ctx, s, s.slug, id),
      WITH_OUTBOX,
    );
    expect(retried.changedTables).toEqual(["outbox"]);
    expect((await listAuditEventsByCorrelationId(db, ctx.correlationId))[0]?.details).toEqual({
      kind: "resync_connection",
      previousErrorCode: "unknown",
    });
    const operator = await anOperator();
    const other = await failedJob(s.workspaceId, "resync_connection", s.connection.id);
    await env.DB.prepare("UPDATE outbox SET last_error_code = NULL WHERE id = ?").bind(other).run();
    const dismissing = serviceContext();
    await dismissFailure(dismissing, operator, {
      workspaceId: s.workspaceId,
      outboxId: other,
      reason: "r",
    });
    expect(
      (await listAuditEventsByCorrelationId(db, dismissing.correlationId))[0]?.details,
    ).toEqual({ kind: "resync_connection", errorCode: "unknown" });
  });

  it("shows a workspace read-only, and refuses an unknown one", async () => {
    const s = await shop();
    await offer(s, { items: ["sim_view"] });
    await subscribe(s, { items: ["sim_view"] });
    await drain(s.workspaceId);
    await failedJob(s.workspaceId, "resync_connection", s.connection.id);
    const operator = await anOperator();
    const view = await viewWorkspaceAsOperator(serviceContext(), operator, s.slug);
    expect(view.workspace).toEqual({
      id: s.workspaceId,
      slug: s.slug,
      name: "Shop",
      status: "active",
    });
    expect(view.access.canManage).toBe(false);
    expect(view.access.rows).toHaveLength(1);
    expect(view.failures.canRetry).toBe(false);
    expect(view.failures.jobs).toHaveLength(1);
    for (const slug of ["ws-does-not-exist", "Not A Slug!"]) {
      const ctx = serviceContext();
      await expect(viewWorkspaceAsOperator(ctx, operator, slug)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(await listAuditEventsByCorrelationId(db, ctx.correlationId)).toEqual([]);
    }
    expect(parseWorkspaceSlug(s.slug).ok).toBe(true);
  });
});

describe("alert lines", () => {
  it("raises reconcile_failing once, at the third failure in a row", async () => {
    const s = await shop(1, createFakeGitHubApp({ clock }));
    await offer(s, { items: ["sim_alert"], resources: s.resources });
    await subscribe(s, { items: ["sim_alert"] });
    await drain(s.workspaceId);
    const ref = { workspaceId: s.workspaceId, resourceId: s.resources[0]?.id as string };
    const seen: Record<string, unknown>[] = [];
    for (let attempt = 1; attempt <= RECONCILE_FAILING_THRESHOLD + 1; attempt += 1) {
      clock.advance(24 * 60 * 60_000);
      s.github.failNext(
        "listCollaborators",
        new GitHubApiError("transient", "down", { status: 502 }),
      );
      const { ctx, lines } = logged();
      expect(await reconcileResource(ctx, ref, s.github)).toBe("done");
      seen.push(...lines().filter((line) => line.alert !== undefined));
    }
    expect(seen).toEqual([
      expect.objectContaining({
        alert: "reconcile_failing",
        workspaceId: s.workspaceId,
        resourceId: ref.resourceId,
        failures: RECONCILE_FAILING_THRESHOLD,
        errorCode: "provider_unavailable",
      }),
    ]);
  });

  it("raises connection_lost when an installation is suspended or deleted, once", async () => {
    const s = await shop();
    s.github.suspend(s.installationId, clock.now());
    const first = logged();
    await resyncConnection(first.ctx, s.connection, s.github, "test");
    expect(first.lines().filter((line) => line.alert !== undefined)).toEqual([
      expect.objectContaining({
        alert: "connection_lost",
        workspaceId: s.workspaceId,
        connectionId: s.connection.id,
        provider: "github",
        status: "suspended",
      }),
    ]);
    // Still suspended: no change, no alert.
    const again = logged();
    await resyncConnection(again.ctx, s.connection, s.github, "test");
    expect(again.lines().filter((line) => line.alert !== undefined)).toEqual([]);
    // Resumed: no alert either.
    s.github.unsuspend(s.installationId);
    const resumed = logged();
    await resyncConnection(resumed.ctx, s.connection, s.github, "test");
    expect(resumed.lines().filter((line) => line.alert !== undefined)).toEqual([]);
  });

  it("raises connection_lost when Paddle refuses a connection's key, once", async () => {
    const s = await paddleShop();
    const ref = { workspaceId: s.workspaceId, connectionId: s.connectionId };
    s.paddle.revokeKey();
    const first = logged();
    expect(await checkPaddleConnection(first.ctx, ref, s.deps)).toBe("unauthorized");
    expect(first.lines().filter((line) => line.alert !== undefined)).toEqual([
      expect.objectContaining({
        alert: "connection_lost",
        workspaceId: s.workspaceId,
        connectionId: s.connectionId,
        provider: "paddle",
        status: "unauthorized",
      }),
    ]);
    const again = logged();
    await checkPaddleConnection(again.ctx, ref, s.deps);
    s.paddle.restoreKey();
    await checkPaddleConnection(again.ctx, ref, s.deps);
    expect(again.lines().filter((line) => line.alert !== undefined)).toEqual([]);
  });
});
