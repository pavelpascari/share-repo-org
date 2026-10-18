import {
  type EntitlementSourcePort,
  queueDueEvaluations,
  type ServiceContext,
} from "@sharerepo/application";
import {
  claimOutbox,
  createDb,
  type Db,
  enqueueOutbox,
  listActiveConnectionIds,
  markOutboxFailed,
  markOutboxSent,
} from "@sharerepo/db";
import type { Clock, IdGenerator } from "@sharerepo/domain";
import { GitHubApiError, type GitHubAppConfig, type GitHubAppPort } from "@sharerepo/integrations";
import {
  AppError,
  ConflictError,
  correlationIdFrom,
  createLogger,
  type Logger,
  NotFoundError,
  toErrorResponse,
  withCorrelationId,
} from "@sharerepo/platform";
import { type JobsConfig, parseJobsEnv } from "./env.ts";
import { jobMessageSchema } from "./messages.ts";
import { type JobDeps, retryDelaySeconds, runJob } from "./work.ts";

export interface JobsWorkerDeps {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** Builds the GitHub App from validated configuration; tests inject the fake. */
  readonly github: (config: GitHubAppConfig) => GitHubAppPort;
  /** The simulated entitlement source; used outside production only. */
  readonly simulatedSource: (db: Db) => EntitlementSourcePort;
}

const HEALTH_PATH = "/healthz";

/** The crons declared in wrangler.jsonc. */
export const CRONS = {
  heartbeat: "0 * * * *",
  drainOutbox: "* * * * *",
  dailyResync: "17 3 * * *",
} as const;

const OUTBOX_BATCH = 25;
const OUTBOX_LEASE_MS = 60_000;
/** After this many attempts a row is marked failed and left for the operator. */
export const OUTBOX_MAX_ATTEMPTS = 10;
/** Subscriptions whose next policy boundary passed, queued per minute (phase-3 plan § Time). */
export const DUE_EVALUATION_BATCH = 100;

class MethodNotAllowedError extends AppError {
  constructor() {
    super("Method not allowed", {
      httpStatus: 405,
      code: "method_not_allowed",
      expose: "The request method is not allowed.",
    });
  }
}

/**
 * Log fields for a failure: its class and, for GitHub, its classification; for an AppError, its
 * code. Never its message.
 */
function classify(error: unknown) {
  if (error instanceof GitHubApiError) return { errorName: error.name, errorKind: error.kind };
  if (error instanceof AppError) return { errorName: error.name, errorCode: error.code };
  return { errorName: error instanceof Error ? error.name : "unknown" };
}

/**
 * Worth retrying: GitHub was unavailable or rate limited, or a resync or subscription refresh kept
 * losing to concurrent writers (ConflictError). Anything else (rejected, malformed, a bug) will
 * not succeed by waiting.
 */
const isRetryable = (error: unknown): boolean =>
  error instanceof ConflictError ||
  (error instanceof GitHubApiError &&
    (error.kind === "transient" || error.kind === "rate_limited"));

/** A classified code for a failed outbox row, never a message. */
const errorCode = (error: unknown): string =>
  error instanceof GitHubApiError
    ? error.kind
    : error instanceof AppError
      ? error.code
      : "internal_error";

