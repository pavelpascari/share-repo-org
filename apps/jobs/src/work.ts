import {
  type CommerceDeps,
  checkPaddleConnection,
  decodeClaimRequestKey,
  decodeOfferKey,
  decodePaddleConnectionKey,
  decodeReconcileKey,
  decodeRefreshKey,
  decodeRewrapKey,
  type EntitlementSourcePort,
  PaddleUnavailableError,
  paddleEntitlementSource,
  processExternalEvent,
  processPaddleEvent,
  recomputeOffer,
  reconcileResource,
  refreshSubscription,
  resyncConnection,
  rewrapCredentials,
  type ServiceContext,
  sendClaimEmail,
  sweepPaddleSubscriptions,
} from "@sharerepo/application";
import { type Db, getExternalEvent, listActiveConnectionIds } from "@sharerepo/db";
import { type CommercialSource, OutboxKind } from "@sharerepo/domain";
import type { GitHubAppPort, MailPort } from "@sharerepo/integrations";
import { AppError } from "@sharerepo/platform";
import type { JobsEnvironment } from "./env.ts";
import type { JobMessage } from "./messages.ts";

/** How a job ended without an error. */
export const JobOutcome = {
  /** The work ran, or was already done. */
  Done: "done",
  /** No workspace owns the job's subject, so there was nothing to do. */
  OutOfScope: "out_of_scope",
  /**
   * The work ran but covered only part of its subject: a Paddle sweep stopped at the page limit.
   * The next daily sweep runs again; webhooks still cover the rest.
   */
  Partial: "partial",
} as const;
export type JobOutcome = (typeof JobOutcome)[keyof typeof JobOutcome];

/** What a job may use beyond the service context. */
export interface JobDeps {
  readonly github: GitHubAppPort;
  readonly environment: JobsEnvironment;
  /** The simulated entitlement source over a database; tests inject a contended one. */
  readonly simulatedSource: (db: Db) => EntitlementSourcePort;
  /** Paddle and purchase claims, or null when the commerce secrets are not configured. */
  readonly commerce: CommerceDeps | null;
  /** The claim email transport, or null when none is configured. */
  readonly mail: MailPort | null;
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
  /** The kind has no handler yet in this build (Phase 6 T1 placeholders). */
  NotImplemented: "not_implemented",
} as const;
export type JobRejection = (typeof JobRejection)[keyof typeof JobRejection];

export class JobRejectedError extends AppError {
  constructor(code: JobRejection) {
    super("job rejected", { httpStatus: 422, code });
  }
}

/**
 * The commerce dependencies of a Paddle job. Without the commerce secrets Paddle is unavailable:
 * retryable, like an inactive connection, so the work runs once the Worker is configured.
 */
function commerceOf(deps: JobDeps): CommerceDeps {
  if (deps.commerce === null) throw new PaddleUnavailableError("commerce is not configured");
  return deps.commerce;
}

/**
 * The entitlement source for a refresh. Paddle runs everywhere; the simulator never runs in
 * production (decision 0009).
 */
function entitlementSource(
  source: CommercialSource,
  ctx: ServiceContext,
  deps: JobDeps,
): EntitlementSourcePort {
  if (source === "paddle") return paddleEntitlementSource(ctx, commerceOf(deps));
  if (source === "simulated" && deps.environment !== "production") {
    return deps.simulatedSource(ctx.db);
  }
  throw new JobRejectedError(JobRejection.SourceUnavailable);
}

/** The key's decoded value; a key that does not decode names no workspace and is rejected. */
function decoded<T>(key: { ok: true; value: T } | { ok: false }): T {
  if (!key.ok) throw new JobRejectedError(JobRejection.KeyInvalid);
  return key.value;
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
    case OutboxKind.ProcessExternalEvent: {
      // Routed by the stored event's provider, never by anything in the message.
      const event = await getExternalEvent(ctx.db, job.subjectId);
      if (event?.provider === "paddle") await processPaddleEvent(ctx, job.subjectId);
      else await processExternalEvent(ctx, job.subjectId, deps.github);
      return JobOutcome.Done;
    }
    case OutboxKind.RefreshSubscription: {
      // The workspace comes from the key and scopes every read and write of the refresh.
      const key = decoded(decodeRefreshKey(job.subjectId));
      await refreshSubscription(ctx, key, entitlementSource(key.source, ctx, deps));
      return JobOutcome.Done;
    }
    case OutboxKind.RecomputeOffer: {
      await recomputeOffer(ctx, decoded(decodeOfferKey(job.subjectId)));
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
      const outcome = await reconcileResource(
        ctx,
        decoded(decodeReconcileKey(job.subjectId)),
        deps.github,
      );
      // `busy`: another run holds the repository; this delivery is done. The request that queued
      // it was stamped on the repository, so the holder schedules another run at once when it
      // releases, or, if it crashed, the sweep queues one once its lease expires.
      return outcome === "out_of_scope" ? JobOutcome.OutOfScope : JobOutcome.Done;
    }
    case OutboxKind.SendClaimEmail: {
      // The request is read within the key's workspace only: one of another workspace, or one
      // already handled, is `already_done` and changes nothing.
      const key = decoded(decodeClaimRequestKey(job.subjectId));
      await sendClaimEmail(ctx, key, { ...commerceOf(deps), mail: deps.mail });
      return JobOutcome.Done;
    }
    case OutboxKind.CheckPaddleConnection: {
      // The connection must be the key's workspace's own; otherwise it is `not_connected`.
      const key = decoded(decodePaddleConnectionKey(job.subjectId));
      const status = await checkPaddleConnection(ctx, key, commerceOf(deps));
      return status === "not_connected" ? JobOutcome.OutOfScope : JobOutcome.Done;
    }
    case OutboxKind.SweepPaddleSubscriptions: {
      // Null: the key's workspace has no such active connection (disconnected or unauthorized
      // meanwhile, or another workspace's), so there is nothing to sweep.
      const key = decoded(decodePaddleConnectionKey(job.subjectId));
      const swept = await sweepPaddleSubscriptions(ctx, key, commerceOf(deps));
      return swept?.truncated === true ? JobOutcome.Partial : JobOutcome.Done;
    }
    case OutboxKind.RewrapCredentials: {
      // System-wide: every workspace's envelopes under a retired master key. Needs the commerce
      // secrets (the keyring); without them it waits, like a Paddle job.
      const generation = decoded(decodeRewrapKey(job.subjectId));
      await rewrapCredentials(ctx, generation, commerceOf(deps));
      return JobOutcome.Done;
    }
    case OutboxKind.PruneData:
    case OutboxKind.PurgeWorkspace:
      // Placeholders until their handlers land (Phase 6 plan, T4). Nothing enqueues these
      // kinds before then. Not retryable: the row is marked failed with this rejection's code.
      throw new JobRejectedError(JobRejection.NotImplemented);
  }
}

const BASE_RETRY_DELAY_SECONDS = 30;
const MAX_RETRY_DELAY_SECONDS = 15 * 60;

/**
 * Queue retry delay: the provider's rate-limit reset when known (GitHub, Paddle's `Retry-After`),
 * else 30 s doubling per attempt.
 */
export function retryDelaySeconds(attempts: number, retryAfterMs?: number): number {
  const seconds =
    retryAfterMs === undefined
      ? BASE_RETRY_DELAY_SECONDS * 2 ** Math.max(0, attempts - 1)
      : Math.ceil(retryAfterMs / 1000);
  return Math.min(Math.max(seconds, 1), MAX_RETRY_DELAY_SECONDS);
}
