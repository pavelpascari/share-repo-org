import {
  processExternalEvent,
  resyncConnection,
  type ServiceContext,
} from "@sharerepo/application";
import { listActiveConnectionIds } from "@sharerepo/db";
import type { GitHubAppPort } from "@sharerepo/integrations";
import type { JobMessage } from "./messages.ts";

/** `done`: the work ran (or was already done). `out_of_scope`: no workspace owns the subject. */
export type JobOutcome = "done" | "out_of_scope";

/**
 * Runs one unit of handed-off work. Shared by the queue consumer (fast path) and the outbox drain
 * (safety net), so it must be idempotent: the services re-read current state every time.
 */
export async function runJob(
  ctx: ServiceContext,
  job: Pick<JobMessage, "kind" | "subjectId">,
  github: GitHubAppPort,
): Promise<JobOutcome> {
  if (job.kind === "process_external_event") {
    await processExternalEvent(ctx, job.subjectId, github);
    return "done";
  }
  // A resync is always scoped to the connection's workspace as stored in the database, never to
  // anything in the message. The active-connection list is small in v1; a keyed lookup can
  // replace this scan when it is not.
  const connection = (await listActiveConnectionIds(ctx.db)).find(
    (candidate) => candidate.id === job.subjectId,
  );
  if (connection === undefined) return "out_of_scope";
  await resyncConnection(ctx, connection, github, "outbox: resync_connection");
  return "done";
}

const BASE_RETRY_DELAY_SECONDS = 30;
const MAX_RETRY_DELAY_SECONDS = 15 * 60;

/** Queue retry delay: GitHub's rate-limit reset when known, else 30 s doubling per attempt. */
export function retryDelaySeconds(attempts: number, retryAfterMs?: number): number {
  const seconds =
    retryAfterMs === undefined
      ? BASE_RETRY_DELAY_SECONDS * 2 ** Math.max(0, attempts - 1)
      : Math.ceil(retryAfterMs / 1000);
  return Math.min(Math.max(seconds, 1), MAX_RETRY_DELAY_SECONDS);
}
