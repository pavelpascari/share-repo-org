import type { Logger } from "@sharerepo/platform";
import { createContext } from "react-router";
import type { WebEnv } from "../workers/env.ts";

/** Set by the Worker entry; loaders read it with `context.get(cloudflareContext)`. */
export interface CloudflareContext {
  /** Validated bindings and vars. */
  env: WebEnv;
  ctx: ExecutionContext;
  /** The request's correlation ID, also on the `x-request-id` response header. */
  correlationId: string;
  /** Request-scoped logger carrying the correlation ID. */
  logger: Logger;
}

export const cloudflareContext = createContext<CloudflareContext>();
