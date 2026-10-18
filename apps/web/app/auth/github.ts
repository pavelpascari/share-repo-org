import {
  type GitHubLogin,
  type GitHubUserId,
  parseGitHubLogin,
  parseGitHubUserId,
} from "@sharerepo/domain";
import { z } from "zod";

// GitHub sign-in done by our own code (decision 0006): Better Auth's genericOAuth plugin calls
// `exchangeCode` and `getUser`, so every GitHub URL is injectable. Production always uses
// GITHUB_ENDPOINTS; only the E2E environment points the same code at a local fake.

export interface GitHubEndpoints {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly apiBaseUrl: string;
}

export const GITHUB_ENDPOINTS: GitHubEndpoints = Object.freeze({
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  apiBaseUrl: "https://api.github.com",
});

export type GitHubAuthErrorKind =
  /** The authorization code is invalid, expired, or already used. */
  | "bad_verification_code"
  /** GitHub could not be reached, answered 5xx, or asked us to slow down. Retryable. */
  | "upstream_unavailable"
  /** GitHub answered with a body we do not understand. */
  | "malformed_response"
  /** GitHub refused the request (other 4xx or OAuth errors, e.g. bad client credentials). */
  | "rejected";

/**
 * A classified GitHub sign-in failure. The message is fixed per call site and never includes
 * the code, client secret, access token, or response body; no `cause` is attached because
 * fetch and JSON errors can echo request or response content.
 */
export class GitHubAuthError extends Error {
  readonly kind: GitHubAuthErrorKind;

  constructor(kind: GitHubAuthErrorKind, message: string) {
    super(message);
    this.name = "GitHubAuthError";
    this.kind = kind;
  }
}

export interface GitHubUser {
  /** GitHub's immutable numeric user ID, as a decimal string. */
  readonly id: GitHubUserId;
  /** Mutable; a snapshot only. */
  readonly login: GitHubLogin;
  readonly name: string | null;
  readonly avatarUrl: string | null;
}

export interface GitHubClient {
  readonly endpoints: GitHubEndpoints;
  readonly clientId: string;
  exchangeCode(input: {
    code: string;
    redirectURI: string;
    codeVerifier?: string | undefined;
  }): Promise<{ accessToken: string }>;
  getUser(accessToken: string): Promise<GitHubUser>;
}

const USER_AGENT = "ShareRepo";
const API_VERSION = "2022-11-28";

// The token endpoint answers 200 with `{ error }` for OAuth failures.
const tokenErrorResponse = z.object({ error: z.string().min(1) });
const tokenResponse = z.object({ access_token: z.string().min(1) });

const userResponse = z.object({
  id: z.number().transform((id, ctx) => parsedOrIssue(parseGitHubUserId(id), ctx)),
  login: z.string().transform((login, ctx) => parsedOrIssue(parseGitHubLogin(login), ctx)),
  name: z.string().nullish(),
  avatar_url: z.url().nullish(),
});

function parsedOrIssue<T>(
  result: { ok: true; value: T } | { ok: false; error: string },
  ctx: z.RefinementCtx,
): T {
  if (result.ok) return result.value;
  ctx.addIssue({ code: "custom", message: result.error });
  return z.NEVER;
}

export function createGitHubClient(options: {
  endpoints: GitHubEndpoints;
  clientId: string;
  clientSecret: string;
  fetch: typeof fetch;
}): GitHubClient {
  const { endpoints, clientId, clientSecret } = options;

  return {
    endpoints,
    clientId,

    async exchangeCode({ code, redirectURI, codeVerifier }) {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectURI,
      });
      if (codeVerifier !== undefined) body.set("code_verifier", codeVerifier);
      const response = await send(options.fetch, "token exchange", endpoints.tokenUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": USER_AGENT,
        },
        body,
      });
      const json = await readJson(response, "token exchange");

      const oauthError = tokenErrorResponse.safeParse(json);
      if (oauthError.success) {
        throw oauthError.data.error === "bad_verification_code"
          ? new GitHubAuthError("bad_verification_code", "GitHub rejected the authorization code")
          : new GitHubAuthError("rejected", "GitHub rejected the token exchange");
      }
      const token = tokenResponse.safeParse(json);
      if (!token.success) {
        throw new GitHubAuthError("malformed_response", "GitHub token response is malformed");
      }
      return { accessToken: token.data.access_token };
    },

    async getUser(accessToken) {
      const response = await send(options.fetch, "user lookup", `${endpoints.apiBaseUrl}/user`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": USER_AGENT,
          "x-github-api-version": API_VERSION,
        },
      });
      const user = userResponse.safeParse(await readJson(response, "user lookup"));
      if (!user.success) {
        throw new GitHubAuthError("malformed_response", "GitHub user response is malformed");
      }
      return {
        id: user.data.id,
        login: user.data.login,
        name: user.data.name || null,
        avatarUrl: user.data.avatar_url ?? null,
      };
    },
  };
}

/** Sends the request and classifies transport and status failures. Returns only 2xx responses. */
async function send(
  fetchFn: typeof fetch,
  operation: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchFn(url, init);
  } catch {
    throw new GitHubAuthError("upstream_unavailable", `GitHub ${operation} failed to connect`);
  }
  if (response.ok) return response;
  // Drain the body so the connection can be reused; its content is never read into errors.
  await response.body?.cancel();
  if (response.status >= 500 || response.status === 429) {
    throw new GitHubAuthError(
      "upstream_unavailable",
      `GitHub ${operation} returned ${response.status}`,
    );
  }
  throw new GitHubAuthError("rejected", `GitHub ${operation} returned ${response.status}`);
}

async function readJson(response: Response, operation: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // JSON syntax errors quote the body, which may hold a token.
    throw new GitHubAuthError("malformed_response", `GitHub ${operation} returned invalid JSON`);
  }
}
