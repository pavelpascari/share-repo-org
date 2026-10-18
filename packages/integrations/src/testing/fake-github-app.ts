import type { Instant } from "@sharerepo/domain";
import { GitHubApiError, type GitHubApiErrorKind } from "../github/errors.ts";
import type {
  GitHubAccount,
  GitHubAppPort,
  GitHubInstallation,
  GitHubRepository,
} from "../github/port.ts";

/**
 * In-memory stand-in for the GitHub App, for application and web tests. Behaves like the real
 * client where callers depend on it (checked by the shared contract suite): unknown or deleted
 * installations are `not_found`, and a suspended installation's repositories are `suspended`.
 */
export interface FakeInstallationInput {
  readonly id: string;
  readonly account: GitHubAccount;
  readonly repositories?: readonly GitHubRepository[];
  readonly suspendedAt?: Instant | null;
  readonly permissions?: Readonly<Record<string, string>>;
}

export interface FakeGitHubApp extends GitHubAppPort {
  readonly calls: readonly string[];
  addInstallation(input: FakeInstallationInput): void;
  setRepositories(installationId: string, repositories: readonly GitHubRepository[]): void;
  renameRepository(installationId: string, externalId: string, name: string): void;
  removeRepository(installationId: string, externalId: string): void;
  suspend(installationId: string, at: Instant): void;
  unsuspend(installationId: string): void;
  deleteInstallation(installationId: string): void;
  /** The next call (of any operation) fails with this kind. */
  failNext(kind: GitHubApiErrorKind): void;
}

interface State {
  installation: GitHubInstallation;
  repositories: GitHubRepository[];
}

export const FAKE_INSTALL_BASE = "https://github.test/apps/sharerepo-fake/installations/new";

export function createFakeGitHubApp(): FakeGitHubApp {
  const installations = new Map<string, State>();
  const calls: string[] = [];
  let failure: GitHubApiErrorKind | undefined;

  function begin(operation: string, installationId: string): State {
    calls.push(`${operation}:${installationId}`);
    if (failure !== undefined) {
      const kind = failure;
      failure = undefined;
      throw new GitHubApiError(kind, `GitHub ${operation} failed (fake)`);
    }
    const state = installations.get(installationId);
    if (state === undefined) {
      throw new GitHubApiError("not_found", `GitHub ${operation} failed with status 404`, {
        status: 404,
      });
    }
    return state;
  }

  function existing(installationId: string): State {
    const state = installations.get(installationId);
    if (state === undefined) throw new Error(`fake: unknown installation ${installationId}`);
    return state;
  }

  return {
    calls,

    async getInstallation(installationId) {
      return structuredClone(begin("getInstallation", installationId).installation);
    },

    async listInstallationRepositories(installationId) {
      const state = begin("listInstallationRepositories", installationId);
      if (state.installation.suspendedAt !== null) {
        throw new GitHubApiError(
          "suspended",
          "GitHub create installation token failed with status 403",
          { status: 403 },
        );
      }
      return structuredClone(state.repositories);
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
      });
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

    failNext(kind) {
      failure = kind;
    },
  };
}
