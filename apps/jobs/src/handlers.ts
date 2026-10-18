import type { Clock } from "@sharerepo/domain";
import {
  AppError,
  type CorrelationIdSource,
  correlationIdFrom,
  createLogger,
  NotFoundError,
  toErrorResponse,
  withCorrelationId,
} from "@sharerepo/platform";
import { parseJobsEnv } from "./env.ts";

export interface JobsWorkerDeps {
  readonly ids: CorrelationIdSource;
  readonly clock: Clock;
}

const HEALTH_PATH = "/healthz";

class MethodNotAllowedError extends AppError {
  constructor() {
    super("Method not allowed", {
      httpStatus: 405,
      code: "method_not_allowed",
      expose: "The request method is not allowed.",
    });
  }
}

export function createJobsWorker(deps: JobsWorkerDeps) {
  const logOptions = { now: () => deps.clock.now() };

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

    /** Cron heartbeat. Rethrows invalid configuration so the runtime records a failed run. */
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
      const logger = createLogger(
        { correlationId: deps.ids.next(), worker: "jobs", cron: controller.cron },
        logOptions,
      );
      let environment: string;
      try {
        ({ environment } = parseJobsEnv(env));
      } catch (error) {
        // ConfigurationError messages name keys and issue codes only, never values.
        logger.error("invalid environment configuration", { error });
        throw error;
      }
      logger.info("scheduled heartbeat", {
        environment,
        scheduledTime: new Date(controller.scheduledTime).toISOString(),
      });
    },
  } satisfies ExportedHandler<Env>;
}
