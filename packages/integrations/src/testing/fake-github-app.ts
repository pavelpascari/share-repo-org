import { type Clock, type Instant, parseGitHubLogin, systemClock } from "@sharerepo/domain";
import { loginSegment, pathSegment, repositoryPath } from "../github/client.ts";
import { GitHubApiError, type GitHubApiErrorKind } from "../github/errors.ts";
import type {
  GitHubAccount,
  GitHubAppPort,
  GitHubCollaborator,
  GitHubInstallation,
  GitHubInvitation,
  GitHubPermission,
  GitHubRepository,
  GitHubUser,
} from "../github/port.ts";

/**
 * In-memory stand-in for the GitHub App, for application and web tests. Behaves like the real
 * client where callers depend on it (checked by the shared contract suite): unknown or deleted
 * installations are `not_found`, and a suspended installation's repositories are `suspended`.
 * `getUserByLogin` knows every user added with `addUser` and every User or Organization account
 * that installed the App; like GitHub, it matches logins case-insensitively.
 *
 * Each repository has direct collaborators and invitations. Its owner appears only in the `all`
 * list, as `admin`. A repository is found by its current `owner/name`, so after a rename or
 * removal its calls are `not_found` with target `repository`. Re-inviting someone with a pending,
 * unexpired invitation returns that invitation (assumed: GitHub's re-PUT is idempotent).
 * Removing a collaborator leaves invitations alone (decision 0010).
 */
export interface FakeInstallationInput {
  readonly id: string;
  readonly account: GitHubAccount;
  readonly repositories?: readonly GitHubRepository[];
  readonly suspendedAt?: Instant | null;
  readonly permissions?: Readonly<Record<string, string>>;
}

/** The port operations a test can fail or lose the response of. */
export type FakeGitHubOperation = Exclude<keyof GitHubAppPort, "installUrl">;

export interface FakeGitHubAppOptions {
  /** Sets invitations' `createdAt`. */
  readonly clock?: Clock;
}

export interface FakeRepositoryAccess {
  readonly collaborators: GitHubCollaborator[];
  readonly invitations: GitHubInvitation[];
}

export interface FakeGitHubApp extends GitHubAppPort {
  /** `operation:installationId` for every port call that passed input validation. */
  readonly calls: readonly string[];
  addInstallation(input: FakeInstallationInput): void;
  /** Makes a GitHub account resolvable by `getUserByLogin` and `getUserById`. */
  addUser(user: GitHubUser): void;
  setRepositories(installationId: string, repositories: readonly GitHubRepository[]): void;
  renameRepository(installationId: string, externalId: string, name: string): void;
  removeRepository(installationId: string, externalId: string): void;
  suspend(installationId: string, at: Instant): void;
  unsuspend(installationId: string): void;
  deleteInstallation(installationId: string): void;
  /** The next call (of any operation) fails with this kind. */
  failNext(kind: GitHubApiErrorKind): void;
  /** The next call of `operation` throws `error`, without doing anything. */
  failNext(operation: FakeGitHubOperation, error: GitHubApiError): void;
  /** The next call of `operation` does its work, then throws `transient` (a lost response). */
  loseNextResponse(operation: FakeGitHubOperation): void;
  /** The creator adds a collaborator on GitHub (`permission` defaults to `write`). */
  addCollaboratorByHand(
    repo: string,
    user: { readonly id: string; readonly login: string },
    permission?: GitHubPermission,
  ): void;
  /** The creator removes a direct collaborator on GitHub. */
  removeCollaboratorByHand(repo: string, userId: string): void;
  /** The invitee accepts their pending invitation and becomes a `write` collaborator. */
  acceptInvitation(repo: string, userId: string): void;
  /** GitHub marks the invitation `expired` (seven days after it was sent). */
  expireInvitation(repo: string, invitationId: string): void;
  /** The repository's direct collaborators and invitations, as copies. */
  repositoryAccess(repo: string): FakeRepositoryAccess;
}

interface Access {
  /** Direct collaborators, keyed by user ID. */
  collaborators: Map<string, GitHubCollaborator>;
  invitations: GitHubInvitation[];
}

interface State {
  installation: GitHubInstallation;
  repositories: GitHubRepository[];
  /** Keyed by the repository's immutable ID, so access survives a rename. */
  access: Map<string, Access>;
}

export const FAKE_INSTALL_BASE = "https://github.test/apps/sharerepo-fake/installations/new";

const notFound = (operation: string, target?: "repository" | "account") =>
  new GitHubApiError("not_found", `GitHub ${operation} failed with status 404`, {
    status: 404,
    ...(target === undefined ? {} : { target }),
  });

