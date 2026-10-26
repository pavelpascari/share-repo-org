import { env } from "cloudflare:workers";
import { enqueueOutbox, markOutboxSent } from "@sharerepo/db";
import { GitHubApiError, type GitHubAppPort } from "@sharerepo/integrations";
import { createFakeGitHubApp, type FakeGitHubApp } from "@sharerepo/integrations/testing";
import { captureLogs, changedTables, type LogCapture, snapshotTables } from "@sharerepo/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CRONS } from "../src/handlers.ts";
import { refreshKey, type Shop, shop, subscribe } from "./support/commerce.ts";
import { clock, count, db, envWithGitHub } from "./support/github.ts";
import { deliver, jobsWorker, outboxRow, runCron, sentAt } from "./support/worker.ts";

// reconcile_resource on the queue and in the outbox drain (phase-4 plan, T7).

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});
const logged = () => logs.lines().map((line) => JSON.parse(line) as Record<string, unknown>);

const github = () => createFakeGitHubApp({ clock });

async function resourceOf(s: Shop) {
  const row = await env.DB.prepare(
    "SELECT id, name_snapshot AS name FROM resources WHERE workspace_id = ?",
  )
    .bind(s.workspaceId)
    .first<{ id: string; name: string }>();
  if (row === null) throw new Error("no resource");
  return row;
}

/** A shop with one subscriber whose refresh ran, and the reconcile it queued. */
async function subscribed(fake: FakeGitHubApp = github()) {
  const s = await shop(fake);
  const sub = await subscribe(s);
  await deliver(jobsWorker(s.github), [
    { kind: "refresh_subscription", subjectId: refreshKey(s, sub.id), outboxId: sub.outboxId },
  ]);
  const resource = await resourceOf(s);
  const subjectId = `${s.workspaceId}:${resource.id}`;
  const row = await env.DB.prepare(
    "SELECT id FROM outbox WHERE kind = 'reconcile_resource' AND subject_id = ? AND sent_at IS NULL",
  )
    .bind(subjectId)
    .first<{ id: string }>();
  if (row === null) throw new Error("the refresh queued no reconcile");
  const message = { kind: "reconcile_resource", subjectId, outboxId: row.id };
  return { s, fake, resource, message };
}

const invitations = (fake: FakeGitHubApp, repo: string) =>
  fake.repositoryAccess(repo).invitations.length;

describe("reconcile_resource on the queue", () => {
  it("queue/redelivery-is-idempotent for a reconciliation", async () => {
    const { s, fake, resource, message } = await subscribed();
    // At-least-once delivery: the same reconciliation twice in one batch, then once more.
    const result = await deliver(jobsWorker(s.github), [message, message]);
    clock.advance(60_000);
    const again = await deliver(jobsWorker(s.github), [message]);
    expect(result.explicitAcks).toHaveLength(2);
    expect(again.explicitAcks).toHaveLength(1);
    expect(invitations(fake, resource.name)).toBe(1);
    expect(fake.calls.filter((call) => call.startsWith("addCollaborator:"))).toHaveLength(1);
    expect(await sentAt(message.outboxId)).toBe(clock.now() - 60_000);
  });

  it("queue/redelivery-is-idempotent for concurrent deliveries of a reconciliation", async () => {
    const { s, fake, resource, message } = await subscribed();
    // One run holds the repository's lease; the other is turned away (or finds it done).
    const results = await Promise.all([
      deliver(jobsWorker(s.github), [message]),
      deliver(jobsWorker(s.github), [message]),
    ]);
    expect(results.flatMap((r) => r.explicitAcks)).toHaveLength(2);
    expect(results.flatMap((r) => r.retryMessages)).toEqual([]);
    expect(invitations(fake, resource.name)).toBe(1);
  });

  it.each(["res-1", ":res-1", "ws-1:", "ws-1:res-1:extra"])(
    "isolation/job-without-workspace-scope-rejected (reconcile_resource %s)",
    async (subjectId) => {
      const fake = github();
      const outboxId = `row-${crypto.randomUUID()}`;
      await enqueueOutbox(db, {
        id: outboxId,
        kind: "reconcile_resource",
        subjectId,
        createdAt: clock.now(),
        availableAt: clock.now(),
        workspaceId: null,
      });
      const before = await snapshotTables(env.DB);
      const result = await deliver(jobsWorker(fake), [
        { kind: "reconcile_resource", subjectId, outboxId },
      ]);
      expect(result.explicitAcks).toHaveLength(1);
      expect(changedTables(before, await snapshotTables(env.DB))).toEqual([]);
      expect(await outboxRow(outboxId)).toMatchObject({
        sent_at: null,
        last_error_code: "key_invalid",
      });
      expect(fake.calls).toEqual([]);
    },
  );

  it("isolation/job-without-workspace-scope-rejected: a key naming another workspace's repository does nothing", async () => {
    const { resource, fake } = await subscribed();
    const other = await shop(github());
    const subjectId = `${other.workspaceId}:${resource.id}`;
    const outboxId = `row-${crypto.randomUUID()}`;
    await enqueueOutbox(db, {
      id: outboxId,
      kind: "reconcile_resource",
      subjectId,
      createdAt: clock.now(),
      availableAt: clock.now(),
      workspaceId: null,
    });
    const before = await snapshotTables(env.DB, {});
    const calls = fake.calls.length;
    const result = await deliver(jobsWorker(fake), [
      { kind: "reconcile_resource", subjectId, outboxId },
    ]);
    expect(result.explicitAcks).toHaveLength(1);
    // Only the outbox row is marked delivered; nothing else is read from or written to GitHub.
    expect(changedTables(before, await snapshotTables(env.DB, {}))).toEqual(["outbox"]);
    expect(fake.calls.length).toBe(calls);
    expect(logged().find((line) => line.msg === "job has no workspace scope")).toMatchObject({
      outboxId,
    });
  });
});

