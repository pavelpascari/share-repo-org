import {
  type CommerceDeps,
  type EntitlementSourcePort,
  PaddleUnavailableError,
  queueCredentialRewrap,
  queueDueEvaluations,
  queueDueReconciles,
  queuePaddleSweeps,
  recordJobFailure,
  type ServiceContext,
} from "@sharerepo/application";
import {
  claimOutbox,
  createDb,
  type Db,
  enqueueOutbox,
  listActiveConnectionIds,
  markOutboxSent,
  type OutboxRow,
  pendingOutboxSince,
} from "@sharerepo/db";
import { type Clock, type IdGenerator, OutboxKind } from "@sharerepo/domain";
import {
  GitHubApiError,
  type GitHubAppConfig,
  type GitHubAppPort,
  type MailPort,
  type MailTransportConfig,
  PaddleApiError,
  type PaddlePort,
} from "@sharerepo/integrations";
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
import { type JobMessage, jobMessageSchema } from "./messages.ts";
import { type JobDeps, JobOutcome, retryDelaySeconds, runJob } from "./work.ts";

export interface JobsWorkerDeps {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** Builds the GitHub App from validated configuration; tests inject the fake. */
  readonly github: (config: GitHubAppConfig) => GitHubAppPort;
  /** The simulated entitlement source; used outside production only. */
  readonly simulatedSource: (db: Db) => EntitlementSourcePort;
  /**
   * A Paddle client for one seller's key at the API base URL of its environment
   * (`PaddleConfig.apiBaseUrls`); tests return a `FakePaddle`.
   */
  readonly paddle: (options: {
    readonly apiKey: string;
    readonly apiBaseUrl: string;
  }) => PaddlePort;
  /** The mail port for a configured transport and sender; tests return a `FakeMail`. */
  readonly mail: (transport: MailTransportConfig, from: string) => MailPort;
  /**
   * Where the queue consumer hands follow-up work a job queued (the `EVENTS` producer binding),
   * or undefined to leave it to the outbox drain. Tests leave it out or record the messages.
   */
  readonly followUps?: (env: Env) => { send(message: JobMessage): Promise<unknown> } | undefined;
}

const HEALTH_PATH = "/healthz";

/** The crons declared in wrangler.jsonc. */
export const CRONS = {
  heartbeat: "0 * * * *",
  drainOutbox: "* * * * *",
  dailyResync: "17 3 * * *",
} as const;

export const OUTBOX_BATCH = 25;
const OUTBOX_LEASE_MS = 60_000;
/**
 * How long one drain keeps claiming batches. The cron runs every minute and each claimed row is
 * leased for a minute, so a drain stops well within both.
 */
export const OUTBOX_DRAIN_BUDGET_MS = 20_000;
/** After this many attempts a row is marked failed and left for the operator. */
export const OUTBOX_MAX_ATTEMPTS = 10;
/** Subscriptions whose next policy boundary passed, queued per minute (phase-3 plan § Time). */
export const DUE_EVALUATION_BATCH = 100;
/** Repositories due for reconciliation, queued per minute (phase-4 plan § Reconciliation job). */
export const DUE_RECONCILE_BATCH = 100;
/**
 * Follow-up work a job's queue consumer hands to the queue at once (decision 0003): a refresh
 * that a Paddle event or a customer link queued, and a Paddle key check. Reconciliations keep
 * their own schedule. At most {@link FOLLOW_UP_LIMIT} per job; the drain runs the rest.
 */
export const FOLLOW_UP_KINDS = [OutboxKind.RefreshSubscription, OutboxKind.CheckPaddleConnection];
export const FOLLOW_UP_LIMIT = 50;

class MethodNotAllowedError extends AppError {
  constructor() {
    super("Method not allowed", {
      httpStatus: 405,
      code: "method_not_allowed",
      expose: "The request method is not allowed.",
    });
  }
}

const isProviderError = (error: unknown): error is GitHubApiError | PaddleApiError =>
  error instanceof GitHubApiError || error instanceof PaddleApiError;

/**
 * Log fields for a failure: its class and, for GitHub or Paddle, its classification; for an
 * AppError, its code. Never its message.
 */