export function createJobsWorker(deps: JobsWorkerDeps) {
  const logOptions = { now: () => deps.clock.now() };
  const services = (db: Db): ServiceContext => ({
    db,
    clock: deps.clock,
    ids: deps.ids,
    correlationId: deps.ids.next(),
  });

  const jobDeps = (config: JobsConfig, github: GitHubAppConfig): JobDeps => ({
    github: deps.github(github),
    environment: config.environment,
    simulatedSource: deps.simulatedSource,
  });

  /** Parses the env, logging a classified error and rethrowing so the runtime records it. */
  function configFrom(env: Env, logger: Logger): JobsConfig {
    try {
      return parseJobsEnv(env);
    } catch (error) {
      // ConfigurationError messages name keys and issue codes only, never values.
      logger.error("invalid environment configuration", { error });
      throw error;
    }
  }

  /** The outbox safety net (decision 0003): runs due work the queue did not complete. */
  async function drainOutbox(db: Db, jobs: JobDeps, logger: Logger): Promise<void> {
    const now = deps.clock.now();
    const rows = await claimOutbox(db, {
      now,
      limit: OUTBOX_BATCH,
      leaseMs: OUTBOX_LEASE_MS,
      maxAttempts: OUTBOX_MAX_ATTEMPTS,
    });
    let sent = 0;
    for (const row of rows) {
      const ctx = services(db);
      try {
        const outcome = await runJob(ctx, row, jobs);
        await markOutboxSent(db, [row.id], now);
        sent += 1;
        if (outcome === "out_of_scope") {
          logger.warn("job has no workspace scope", { outboxId: row.id, kind: row.kind });
        }
      } catch (error) {
        const final = !isRetryable(error) || row.attempts >= OUTBOX_MAX_ATTEMPTS;
        if (final) {
          // Will not succeed by waiting: record it once instead of retrying every minute.
          await markOutboxFailed(db, { id: row.id, now, errorCode: errorCode(error) });
        }
        // Otherwise left leased: the row becomes due again when the lease expires.
        logger.warn("outbox job failed", {
          outboxId: row.id,
          kind: row.kind,
          final,
          ...classify(error),
        });
      }
    }
    logger.info("outbox drained", { claimed: rows.length, sent });
  }

  /**
   * Time-based re-evaluation: queues a refresh of every subscription whose next policy boundary
   * has passed, so the drain that follows in the same tick runs them.
   */
  async function sweepDueEvaluations(db: Db, logger: Logger): Promise<void> {
    const queued = await queueDueEvaluations(services(db), { limit: DUE_EVALUATION_BATCH });
    logger.info("due evaluations queued", { queued });
  }

  /**
   * The daily repair path: queue a resync of every connection that is not deleted. The outbox
   * drain runs them a batch at a time, so one cron run never does every connection's GitHub calls.
   */
  async function dailyResync(db: Db, logger: Logger): Promise<void> {
    const connections = await listActiveConnectionIds(db);
    const now = deps.clock.now();
    for (const connection of connections) {
      await enqueueOutbox(db, {
        id: deps.ids.next(),
        kind: "resync_connection",
        subjectId: connection.id,
        createdAt: now,
        availableAt: now,
      });
    }
    logger.info("daily resync queued", { connections: connections.length });
  }

  return {
    /** Liveness only: answers without reading configuration or touching D1. */
    async fetch(request: Request): Promise<Response> {
      const correlationId = correlationIdFrom(request, deps.ids);
      if (new URL(request.url).pathname !== HEALTH_PATH) {
        return toErrorResponse(new NotFoundError(), correlationId);
      }
      if (request.method !== "GET") {
        const response = toErrorResponse(new MethodNotAllowedError(), correlationId);
        response.headers.set("allow", "GET");
        return response;
      }
      const response = Response.json(
        { status: "ok" },
        { headers: { "cache-control": "no-store" } },
      );
      return withCorrelationId(response, correlationId);
    },

    /**
     * Crons: heartbeat; every minute, the due-evaluation sweep then the outbox drain; daily
     * resync. Invalid configuration fails the run.
     */
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
      const logger = createLogger(
        { correlationId: deps.ids.next(), worker: "jobs", cron: controller.cron },
        logOptions,
      );
      const config = configFrom(env, logger);
      if (controller.cron === CRONS.heartbeat) {
        logger.info("scheduled heartbeat", {
          environment: config.environment,
          scheduledTime: new Date(controller.scheduledTime).toISOString(),
        });
        return;
      }
      if (controller.cron !== CRONS.drainOutbox && controller.cron !== CRONS.dailyResync) {
        logger.warn("unknown cron; nothing to do");
        return;
      }
      if (config.github === null) {
        logger.info("GitHub App not configured; skipped");
        return;
      }
      const db = createDb(config.db);
      if (controller.cron === CRONS.dailyResync) {
        await dailyResync(db, logger);
        return;
      }
      await sweepDueEvaluations(db, logger);
      await drainOutbox(db, jobDeps(config, config.github), logger);
    },

    /**
     * The fast path for handed-off work. Each message is acknowledged unless a retry can help:
     * poison messages and work without a workspace are dropped with a warning; GitHub outages,
     * rate limits and concurrent writers are retried with a delay; other failures (including a
     * key that does not decode, or an unavailable entitlement source) are marked failed on the
     * outbox row with a classified code and acknowledged.
     */
    async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
      const batchLogger = createLogger(
        { correlationId: deps.ids.next(), worker: "jobs", queue: batch.queue },
        logOptions,
      );
      const config = configFrom(env, batchLogger);
      const db = createDb(config.db);
      const jobs = config.github === null ? null : jobDeps(config, config.github);

      for (const message of batch.messages) {
        const parsed = jobMessageSchema.safeParse(message.body);
        if (!parsed.success) {
          batchLogger.warn("invalid job message dropped", { messageId: message.id });
          message.ack();
          continue;
        }
        const job = parsed.data;
        if (jobs === null) {
          batchLogger.warn("GitHub App not configured; job dropped", { kind: job.kind });
          message.ack();
          continue;
        }
        const ctx = services(db);
        const logger = createLogger(
          { correlationId: ctx.correlationId, worker: "jobs", kind: job.kind },
          logOptions,
        );
        try {
          const outcome = await runJob(ctx, job, jobs);
          await markOutboxSent(db, [job.outboxId], deps.clock.now());
          if (outcome === "out_of_scope") {
            logger.warn("job has no workspace scope", { outboxId: job.outboxId });
          }
          message.ack();
        } catch (error) {
          if (isRetryable(error)) {
            const retryAfterMs = error instanceof GitHubApiError ? error.retryAfterMs : undefined;
            const delaySeconds = retryDelaySeconds(message.attempts, retryAfterMs);
            logger.warn("job will be retried", {
              outboxId: job.outboxId,
              delaySeconds,
              ...classify(error),
            });
            message.retry({ delaySeconds });
          } else {
            // Final: record it on the outbox row too, so the drain does not pick it up again.
            await markOutboxFailed(db, {
              id: job.outboxId,
              now: deps.clock.now(),
              errorCode: errorCode(error),
            });
            logger.error("job failed", { outboxId: job.outboxId, ...classify(error) });
            message.ack();
          }
        }
      }
    },
  } satisfies ExportedHandler<Env>;
}
