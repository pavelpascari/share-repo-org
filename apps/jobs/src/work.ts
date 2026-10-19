import {
  decodeOfferKey,
  decodeReconcileKey,
  decodeRefreshKey,
  type EntitlementSourcePort,
  processExternalEvent,
  recomputeOffer,
  reconcileResource,
  refreshSubscription,
  resyncConnection,
  type ServiceContext,
} from "@sharerepo/application";
import { type Db, listActiveConnectionIds } from "@sharerepo/db";
import { type CommercialSource, OutboxKind } from "@sharerepo/domain";
import type { GitHubAppPort } from "@sharerepo/integrations";
import { AppError } from "@sharerepo/platform";
import type { JobsEnvironment } from "./env.ts";
import type { JobMessage } from "./messages.ts";

/** How a job ended without an error. */
export const JobOutcome = {
  /** The work ran, or was already done. */
  Done: "done",
  /** No workspace owns the job's subject, so there was nothing to do. */
  OutOfScope: "out_of_scope",
} as const;
export type JobOutcome = (typeof JobOutcome)[keyof typeof JobOutcome];

/** What a job may use beyond the service context. */
export interface JobDeps {
  readonly github: GitHubAppPort;
  readonly environment: JobsEnvironment;
  /** The simulated entitlement source over a database; tests inject a contended one. */
  readonly simulatedSource: (db: Db) => EntitlementSourcePort;
}

/**
 * A job that can never succeed as written: its key does not decode (so it names no workspace),
 * or its entitlement source is not available here. Final, with a classified code only.
 */
export const JobRejection = {
  /** The job's key does not decode, so it names no workspace. */
  KeyInvalid: "key_invalid",
  /** The job's entitlement source does not run in this environment. */
  SourceUnavailable: "source_unavailable",
} as const;
export type JobRejection = (typeof JobRejection)[keyof typeof JobRejection];

export class JobRejectedError extends AppError {
  constructor(code: JobRejection) {
    super("job rejected", { httpStatus: 422, code });
  }
}

/**
 * The entitlement source for a refresh. The simulator never runs in production (decision 0009);
 * Paddle arrives in Phase 5.
 */
function entitlementSource(source: CommercialSource, db: Db, deps: JobDeps): EntitlementSourcePort {
  if (source === "simulated" && deps.environment !== "production") {
    return deps.simulatedSource(db);
  }
  throw new JobRejectedError(JobRejection.SourceUnavailable);
}

/**
 * Runs one unit of handed-off work. Shared by the queue consumer (fast path) and the outbox drain
 * (safety net), so it must be idempotent: the services re-read current state every time.
 */
export async function runJob(
  ctx: ServiceContext,
  job: Pick<JobMessage, "kind" | "subjectId">,
  deps: JobDeps,
): Promise<JobOutcome> {
  switch (job.kind) {
    case OutboxKind.ProcessExternalEvent:
      await processExternalEvent(ctx, job.subjectId, deps.github);
      return JobOutcome.Done;
    case OutboxKind.RefreshSubscription: {
      // The workspace comes from the key and scopes every read and write of the refresh.
      const key = decodeRefreshKey(job.subjectId);
      if (!key.ok) throw new JobRejectedError(JobRejection.KeyInvalid);
      await refreshSubscription(ctx, key.value, entitlementSource(key.value.source, ctx.db, deps));
      return JobOutcome.Done;
    }
    case OutboxKind.RecomputeOffer: {
      const key = decodeOfferKey(job.subjectId);
      if (!key.ok) throw new JobRejectedError(JobRejection.KeyInvalid);
      await recomputeOffer(ctx, key.value);
      return JobOutcome.Done;
    }
    case OutboxKind.ResyncConnection: {
      // A resync is always scoped to the connection's workspace as stored in the database, never
      // to anything in the message. The active-connection list is small in v1; a keyed lookup
      // can replace this scan when it is not.
      const connection = (await listActiveConnectionIds(ctx.db)).find(
        (candidate) => candidate.id === job.subjectId,
      );
      if (connection === undefined) return JobOutcome.OutOfScope;
      await resyncConnection(ctx, connection, deps.github, "outbox: resync_connection");
      return JobOutcome.Done;
    }
    case OutboxKind.ReconcileResource: {
      // The workspace comes from the key and scopes every read and write of the run.
      const key = decodeReconcileKey(job.subjectId);
      if (!key.ok) throw new JobRejectedError(JobRejection.KeyInvalid);
      const outcome = await reconcileResource(ctx, key.value, deps.github);
      // `busy`: another run holds the repository and converges it; this delivery is done.
      return outcome === "out_of_scope" ? JobOutcome.OutOfScope : JobOutcome.Done;
    }
  }
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
