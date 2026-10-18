import type { ServiceContext } from "@sharerepo/application";
import { createDb } from "@sharerepo/db";
import { randomIds, systemClock } from "@sharerepo/domain";
import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../context.ts";
import { type Auth, createAuth } from "./auth.ts";
import { createGitHubClient } from "./github.ts";

type Context = Readonly<RouterContextProvider>;

/** Service context for this request: D1, system clock, random IDs, the request's correlation ID. */
export function servicesFor(context: Context): ServiceContext {
  const { env, correlationId } = context.get(cloudflareContext);
  return { db: createDb(env.DB), clock: systemClock, ids: randomIds, correlationId };
}

const instances = new WeakMap<Context, Auth>();

/** The request's Better Auth instance, built once per request from the validated env. */
export function authFor(context: Context): Auth {
  const existing = instances.get(context);
  if (existing !== undefined) return existing;
  const { env, logger } = context.get(cloudflareContext);
  const auth = createAuth({
    config: env.auth,
    github: createGitHubClient({
      endpoints: env.auth.github.endpoints,
      clientId: env.auth.github.clientId,
      clientSecret: env.auth.github.clientSecret,
      fetch: globalThis.fetch.bind(globalThis),
    }),
    services: servicesFor(context),
    logger,
  });
  instances.set(context, auth);
  return auth;
}
