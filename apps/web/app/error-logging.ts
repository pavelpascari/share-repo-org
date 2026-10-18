import { AppError, type Logger } from "@sharerepo/platform";
import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "./context.ts";

/**
 * Logs an error React Router caught in a loader, action or render. Only a classification is
 * kept: messages can embed SQL with its parameters (Drizzle), tokens, or personal data.
 */
export function logRouteError(logger: Logger, error: unknown): void {
  const fields =
    error instanceof AppError
      ? { errorName: error.name, errorCode: error.code }
      : { errorName: error instanceof Error ? error.name : "unknown" };
  logger.error("route error", fields);
}

/** The request's logger, if the Worker entry set one (it always does outside tests). */
export function requestLogger(context: Readonly<RouterContextProvider>): Logger | undefined {
  try {
    return context.get(cloudflareContext).logger;
  } catch {
    return undefined;
  }
}
