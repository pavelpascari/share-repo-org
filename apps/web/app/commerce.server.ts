import type { CommerceDeps } from "@sharerepo/application";
import { pendingOutboxMessage, pendingOutboxSince } from "@sharerepo/db";
import { OutboxKind, systemClock } from "@sharerepo/domain";
import { createPaddleClient, type GitHubAppPort, PaddleApiError } from "@sharerepo/integrations";
import { ConflictError, ServiceUnavailableError } from "@sharerepo/platform";
import { createContext, type RouterContextProvider } from "react-router";
import type { WebEnv } from "../workers/env.ts";
import type { JobMessage } from "../workers/webhooks.ts";
import { servicesFor } from "./auth/server.ts";
import { cloudflareContext } from "./context.ts";
import { CONFLICT_MESSAGE } from "./entitlement-messages.ts";
import { githubFor } from "./github.server.ts";
import { asResponse } from "./workspaces.server.ts";

type Context = Readonly<RouterContextProvider>;

/**
 * Provider clients for this request. The Worker entry leaves this unset, so they are built from
 * the env; route tests set fakes (a FakePaddle factory, a FakeGitHubApp) here.
 */
export interface ProviderOverrides {
  readonly paddle?: CommerceDeps["paddle"];
  readonly github?: GitHubAppPort;
}

export const providerOverrides = createContext<ProviderOverrides>({});

/**
 * What the commerce services need, from the validated env: a Paddle client per key for the key's
 * environment, the credential keyring, the claim signing key, the public origin and the
 * deployment. Null when `CREDENTIAL_KEYS` and `CLAIM_SIGNING_KEY` are not configured (local
 * development without secrets): Paddle pages then say Paddle is not configured.
 */
export function commerceDepsFromEnv(
  env: WebEnv,
  paddle?: CommerceDeps["paddle"],
): CommerceDeps | null {
  if (env.commerce === null) return null;
  const fetch = globalThis.fetch.bind(globalThis);
  return {
    paddle:
      paddle ??
      (({ apiKey, environment }) =>
        createPaddleClient({
          apiKey,
          apiBaseUrl: env.paddle.apiBaseUrls[environment],
          fetch,
          clock: systemClock,
        })),
    credentialKeys: env.commerce.credentialKeys,
    claimSigningKey: env.commerce.claimSigningKey,
    baseUrl: new URL(env.auth.baseURL).origin,
    deployment: env.ENVIRONMENT,
  };
}

const instances = new WeakMap<Context, CommerceDeps | null>();

/** The request's commerce dependencies, built once per request; null when not configured. */
export function commerceFor(context: Context): CommerceDeps | null {
  if (instances.has(context)) return instances.get(context) ?? null;
  const deps = commerceDepsFromEnv(
    context.get(cloudflareContext).env,
    context.get(providerOverrides).paddle,
  );
  instances.set(context, deps);
  return deps;
}

/** The GitHub App for this request (a test's fake when one is set), or null when unconfigured. */
export function githubAppFor(context: Context): GitHubAppPort | null {
  return context.get(providerOverrides).github ?? githubFor(context);
}

/** The public origin, for links people copy (`https://sharerepo.org`). */
export function publicOrigin(context: Context): string {
  return new URL(context.get(cloudflareContext).env.auth.baseURL).origin;
}

/**
 * Hands an outbox row the caller knows only by ID to the queue, best effort and off the response
 * path: the row's kind and subject are read inside `waitUntil`, so the response takes the same
 * time whatever the row is (threat T4). The cron drain delivers it if this fails.
 */
export function enqueueOutboxById(context: Context, outboxId: string): void {
  const { env, ctx, logger } = context.get(cloudflareContext);
  const { db } = servicesFor(context);
  ctx.waitUntil(
    pendingOutboxMessage(db, outboxId)
      .then(async (row) => {
        if (row !== null) await env.EVENTS.send({ ...row, outboxId } satisfies JobMessage);
      })
      .catch((error: unknown) =>
        logger.warn("queue send failed; the outbox drain will deliver", {
          outboxId,
          errorName: error instanceof Error ? error.name : "unknown",
        }),
      ),
  );
}

/** At most this many refreshes one request hands to the queue; the drain runs any others. */
const REFRESH_HAND_OFF_LIMIT = 50;

/**
 * Hands the refreshes a customer link queued in the workspace since `since` (a confirmed claim,
 * a manual link) to the queue, best effort and off the response path, so access follows the
 * link without waiting for the outbox drain, which remains the safety net.
 */
export function enqueueRefreshesSince(context: Context, workspaceId: string, since: number): void {
  const { env, ctx, logger } = context.get(cloudflareContext);
  const { db, clock } = servicesFor(context);
  ctx.waitUntil(
    pendingOutboxSince(db, {
      kinds: [OutboxKind.RefreshSubscription],
      since,
      now: clock.now(),
      limit: REFRESH_HAND_OFF_LIMIT,
      subjectPrefix: `${workspaceId}:`,
    })
      .then(async (rows) => {
        for (const row of rows) {
          const message = { kind: row.kind, subjectId: row.subjectId, outboxId: row.id };
          await env.EVENTS.send(message satisfies JobMessage);
        }
      })
      .catch((error: unknown) =>
        logger.warn("queue send failed; the outbox drain will deliver", {
          errorName: error instanceof Error ? error.name : "unknown",
        }),
      ),
  );
}

/**
 * Runs a service call that may reach Paddle, for a form action. Paddle being down, rate limited
 * or refusing the key (which the service records) becomes `unreachable` copy, a concurrent change
 * the conflict message; not found and forbidden become 404 and 403; anything else stays a 500.
 * Errors are never echoed: they can name the operation, never the key.
 */
export async function attemptPaddle<T>(
  run: () => Promise<T>,
  unreachable: string,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof PaddleApiError || error instanceof ServiceUnavailableError) {
      return { ok: false, error: unreachable };
    }
    if (error instanceof ConflictError) return { ok: false, error: CONFLICT_MESSAGE };
    throw asResponse(error);
  }
}
