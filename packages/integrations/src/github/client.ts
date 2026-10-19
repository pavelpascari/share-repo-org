import { type Clock, type Instant, parseGitHubLogin } from "@sharerepo/domain";
import { z } from "zod";
import { GitHubApiError, type GitHubNotFoundTarget } from "./errors.ts";
import { importPrivateKey, signAppJwt } from "./jwt.ts";
import type {
  AddCollaboratorResult,
  GitHubAccountType,
  GitHubAppPort,
  GitHubCollaborator,
  GitHubInstallation,
  GitHubInvitation,
  GitHubPermission,
  GitHubRepository,
  GitHubUser,
} from "./port.ts";

// The GitHub App's REST client. Every response is Zod-parsed; IDs become decimal strings.
// https://docs.github.com/en/rest/apps/apps and https://docs.github.com/en/rest/collaborators
// and https://docs.github.com/en/rest/users/users

export interface GitHubAppOptions {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly apiBaseUrl: string;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  /** Needed only for `installUrl`. */
  readonly install?: { readonly slug: string; readonly webBaseUrl: string };
}

export interface GitHubAppClient extends GitHubAppPort {
  appJwt(): Promise<string>;
  installationToken(installationId: string): Promise<string>;
}

/** Tokens are reused until 5 minutes before GitHub says they expire (they last an hour). */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const PAGE_LIMIT = 50;
/** Collaborator and invitation lists: 30 pages of 100 (phase 4 plan). */
const REPOSITORY_LIST_PAGE_LIMIT = 30;
const AFFILIATIONS = new Set(["direct", "all"]);
const DEFAULT_RETRY_AFTER_MS = 60_000;

const id = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .transform((value) => String(value));
const timestamp = z.iso.datetime({ offset: true }).transform((value) => Date.parse(value));
const accountType = z
  .enum(["User", "Organization"])
  .optional()
  .transform((type): GitHubAccountType => type ?? "Enterprise");
const account = z.object({ id, login: z.string().min(1), type: accountType });
const user = z.object({ id, login: z.string().min(1) });

const userResponse = z.object({
  id,
  login: z.string().min(1),
  type: z.enum(["User", "Organization", "Bot"]),
});

const tokenResponse = z.object({ token: z.string().min(1), expires_at: timestamp });
const installationResponse = z.object({
  id,
  account,
  suspended_at: timestamp.nullable(),
  permissions: z.record(z.string(), z.string()),
  repository_selection: z.enum(["all", "selected"]),
});
const repository = z.object({
  id,
  full_name: z.string().min(1),
  owner: account,
  private: z.boolean(),
  archived: z.boolean(),
});
const repositoriesPage = z.object({ repositories: z.array(repository) });
const collaborators = z.array(
  z.object({
    id,
    login: z.string().min(1),
    permissions: z.object({
      admin: z.boolean(),
      maintain: z.boolean().optional(),
      push: z.boolean(),
      triage: z.boolean().optional(),
      pull: z.boolean(),
    }),
  }),
);
const invitation = z.object({
  id,
  // `null` for an invitation sent to an email address rather than an account.
  invitee: user.nullable(),
  created_at: timestamp,
  // Decision 0010: the field may be absent; a missing flag is not expired.
  expired: z.boolean().optional().default(false),
});
const invitations = z.array(invitation);
const invitationCreated = z.object({ id, created_at: timestamp });
const errorBody = z
  .object({
    message: z.string().optional(),
    errors: z.array(z.object({ code: z.string() }).loose()).optional(),
  })
  .loose();

type Auth = { readonly kind: "app" } | { readonly kind: "installation"; readonly id: string };