export function createFakeGitHubApp(options: FakeGitHubAppOptions = {}): FakeGitHubApp {
  const clock = options.clock ?? systemClock;
  const installations = new Map<string, State>();
  const users = new Map<string, GitHubUser>();
  const calls: string[] = [];
  let failure: GitHubApiErrorKind | undefined;
  const failures = new Map<FakeGitHubOperation, GitHubApiError>();
  const lostResponses = new Set<FakeGitHubOperation>();
  let nextInvitationId = 1;

  function begin(operation: FakeGitHubOperation, installationId: string): State {
    calls.push(`${operation}:${installationId}`);
    if (failure !== undefined) {
      const kind = failure;
      failure = undefined;
      throw new GitHubApiError(kind, `GitHub ${operation} failed (fake)`);
    }
    const injected = failures.get(operation);
    if (injected !== undefined) {
      failures.delete(operation);
      throw injected;
    }
    const state = installations.get(installationId);
    if (state === undefined) throw notFound(operation);
    return state;
  }

  /** As `begin`, for calls that need an installation token, which a suspension refuses. */
  function active(operation: FakeGitHubOperation, installationId: string): State {
    const state = begin(operation, installationId);
    if (state.installation.suspendedAt !== null) {
      throw new GitHubApiError(
        "suspended",
        "GitHub create installation token failed with status 403",
        { status: 403 },
      );
    }
    return state;
  }

  /** Returns the result, unless the test asked to lose this operation's response. */
  function settle<T>(operation: FakeGitHubOperation, result: T): T {
    if (lostResponses.delete(operation)) {
      throw new GitHubApiError("transient", `GitHub ${operation} failed: network error`);
    }
    return result;
  }

  function accessOf(state: State, externalId: string): Access {
    let access = state.access.get(externalId);
    if (access === undefined) {
      access = { collaborators: new Map(), invitations: [] };
      state.access.set(externalId, access);
    }
    return access;
  }

  /** The repository called `repo` in this installation, as the port sees it. */
  function repository(state: State, operation: FakeGitHubOperation, repo: string) {
    const found = state.repositories.find((candidate) => candidate.name === repo);
    if (found === undefined) throw notFound(operation, "repository");
    return { repository: found, access: accessOf(state, found.externalId) };
  }

  /** The repository called `repo` in any installation, for controls. */
  function controlled(repo: string) {
    for (const state of installations.values()) {
      const found = state.repositories.find((candidate) => candidate.name === repo);
      if (found !== undefined)
        return { repository: found, access: accessOf(state, found.externalId) };
    }
    throw new Error(`fake: unknown repository ${repo}`);
  }

  const userById = (id: string) => [...users.values()].find((user) => user.id === id);

  function existing(installationId: string): State {
    const state = installations.get(installationId);
    if (state === undefined) throw new Error(`fake: unknown installation ${installationId}`);
    return state;
  }

  function pendingInvitation(access: Access, userId: string) {
    return access.invitations.find(
      (invitation) => invitation.inviteeId === userId && !invitation.expired,
    );
  }

  return {
    calls,

    async getInstallation(installationId) {
      const state = begin("getInstallation", installationId);
      return settle("getInstallation", structuredClone(state.installation));
    },

    async listInstallationRepositories(installationId) {
      const operation = "listInstallationRepositories";
      return settle(operation, structuredClone(active(operation, installationId).repositories));
    },

    async getUserByLogin(installationId, login) {
      if (!parseGitHubLogin(login).ok) {
        throw new GitHubApiError("rejected", "GitHub request refused: invalid login");
      }
      active("getUserByLogin", installationId);
      const user = users.get(login.toLowerCase());
      if (user === undefined) throw notFound("get user");
      return settle("getUserByLogin", { ...user });
    },

    async getUserById(installationId, id) {
      pathSegment("id", id);
      active("getUserById", installationId);
      const user = userById(id);
      if (user === undefined) throw notFound("get user by id");
      return settle("getUserById", { ...user });
    },

    async listCollaborators(installationId, repo, affiliation) {
      repositoryPath(repo);
      const operation = "listCollaborators";
      const found = repository(active(operation, installationId), operation, repo);
      const direct = [...found.access.collaborators.values()];
      const owner = userById(found.repository.ownerExternalId);
      const all =
        affiliation === "all" && owner !== undefined && !found.access.collaborators.has(owner.id)
          ? [{ id: owner.id, login: owner.login, permission: "admin" as const }, ...direct]
          : direct;
      return settle(operation, structuredClone(all));
    },

    async listInvitations(installationId, repo) {
      repositoryPath(repo);
      const operation = "listInvitations";
      const found = repository(active(operation, installationId), operation, repo);
      return settle(operation, structuredClone(found.access.invitations));
    },

    async addCollaborator(installationId, repo, login) {
      repositoryPath(repo);
      loginSegment(login);
      const operation = "addCollaborator";
      const { access } = repository(active(operation, installationId), operation, repo);
      const user = users.get(login.toLowerCase());
      if (user === undefined) throw notFound("add collaborator", "account");
      if (access.collaborators.has(user.id)) {
        return settle(operation, { outcome: "already_collaborator" as const });
      }
      let invitation = pendingInvitation(access, user.id);
      if (invitation === undefined) {
        invitation = {
          id: String(nextInvitationId++),
          inviteeId: user.id,
          inviteeLogin: user.login,
          createdAt: clock.now(),
          expired: false,
        };
        access.invitations.push(invitation);
      }
      return settle(operation, {
        outcome: "invited" as const,
        invitationId: invitation.id,
        createdAt: invitation.createdAt,
      });
    },

    async removeCollaborator(installationId, repo, login) {
      repositoryPath(repo);
      loginSegment(login);
      const operation = "removeCollaborator";
      const { access } = repository(active(operation, installationId), operation, repo);
      const user = users.get(login.toLowerCase());
      const removed = user !== undefined && access.collaborators.delete(user.id);
      return settle(operation, removed ? ("removed" as const) : ("not_found" as const));
    },

    async cancelInvitation(installationId, repo, invitationId) {
      repositoryPath(repo);
      pathSegment("id", invitationId);
      const operation = "cancelInvitation";
      const { access } = repository(active(operation, installationId), operation, repo);
      const before = access.invitations.length;
      access.invitations = access.invitations.filter(
        (invitation) => invitation.id !== invitationId,
      );
      const cancelled = access.invitations.length < before;
      return settle(operation, cancelled ? ("cancelled" as const) : ("not_found" as const));
    },

    installUrl(state) {
      calls.push("installUrl");
      return `${FAKE_INSTALL_BASE}?state=${encodeURIComponent(state)}`;
    },

    addInstallation(input) {
      installations.set(input.id, {
        installation: {
          id: input.id,
          account: input.account,
          suspendedAt: input.suspendedAt ?? null,
          permissions: input.permissions ?? { administration: "write", metadata: "read" },
          repositorySelection: "selected",
        },
        repositories: [...(input.repositories ?? [])],
        access: new Map(),
      });
      const { account } = input;
      if (account.type !== "Enterprise") {
        users.set(account.login.toLowerCase(), {
          id: account.id,
          login: account.login,
          type: account.type,
        });
      }
    },

    addUser(user) {
      users.set(user.login.toLowerCase(), { ...user });
    },

    setRepositories(installationId, repositories) {
      existing(installationId).repositories = [...repositories];
    },

    renameRepository(installationId, externalId, name) {
      const state = existing(installationId);
      state.repositories = state.repositories.map((repo) =>
        repo.externalId === externalId ? { ...repo, name } : repo,
      );
    },

    removeRepository(installationId, externalId) {
      const state = existing(installationId);
      state.repositories = state.repositories.filter((repo) => repo.externalId !== externalId);
    },

    suspend(installationId, at) {
      const state = existing(installationId);
      state.installation = { ...state.installation, suspendedAt: at };
    },

    unsuspend(installationId) {
      const state = existing(installationId);
      state.installation = { ...state.installation, suspendedAt: null };
    },

    deleteInstallation(installationId) {
      existing(installationId);
      installations.delete(installationId);
    },

    failNext(first: GitHubApiErrorKind | FakeGitHubOperation, error?: GitHubApiError) {
      if (error === undefined) failure = first as GitHubApiErrorKind;
      else failures.set(first as FakeGitHubOperation, error);
    },

    loseNextResponse(operation) {
      lostResponses.add(operation);
    },

    addCollaboratorByHand(repo, user, permission = "write") {
      const { access } = controlled(repo);
      access.collaborators.set(user.id, { id: user.id, login: user.login, permission });
      if (!users.has(user.login.toLowerCase())) {
        users.set(user.login.toLowerCase(), { id: user.id, login: user.login, type: "User" });
      }
    },

    removeCollaboratorByHand(repo, userId) {
      if (!controlled(repo).access.collaborators.delete(userId)) {
        throw new Error(`fake: ${userId} is not a collaborator on ${repo}`);
      }
    },

    acceptInvitation(repo, userId) {
      const { access } = controlled(repo);
      const invitation = pendingInvitation(access, userId);
      if (invitation === undefined) {
        throw new Error(`fake: no pending invitation for ${userId} on ${repo}`);
      }
      access.invitations = access.invitations.filter((other) => other !== invitation);
      access.collaborators.set(userId, {
        id: userId,
        login: invitation.inviteeLogin,
        permission: "write",
      });
    },

    expireInvitation(repo, invitationId) {
      const { access } = controlled(repo);
      const index = access.invitations.findIndex((invitation) => invitation.id === invitationId);
      if (index === -1) throw new Error(`fake: unknown invitation ${invitationId} on ${repo}`);
      access.invitations[index] = {
        ...(access.invitations[index] as GitHubInvitation),
        expired: true,
      };
    },

    repositoryAccess(repo) {
      const { access } = controlled(repo);
      return structuredClone({
        collaborators: [...access.collaborators.values()],
        invitations: access.invitations,
      });
    },
  };
}
