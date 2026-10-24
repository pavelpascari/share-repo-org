import { env } from "cloudflare:workers";
import {
  completeGitHubConnection,
  createUserForSignIn,
  createWorkspace,
  ingestGitHubWebhook,
  recordSignIn,
  type ServiceContext,
  startGitHubConnection,
} from "@sharerepo/application";
import { createDb } from "@sharerepo/db";
import { type GitHubUserId, parseGitHubLogin, randomIds } from "@sharerepo/domain";
import { type FakeGitHubApp, signWebhook } from "@sharerepo/integrations/testing";
import { FakeClock } from "@sharerepo/testing";

/** A syntactically valid GitHub App configuration; the fake App never uses the key. */
export const GITHUB_APP = {
  GITHUB_APP_ID: "1000",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----",
};

/** What makes the local env a production one: production also requires an https origin. */
export const PRODUCTION = {
  ENVIRONMENT: "production",
  PUBLIC_BASE_URL: "https://REPLACE-WITH-PRODUCTION-HOST.invalid",
} as const;

/** The test Worker's env with a GitHub App configured. */
export const envWithGitHub = { ...env, ...GITHUB_APP } as Env;

export const db = createDb(env.DB);
export const clock = new FakeClock("2026-10-18T12:00:00Z");

let counter = Math.floor(Math.random() * 1e8);
const unique = () => String(++counter);

export function serviceContext(): ServiceContext {
  return { db, clock, ids: randomIds, correlationId: `corr-${crypto.randomUUID()}` };
}

/**
 * A creator who signed in, created a workspace, installed the fake App on their account with one
 * private repository, and connected it. Completing the connection left a resync in the outbox.
 */
export async function connectedCreator(github: FakeGitHubApp) {
  const githubId = unique() as GitHubUserId;
  const login = parseGitHubLogin(`octo-${githubId}`);
  if (!login.ok) throw new Error(login.error);
  const { userId } = await createUserForSignIn(serviceContext());
  await recordSignIn(
    serviceContext(),
    { userId },
    {
      provider: "github",
      externalUserId: githubId,
      username: login.value,
      displayName: null,
      avatarUrl: null,
    },
  );
  const workspace = await createWorkspace(
    serviceContext(),
    { userId },
    {
      name: "Creator",
      slug: `ws-${unique()}`,
    },
  );
  if (!workspace.ok) throw new Error("workspace setup failed");

  const installationId = unique();
  const repositoryId = unique();
  github.addInstallation({
    id: installationId,
    account: { id: githubId, login: login.value, type: "User" },
    repositories: [
      {
        externalId: repositoryId,
        name: `${login.value}/course`,
        ownerExternalId: githubId,
        ownerType: "User",
        private: true,
        archived: false,
      },
    ],
  });
  const started = await startGitHubConnection(
    serviceContext(),
    { userId },
    workspace.workspace.slug,
    { acknowledgeWriteAccess: true },
    github,
  );
  if (!started.ok) throw new Error("start failed");
  const state = new URL(started.installUrl).searchParams.get("state") ?? "";
  const completed = await completeGitHubConnection(
    serviceContext(),
    { userId },
    { state, installationId },
    github,
  );
  if (!completed.ok) throw new Error(completed.reason);
  return {
    userId,
    slug: workspace.workspace.slug,
    installationId,
    repositoryId,
    connection: { workspaceId: workspace.workspace.id, id: completed.connectionId },
  };
}

const SECRET = "jobs-test-webhook-secret";

/** Records a signed `installation_repositories` webhook; returns its event and outbox IDs. */
export async function receivedWebhook(installationId: string) {
  const raw = JSON.stringify({ action: "added", installation: { id: Number(installationId) } });
  const headers = new Headers({
    "x-github-delivery": crypto.randomUUID(),
    "x-github-event": "installation_repositories",
    "x-hub-signature-256": await signWebhook(SECRET, raw),
  });
  const result = await ingestGitHubWebhook(serviceContext(), {
    secret: SECRET,
    rawBody: new TextEncoder().encode(raw).buffer as ArrayBuffer,
    headers,
  });
  if (result.status !== "accepted") throw new Error("webhook setup failed");
  return { eventId: result.eventId, outboxId: await outboxIdFor(result.eventId) };
}

export async function outboxIdFor(subjectId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM outbox WHERE subject_id = ?")
    .bind(subjectId)
    .first<{ id: string }>();
  if (row === null) throw new Error("no outbox row");
  return row.id;
}

export async function count(sql: string, ...params: string[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...params)
    .first<{ n: number }>();
  return Number(row?.n);
}