export function createGitHubApp(options: GitHubAppOptions): GitHubAppClient {
  const { apiBaseUrl, clock } = options;
  let key: Promise<CryptoKey> | undefined;
  const tokens = new Map<string, { token: string; expiresAt: Instant }>();

  async function appJwt(): Promise<string> {
    key ??= importPrivateKey(options.privateKeyPem);
    return signAppJwt(await key, options.appId, clock);
  }

  async function installationToken(installationId: string): Promise<string> {
    const cached = tokens.get(installationId);
    if (cached !== undefined && clock.now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return cached.token;
    }
    const response = await request("create installation token", "POST", tokenPath(installationId), {
      kind: "app",
    });
    const body = parse("create installation token", tokenResponse, await json(response));
    tokens.set(installationId, { token: body.token, expiresAt: body.expires_at });
    return body.token;
  }

  async function request(
    operation: string,
    method: string,
    pathOrUrl: string,
    auth: Auth,
    body?: unknown,
    /** What a 404 from this request (not from minting its token) means. */
    notFound?: GitHubNotFoundTarget,
  ): Promise<Response> {
    const token = auth.kind === "app" ? await appJwt() : await installationToken(auth.id);
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "ShareRepo",
      "x-github-api-version": "2022-11-28",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await options.fetch(
        pathOrUrl.startsWith("/") ? `${apiBaseUrl}${pathOrUrl}` : pathOrUrl,
        { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      );
    } catch {
      throw new GitHubApiError("transient", `GitHub ${operation} failed: network error`);
    }
    if (response.ok) return response;
    throw await classify(operation, response, clock, notFound);
  }

  const installation = (installationId: string): Auth => ({
    kind: "installation",
    id: installationId,
  });

  async function paginate<T>(
    operation: string,
    first: string,
    auth: Auth,
    read: (body: unknown) => T[],
    limit = PAGE_LIMIT,
    notFound?: GitHubNotFoundTarget,
  ): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = first;
    for (let page = 0; next !== null; page += 1) {
      if (page === limit) {
        throw new GitHubApiError("malformed_response", `GitHub ${operation}: too many pages`);
      }
      const response = await request(operation, "GET", next, auth, undefined, notFound);
      items.push(...read(await json(response)));
      next = nextLink(response.headers.get("link"), apiBaseUrl);
    }
    return items;
  }

  /**
   * Sends a collaborator or invitation change, and settles what a 404 meant. GitHub answers 404
   * both when the repository is gone (renamed, transferred, deleted or no longer selected) and
   * when the user, collaborator or invitation is; its body does not reliably say which. So a 404
   * is followed by one `GET /repos/{owner}/{repo}` (Metadata: read): if that 404s too, the error
   * is `not_found` with target `repository` (the caller resyncs); otherwise the change's 404 is
   * returned as `null`, meaning the account, collaborator or invitation was not found.
   */
  async function mutate(
    operation: string,
    method: string,
    repo: string,
    path: string,
    auth: Auth,
    body?: unknown,
  ): Promise<Response | null> {
    try {
      return await request(operation, method, `${repo}${path}`, auth, body, "account");
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.target === "account")) throw error;
      await request("get repository", "GET", repo, auth, undefined, "repository");
      return null;
    }
  }

  return {
    appJwt,
    installationToken,

    async getInstallation(installationId) {
      const operation = "get installation";
      const response = await request(
        operation,
        "GET",
        `/app/installations/${pathSegment("id", installationId)}`,
        { kind: "app" },
      );
      const body = parse(operation, installationResponse, await json(response));
      return {
        id: body.id,
        account: body.account,
        suspendedAt: body.suspended_at,
        permissions: body.permissions,
        repositorySelection: body.repository_selection,
      } satisfies GitHubInstallation;
    },

    async listInstallationRepositories(installationId) {
      const operation = "list installation repositories";
      return paginate(
        operation,
        "/installation/repositories?per_page=100",
        installation(installationId),
        (body) =>
          parse(operation, repositoriesPage, body).repositories.map(
            (repo): GitHubRepository => ({
              externalId: repo.id,
              name: repo.full_name,
              ownerExternalId: repo.owner.id,
              ownerType: repo.owner.type,
              private: repo.private,
              archived: repo.archived,
            }),
          ),
      );
    },

    installUrl(state) {
      if (options.install === undefined) throw new Error("GitHub App slug is not configured");
      const url = new URL(
        `${options.install.webBaseUrl}/apps/${encodeURIComponent(options.install.slug)}/installations/new`,
      );
      url.searchParams.set("state", state);
      return url.toString();
    },

    async getUserByLogin(installationId, login) {
      const operation = "get user";
      const response = await request(
        operation,
        "GET",
        `/users/${loginSegment(login)}`,
        installation(installationId),
      );
      const body = parse(operation, userResponse, await json(response));
      return { id: body.id, login: body.login, type: body.type } satisfies GitHubUser;
    },

    async getUserById(installationId, userId) {
      const operation = "get user by id";
      const response = await request(
        operation,
        "GET",
        `/user/${pathSegment("id", userId)}`,
        installation(installationId),
      );
      const body = parse(operation, userResponse, await json(response));
      return { id: body.id, login: body.login, type: body.type } satisfies GitHubUser;
    },

    async listCollaborators(installationId, repo, affiliation) {
      const operation = "list collaborators";
      const path = repositoryPath(repo);
      if (!AFFILIATIONS.has(affiliation)) {
        throw new GitHubApiError("rejected", "GitHub request refused: invalid affiliation");
      }
      return paginate(
        operation,
        `${path}/collaborators?affiliation=${affiliation}&per_page=100`,
        installation(installationId),
        (body) =>
          parse(operation, collaborators, body).map(
            (collaborator): GitHubCollaborator => ({
              id: collaborator.id,
              login: collaborator.login,
              permission: highestPermission(collaborator.permissions),
            }),
          ),
        REPOSITORY_LIST_PAGE_LIMIT,
        "repository",
      );
    },

    async listInvitations(installationId, repo) {
      const operation = "list invitations";
      return paginate(
        operation,
        `${repositoryPath(repo)}/invitations?per_page=100`,
        installation(installationId),
        (body) =>
          parse(operation, invitations, body).flatMap((item): GitHubInvitation[] =>
            item.invitee === null
              ? []
              : [
                  {
                    id: item.id,
                    inviteeId: item.invitee.id,
                    inviteeLogin: item.invitee.login,
                    createdAt: item.created_at,
                    expired: item.expired,
                  },
                ],
          ),
        REPOSITORY_LIST_PAGE_LIMIT,
        "repository",
      );
    },

    async addCollaborator(installationId, repo, login): Promise<AddCollaboratorResult> {
      const operation = "add collaborator";
      const path = repositoryPath(repo);
      const segment = `/collaborators/${loginSegment(login)}`;
      // No `permission`: it is documented for organization repositories only (decision 0010).
      const response = await mutate(
        operation,
        "PUT",
        path,
        segment,
        installation(installationId),
        {},
      );
      if (response === null) {
        throw new GitHubApiError("not_found", `GitHub ${operation} failed with status 404`, {
          status: 404,
          target: "account",
        });
      }
      if (response.status === 204) return { outcome: "already_collaborator" };
      if (response.status !== 201) {
        throw new GitHubApiError(
          "malformed_response",
          `GitHub ${operation} returned ${response.status}`,
          { status: response.status },
        );
      }
      const body = parse(operation, invitationCreated, await json(response));
      return { outcome: "invited", invitationId: body.id, createdAt: body.created_at };
    },

    async removeCollaborator(installationId, repo, login) {
      const path = repositoryPath(repo);
      const segment = `/collaborators/${loginSegment(login)}`;
      const response = await mutate(
        "remove collaborator",
        "DELETE",
        path,
        segment,
        installation(installationId),
      );
      return response === null ? "not_found" : "removed";
    },

    async cancelInvitation(installationId, repo, invitationId) {
      const path = repositoryPath(repo);
      const segment = `/invitations/${pathSegment("id", invitationId)}`;
      const response = await mutate(
        "cancel invitation",
        "DELETE",
        path,
        segment,
        installation(installationId),
      );
      return response === null ? "not_found" : "cancelled";
    },
  };
}