function classify(error: unknown) {
  if (isProviderError(error)) return { errorName: error.name, errorKind: error.kind };
  if (error instanceof AppError) return { errorName: error.name, errorCode: error.code };
  return { errorName: error instanceof Error ? error.name : "unknown" };
}

/**
 * Worth retrying: GitHub or Paddle was unavailable or rate limited; Paddle cannot be read for the
 * workspace now (no active connection, a refused key, or no commerce configuration); or a resync
 * or subscription refresh kept losing to concurrent writers (ConflictError). Anything else
 * (rejected, malformed, a bug) will not succeed by waiting.
 */
const isRetryable = (error: unknown): boolean =>
  error instanceof ConflictError ||
  error instanceof PaddleUnavailableError ||
  (isProviderError(error) && (error.kind === "transient" || error.kind === "rate_limited"));

/** Warns about a job that ended without doing all of its work. */
function logOutcome(logger: Logger, outcome: JobOutcome, fields: Record<string, string>): void {
  if (outcome === JobOutcome.OutOfScope) logger.warn("job has no workspace scope", fields);
  if (outcome === JobOutcome.Partial) logger.warn("job covered only part of its subject", fields);
}

/**
 * The dead-letter queue of the events queue (`sharerepo-events-dlq-<env>`, decision 0014): it
 * receives messages that used up their queue retries, and this Worker consumes it too.
 */
export const DEAD_LETTER_QUEUE_PREFIX = "sharerepo-events-dlq-";
/** The error code of a row whose message reached the dead-letter queue. */
export const DEAD_LETTERED = "dead_lettered";

/** A classified code for a failed outbox row, never a message. */
const errorCode = (error: unknown): string =>
  isProviderError(error) ? error.kind : error instanceof AppError ? error.code : "internal_error";