describe("reconcile_resource in the per-minute cron", () => {
  it("provider/outage-recovers-on-scheduled-reconcile", async () => {
    const fake = github();
    let down = true;
    const outage =
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
      (...args: A): Promise<R> =>
        down ? Promise.reject(new GitHubApiError("transient", "GitHub down (test)")) : fn(...args);
    const flaky: GitHubAppPort = {
      ...fake,
      listCollaborators: outage(fake.listCollaborators),
      listInvitations: outage(fake.listInvitations),
    };
    const { resource, message } = await subscribed(fake);
    const result = await deliver(jobsWorker(flaky), [message]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(invitations(fake, resource.name)).toBe(0);

    // GitHub recovers; a minute later the sweep queues the due repository and the drain runs it.
    down = false;
    clock.advance(60_000);
    await runCron(jobsWorker(flaky), CRONS.drainOutbox);
    expect(
      logged()
        .filter((line) => line.msg === "due reconciles queued")
        .at(-1)?.queued,
    ).toBeGreaterThan(0);
    expect(invitations(fake, resource.name)).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM outbox WHERE kind = 'reconcile_resource' AND subject_id = ? AND sent_at IS NULL",
        message.subjectId,
      ),
    ).toBe(0);
  });

  it("provider/timeout-is-retryable: a reconcile whose GitHub call hangs is checked again, never failed", async () => {
    const fake = github();
    const { resource, message } = await subscribed(fake);
    // The read hangs past the client's timeout, which the client reports as transient.
    fake.hangNext("listCollaborators");
    const result = await deliver(jobsWorker(fake), [message]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(invitations(fake, resource.name)).toBe(0);
    expect(await outboxRow(message.outboxId)).toMatchObject({
      failed_at: null,
      last_error_code: null,
    });
    const state = await env.DB.prepare(
      "SELECT reconcile_failures, last_reconcile_error, next_reconcile_at FROM resources WHERE id = ?",
    )
      .bind(resource.id)
      .first<{
        reconcile_failures: number;
        last_reconcile_error: string;
        next_reconcile_at: number;
      }>();
    expect(state).toMatchObject({
      reconcile_failures: 1,
      last_reconcile_error: "provider_unavailable",
    });
    expect(state?.next_reconcile_at).toBeGreaterThanOrEqual(clock.now());
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_events WHERE action = 'job.failed' AND target_id = ?",
        message.outboxId,
      ),
    ).toBe(0);

    // The scheduled check runs it again and invites.
    clock.set(state?.next_reconcile_at as number);
    await runCron(jobsWorker(fake), CRONS.drainOutbox);
    expect(invitations(fake, resource.name)).toBe(1);
  });

  it("still sweeps evaluations and drains the outbox when the reconcile sweep fails", async () => {
    const { s, message } = await subscribed();
    await markOutboxSent(db, [message.outboxId], clock.now());
    // The reconcile sweep's first query fails, as during a D1 outage.
    let failures = 1;
    const flaky = new Proxy(env.DB, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (
            property === "prepare" &&
            failures > 0 &&
            String(args[0]).includes('"next_reconcile_at" <=')
          ) {
            failures -= 1;
            throw new Error("d1 unavailable: secret-ish detail");
          }
          return value.apply(target, args);
        };
      },
    });
    await runCron(jobsWorker(s.github), CRONS.drainOutbox, { ...envWithGitHub, DB: flaky } as Env);
    expect(failures).toBe(0);
    expect(logged().map((line) => line.msg)).toEqual(
      expect.arrayContaining([
        "due evaluations queued",
        "due reconcile sweep failed",
        "outbox drained",
      ]),
    );
    expect(logs.text()).not.toContain("secret-ish detail");
  });
});