/** `owner/name` as the `/repos/{owner}/{repo}` path, each part validated (never echoed). */
export function repositoryPath(repo: string): string {
  const parts = repo.split("/");
  if (parts.length !== 2) {
    throw new GitHubApiError("rejected", "GitHub request refused: invalid repository");
  }
  const [owner, name] = parts as [string, string];
  return `/repos/${pathSegment("login", owner)}/${pathSegment("repo", name)}`;
}

/** A login checked with the domain's rules, then as a path segment. */
export function loginSegment(login: string): string {
  if (!parseGitHubLogin(login).ok) {
    throw new GitHubApiError("rejected", "GitHub request refused: invalid login");
  }
  return pathSegment("login", login);
}

function highestPermission(permissions: {
  admin: boolean;
  maintain?: boolean | undefined;
  push: boolean;
}): GitHubPermission {
  if (permissions.admin) return "admin";
  if (permissions.maintain === true || permissions.push) return "write";
  return "read";
}

const tokenPath = (installationId: string) =>
  `/app/installations/${pathSegment("id", installationId)}/access_tokens`;

function parse<T>(operation: string, schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new GitHubApiError("malformed_response", `GitHub ${operation} response is malformed`);
  }
  return result.data;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * The `rel="next"` URL from a Link header. It must stay under the API base URL: the request
 * carries a token, which must never be sent elsewhere. A next link anywhere else is
 * `malformed_response`: stopping there would silently truncate the list.
 */
