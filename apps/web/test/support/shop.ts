import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  addWorkspaceMember,
  completeGitHubConnection,
  createWorkspace,
  resyncConnection,
  type ServiceContext,
  startGitHubConnection,
} from "@sharerepo/application";
import { listResourcesForConnection, type Resource } from "@sharerepo/db";
import { randomIds, systemClock } from "@sharerepo/domain";
import { createFakeGitHubApp, type FakeGitHubApp } from "@sharerepo/integrations/testing";
import type { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../app/context.ts";
import type { WebEnv } from "../../workers/env.ts";
import { fakeAccount } from "./fake-github.ts";
import { requestContext } from "./request-context.ts";
import { BASE, db, sessionUser, signIn } from "./sign-in.ts";

// A signed-in creator whose workspace has an active GitHub connection and synced repositories,
// built through the real services, plus helpers to call route loaders and actions directly.

export const services = (): ServiceContext => ({
  db,
  clock: systemClock,
  ids: randomIds,
  correlationId: `corr-${crypto.randomUUID()}`,
});

export interface SignedIn {
  readonly userId: string;
  readonly cookie: string;
  readonly login: string;
  readonly githubId: string;
}

export async function signedIn(): Promise<SignedIn> {
  const account = fakeAccount();
  const { cookie } = await signIn(account);
  const user = await sessionUser(cookie);
  if (user === null) throw new Error("sign-in failed");
  return { userId: user.id, cookie, login: account.login, githubId: account.id };
}

/** A new session for the same GitHub account (signing in again). */
export async function signedInAs(who: SignedIn): Promise<SignedIn> {
  const account = fakeAccount({ id: who.githubId as never, login: who.login as never });
  const { cookie } = await signIn(account);
  const user = await sessionUser(cookie);
  if (user?.id !== who.userId) throw new Error("sign-in failed");
  return { ...who, cookie };
}

export interface Shop {
  readonly owner: SignedIn;
  readonly slug: string;
  readonly workspaceId: string;
  readonly github: FakeGitHubApp;
  readonly resources: readonly Resource[];
}

let next = Math.floor(Math.random() * 1e8);

export async function shop(): Promise<Shop> {
  const owner = await signedIn();
  const created = await createWorkspace(services(), owner, {
    name: "Shop",
    slug: `ws-${crypto.randomUUID().slice(0, 8)}`,
  });
  if (!created.ok) throw new Error("setup failed");
  const { slug, id: workspaceId } = created.workspace;
  const github = createFakeGitHubApp();
  const installationId = String(++next);
  github.addInstallation({
    id: installationId,
    account: { id: owner.githubId, login: owner.login, type: "User" },
    repositories: [0, 1].map((i) => ({
      externalId: String(++next),
      name: `${owner.login}/repo-${i}`,
      ownerExternalId: owner.githubId,
      ownerType: "User" as const,
      private: i === 0,
      archived: false,
    })),
  });
  const started = await startGitHubConnection(
    services(),
    owner,
    slug,
    { acknowledgeWriteAccess: true },
    github,
  );
  if (!started.ok) throw new Error("setup failed");
  const state = new URL(started.installUrl).searchParams.get("state") ?? "";
  const completed = await completeGitHubConnection(
    services(),
    owner,
    { state, installationId },
    github,
  );
  if (!completed.ok) throw new Error(completed.reason);
  const connection = { workspaceId, id: completed.connectionId };
  await resyncConnection(services(), connection, github, "setup");
  const resources = await listResourcesForConnection(db, {
    workspaceId,
    connectionId: connection.id,
  });
  return { owner, slug, workspaceId, github, resources };
}

/** Another signed-in user, added to the shop's workspace as a member. */
export async function memberOf(s: Shop): Promise<SignedIn> {
  const member = await signedIn();
  await addWorkspaceMember(services(), s.owner, s.slug, { userId: member.userId, role: "member" });
  return member;
}

/** A route call harness: a request context with a recording EVENTS queue and log sink. */
export function harness(
  options: {
    sendFails?: boolean;
    environment?: WebEnv["ENVIRONMENT"];
    /** Raw env entries to add or (with undefined) remove before validation. */
    env?: Record<string, unknown>;
  } = {},
) {
  const sent: unknown[] = [];
  const lines: string[] = [];
  const record = (line: string) => {
    lines.push(line);
  };
  const ctx = createExecutionContext();
  const rawEnv = {
    ...env,
    ...options.env,
    EVENTS: {
      send: async (message: unknown) => {
        if (options.sendFails) throw new Error("queue unavailable: secret-ish detail");
        sent.push(message);
      },
    },
  };
  const context: RouterContextProvider = requestContext({
    rawEnv,
    ctx,
    sink: { debug: record, info: record, warn: record, error: record },
  });
  if (options.environment !== undefined) {
    // Only the ENVIRONMENT switch: a full production config (https URL, secure cookies) would
    // not accept this test's session.
    const cloudflare = context.get(cloudflareContext);
    context.set(cloudflareContext, {
      ...cloudflare,
      env: { ...cloudflare.env, ENVIRONMENT: options.environment },
    });
  }
  return {
    context,
    sent,
    logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    settle: () => waitOnExecutionContext(ctx),
  };
}

export function get(path: string, who: SignedIn): Request {
  return new Request(`${BASE}${path}`, { headers: { cookie: who.cookie } });
}

export function post(
  path: string,
  who: SignedIn,
  fields: Record<string, string | string[]>,
  origin = new URL(BASE).origin,
): Request {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
  }
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie: who.cookie, origin, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

/** What a loader or action threw: a status for data() and Response throws. */
export async function thrownStatus(promise: Promise<unknown>): Promise<number> {
  const error = await promise.then(
    () => {
      throw new Error("expected a throw");
    },
    (e: unknown) => e,
  );
  if (error instanceof Response) return error.status;
  const init = (error as { init?: { status?: number } }).init;
  if (init?.status !== undefined) return init.status;
  throw error;
}
