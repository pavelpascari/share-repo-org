import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { simulatedEntitlementSource } from "@sharerepo/application";
import type { GitHubAppPort } from "@sharerepo/integrations";
import { SequentialIds } from "@sharerepo/testing";
import { createJobsWorker, type JobsWorkerDeps } from "../../src/handlers.ts";
import { clock, envWithGitHub } from "./github.ts";

const QUEUE = "sharerepo-events-dev";

/** The jobs Worker over the given GitHub App, with the real simulated source unless replaced. */
export function jobsWorker(github: GitHubAppPort, overrides: Partial<JobsWorkerDeps> = {}) {
  return createJobsWorker({
    ids: new SequentialIds({ prefix: `corr-${crypto.randomUUID()}-` }),
    clock,
    github: () => github,
    simulatedSource: simulatedEntitlementSource,
    ...overrides,
  });
}

let messageCounter = 0;

/** Delivers one queue batch and reports what the consumer acknowledged or retried. */
export async function deliver(
  target: ExportedHandler<Env>,
  bodies: unknown[],
  options: { attempts?: number; bindings?: Env } = {},
) {
  const batch = createMessageBatch(
    QUEUE,
    bodies.map((body) => ({
      id: `msg-${++messageCounter}`,
      timestamp: clock.now(),
      attempts: options.attempts ?? 1,
      body,
    })),
  );
  const ctx = createExecutionContext();
  await target.queue?.(batch, options.bindings ?? envWithGitHub, ctx);
  return getQueueResult(batch, ctx);
}

export function runCron(target: ExportedHandler<Env>, cron: string, bindings: Env = envWithGitHub) {
  return target.scheduled?.(
    createScheduledController({ cron, scheduledTime: clock.now() }),
    bindings,
    createExecutionContext(),
  );
}

export async function outboxRow(outboxId: string) {
  return env.DB.prepare(
    "SELECT sent_at, failed_at, last_error_code, attempts FROM outbox WHERE id = ?",
  )
    .bind(outboxId)
    .first<{
      sent_at: number | null;
      failed_at: number | null;
      last_error_code: string | null;
      attempts: number;
    }>();
}

export const sentAt = async (outboxId: string) => (await outboxRow(outboxId))?.sent_at;
