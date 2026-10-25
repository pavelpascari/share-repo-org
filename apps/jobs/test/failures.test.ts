import { env } from "cloudflare:workers";
import { enqueueOutbox, listAuditEventsByCorrelationId } from "@sharerepo/db";
import { createFakeGitHubApp, type FakeGitHubApp } from "@sharerepo/integrations/testing";
import {
  captureLogs,
  changedTables,
  createSecretCanaries,
  expectNoCanaryLeak,
  type LogCapture,
  snapshotTables,
} from "@sharerepo/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CRONS, OUTBOX_MAX_ATTEMPTS } from "../src/handlers.ts";
import { clock, connectedCreator, db, envWithGitHub, outboxIdFor } from "./support/github.ts";
import { deliver, jobsWorker, outboxRow, runCron } from "./support/worker.ts";

// Terminal job failures (decision 0014): every path that gives up on a job marks its outbox row
// failed, writes `job.failed` and logs a `job_failed` alert line; the dead-letter queue records
// a row only when the message matches it (threat O14).

const DLQ = "sharerepo-events-dlq-dev";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});
const logged = () => logs.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
const alerts = () => logged().filter((line) => line.alert !== undefined);

/** A connected creator whose connection's resync is still queued, and that row's message. */
async function pendingResync(github: FakeGitHubApp) {
  const created = await connectedCreator(github);
  const outboxId = await outboxIdFor(created.connection.id);
  const message = { kind: "resync_connection", subjectId: created.connection.id, outboxId };
  return { ...created, outboxId, message };
}

/** The audit events about one outbox row. */
async function jobEvents(outboxId: string) {
  const { results } = await env.DB.prepare(
    "SELECT action, scope, workspace_id, actor_type, actor_id, correlation_id, details FROM audit_events WHERE target_type = 'outbox' AND target_id = ? ORDER BY rowid",
  )
    .bind(outboxId)
    .all<{
      action: string;
      scope: string;
      workspace_id: string | null;
      actor_type: string;
      actor_id: string | null;
      correlation_id: string;
      details: string;
    }>();
  return results.map((row) => ({ ...row, details: JSON.parse(row.details) as unknown }));
}

