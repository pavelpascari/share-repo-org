// Live GitHub feasibility spike (Phase 2 T6). Run by a human against their own development
// GitHub App, a private test repository on their personal account, and a second "subscriber"
// account; see docs/runbooks/github-app-setup.md § 6. Never runs in CI.
//
// Safety: without --yes it only reads. With --yes it invites the subscriber, observes, and removes
// every invitation and collaborator it touched, cleaning up first so re-runs are safe. It never
// prints the private key, the App JWT or installation tokens.
//
//   SPIKE_REPO=<owner>/<repo> SPIKE_SUBSCRIBER=<login> pnpm spike:github [--yes]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { systemClock } from "../../packages/domain/src/index.ts";
import { pathSegment } from "../../packages/integrations/src/github/client.ts";
import {
  createGitHubApp,
  GitHubApiError,
  type GitHubAppClient,
  type GitHubInvitation,
  parseGitHubAppConfig,
} from "../../packages/integrations/src/index.ts";
import { parseDotenv } from "./dotenv.ts";
import { parseRepoArgument, preflightProblems } from "./preflight.ts";
import { type Conclusion, extractChecklist, renderReport, type StepResult } from "./report.ts";

const ROOT = new URL("../../", import.meta.url);
const DEV_VARS = new URL("apps/web/.dev.vars", ROOT);
const RESULTS = new URL("docs/research/github-live-results.md", ROOT);
const USAGE =
  "Usage: SPIKE_REPO=<owner>/<repo> SPIKE_SUBSCRIBER=<login> pnpm spike:github [--yes]\n" +
  "Reads the GitHub App config from apps/web/.dev.vars (or GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY in the environment).\n" +
  "Without --yes it only reads. See docs/runbooks/github-app-setup.md § 6.";

class UsageError extends Error {}

/** Error description safe to print and record: a classification, never a message body. */
function describe(error: unknown): string {
  if (error instanceof GitHubApiError) {
    const codes =
      error.githubErrorCodes.length > 0 ? ` (${error.githubErrorCodes.join(", ")})` : "";
    return `${error.kind}${error.status === undefined ? "" : ` ${error.status}`}${codes}`;
  }
  if (error instanceof UsageError) return error.message;
  // Configuration errors name keys and issue codes only (packages/platform parseEnv).
  if (error instanceof Error && error.name === "ConfigurationError") {
    return `${error.message}\nSet them in apps/web/.dev.vars (docs/runbooks/github-app-setup.md § 5).`;
  }
  return error instanceof Error ? error.name : "unknown error";
}

function loadConfig() {
  const file = existsSync(DEV_VARS) ? parseDotenv(readFileSync(DEV_VARS, "utf8")) : {};
  const pick = (key: string) => process.env[key] ?? file[key];
  // Production rules: real GitHub only (endpoint overrides are refused outside e2e).
  return parseGitHubAppConfig(
    {
      ENVIRONMENT: "production",
      GITHUB_APP_ID: pick("GITHUB_APP_ID"),
      GITHUB_APP_PRIVATE_KEY: pick("GITHUB_APP_PRIVATE_KEY"),
    },
    { requireWebhookSecret: false, requireSlug: false },
  );
}

