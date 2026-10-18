import { createDb, ping } from "@sharerepo/db";
import { type Clock, type IdGenerator, randomIds } from "@sharerepo/domain";
import {
  AppError,
  ConfigurationError,
  createLogger,
  isValidCorrelationId,
  type Logger,
  type LoggerOptions,
  type LogSink,
  REQUEST_ID_HEADER,
  ServiceUnavailableError,
  toErrorResponse,
  withCorrelationId,
} from "@sharerepo/platform";
import { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../app/context.ts";
import { parseWebEnv, type WebEnv } from "./env.ts";
import { handleGitHubWebhook } from "./webhooks.ts";

const GITHUB_WEBHOOK_PATH = "/webhooks/github";

/** React Router's request handler, as returned by `createRequestHandler`. */
export type RenderApp = (request: Request, context: RouterContextProvider) => Promise<Response>;

export interface FetchHandlerDeps {
  readonly renderApp: RenderApp;
  /** Generates each request's correlation ID. */
  readonly ids?: IdGenerator;
  /** Epoch-millisecond clock for log timestamps and request duration. */
  readonly now?: () => number;
  /** Defaults to the console. */
  readonly logSink?: LogSink;
}

export type FetchHandler = (
  request: Request,
  env: unknown,
  ctx: ExecutionContext,
) => Promise<Response>;

const PROBE_METHODS = ["GET", "HEAD"];

/**
 * The web Worker's `fetch`: validates the env, assigns a correlation ID, answers probes
 * before React Router, turns unhandled errors into a generic response, and logs one line per
 * request. Logs carry classifications only: error messages, query strings, headers, and
 * cookies can contain secrets or personal data.
 */
export function createFetchHandler(deps: FetchHandlerDeps): FetchHandler {
  const ids = deps.ids ?? randomIds;
  const now = deps.now ?? Date.now;
  const loggerOptions: LoggerOptions =
    deps.logSink === undefined ? { now } : { now, sink: deps.logSink };

  return async (request, rawEnv, ctx) => {
    const startedAt = now();
    // Always generated here: correlation IDs end up in audit events, so a client must not be
    // able to choose one. A valid incoming x-request-id is kept in logs only.
    const correlationId = ids.next();
    const incoming = request.headers.get(REQUEST_ID_HEADER);
    const logger = createLogger(
      incoming !== null && isValidCorrelationId(incoming)
        ? { correlationId, clientRequestId: incoming }
        : { correlationId },
      loggerOptions,
    );
    const path = new URL(request.url).pathname;

    let response: Response;
    try {
      const env = parseWebEnv(rawEnv);
      response = await route(request, path, env, ctx, deps.renderApp, logger, correlationId, {
        ids,
        clock: { now },
      });
    } catch (error) {
      logFailure(logger, error);
      response = toErrorResponse(error, correlationId);
    }
    response = withCorrelationId(response, correlationId);

    logger.info("request", {
      method: request.method,
      path,
      status: response.status,
      durationMs: now() - startedAt,
    });
    return response;
  };
}

async function route(
  request: Request,
  path: string,
  env: WebEnv,
  ctx: ExecutionContext,
  renderApp: RenderApp,
  logger: Logger,
  correlationId: string,
  { ids, clock }: { ids: IdGenerator; clock: Clock },
): Promise<Response> {
  if (path === "/healthz" || path === "/readyz") {
    if (!PROBE_METHODS.includes(request.method)) {
      const response = toErrorResponse(METHOD_NOT_ALLOWED, correlationId);
      response.headers.set("allow", PROBE_METHODS.join(", "));
      return response;
    }
    return path === "/healthz"
      ? json(200, { status: "ok" })
      : readiness(env, logger, correlationId);
  }

  if (path === GITHUB_WEBHOOK_PATH) {
    if (request.method !== "POST") {
      const response = toErrorResponse(METHOD_NOT_ALLOWED, correlationId);
      response.headers.set("allow", "POST");
      return response;
    }
    return handleGitHubWebhook(request, env, ctx, { ids, clock, correlationId, logger });
  }

  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env, ctx, correlationId, logger });
  return renderApp(request, context);
}

const METHOD_NOT_ALLOWED = new AppError("Probe called with an unsupported method", {
  httpStatus: 405,
  code: "method_not_allowed",
  expose: "The request method is not allowed.",
});

async function readiness(env: WebEnv, logger: Logger, correlationId: string): Promise<Response> {
  try {
    await ping(createDb(env.DB));
  } catch (error) {
    // Drizzle errors embed the SQL and its parameters; log the classification only.
    logger.warn("readiness check failed", { check: "d1", errorName: errorName(error) });
    return toErrorResponse(new ServiceUnavailableError("D1 readiness check failed"), correlationId);
  }
  return json(200, { status: "ready", checks: { d1: "ok" } });
}

function logFailure(logger: Logger, error: unknown): void {
  if (error instanceof ConfigurationError) {
    logger.error("invalid environment configuration", {
      errorCode: error.code,
      issues: error.issues,
    });
  } else if (error instanceof AppError) {
    logger.error("unhandled error", { errorName: error.name, errorCode: error.code });
  } else {
    logger.error("unhandled error", { errorName: errorName(error) });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