describe("terminal failures", () => {
  it("failure/exhausted-job-is-recorded-and-alerted", async () => {
    const github = createFakeGitHubApp();
    const { outboxId, connection } = await pendingResync(github);
    // The drain's last attempt: the row has used every attempt but one, and GitHub is down.
    await env.DB.prepare("UPDATE outbox SET attempts = ?, available_at = 0 WHERE id = ?")
      .bind(OUTBOX_MAX_ATTEMPTS - 1, outboxId)
      .run();
    github.failNext("transient");
    await runCron(jobsWorker(github), CRONS.drainOutbox);

    expect(await outboxRow(outboxId)).toMatchObject({
      sent_at: null,
      failed_at: clock.now(),
      last_error_code: "transient",
      attempts: OUTBOX_MAX_ATTEMPTS,
    });
    const [failed, ...rest] = await jobEvents(outboxId);
    expect(rest).toEqual([]);
    expect(failed).toMatchObject({
      action: "job.failed",
      scope: "workspace",
      workspace_id: connection.workspaceId,
      actor_type: "system",
      actor_id: null,
      details: {
        kind: "resync_connection",
        subjectId: connection.id,
        errorCode: "transient",
        attempts: OUTBOX_MAX_ATTEMPTS,
      },
    });
    // One alert line, by IDs and codes, with the audit event's correlation ID.
    expect(alerts()).toEqual([
      {
        ts: expect.any(String),
        level: "warn",
        msg: "alert: job_failed",
        correlationId: failed?.correlation_id,
        worker: "jobs",
        outboxId,
        kind: "resync_connection",
        errorCode: "transient",
        attempts: OUTBOX_MAX_ATTEMPTS,
        workspaceId: connection.workspaceId,
        alert: "job_failed",
      },
    ]);
    // Never claimed, recorded or alerted again.
    clock.advance(10 * 60_000);
    await runCron(jobsWorker(github), CRONS.drainOutbox);
    expect(await jobEvents(outboxId)).toHaveLength(1);
    expect(alerts()).toHaveLength(1);
  });

  it("records a failure a retry cannot fix on the queue path, in the row's workspace", async () => {
    const github = createFakeGitHubApp();
    const { message, connection } = await pendingResync(github);
    github.failNext("rejected");
    const result = await deliver(jobsWorker(github), [message]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(await outboxRow(message.outboxId)).toMatchObject({ last_error_code: "rejected" });
    expect(await jobEvents(message.outboxId)).toEqual([
      expect.objectContaining({
        action: "job.failed",
        workspace_id: connection.workspaceId,
        details: expect.objectContaining({ errorCode: "rejected", attempts: 0 }),
      }),
    ]);
    expect(alerts().map((line) => [line.alert, line.outboxId])).toEqual([
      ["job_failed", message.outboxId],
    ]);
  });

  it("does not fail a row the queue message does not match", async () => {
    const github = createFakeGitHubApp();
    const { message } = await pendingResync(github);
    // The message names the row but another subject: the job finds nothing and the failure of
    // a key that does not decode is never pinned on the unrelated row.
    const forged = {
      kind: "reconcile_resource",
      subjectId: "not-a-key",
      outboxId: message.outboxId,
    };
    const result = await deliver(jobsWorker(github), [forged]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(await outboxRow(message.outboxId)).toMatchObject({ failed_at: null });
    expect(await jobEvents(message.outboxId)).toEqual([]);
    expect(alerts()).toEqual([]);
  });

  it("queue/outbox-ack-matches-kind-and-subject: a message for another job leaves the row open", async () => {
    const github = createFakeGitHubApp();
    const { message } = await pendingResync(github);
    // A valid job (a decodable key of another kind) that names this row: it runs, but must not
    // settle the row, which stays open for the drain to run its own job.
    const other = { kind: "rewrap_credentials", subjectId: "rewrap:0", outboxId: message.outboxId };
    const result = await deliver(jobsWorker(github), [other]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(await outboxRow(message.outboxId)).toMatchObject({ sent_at: null, failed_at: null });
    // The matching message settles it; a replay of it changes nothing.
    await deliver(jobsWorker(github), [message]);
    const sent = (await outboxRow(message.outboxId))?.sent_at;
    expect(sent).toEqual(expect.any(Number));
    clock.advance(60_000);
    await deliver(jobsWorker(github), [message]);
    expect(await outboxRow(message.outboxId)).toMatchObject({ sent_at: sent, failed_at: null });
  });

  // A system-wide job (no workspace) whose key does not decode fails for good.
  it("records a system-wide job's failure as an account-scoped event", async () => {
    const outboxId = `sys-${crypto.randomUUID()}`;
    await enqueueOutbox(db, {
      id: outboxId,
      kind: "rewrap_credentials",
      subjectId: "not-a-rewrap-key",
      createdAt: clock.now(),
      availableAt: clock.now(),
      workspaceId: null,
    });
    await deliver(jobsWorker(createFakeGitHubApp()), [
      { kind: "rewrap_credentials", subjectId: "not-a-rewrap-key", outboxId },
    ]);
    expect(await jobEvents(outboxId)).toEqual([
      expect.objectContaining({ action: "job.failed", scope: "account", workspace_id: null }),
    ]);
    const [line] = alerts();
    expect(line).toMatchObject({ alert: "job_failed", outboxId });
    expect(line).not.toHaveProperty("workspaceId");
  });
});

describe("dead-letter queue", () => {
  it("failure/dead-letter-marks-row-failed", async () => {
    const github = createFakeGitHubApp();
    const { message, connection } = await pendingResync(github);
    const calls = github.calls.length;
    const result = await deliver(jobsWorker(github), [message], { queue: DLQ, attempts: 6 });

    expect(result.explicitAcks).toHaveLength(1);
    expect(result.retryMessages).toEqual([]);
    // Never run: the dead-letter queue only records.
    expect(github.calls).toHaveLength(calls);
    expect(await outboxRow(message.outboxId)).toMatchObject({
      sent_at: null,
      failed_at: clock.now(),
      last_error_code: "dead_lettered",
    });
    const [failed] = await jobEvents(message.outboxId);
    expect(failed).toMatchObject({
      action: "job.failed",
      scope: "workspace",
      workspace_id: connection.workspaceId,
      details: { kind: "resync_connection", errorCode: "dead_lettered" },
    });
    expect(
      (await listAuditEventsByCorrelationId(db, failed?.correlation_id as string)).map(
        (event) => event.action,
      ),
    ).toEqual(["job.failed"]);
    expect(alerts().map((line) => [line.alert, line.errorCode])).toEqual([
      ["job_failed", "dead_lettered"],
    ]);

    // A replay changes nothing and alerts nothing; it is logged by IDs and acknowledged.
    const before = await snapshotTables(env.DB, {});
    const again = await deliver(jobsWorker(github), [message], { queue: DLQ });
    expect(again.explicitAcks).toHaveLength(1);
    expect(changedTables(before, await snapshotTables(env.DB, {}))).toEqual([]);
    expect(alerts()).toHaveLength(1);
    expect(logged().at(-1)).toMatchObject({
      msg: "dead-lettered message matched no open job",
      outboxId: message.outboxId,
    });
  });

  it("changes nothing for a sent row, an unknown row, or a message that does not match its row", async () => {
    const github = createFakeGitHubApp();
    const sent = await pendingResync(github);
    await env.DB.prepare("UPDATE outbox SET sent_at = 1 WHERE id = ?").bind(sent.outboxId).run();
    const other = await pendingResync(github);
    const before = await snapshotTables(env.DB, {});
    const result = await deliver(
      jobsWorker(github),
      [
        sent.message,
        { ...other.message, outboxId: `unknown-${crypto.randomUUID()}` },
        { ...other.message, subjectId: sent.connection.id },
        { ...other.message, kind: "recompute_offer" },
      ],
      { queue: DLQ },
    );
    expect(result.explicitAcks).toHaveLength(4);
    expect(changedTables(before, await snapshotTables(env.DB, {}))).toEqual([]);
    expect(alerts()).toEqual([]);
    expect(
      logged().filter((line) => line.msg === "dead-lettered message matched no open job"),
    ).toHaveLength(4);
  });

  it("drops an invalid message by its ID, never logging its body", async () => {
    const canaries = createSecretCanaries(["dlqBody"]);
    const before = await snapshotTables(env.DB, {});
    const result = await deliver(
      jobsWorker(createFakeGitHubApp()),
      [{ kind: "drop_tables", subjectId: canaries.dlqBody, outboxId: "x" }],
      { queue: DLQ },
    );
    expect(result.explicitAcks).toHaveLength(1);
    expect(changedTables(before, await snapshotTables(env.DB, {}))).toEqual([]);
    expect(logged().at(-1)).toMatchObject({
      msg: "invalid dead-lettered message dropped",
      messageId: expect.any(String),
    });
    expectNoCanaryLeak(logs.text(), canaries);
  });

  it("retries a message it could not record", async () => {
    const broken = {
      ...envWithGitHub,
      DB: {
        prepare: () => {
          throw new Error("D1 is down: secret detail");
        },
      },
    } as unknown as Env;
    const result = await deliver(
      jobsWorker(createFakeGitHubApp()),
      [{ kind: "resync_connection", subjectId: "c", outboxId: "o" }],
      { queue: DLQ, bindings: broken },
    );
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toHaveLength(1);
    expect(logged().at(-1)).toMatchObject({
      level: "error",
      msg: "dead-lettered message not recorded; retrying",
      errorName: "Error",
    });
    expect(logs.text()).not.toContain("secret detail");
  });
});
