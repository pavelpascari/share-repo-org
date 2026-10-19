import { env } from "cloudflare:workers";
import { createLogger, type LogSink } from "@sharerepo/platform";
import { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../app/context.ts";
import { parseWebEnv } from "../../workers/env.ts";

/** A router context as the Worker entry builds it, from the test Worker's validated env. */
export function requestContext(
  options: {
    correlationId?: string;
    sink?: LogSink;
    rawEnv?: unknown;
    ctx?: ExecutionContext;
  } = {},
): RouterContextProvider {
  const correlationId = options.correlationId ?? `corr-${crypto.randomUUID()}`;
  const logger = createLogger(
    { correlationId },
    options.sink === undefined ? {} : { sink: options.sink },
  );
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: parseWebEnv(options.rawEnv ?? env),
    ctx: options.ctx ?? ({} as ExecutionContext),
    correlationId,
    logger,
  });
  return context;
}
