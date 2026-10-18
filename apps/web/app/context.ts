import { createContext } from "react-router";
import type { WebEnv } from "../workers/env.ts";

/** Set by the Worker entry; loaders read it with `context.get(cloudflareContext)`. */
export interface CloudflareContext {
  /** Validated bindings and vars. */
  env: WebEnv;
  ctx: ExecutionContext;
}

export const cloudflareContext = createContext<CloudflareContext>();
