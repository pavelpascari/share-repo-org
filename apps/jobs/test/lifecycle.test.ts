import { env } from "cloudflare:workers";
import { requestWorkspaceDeletion } from "@sharerepo/application";
import { enqueueOutbox, getWorkspace } from "@sharerepo/db";
import { WORKSPACE_DELETION_DELAY_MS } from "@sharerepo/domain";
import { createFakeGitHubApp } from "@sharerepo/integrations/testing";
import { captureLogs, type LogCapture } from "@sharerepo/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CRONS } from "../src/handlers.ts";
import {
  clock,
  connectedCreator,
  count,
  db,
  envWithGitHub,
  serviceContext,
} from "./support/github.ts";
import { deliver, jobsWorker, outboxRow, runCron } from "./support/worker.ts";

// The data lifecycle jobs (decision 0015) at the jobs Worker's entry points: the daily cron
// queues them, and the queue consumer and the outbox drain run them.

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});
const logged = () => logs.lines().map((line) => JSON.parse(line) as Record<string, unknown>);

async function queued(kind: string, subjectId: string) {
  const id = `row-${crypto.randomUUID()}`;
  await enqueueOutbox(db, {
    id,
    kind: kind as "prune_data",
    subjectId,
    createdAt: clock.now(),
    availableAt: clock.now(),
    workspaceId: null,
  });
  return id;
}

/** A creator's workspace whose deletion they asked for. */
async function deletingWorkspace() {
  const creator = await connectedCreator(createFakeGitHubApp());
  const requested = await requestWorkspaceDeletion(
    serviceContext(),
    creator,
    creator.slug,
    { confirmation: creator.slug },
    null,
  );
  if (!requested.ok) throw new Error(requested.reason);
  return creator;
}

describe("lifecycle jobs", () => {
  it("runs prune_data: one data.pruned system event per run", async () => {
    const outboxId = await queued("prune_data", "retention");
    const before = await count(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'data.pruned'",
    );
    const result = await deliver(jobsWorker(createFakeGitHubApp()), [
      { kind: "prune_data", subjectId: "retention", outboxId },
    ]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(await outboxRow(outboxId)).toMatchObject({ sent_at: clock.now(), failed_at: null });
    expect(await count("SELECT count(*) AS n FROM audit_events WHERE action = 'data.pruned'")).toBe(
      before + 1,
    );
  });

  it("runs purge_workspace once the deletion is due, and only then", async () => {
    const creator = await deletingWorkspace();
    const { workspaceId } = creator.connection;
    const early = await queued("purge_workspace", workspaceId);
    await deliver(jobsWorker(createFakeGitHubApp()), [
      { kind: "purge_workspace", subjectId: workspaceId, outboxId: early },
    ]);
    expect(await outboxRow(early)).toMatchObject({ sent_at: clock.now() });
    expect(await getWorkspace(db, workspaceId)).toMatchObject({ status: "deleting" });

    clock.advance(WORKSPACE_DELETION_DELAY_MS);
    const due = await queued("purge_workspace", workspaceId);
    await deliver(jobsWorker(createFakeGitHubApp()), [
      { kind: "purge_workspace", subjectId: workspaceId, outboxId: due },
    ]);
    // The purge ran in one go: the workspace and its rows are gone, with a tombstone.
    expect(await getWorkspace(db, workspaceId)).toBeNull();
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_events WHERE action = 'workspace.purged' AND target_id = ?",
        workspaceId,
      ),
    ).toBe(1);
  });

  it("logs a purge that waits for access to be revoked, by IDs only", async () => {
    const creator = await deletingWorkspace();
    const { workspaceId } = creator.connection;
    // A managed grant ShareRepo has not yet revoked.
    await env.DB.prepare(
      `INSERT INTO subjects (id, workspace_id, provider, type, external_subject_id, login_snapshot, created_at, updated_at)
       VALUES (?, ?, 'github', 'user', ?, 'collaborator', ?, ?)`,
    )
      .bind(`sub-${workspaceId}`, workspaceId, `gh-${workspaceId}`, clock.now(), clock.now())
      .run();
    const resourceId = `res-${workspaceId}`;
    await env.DB.prepare(
      `INSERT INTO resources (id, workspace_id, connection_id, provider, type, external_id, name_snapshot,
         owner_external_id, private, archived, selection, capabilities, discovered_at, updated_at)
       VALUES (?, ?, ?, 'github', 'repository', ?, 'o/r', '1', 1, 0, 'selected', '{}', ?, ?)`,
    )
      .bind(
        resourceId,
        workspaceId,
        creator.connection.id,
        `ext-${workspaceId}`,
        clock.now(),
        clock.now(),
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO grants (id, workspace_id, connection_id, subject_id, resource_id, access_level, state, managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'write', 'active', 1, ?, ?)`,
    )
      .bind(
        `grant-${workspaceId}`,
        workspaceId,
        creator.connection.id,
        `sub-${workspaceId}`,
        resourceId,
        clock.now(),
        clock.now(),
      )
      .run();
    clock.advance(WORKSPACE_DELETION_DELAY_MS);
    const outboxId = await queued("purge_workspace", workspaceId);
    await deliver(jobsWorker(createFakeGitHubApp()), [
      { kind: "purge_workspace", subjectId: workspaceId, outboxId },
    ]);
    expect(await outboxRow(outboxId)).toMatchObject({ sent_at: clock.now(), failed_at: null });
    expect(await getWorkspace(db, workspaceId)).toMatchObject({ status: "deleting" });
    const line = logged().find((entry) => entry.msg === "job waits for a precondition");
    expect(line).toMatchObject({ outboxId });
  });

  it("queues the lifecycle jobs from the daily cron, spread over the day", async () => {
    const creator = await deletingWorkspace();
    clock.advance(WORKSPACE_DELETION_DELAY_MS);
    await runCron(jobsWorker(createFakeGitHubApp()), CRONS.dailyResync);
    expect(logged().find((line) => line.msg === "lifecycle jobs queued")).toBeDefined();
    const purge = await env.DB.prepare(
      `SELECT available_at FROM outbox WHERE kind = 'purge_workspace' AND subject_id = ?
         AND sent_at IS NULL`,
    )
      .bind(creator.connection.workspaceId)
      .first<{ available_at: number }>();
    expect(purge?.available_at).toBeGreaterThanOrEqual(clock.now());
    expect(
      await count("SELECT count(*) AS n FROM outbox WHERE kind = 'prune_data' AND sent_at IS NULL"),
    ).toBe(1);
  });

  it("logs a failed lifecycle queueing by its classification only", async () => {
    const failing = {
      ...envWithGitHub,
      DB: new Proxy(env.DB, {
        get(target, property) {
          if (property === "prepare") {
            return (query: string) => {
              if (query.includes("delete_after")) throw new Error("workspaces down");
              return target.prepare(query);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as Env;
    await runCron(jobsWorker(createFakeGitHubApp()), CRONS.dailyResync, failing);
    expect(logged()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ msg: "lifecycle job queueing failed", errorName: "Error" }),
      ]),
    );
    expect(logs.text()).not.toContain("workspaces down");
  });
});
