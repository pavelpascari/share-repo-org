import { env } from "cloudflare:workers";
import { createDb, listAuditEventsByCorrelationId } from "@sharerepo/db";
import { randomIds, systemClock } from "@sharerepo/domain";
import { createLogger } from "@sharerepo/platform";
import { createSecretCanaries } from "@sharerepo/testing";
import { createAuth } from "../../app/auth/auth.ts";
import { parseWebEnv } from "../../workers/env.ts";
import { createFakeGitHub, type FakeGitHubAccount } from "./fake-github.ts";

// Drives Better Auth's real sign-in and OAuth callback endpoints in workerd, against local D1 and
// an in-process fake GitHub. Each step is a separate request with its own auth instance.

export const db = createDb(env.DB);
export const config = parseWebEnv(env).auth;
export const BASE = config.baseURL;
export const canaries = createSecretCanaries(["githubAccessToken"]);
export const github = createFakeGitHub(canaries.githubAccessToken);

export function authForRequest(correlationId = `corr-${crypto.randomUUID()}`) {
  const lines: string[] = [];
  const record = (line: string) => {
    lines.push(line);
  };
  const logger = createLogger(
    { correlationId },
    { sink: { debug: record, info: record, warn: record, error: record } },
  );
  const auth = createAuth({
    config,
    github: github.client,
    services: { db, clock: systemClock, ids: randomIds, correlationId },
    logger,
  });
  return { auth, correlationId, lines };
}

export const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

/** Starts sign-in as our sign-in action does and returns GitHub's authorize URL and the cookies. */
export async function startSignIn() {
  const { auth } = authForRequest();
  const response = await auth.api.signInSocial({
    body: { provider: "github", callbackURL: "/", errorCallbackURL: "/?error=sign_in_failed" },
    headers: new Headers({ origin: BASE }),
    asResponse: true,
  });
  const { url } = (await response.json()) as { url: string };
  return { authorize: new URL(url), cookie: cookiesOf(response) };
}

export async function callback(query: string, cookie: string) {
  const request = authForRequest();
  const response = await request.auth.handler(
    new Request(`${BASE}/api/auth/callback/github?${query}`, { headers: { cookie } }),
  );
  return { ...request, response, cookie: cookiesOf(response) };
}

export async function signIn(account: FakeGitHubAccount) {
  const started = await startSignIn();
  const state = started.authorize.searchParams.get("state") ?? "";
  const code = github.authorize(account);
  return callback(`code=${code}&state=${state}`, started.cookie);
}

export async function sessionUser(cookie: string) {
  const { auth } = authForRequest();
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  return session?.user ?? null;
}

export const actions = async (correlationId: string) =>
  (await listAuditEventsByCorrelationId(db, correlationId)).map((event) => event.action);