export function nextLink(header: string | null, apiBaseUrl: string): string | null {
  if (header === null) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match?.[2]?.split(/\s+/).includes("next")) {
      const url = match[1] as string;
      if (url.startsWith(`${apiBaseUrl}/`)) return url;
      throw new GitHubApiError(
        "malformed_response",
        "GitHub pagination link points outside the API",
      );
    }
  }
  return null;
}

async function classify(
  operation: string,
  response: Response,
  clock: Clock,
  notFound: GitHubNotFoundTarget | undefined,
): Promise<GitHubApiError> {
  const { status } = response;
  const message = `GitHub ${operation} failed with status ${status}`;
  const details = { status };
  const parsed = errorBody.safeParse(await json(response));
  const body = parsed.success ? parsed.data : {};

  const retryAfter = retryAfterMs(response.headers, clock);
  const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
  if (status === 429 || (status === 403 && (exhausted || response.headers.has("retry-after")))) {
    return new GitHubApiError("rate_limited", message, { ...details, retryAfterMs: retryAfter });
  }
  if (status === 403 && /suspended/i.test(body.message ?? "")) {
    return new GitHubApiError("suspended", message, details);
  }
  if (status === 404) {
    return new GitHubApiError(
      "not_found",
      message,
      notFound === undefined ? details : { ...details, target: notFound },
    );
  }
  if (status >= 500) return new GitHubApiError("transient", message, details);
  return new GitHubApiError("rejected", message, {
    ...details,
    githubErrorCodes: (body.errors ?? []).map((error) => error.code),
  });
}

function retryAfterMs(headers: Headers, clock: Clock): number {
  const retryAfter = Number(headers.get("retry-after"));
  if (headers.has("retry-after") && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return retryAfter * 1000;
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (headers.has("x-ratelimit-reset") && Number.isFinite(reset)) {
    return Math.max(0, reset * 1000 - clock.now());
  }
  return DEFAULT_RETRY_AFTER_MS;
}

// Every value placed in a URL path must match GitHub's own format. Percent-encoding alone is not
// enough: `.` and `..` survive it and URL resolution collapses them, so a username of `..` would
// turn `DELETE …/collaborators/..` into `DELETE /repos/{owner}/{repo}`, deleting the repository.
const PATH_SEGMENT_FORMATS = {
  login: /^[A-Za-z0-9-]{1,39}$/,
  repo: /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/,
  id: /^[1-9][0-9]{0,19}$/,
} as const;

/** Validates a URL path segment against GitHub's format; never echoes the value. */
export function pathSegment(kind: keyof typeof PATH_SEGMENT_FORMATS, value: string): string {
  if (!PATH_SEGMENT_FORMATS[kind].test(value)) {
    throw new GitHubApiError("rejected", `GitHub request refused: invalid ${kind} path segment`);
  }
  // A no-op for the formats above; kept so a looser format can never inject a path.
  return encodeURIComponent(value);
}