export function createJobsWorker(deps: JobsWorkerDeps) {
  const logOptions = { now: () => deps.clock.now() };
  /** A job's service context, with its own correlation ID and a logger for its alert lines. */
  const services = (db: Db): ServiceContext => {
    const correlationId = deps.ids.next();
    return {
      db,
      clock: deps.clock,
      ids: deps.ids,
      correlationId,
      logger: createLogger({ correlationId, worker: "jobs" }, logOptions),
    };
  };

  /** Paddle and claims from validated configuration; null without the commerce secrets. */
  function commerceDeps(config: JobsConfig): CommerceDeps | null {
    if (config.commerce === null) return null;
    const { apiBaseUrls } = config.paddle;
    return {
      paddle: ({ apiKey, environment }) =>
        deps.paddle({ apiKey, apiBaseUrl: apiBaseUrls[environment] }),
      credentialKeys: config.commerce.credentialKeys,
      claimSigningKeys: config.commerce.claimSigningKeys,
      baseUrl: config.publicBaseUrl,
      deployment: config.environment,
    };
  }

  const jobDeps = (config: JobsConfig, github: GitHubAppConfig): JobDeps => ({
    github: deps.github(github),
    environment: config.environment,
    simulatedSource: deps.simulatedSource,
    commerce: commerceDeps(config),
    mail: config.mail === null ? null : deps.mail(config.mail, config.mailFrom),
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

  /**
   * The outbox safety net (decision 0003): runs due work the queue did not complete. Claims a
   * batch at a time and keeps going while batches come back full (a sweep or a recompute can
   * queue far more than one batch a minute), until about {@link OUTBOX_DRAIN_BUDGET_MS} has
   * passed. Work queued during the drain is claimed by it too.
   */
  async function drainOutbox(db: Db, jobs: JobDeps, logger: Logger): Promise<void> {
    const started = deps.clock.now();
    let claimed = 0;
    let sent = 0;
    for (;;) {
      const now = deps.clock.now();
      const rows = await claimOutbox(db, {
        now,
        limit: OUTBOX_BATCH,
        leaseMs: OUTBOX_LEASE_MS,
        maxAttempts: OUTBOX_MAX_ATTEMPTS,
      });
      claimed += rows.length;
      for (const row of rows) {
        if (await runOutboxRow(db, row, jobs, logger, now)) sent += 1;
      }
      if (rows.length < OUTBOX_BATCH || deps.clock.now() - started >= OUTBOX_DRAIN_BUDGET_MS) {
        break;
      }
    }
    logger.info("outbox drained", { claimed, sent });
  }

  /**
   * Sends the follow-up work queued since a job started to the queue, best effort: the rows are
   * in the outbox, so a failure only waits for the drain. Rows queued meanwhile by other jobs may
   * be sent too; every job is idempotent. Logged by classification, never thrown.
   */
  async function handOff(env: Env, db: Db, since: number, logger: Logger): Promise<void> {
    const queue = deps.followUps?.(env);
    if (queue === undefined) return;
    try {
      const rows = await pendingOutboxSince(db, {
        kinds: FOLLOW_UP_KINDS,
        since,
        now: deps.clock.now(),
        limit: FOLLOW_UP_LIMIT,
      });
      for (const row of rows) {
        await queue.send({ kind: row.kind, subjectId: row.subjectId, outboxId: row.id });
      }
    } catch (error) {
      logger.warn("follow-up hand-off failed; the outbox drain will deliver", classify(error));
    }
  }

  /** Runs one claimed row; returns whether it was sent. A failure is logged, never thrown. */
  async function runOutboxRow(
    db: Db,
    row: OutboxRow,
    jobs: JobDeps,
    logger: Logger,
    now: number,
  ): Promise<boolean> {
    const ctx = services(db);
    try {
      const outcome = await runJob(ctx, row, jobs);
      await markOutboxSent(db, [row.id], now);
      logOutcome(logger, outcome, { outboxId: row.id, kind: row.kind });
      return true;
    } catch (error) {
      const final = !isRetryable(error) || row.attempts >= OUTBOX_MAX_ATTEMPTS;
      if (final) {
        // Will not succeed by waiting: record it once (row, `job.failed`, alert line) instead of
        // retrying every minute.
        await recordJobFailure(ctx, { outboxId: row.id, errorCode: errorCode(error) });
      }
      // Otherwise left leased: the row becomes due again when the lease expires.
      logger.warn("outbox job failed", {
        outboxId: row.id,
        kind: row.kind,
        final,
        ...classify(error),
      });
      return false;
    }
  }

  /**
   * Time-based re-evaluation: queues a refresh of every subscription whose next policy boundary
   * has passed (and repairs lapsed entitlements), so the drain that follows in the same tick runs
   * them. A failing sweep is logged by its classification only and never stops that drain.
   */
  async function sweepDueEvaluations(db: Db, logger: Logger): Promise<void> {
    try {
      const queued = await queueDueEvaluations(services(db), { limit: DUE_EVALUATION_BATCH });
      logger.info("due evaluations queued", { queued });
    } catch (error) {
      logger.error("due evaluation sweep failed", classify(error));
    }
  }

  /**
   * Scheduled reconciliation: queues a `reconcile_resource` for every repository that is due (or
   * has live access and nothing scheduled), for the drain that follows in the same tick. Like the
   * evaluation sweep, a failure is logged by its classification only and stops nothing else.
   */
  async function sweepDueReconciles(db: Db, logger: Logger): Promise<void> {
    try {
      const queued = await queueDueReconciles(services(db), { limit: DUE_RECONCILE_BATCH });
      logger.info("due reconciles queued", { queued });
    } catch (error) {
      logger.error("due reconcile sweep failed", classify(error));
    }
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
        kind: OutboxKind.ResyncConnection,
        subjectId: connection.id,
        createdAt: now,
        availableAt: now,
        workspaceId: connection.workspaceId,
      });
    }
    logger.info("daily resync queued", { connections: connections.length });
  }

  /**
   * The daily Paddle repair (Phase 5 plan): queues a `sweep_paddle_subscriptions` for every active
   * Paddle connection, once. A failure is logged by its classification only.
   */
  async function dailyPaddleSweeps(db: Db, logger: Logger): Promise<void> {
    try {
      const queued = await queuePaddleSweeps(services(db));
      logger.info("paddle sweeps queued", { queued });
    } catch (error) {
      logger.error("paddle sweep queueing failed", classify(error));
    }
  }

  /**
   * The dead-letter queue (decision 0014): messages that used up their queue retries. Each is
   * validated like a job message and never run. Its outbox row is marked failed with
   * `dead_lettered` (with `job.failed` and an alert line) only if the row matches the message's
   * kind and subject and is neither sent nor failed, so a replay, a stale message or a forged
   * one changes nothing (threat O14). Every message is acknowledged once handled; a storage
   * error retries it.
   */
  async function deadLettered(batch: MessageBatch<unknown>, db: Db, logger: Logger) {
    for (const message of batch.messages) {
      const parsed = jobMessageSchema.safeParse(message.body);
      if (!parsed.success) {
        logger.warn("invalid dead-lettered message dropped", { messageId: message.id });
        message.ack();
        continue;
      }
      const { kind, subjectId, outboxId } = parsed.data;
      try {
        const recorded = await recordJobFailure(services(db), {
          outboxId,
          errorCode: DEAD_LETTERED,
          message: { kind, subjectId },
        });
        if (!recorded) {
          logger.warn("dead-lettered message matched no open job", {
            messageId: message.id,
            outboxId,
          });
        }
        message.ack();
      } catch (error) {
        logger.error("dead-lettered message not recorded; retrying", {
          messageId: message.id,
          ...classify(error),
        });
        message.retry();
      }
    }
  }

  /**
   * The daily credential check (secret rotation): queues a `rewrap_credentials` run while any
   * envelope is still sealed under a retired `CREDENTIAL_KEYS` key. A failure is logged by its
   * classification only.
   */
  async function dailyRewrapCheck(db: Db, config: JobsConfig, logger: Logger): Promise<void> {
    if (config.commerce === null) return;
    try {
      const queued = await queueCredentialRewrap(services(db), config.commerce);
      logger.info("credential rewrap check", { queued });
    } catch (error) {
      logger.error("credential rewrap check failed", classify(error));
    }
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
     * Crons: heartbeat; every minute, the due-evaluation and due-reconcile sweeps then the outbox
     * drain (each runs even when another fails); daily, the Paddle sweeps and the connection
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
        await dailyPaddleSweeps(db, logger);
        await dailyRewrapCheck(db, config, logger);
        await dailyResync(db, logger);
        return;
      }
      await sweepDueEvaluations(db, logger);
      await sweepDueReconciles(db, logger);
      await drainOutbox(db, jobDeps(config, config.github), logger);
    },

    /**
     * The fast path for handed-off work. Each message is acknowledged unless a retry can help:
     * poison messages and work without a workspace are dropped with a warning; GitHub and Paddle
     * outages and rate limits, an unavailable Paddle connection or commerce configuration, and
     * concurrent writers are retried with a delay; other failures (including a key that does not
     * decode, or an unavailable entitlement source) are marked failed on the outbox row with a
     * classified code and acknowledged.
     */
    async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
      const batchLogger = createLogger(
        { correlationId: deps.ids.next(), worker: "jobs", queue: batch.queue },
        logOptions,
      );
      const config = configFrom(env, batchLogger);
      const db = createDb(config.db);
      if (batch.queue.startsWith(DEAD_LETTER_QUEUE_PREFIX)) {
        await deadLettered(batch, db, batchLogger);
        return;
      }
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
        const startedAt = deps.clock.now();
        try {
          const outcome = await runJob(ctx, job, jobs);
          await markOutboxSent(db, [job.outboxId], deps.clock.now());
          logOutcome(logger, outcome, { outboxId: job.outboxId });
          await handOff(env, db, startedAt, logger);
          message.ack();
        } catch (error) {
          if (isRetryable(error)) {
            const retryAfterMs = isProviderError(error) ? error.retryAfterMs : undefined;
            const delaySeconds = retryDelaySeconds(message.attempts, retryAfterMs);
            logger.warn("job will be retried", {
              outboxId: job.outboxId,
              delaySeconds,
              ...classify(error),
            });
            message.retry({ delaySeconds });
          } else {
            // Final: record it on the outbox row too, so the drain does not pick it up again,
            // with `job.failed` and an alert line.
            await recordJobFailure(ctx, {
              outboxId: job.outboxId,
              errorCode: errorCode(error),
              message: { kind: job.kind, subjectId: job.subjectId },
            });
            logger.error("job failed", { outboxId: job.outboxId, ...classify(error) });
            message.ack();
          }
        }
      }
    },
  } satisfies ExportedHandler<Env>;
}
