import * as repo from "@sharerepo/db";
import { parseGitHubLogin } from "@sharerepo/domain";
import { GitHubApiError, type GitHubAppPort } from "@sharerepo/integrations";
import type { ServiceContext } from "./context.ts";

/**
 * Why an owner's GitHub login could not be resolved: `login_invalid`, `connection_missing` (no
 * active GitHub connection to ask through), `login_not_found`, or `account_not_user` (an
 * organization or bot).
 */
export type GitHubAccountError =
  | "login_invalid"
  | "connection_missing"
  | "login_not_found"
  | "account_not_user";

/** A GitHub user account, by its immutable ID and its current login. */
export interface GitHubAccount {
  readonly id: string;
  readonly login: string;
}

/**
 * Resolves a GitHub login an owner typed to the account's immutable ID, through the workspace's
 * active GitHub connection (the adapter boundary), as a manual link (decision 0012, path 3) and
 * manual access (decision 0016) need. The login is a snapshot; the ID is what ShareRepo stores.
 * GitHub failures other than "not found" propagate.
 */
export async function resolveGitHubAccount(
  ctx: ServiceContext,
  workspaceId: string,
  githubLogin: string,
  github: GitHubAppPort,
): Promise<
  | { readonly ok: true; readonly account: GitHubAccount }
  | { readonly ok: false; readonly error: GitHubAccountError }
> {
  const login = parseGitHubLogin(githubLogin.trim());
  if (!login.ok) return { ok: false, error: "login_invalid" };
  const connection = (await repo.listConnectionsForWorkspace(ctx.db, workspaceId)).find(
    (candidate) => candidate.status === "active",
  );
  if (connection === undefined) return { ok: false, error: "connection_missing" };
  let user: Awaited<ReturnType<GitHubAppPort["getUserByLogin"]>>;
  try {
    user = await github.getUserByLogin(connection.installationId, login.value);
  } catch (error) {
    if (error instanceof GitHubApiError && error.kind === "not_found") {
      return { ok: false, error: "login_not_found" };
    }
    throw error;
  }
  if (user.type !== "User") return { ok: false, error: "account_not_user" };
  return { ok: true, account: { id: user.id, login: user.login } };
}
