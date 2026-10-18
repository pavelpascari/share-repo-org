import type { Instant } from "@sharerepo/domain";

/** `Enterprise` accounts have no `type` in GitHub's payloads; ShareRepo refuses them (0008). */
export type GitHubAccountType = "User" | "Organization" | "Enterprise";

export interface GitHubAccount {
  /** Immutable numeric ID, as a decimal string. */
  readonly id: string;
  /** Mutable; a snapshot only. */
  readonly login: string;
  readonly type: GitHubAccountType;
}

export interface GitHubInstallation {
  readonly id: string;
  readonly account: GitHubAccount;
  readonly suspendedAt: Instant | null;
  readonly permissions: Readonly<Record<string, string>>;
  readonly repositorySelection: "all" | "selected";
}

export interface GitHubRepository {
  /** Immutable numeric repository ID, as a decimal string. */
  readonly externalId: string;
  /** `owner/name`; a snapshot that changes on rename or transfer. */
  readonly name: string;
  readonly ownerExternalId: string;
  readonly ownerType: GitHubAccountType;
  readonly private: boolean;
  readonly archived: boolean;
}

/** The `type` of a GitHub user account (`GET /users/{login}`). */
export type GitHubUserType = "User" | "Organization" | "Bot";

export interface GitHubUser {
  /** Immutable numeric user ID, as a decimal string. */
  readonly id: string;
  /** GitHub's canonical spelling of the login; a snapshot only. */
  readonly login: string;
  readonly type: GitHubUserType;
}

/** What application services need from the GitHub App. The fake implements the same port. */
export interface GitHubAppPort {
  getInstallation(installationId: string): Promise<GitHubInstallation>;
  listInstallationRepositories(installationId: string): Promise<GitHubRepository[]>;
  /** Where to send a user to install the App; GitHub returns `state` to the setup URL. */
  installUrl(state: string): string;
  /**
   * Resolves a login to the account's immutable ID, using the installation's token. The login is
   * checked with the domain's `parseGitHubLogin` before any request (`rejected` if invalid); an
   * unknown login is a `not_found` `GitHubApiError`.
   */
  getUserByLogin(installationId: string, login: string): Promise<GitHubUser>;
}