async function githubGet(
  apiBaseUrl: string,
  path: string,
  bearer: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${bearer}`,
      "user-agent": "ShareRepo",
      "x-github-api-version": "2022-11-28",
    },
  });
  const body: unknown = response.headers.get("content-type")?.includes("json")
    ? await response.json()
    : null;
  return { status: response.status, body };
}

const field = (body: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined,
    body,
  );

interface Context {
  readonly app: GitHubAppClient;
  readonly installationId: string;
  readonly owner: string;
  readonly repo: string;
  readonly subscriber: string;
  readonly steps: StepResult[];
}

const isSubscriber = (ctx: Context, login: string | undefined) =>
  login?.toLowerCase() === ctx.subscriber.toLowerCase();

async function subscriberInvitations(ctx: Context): Promise<GitHubInvitation[]> {
  const invitations = await ctx.app.listInvitations(ctx.installationId, ctx.owner, ctx.repo);
  return invitations.filter((invitation) => isSubscriber(ctx, invitation.invitee?.login));
}

async function subscriberIsCollaborator(ctx: Context): Promise<boolean> {
  const collaborators = await ctx.app.listCollaborators(ctx.installationId, ctx.owner, ctx.repo);
  return collaborators.some((collaborator) => isSubscriber(ctx, collaborator.login));
}

/** Runs one operation and records it; a failure is recorded and the spike continues. */
async function step<T>(
  ctx: Context,
  name: string,
  operation: string,
  run: () => Promise<T>,
  observe: (value: T) => Omit<StepResult, "step" | "operation">,
): Promise<T | undefined> {
  try {
    const value = await run();
    ctx.steps.push({ step: name, operation, ...observe(value) });
    return value;
  } catch (error) {
    ctx.steps.push({
      step: name,
      operation,
      status:
        error instanceof GitHubApiError && error.status !== undefined
          ? String(error.status)
          : "error",
      observed: { error: describe(error) },
      interpretation: "Request failed; see the observed error classification.",
    });
    return undefined;
  }
}

const invitationFacts = (invitations: GitHubInvitation[]) =>
  invitations.map((invitation) => ({
    id: invitation.id,
    permissions: invitation.permissions,
    expired: invitation.expired,
  }));

async function observeState(ctx: Context, name: string, interpretation: string) {
  return step(
    ctx,
    name,
    "GET …/invitations + GET …/collaborators?affiliation=direct",
    async () => ({
      invitations: await subscriberInvitations(ctx),
      collaborator: await subscriberIsCollaborator(ctx),
    }),
    (state) => ({
      status: "200",
      observed: {
        pendingInvitations: invitationFacts(state.invitations),
        subscriberIsCollaborator: state.collaborator,
      },
      interpretation,
    }),
  );
}

async function cleanUp(ctx: Context, name: string) {
  const state = await observeState(ctx, `${name}: state`, "What exists for the subscriber now.");
  for (const invitation of state?.invitations ?? []) {
    await step(
      ctx,
      `${name}: cancel invitation`,
      "DELETE /repos/{owner}/{repo}/invitations/{id}",
      () => ctx.app.deleteInvitation(ctx.installationId, ctx.owner, ctx.repo, invitation.id),
      (status) => ({
        status: String(status),
        observed: { invitationId: invitation.id },
        interpretation: "Cancelled a pending invitation.",
      }),
    );
  }
  if (state?.collaborator) {
    await step(
      ctx,
      `${name}: remove collaborator`,
      "DELETE /repos/{owner}/{repo}/collaborators/{username}",
      () => ctx.app.removeCollaborator(ctx.installationId, ctx.owner, ctx.repo, ctx.subscriber),
      (status) => ({
        status: String(status),
        observed: {},
        interpretation: "Removed the subscriber's access.",
      }),
    );
  }
}

async function invite(ctx: Context, name: string, permission: string | undefined) {
  return step(
    ctx,
    name,
    `PUT /repos/{owner}/{repo}/collaborators/{username}${permission === undefined ? " (no permission)" : ` {"permission":"${permission}"}`}`,
    () =>
      ctx.app.addCollaborator(ctx.installationId, ctx.owner, ctx.repo, ctx.subscriber, permission),
    (result) => ({
      status: String(result.status),
      observed: { invitationId: result.invitationId ?? null },
      interpretation:
        result.status === 201
          ? "201: an invitation was created; access is pending until accepted."
          : "204: the subscriber already had access (or the permission changed).",
    }),
  );
}

async function runLive(ctx: Context): Promise<Conclusion[]> {
  // 2. Start from a clean slate, so a re-run after an interrupted run is safe.
  await cleanUp(ctx, "2 clean-up");

  // 3. Invite asking for read access.
  const pull = await invite(ctx, "3 invite with permission=pull", "pull");
  const afterPull = await observeState(
    ctx,
    "3 state after invite",
    "Which permission GitHub recorded for a personal repository, and whether a pending invitee is listed as a collaborator.",
  );

  // 4. Remove as collaborator while the invitation is pending.
  await step(
    ctx,
    "4 remove pending invitee as collaborator",
    "DELETE /repos/{owner}/{repo}/collaborators/{username}",
    () => ctx.app.removeCollaborator(ctx.installationId, ctx.owner, ctx.repo, ctx.subscriber),
    (status) => ({
      status: String(status),
      observed: {},
      interpretation: "Status of a collaborator DELETE for someone with only a pending invitation.",
    }),
  );
  const afterDelete = await observeState(
    ctx,
    "4 state after collaborator DELETE",
    "If the invitation is still listed, collaborator DELETE does not cancel pending invitations.",
  );

  // 5. Cancel what is left.
  for (const invitation of afterDelete?.invitations ?? []) {
    await step(
      ctx,
      "5 cancel invitation",
      "DELETE /repos/{owner}/{repo}/invitations/{id}",
      () => ctx.app.deleteInvitation(ctx.installationId, ctx.owner, ctx.repo, invitation.id),
      (status) => ({
        status: String(status),
        observed: { invitationId: invitation.id },
        interpretation: "Invitation DELETE cancels a pending invitation.",
      }),
    );
  }
  await observeState(ctx, "5 state after cancelling", "Expected: nothing pending.");

  // 6. Invite without a permission parameter, then cancel.
  await invite(ctx, "6 invite without permission", undefined);
  const afterDefault = await observeState(
    ctx,
    "6 state after default invite",
    "The permission GitHub records when none is requested.",
  );
  for (const invitation of afterDefault?.invitations ?? []) {
    await step(
      ctx,
      "6 cancel invitation",
      "DELETE /repos/{owner}/{repo}/invitations/{id}",
      () => ctx.app.deleteInvitation(ctx.installationId, ctx.owner, ctx.repo, invitation.id),
      (status) => ({
        status: String(status),
        observed: { invitationId: invitation.id },
        interpretation: "Clean-up.",
      }),
    );
  }

  // 7. Final state: the repository is as we found it.
  await cleanUp(ctx, "7 final");
  const final = await observeState(
    ctx,
    "7 final state",
    "Expected: no invitation and no collaborator access.",
  );

  const pullPermission = afterPull?.invitations[0]?.permissions;
  const defaultPermission = afterDefault?.invitations[0]?.permissions;
  return [
    {
      question: "Does `permission=pull` give read-only access on a personal repository?",
      answer:
        pull === undefined
          ? "Unknown: the invite request failed (see step 3)."
          : `The invitation was recorded with permission \`${pullPermission ?? "unknown"}\` (without a permission: \`${defaultPermission ?? "unknown"}\`). ${pullPermission === "read" ? "GitHub honoured read: revisit decision 0008." : "GitHub ignored the request: collaborators get write access, as decision 0008 assumes."}`,
    },
    {
      question: "Does a collaborator DELETE cancel a pending invitation?",
      answer:
        afterDelete === undefined
          ? "Unknown: the state check failed (see step 4)."
          : afterDelete.invitations.length > 0
            ? "No. The invitation survived: revocation must also DELETE the invitation (Phase 4)."
            : "Yes. The invitation was gone after the collaborator DELETE.",
    },
    {
      question: "Is the `expired` field present on invitations?",
      answer:
        afterPull?.invitations[0] === undefined
          ? "Unknown: no invitation was observed."
          : `Yes; a fresh invitation reports \`expired: ${String(afterPull.invitations[0].expired)}\`. Behaviour after 7 days still needs observing.`,
    },
    {
      question: "Is a pending invitee listed as a collaborator before accepting?",
      answer:
        afterPull === undefined
          ? "Unknown: the state check failed (see step 3)."
          : afterPull.collaborator
            ? "Yes: listing collaborators is not enough to tell pending from active."
            : "No: a grant is active only once the subscriber appears in the collaborators list.",
    },
    {
      question: "Was the repository left clean?",
      answer:
        final === undefined
          ? "Unknown: the final state check failed. Re-run the spike to clean up."
          : final.invitations.length === 0 && !final.collaborator
            ? "Yes."
            : "No: re-run the spike, or remove the subscriber by hand.",
    },
  ];
}

