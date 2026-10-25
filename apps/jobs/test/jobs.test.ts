import { env } from "cloudflare:workers";
import { claimOutbox, enqueueOutbox, getExternalEvent } from "@sharerepo/db";
import { GitHubApiError, type GitHubAppPort } from "@sharerepo/integrations";
import { createFakeGitHubApp, type FakeGitHubApp } from "@sharerepo/integrations/testing";
import { ConflictError, NotFoundError } from "@sharerepo/platform";
import {
  captureLogs,
  changedTables,
  type LogCapture,
  SequentialIds,
  snapshotTables,
} from "@sharerepo/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CRONS,
  OUTBOX_BATCH,
  OUTBOX_DRAIN_BUDGET_MS,
  OUTBOX_MAX_ATTEMPTS,
} from "../src/handlers.ts";
import worker from "../src/index.ts";
import { retryDelaySeconds } from "../src/work.ts";
import {
  clock,
  connectedCreator,
  count,
  db,
  envWithGitHub,
  outboxIdFor,
  receivedWebhook,
} from "./support/github.ts";
import { deliver, jobsWorker, outboxRow, runCron, sentAt } from "./support/worker.ts";

const resourcesOf = (connectionId: string) =>
  count("SELECT count(*) AS n FROM resources WHERE connection_id = ?", connectionId);

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});
const logged = () => logs.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
const retried = () => logged().find((line) => line.msg === "job will be retried");

