import { resyncConnection, type ServiceContext } from "@sharerepo/application";
import {
  claimOutbox,
  createDb,
  type Db,
  listActiveConnectionIds,
  markOutboxSent,
} from "@sharerepo/db";
import type { Clock, IdGenerator } from "@sharerepo/domain";
import { GitHubApiError, type GitHubAppConfig, type GitHubAppPort } from "@sharerepo/integrations";
import {
  AppError,
  correlationIdFrom,
  createLogger,
  type Logger,
  NotFoundError,
  toErrorResponse,
  withCorrelationId,
} from "@sharerepo/platform";
import { type JobsConfig, parseJobsEnv } from "./env.ts";
import { jobMessageSchema } from "./messages.ts";
import { retryDelaySeconds, runJob } from "./work.ts";

export interface JobsWorkerDeps {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** Builds the GitHub App from validated configuration; tests inject the fake. */
  readonly github: (config: GitHubAppConfig) => GitHubAppPort;
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

class MethodNotAllowedError extends AppError {
  constructor() {
    super("Method not allowed", {
      httpStatus: 405,
      code: "method_not_allowed",
      expose: "The request method is not allowed.",
    });
  }
}

/** Log fields for a failure: its class and, for GitHub, its classification. Never its message. */
function classify(error: unknown) {
  if (error instanceof GitHubApiError) return { errorName: error.name, errorKind: error.kind };
  return { errorName: error instanceof Error ? error.name : "unknown" };
}

const isRetryable = (error: unknown): error is GitHubApiError =>
  error instanceof GitHubApiError && (error.kind === "transient" || error.kind === "rate_limited");

export function createJobsWorker(deps: JobsWorkerDeps) {
  const logOptions = { now: () => deps.clock.now() };
  const services = (db: Db): ServiceContext => ({
    db,
    clock: deps.clock,
    ids: deps.ids,
    correlationId: deps.ids.next(),
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
  async function drainOutbox(db: Db, github: GitHubAppPort, logger: Logger): Promise<void> {
    const now = deps.clock.now();
    const rows = await claimOutbox(db, { now, limit: OUTBOX_BATCH, leaseMs: OUTBOX_LEASE_MS });
    let sent = 0;
    for (const row of rows) {
      const ctx = services(db);
      try {
        const outcome = await runJob(ctx, row, github);
        await markOutboxSent(db, [row.id], now);
        sent += 1;
        if (outcome === "out_of_scope") {
          logger.warn("job has no workspace scope", { outboxId: row.id, kind: row.kind });
        }
      } catch (error) {
        // Left leased: the row becomes due again when the lease expires.
        logger.warn("outbox job failed", { outboxId: row.id, kind: row.kind, ...classify(error) });
      }
    }
    logger.info("outbox drained", { claimed: rows.length, sent });
  }

  /** The daily repair path: resync every connection that is not deleted, past failures. */
  async function dailyResync(db: Db, github: GitHubAppPort, logger: Logger): Promise<void> {
    const connections = await listActiveConnectionIds(db);
    let failed = 0;
    for (const connection of connections) {
      try {
        await resyncConnection(services(db), connection, github, "daily resync");
      } catch (error) {
        failed += 1;
        logger.warn("daily resync failed", { connectionId: connection.id, ...classify(error) });
      }
    }
    logger.info("daily resync finished", { connections: connections.length, failed });
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

    /** Crons: heartbeat, outbox drain, daily resync. Invalid configuration fails the run. */
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
      const github = deps.github(config.github);
      if (controller.cron === CRONS.drainOutbox) await drainOutbox(db, github, logger);
      else await dailyResync(db, github, logger);
    },

    /**
     * The fast path for handed-off work. Each message is acknowledged unless a retry can help:
     * poison messages and work without a workspace are dropped with a warning; GitHub outages
     * and rate limits are retried with a delay; other failures are already recorded by the
     * services and are acknowledged.
     */
    async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
      const batchLogger = createLogger(
        { correlationId: deps.ids.next(), worker: "jobs", queue: batch.queue },
        logOptions,
      );
      const config = configFrom(env, batchLogger);
      const db = createDb(config.db);
      const github = config.github === null ? null : deps.github(config.github);

      for (const message of batch.messages) {
        const parsed = jobMessageSchema.safeParse(message.body);
        if (!parsed.success) {
          batchLogger.warn("invalid job message dropped", { messageId: message.id });
          message.ack();
          continue;
        }
        const job = parsed.data;
        if (github === null) {
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
          const outcome = await runJob(ctx, job, github);
          await markOutboxSent(db, [job.outboxId], deps.clock.now());
          if (outcome === "out_of_scope") {
            logger.warn("job has no workspace scope", { outboxId: job.outboxId });
          }
          message.ack();
        } catch (error) {
          if (isRetryable(error)) {
            const delaySeconds = retryDelaySeconds(message.attempts, error.retryAfterMs);
            logger.warn("job will be retried", {
              outboxId: job.outboxId,
              delaySeconds,
              ...classify(error),
            });
            message.retry({ delaySeconds });
          } else {
            logger.error("job failed", { outboxId: job.outboxId, ...classify(error) });
            message.ack();
          }
        }
      }
    },
  } satisfies ExportedHandler<Env>;
}
