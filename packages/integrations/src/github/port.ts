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

/**
 * A collaborator's highest permission, from GitHub's `permissions` object: `admin` → `admin`,
 * `maintain` or `push` → `write`, `triage` or `pull` → `read`.
 */
export type GitHubPermission = "read" | "write" | "admin";

/** `direct`: added to the repository itself. `all`: also the owner and other indirect access. */
export type GitHubCollaboratorAffiliation = "direct" | "all";

export interface GitHubCollaborator {
  /** Immutable numeric user ID, as a decimal string. */
  readonly id: string;
  /** A snapshot only. */
  readonly login: string;
  readonly permission: GitHubPermission;
}

/** A pending (or lapsed) repository invitation to a GitHub account. */
export interface GitHubInvitation {
  /** Numeric invitation ID, as a decimal string. */
  readonly id: string;
  readonly inviteeId: string;
  readonly inviteeLogin: string;
  readonly createdAt: Instant;
  /** GitHub's `expired` flag; `false` when GitHub omits it (decision 0010). */
  readonly expired: boolean;
}

/** `PUT …/collaborators/{username}`: 201 created an invitation, 204 means already a collaborator. */
export type AddCollaboratorResult =
  | { readonly outcome: "invited"; readonly invitationId: string; readonly createdAt: Instant }
  | { readonly outcome: "already_collaborator" };

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
  /**
   * Resolves an immutable user ID (a positive decimal string, else `rejected` before any request)
   * to the account's current login. An unknown ID is `not_found`.
   */
  getUserById(installationId: string, id: string): Promise<GitHubUser>;

  // Collaborators and invitations (decision 0010). `repo` is the `owner/name` snapshot; it, the
  // login and the invitation ID are validated before any request (`rejected` if invalid). A
  // `not_found` carries `target: "repository"` when the repository itself is gone or renamed,
  // which needs a resync. Lists follow every page (100 each, at most 30); a longer list is
  // `malformed_response`, never truncated.

  listCollaborators(
    installationId: string,
    repo: string,
    affiliation: GitHubCollaboratorAffiliation,
  ): Promise<GitHubCollaborator[]>;
  /** Invitations to an email address (no invitee account) are skipped. */
  listInvitations(installationId: string, repo: string): Promise<GitHubInvitation[]>;
  /**
   * Invites `login` without a `permission` (decision 0010). Re-inviting someone with a pending
   * invitation returns that invitation. An unknown account is `not_found` with `target: "account"`.
   */
  addCollaborator(
    installationId: string,
    repo: string,
    login: string,
  ): Promise<AddCollaboratorResult>;
  /** `not_found`: the account is not a collaborator (already gone). */
  removeCollaborator(
    installationId: string,
    repo: string,
    login: string,
  ): Promise<"removed" | "not_found">;
  /** `not_found`: no such invitation (already accepted, declined or cancelled). */
  cancelInvitation(
    installationId: string,
    repo: string,
    invitationId: string,
  ): Promise<"cancelled" | "not_found">;
}