describe("queue()", () => {
  it("queue/redelivery-is-idempotent", async () => {
    const github = createFakeGitHubApp();
    const { installationId, connection } = await connectedCreator(github);
    const { eventId, outboxId } = await receivedWebhook(installationId);
    const message = { kind: "process_external_event", subjectId: eventId, outboxId };

    // At-least-once delivery: the same message twice in one batch, then once more.
    const result = await deliver(jobsWorker(github), [message, message]);
    const before = await snapshotTables(env.DB);
    const again = await deliver(jobsWorker(github), [message]);

    expect(result.explicitAcks).toHaveLength(2);
    expect(again.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toEqual([]);
    expect(changedTables(before, await snapshotTables(env.DB))).toEqual([]);
    expect(await resourcesOf(connection.id)).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_events WHERE action = 'resource.discovered' AND workspace_id = ?",
        connection.workspaceId,
      ),
    ).toBe(1);
    expect((await getExternalEvent(db, eventId))?.processingState).toBe("processed");
    expect(await sentAt(outboxId)).toBe(clock.now());
  });

  it("runs a resync_connection job for its connection's workspace", async () => {
    const github = createFakeGitHubApp();
    const { connection } = await connectedCreator(github);
    const outboxId = await outboxIdFor(connection.id);
    const result = await deliver(jobsWorker(github), [
      { kind: "resync_connection", subjectId: connection.id, outboxId },
    ]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(await resourcesOf(connection.id)).toBe(1);
  });

  // The message names a connection that no workspace owns (unknown, or deleted). A job never
  // takes its workspace from the message, so there is nothing it may act on: it is acknowledged
  // as out of scope and changes nothing but its own outbox bookkeeping.
  it("isolation/job-without-workspace-scope-rejected", async () => {
    const github = createFakeGitHubApp();
    const before = await snapshotTables(env.DB);
    const result = await deliver(jobsWorker(github), [
      { kind: "resync_connection", subjectId: "no-such-connection", outboxId: "no-such-outbox" },
    ]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(changedTables(before, await snapshotTables(env.DB))).toEqual([]);
    expect(github.calls).toEqual([]);
    expect(logged().map((line) => line.msg)).toContain("job has no workspace scope");
  });

  // Phase 6 T1 placeholders: the kinds exist in the vocabulary; T4 and T5 add their handlers.
  it.each(["prune_data", "purge_workspace"] as const)(
    "fails %s for good until its handler lands",
    async (kind) => {
      const outboxId = `row-${crypto.randomUUID()}`;
      await enqueueOutbox(db, {
        id: outboxId,
        kind,
        subjectId: "x",
        createdAt: clock.now(),
        availableAt: clock.now(),
        workspaceId: null,
      });
      const result = await deliver(jobsWorker(createFakeGitHubApp()), [
        { kind, subjectId: "x", outboxId },
      ]);
      expect(result.explicitAcks).toHaveLength(1);
      expect(result.retryMessages).toEqual([]);
      expect(await outboxRow(outboxId)).toMatchObject({
        sent_at: null,
        last_error_code: "not_implemented",
      });
    },
  );

  it("drops a poison message without retrying it", async () => {
    const result = await deliver(jobsWorker(createFakeGitHubApp()), [
      { kind: "delete_everything", subjectId: "x", outboxId: "y" },
      "not an object",
    ]);
    expect(result.explicitAcks).toHaveLength(2);
    expect(result.retryMessages).toEqual([]);
    expect(logged().filter((line) => line.msg === "invalid job message dropped")).toHaveLength(2);
  });

  it("retries a GitHub outage with a growing delay", async () => {
    const github = createFakeGitHubApp();
    const { installationId } = await connectedCreator(github);
    const { eventId, outboxId } = await receivedWebhook(installationId);
    github.failNext("transient");
    const result = await deliver(
      jobsWorker(github),
      [{ kind: "process_external_event", subjectId: eventId, outboxId }],
      { attempts: 3 },
    );
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toHaveLength(1);
    // getQueueResult does not report the delay; the log line carries it.
    expect(retried()).toMatchObject({ delaySeconds: 120, errorKind: "transient" });
    expect(await sentAt(outboxId)).toBeNull();
  });

  it("retries a rate limit after GitHub's reset time", async () => {
    const github = createFakeGitHubApp();
    const { installationId } = await connectedCreator(github);
    const { eventId, outboxId } = await receivedWebhook(installationId);
    const limited: GitHubAppPort = {
      ...github,
      getInstallation: () =>
        Promise.reject(new GitHubApiError("rate_limited", "limited", { retryAfterMs: 90_500 })),
    };
    const result = await deliver(jobsWorker(limited), [
      { kind: "process_external_event", subjectId: eventId, outboxId },
    ]);
    expect(result.retryMessages).toHaveLength(1);
    expect(retried()).toMatchObject({ delaySeconds: 91, errorKind: "rate_limited" });
  });

  it("retries a resync that kept losing to concurrent ones", async () => {
    const github = createFakeGitHubApp();
    const { installationId } = await connectedCreator(github);
    const { eventId, outboxId } = await receivedWebhook(installationId);
    const contended: GitHubAppPort = {
      ...github,
      getInstallation: () => Promise.reject(new ConflictError("connection kept changing")),
    };
    const result = await deliver(jobsWorker(contended), [
      { kind: "process_external_event", subjectId: eventId, outboxId },
    ]);
    expect(result.retryMessages).toHaveLength(1);
    expect(retried()).toMatchObject({ delaySeconds: 30, errorName: "ConflictError" });
  });

  it("acknowledges a failure a retry cannot fix, logging only its classification", async () => {
    const github = createFakeGitHubApp();
    const { installationId } = await connectedCreator(github);
    const { eventId, outboxId } = await receivedWebhook(installationId);
    const broken: GitHubAppPort = {
      ...github,
      getInstallation: () => Promise.reject(new Error("secret detail")),
    };
    const result = await deliver(jobsWorker(broken), [
      { kind: "process_external_event", subjectId: eventId, outboxId },
    ]);
    expect(result.explicitAcks).toHaveLength(1);
    expect((await getExternalEvent(db, eventId))?.lastErrorCode).toBe("internal_error");
    expect(logs.text()).not.toContain("secret detail");
    expect(logged().at(-1)).toMatchObject({
      level: "error",
      msg: "job failed",
      errorName: "Error",
    });
  });

  it("drops jobs while no GitHub App is configured", async () => {
    const result = await deliver(
      jobsWorker(createFakeGitHubApp()),
      [{ kind: "resync_connection", subjectId: "c", outboxId: "o" }],
      { bindings: env },
    );
    expect(result.explicitAcks).toHaveLength(1);
    expect(logged().map((line) => line.msg)).toContain("GitHub App not configured; job dropped");
  });

  it("runs through the default export with the real GitHub App client", async () => {
    // An event that does not exist needs no GitHub call, so no network is touched.
    const result = await deliver(worker, [
      { kind: "process_external_event", subjectId: "no-such-event", outboxId: "o" },
    ]);
    expect(result.explicitAcks).toHaveLength(1);
  });
});

describe("retryDelaySeconds", () => {
  it.each([
    [1, undefined, 30],
    [2, undefined, 60],
    [4, undefined, 240],
    [20, undefined, 900],
    [0, undefined, 30],
    [1, 0, 1],
    [1, 1_500, 2],
    [1, 3_600_000, 900],
  ])("attempt %i, retry-after %s ms → %i s", (attempts, retryAfterMs, expected) => {
    expect(retryDelaySeconds(attempts, retryAfterMs)).toBe(expected);
  });
});

describe("scheduled()", () => {
  async function pendingConnection(github: FakeGitHubApp) {
    const created = await connectedCreator(github);
    return { ...created, outboxId: await outboxIdFor(created.connection.id) };
  }

  it("drains due outbox rows, running each job once", async () => {
    const github = createFakeGitHubApp();
    const { connection, outboxId } = await pendingConnection(github);
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    expect(await resourcesOf(connection.id)).toBe(1);
    expect(await sentAt(outboxId)).toBe(clock.now());

    const calls = github.calls.length;
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    expect(github.calls.length).toBe(calls);
  });

  it("does not run rows another drainer has leased", async () => {
    const github = createFakeGitHubApp();
    const { connection } = await pendingConnection(github);
    await claimOutbox(db, { now: clock.now(), limit: 1000, leaseMs: 60_000, maxAttempts: 10 });
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    expect(await resourcesOf(connection.id)).toBe(0);
  });

  it("leaves a failed job leased for a later attempt", async () => {
    const github = createFakeGitHubApp();
    const { outboxId } = await pendingConnection(github);
    // Clear anything else due so this row is the only claimed job.
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    // Due before anything else, so it is the first job claimed and meets the failure.
    await env.DB.prepare("UPDATE outbox SET sent_at = NULL, available_at = 0 WHERE id = ?")
      .bind(outboxId)
      .run();
    github.failNext("transient");
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    expect(await sentAt(outboxId)).toBeNull();
    expect(logged().find((line) => line.msg === "outbox job failed")).toMatchObject({
      outboxId,
      kind: "resync_connection",
      errorKind: "transient",
    });
  });

  it("marks an out-of-scope outbox job sent so it is not repeated", async () => {
    const id = `out-${crypto.randomUUID()}`;
    await enqueueOutbox(db, {
      id,
      kind: "resync_connection",
      subjectId: "no-such-connection",
      createdAt: clock.now(),
      availableAt: clock.now(),
      workspaceId: null,
    });
    await runCron(jobsWorker(createFakeGitHubApp()), CRONS.drainOutbox);
    expect(await sentAt(id)).toBe(clock.now());
  });

  it("queues a resync of every connection daily for the outbox drain to run", async () => {
    const github = createFakeGitHubApp();
    const first = await connectedCreator(github);
    const second = await connectedCreator(github);
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    await runCron(jobsWorker(github), CRONS.dailyResync);
    const summary = logged().find((line) => line.msg === "daily resync queued");
    expect(summary?.connections).toBeGreaterThanOrEqual(2);
    for (const { connection } of [first, second]) {
      const queued = await env.DB.prepare(
        "SELECT count(*) AS n FROM outbox WHERE kind = 'resync_connection' AND subject_id = ? AND sent_at IS NULL",
      )
        .bind(connection.id)
        .first<{ n: number }>();
      expect(queued?.n).toBe(1);
    }
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    expect(await resourcesOf(first.connection.id)).toBe(1);
    expect(await resourcesOf(second.connection.id)).toBe(1);
  });

  it("marks a job that cannot succeed as failed at once, and stops retrying it", async () => {
    const github = createFakeGitHubApp();
    const { outboxId } = await pendingConnection(github);
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    await env.DB.prepare("UPDATE outbox SET sent_at = NULL, available_at = 0 WHERE id = ?")
      .bind(outboxId)
      .run();
    github.failNext("rejected");
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    expect(
      await env.DB.prepare("SELECT last_error_code AS code FROM outbox WHERE id = ?")
        .bind(outboxId)
        .first(),
    ).toEqual({ code: "rejected" });
    expect(logged().find((line) => line.msg === "outbox job failed")).toMatchObject({
      final: true,
      errorKind: "rejected",
    });
    // Never claimed again.
    clock.advance(10 * 60_000);
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    expect(await sentAt(outboxId)).toBeNull();
  });

  it("marks a retryable job failed once it used every attempt", async () => {
    const github = createFakeGitHubApp();
    const { outboxId } = await pendingConnection(github);
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    await env.DB.prepare(
      "UPDATE outbox SET sent_at = NULL, available_at = 0, attempts = ? WHERE id = ?",
    )
      .bind(OUTBOX_MAX_ATTEMPTS - 1, outboxId)
      .run();
    github.failNext("transient");
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    expect(
      await env.DB.prepare("SELECT last_error_code AS code FROM outbox WHERE id = ?")
        .bind(outboxId)
        .first(),
    ).toEqual({ code: "transient" });
  });

  it("classifies non-GitHub failures by error code, or as internal", async () => {
    const github = createFakeGitHubApp();
    const { outboxId } = await pendingConnection(github);
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    const reset = () =>
      env.DB.prepare(
        "UPDATE outbox SET sent_at = NULL, failed_at = NULL, available_at = 0 WHERE id = ?",
      )
        .bind(outboxId)
        .run();
    const code = async () =>
      (
        await env.DB.prepare("SELECT last_error_code AS code FROM outbox WHERE id = ?")
          .bind(outboxId)
          .first<{ code: string }>()
      )?.code;
    await reset();
    await runCron(
      jobsWorker({ ...github, getInstallation: () => Promise.reject(new NotFoundError()) }),
      CRONS.drainOutbox,
    );
    expect(await code()).toBe("not_found");
    await reset();
    await runCron(
      jobsWorker({ ...github, getInstallation: () => Promise.reject("plain string") }),
      CRONS.drainOutbox,
    );
    expect(await code()).toBe("internal_error");
    expect(
      logged()
        .filter((line) => line.msg === "outbox job failed")
        .map((line) => line.errorName),
    ).toContain("unknown");
  });

  /** Queues `n` out-of-scope jobs (cheap to run), due before anything else. */
  async function queuedJobs(n: number) {
    const prefix = `bulk-${crypto.randomUUID()}`;
    for (let i = 0; i < n; i += 1) {
      await enqueueOutbox(db, {
        id: `${prefix}-${i}`,
        kind: "resync_connection",
        subjectId: "no-such-connection",
        createdAt: 0,
        availableAt: 0,
        workspaceId: null,
      });
    }
    return () =>
      count("SELECT count(*) AS n FROM outbox WHERE id LIKE ? AND sent_at IS NULL", `${prefix}-%`);
  }

  it("keeps draining while batches come back full, in one tick", async () => {
    const unsent = await queuedJobs(OUTBOX_BATCH * 2 + 10);
    await runCron(jobsWorker(createFakeGitHubApp()), CRONS.drainOutbox);
    expect(await unsent()).toBe(0);
    const drained = logged().find((line) => line.msg === "outbox drained");
    expect(drained?.claimed).toBeGreaterThanOrEqual(OUTBOX_BATCH * 2 + 10);
  });

  it("stops claiming new batches once its time budget is spent", async () => {
    await runCron(jobsWorker(createFakeGitHubApp()), CRONS.drainOutbox);
    const unsent = await queuedJobs(OUTBOX_BATCH * 2);
    // Every job takes a second: the first batch spends more than the budget.
    const slow = new SequentialIds({ prefix: `slow-${crypto.randomUUID()}-` });
    const ids = {
      next: () => {
        clock.advance(Math.ceil(OUTBOX_DRAIN_BUDGET_MS / OUTBOX_BATCH) + 1);
        return slow.next();
      },
    };
    await runCron(jobsWorker(createFakeGitHubApp(), { ids }), CRONS.drainOutbox);
    expect(await unsent()).toBe(OUTBOX_BATCH);
    await runCron(jobsWorker(createFakeGitHubApp()), CRONS.drainOutbox);
    expect(await unsent()).toBe(0);
  });

  it("still drains the outbox when the due-evaluation sweep fails", async () => {
    const unsent = await queuedJobs(1);
    // The sweep's query is the tick's first statement; it fails as during a D1 outage.
    let failures = 1;
    const flaky = new Proxy(env.DB, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "prepare" && failures > 0) {
            failures -= 1;
            throw new Error("d1 unavailable: secret-ish detail");
          }
          return value.apply(target, args);
        };
      },
    });
    await runCron(jobsWorker(createFakeGitHubApp()), CRONS.drainOutbox, {
      ...envWithGitHub,
      DB: flaky,
    } as Env);
    expect(logged().find((line) => line.msg === "due evaluation sweep failed")).toMatchObject({
      level: "error",
      errorName: "Error",
    });
    expect(logs.text()).not.toContain("secret-ish detail");
    expect(logged().some((line) => line.msg === "outbox drained")).toBe(true);
    expect(await unsent()).toBe(0);
  });

  it("skips GitHub work while no App is configured, but keeps the heartbeat", async () => {
    await runCron(jobsWorker(createFakeGitHubApp()), CRONS.drainOutbox, env);
    await runCron(jobsWorker(createFakeGitHubApp()), CRONS.heartbeat, env);
    expect(logged().map((line) => line.msg)).toEqual([
      "GitHub App not configured; skipped",
      "scheduled heartbeat",
    ]);
  });

  it("ignores an unknown cron", async () => {
    await runCron(jobsWorker(createFakeGitHubApp()), "5 5 * * *");
    expect(logged()).toMatchObject([{ level: "warn", msg: "unknown cron; nothing to do" }]);
  });
});
