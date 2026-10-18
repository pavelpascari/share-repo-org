import { type GitHubLogin, type GitHubUserId, parseGitHubLogin } from "@sharerepo/domain";
import { GitHubAuthError, type GitHubClient, type GitHubUser } from "../../app/auth/github.ts";

/** One GitHub account the fake knows about. Its login can be changed to simulate a rename. */
export interface FakeGitHubAccount {
  id: GitHubUserId;
  login: GitHubLogin;
  name: string | null;
  avatarUrl: string | null;
}

let nextId = Math.floor(Math.random() * 1e8);

export function fakeAccount(overrides: Partial<FakeGitHubAccount> = {}): FakeGitHubAccount {
  nextId += 1;
  const login = parseGitHubLogin(`octo-${nextId}`);
  if (!login.ok) throw new Error(login.error);
  return {
    id: String(nextId) as GitHubUserId,
    login: login.value,
    name: "Mona Lisa",
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
    ...overrides,
  };
}

/**
 * In-process stand-in for GitHub's OAuth endpoints. `authorize(account)` returns the code GitHub
 * would put on the callback; the access token it is exchanged for is the given canary, so tests
 * can prove the token is never stored or logged.
 */
export function createFakeGitHub(accessTokenCanary: string) {
  const codes = new Map<string, FakeGitHubAccount>();
  const calls: string[] = [];
  const client: GitHubClient = {
    endpoints: {
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      apiBaseUrl: "https://api.github.com",
    },
    clientId: "test-client",
    async exchangeCode({ code, codeVerifier }) {
      calls.push(`token${codeVerifier ? "+pkce" : ""}`);
      const account = codes.get(code);
      codes.delete(code);
      if (account === undefined) {
        throw new GitHubAuthError("bad_verification_code", "GitHub token exchange failed");
      }
      return { accessToken: `${accessTokenCanary}:${account.id}` };
    },
    async getUser(accessToken): Promise<GitHubUser> {
      calls.push("user");
      const id = accessToken.split(":")[1];
      const account = [...accounts].find((candidate) => candidate.id === id);
      if (account === undefined) throw new GitHubAuthError("rejected", "GitHub user lookup failed");
      return {
        id: account.id,
        login: account.login,
        name: account.name,
        avatarUrl: account.avatarUrl,
      };
    },
  };
  const accounts = new Set<FakeGitHubAccount>();
  return {
    client,
    calls,
    authorize(account: FakeGitHubAccount): string {
      accounts.add(account);
      const code = `code-${crypto.randomUUID()}`;
      codes.set(code, account);
      return code;
    },
  };
}