async function main(argv: readonly string[]): Promise<number> {
  const live = argv.includes("--yes");
  const target = parseRepoArgument(process.env.SPIKE_REPO);
  const subscriber = process.env.SPIKE_SUBSCRIBER ?? "";
  if (target === null || subscriber === "") throw new UsageError(USAGE);
  try {
    pathSegment("login", target.owner);
    pathSegment("repo", target.repo);
    pathSegment("login", subscriber);
  } catch {
    throw new UsageError(`SPIKE_REPO or SPIKE_SUBSCRIBER is not a valid GitHub name.\n${USAGE}`);
  }

  const config = loadConfig();
  if (config === null) throw new UsageError(`GITHUB_APP_ID is not set.\n${USAGE}`);
  const app = createGitHubApp({
    appId: config.appId,
    privateKeyPem: config.privateKeyPem,
    apiBaseUrl: config.apiBaseUrl,
    fetch: globalThis.fetch.bind(globalThis),
    clock: systemClock,
  });

  const repoPath = `/repos/${target.owner}/${target.repo}`;
  const located = await githubGet(
    config.apiBaseUrl,
    `${repoPath}/installation`,
    await app.appJwt(),
  );
  if (located.status === 401) {
    throw new UsageError(
      "GitHub rejected the App's credentials (401). Check GITHUB_APP_ID and that the private key belongs to this App.",
    );
  }
  if (located.status !== 200) {
    throw new UsageError(
      `The App is not installed on ${target.owner}/${target.repo} (GitHub answered ${located.status}). Install it on that repository first.`,
    );
  }
  const installationId = String(field(located.body, "id"));
  const installation = await app.getInstallation(installationId);
  const repository = await githubGet(
    config.apiBaseUrl,
    repoPath,
    await app.installationToken(installationId),
  );

  const ctx: Context = { app, installationId, ...target, subscriber, steps: [] };
  ctx.steps.push({
    step: "1 installation",
    operation:
      "GET /repos/{owner}/{repo}/installation, GET /app/installations/{id}, GET /repos/{owner}/{repo}",
    status: `${located.status}, 200, ${repository.status}`,
    observed: {
      accountType: installation.account.type,
      permissions: installation.permissions,
      repositorySelection: installation.repositorySelection,
      suspended: installation.suspendedAt !== null,
      repositoryPrivate: field(repository.body, "private"),
      repositoryOwnerType: field(repository.body, "owner", "type"),
    },
    interpretation: "The permissions the installation actually holds.",
  });

  const problems = preflightProblems({
    owner: target.owner,
    subscriber,
    repoPrivate: field(repository.body, "private") === true,
    repoOwnerType: String(field(repository.body, "owner", "type")),
    installationAccountLogin: installation.account.login,
    installationAccountType: installation.account.type,
    installationSuspended: installation.suspendedAt !== null,
  });
  if (problems.length > 0) {
    console.error(`Refusing to run:\n- ${problems.join("\n- ")}`);
    return 2;
  }

  console.log(
    [
      `Repository: ${target.owner}/${target.repo} (installation ${installationId}, App ${config.appId})`,
      `Subscriber: ${subscriber}`,
      "Plan: clean up, invite with permission=pull, observe, remove while pending, observe,",
      "      cancel, invite without permission, observe, cancel, verify clean.",
      "The subscriber receives two invitation emails; both invitations are cancelled.",
      "Two of the repository's 50 invitations per 24 hours are used.",
    ].join("\n"),
  );

  if (!live) {
    const state = await observeState(ctx, "dry run", "Current state for the subscriber.");
    console.log(
      `Dry run (read only). Current state: ${JSON.stringify(ctx.steps.at(-1)?.observed ?? {})}`,
    );
    console.log(
      state === undefined
        ? "Reading the current state failed."
        : "Re-run with --yes to perform the plan.",
    );
    return state === undefined ? 1 : 0;
  }

  const conclusions = await runLive(ctx);
  const existing = existsSync(RESULTS) ? extractChecklist(readFileSync(RESULTS, "utf8")) : null;
  writeFileSync(
    RESULTS,
    renderReport({
      date: new Date().toISOString(),
      appId: config.appId,
      repository: `${target.owner}/${target.repo}`,
      subscriber,
      steps: ctx.steps,
      conclusions,
      existingChecklist: existing,
    }),
  );
  for (const conclusion of conclusions)
    console.log(`- ${conclusion.question} ${conclusion.answer}`);
  console.log("Wrote docs/research/github-live-results.md. Complete its manual checklist next.");
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(describe(error));
    process.exitCode = 1;
  },
);
