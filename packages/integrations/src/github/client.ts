import type { Clock, Instant } from "@sharerepo/domain";
import { z } from "zod";
import { GitHubApiError } from "./errors.ts";
import { importPrivateKey, signAppJwt } from "./jwt.ts";
import type {
  GitHubAccountType,
  GitHubAppPort,
  GitHubInstallation,
  GitHubRepository,
} from "./port.ts";

// The GitHub App's REST client. Every response is Zod-parsed; IDs become decimal strings.
// https://docs.github.com/en/rest/apps/apps and https://docs.github.com/en/rest/collaborators

export interface GitHubAppOptions {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly apiBaseUrl: string;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  /** Needed only for `installUrl`. */
  readonly install?: { readonly slug: string; readonly webBaseUrl: string };
}

export interface GitHubCollaborator {
  readonly id: string;
  readonly login: string;
}

export interface GitHubInvitation {
  readonly id: string;
  readonly invitee: GitHubCollaborator | null;
  readonly permissions: string;
  readonly expired: boolean;
  readonly createdAt: Instant;
}

export interface AddCollaboratorResult {
  /** 201: an invitation was created (pending). 204: already a collaborator. */
  readonly status: 201 | 204;
  readonly invitationId?: string;
}

export interface GitHubAppClient extends GitHubAppPort {
  appJwt(): Promise<string>;
  installationToken(installationId: string): Promise<string>;
  listCollaborators(
    installationId: string,
    owner: string,
    repo: string,
  ): Promise<GitHubCollaborator[]>;
  listInvitations(installationId: string, owner: string, repo: string): Promise<GitHubInvitation[]>;
  addCollaborator(
    installationId: string,
    owner: string,
    repo: string,
    username: string,
    permission?: string,
  ): Promise<AddCollaboratorResult>;
  removeCollaborator(
    installationId: string,
    owner: string,
    repo: string,
    username: string,
  ): Promise<204>;
  deleteInvitation(
    installationId: string,
    owner: string,
    repo: string,
    invitationId: string,
  ): Promise<204>;
}

/** Tokens are reused until 5 minutes before GitHub says they expire (they last an hour). */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const PAGE_LIMIT = 50;
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
const collaborators = z.array(user);
const invitations = z.array(
  z.object({
    id,
    invitee: user.nullable(),
    permissions: z.string(),
    expired: z.boolean(),
    created_at: timestamp,
  }),
);
const invitationCreated = z.object({ id });
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
    throw await classify(operation, response, clock);
  }

  const installation = (installationId: string): Auth => ({
    kind: "installation",
    id: installationId,
  });
  const repoPath = (owner: string, repo: string) =>
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function paginate<T>(
    operation: string,
    first: string,
    auth: Auth,
    read: (body: unknown) => T[],
  ): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = first;
    for (let page = 0; next !== null; page += 1) {
      if (page === PAGE_LIMIT) {
        throw new GitHubApiError("malformed_response", `GitHub ${operation}: too many pages`);
      }
      const response = await request(operation, "GET", next, auth);
      items.push(...read(await json(response)));
      next = nextLink(response.headers.get("link"), apiBaseUrl);
    }
    return items;
  }

  return {
    appJwt,
    installationToken,

    async getInstallation(installationId) {
      const operation = "get installation";
      const response = await request(
        operation,
        "GET",
        `/app/installations/${encodeURIComponent(installationId)}`,
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

    async listCollaborators(installationId, owner, repo) {
      const operation = "list collaborators";
      return paginate(
        operation,
        `${repoPath(owner, repo)}/collaborators?affiliation=direct&per_page=100`,
        installation(installationId),
        (body) => parse(operation, collaborators, body),
      );
    },

    async listInvitations(installationId, owner, repo) {
      const operation = "list invitations";
      return paginate(
        operation,
        `${repoPath(owner, repo)}/invitations?per_page=100`,
        installation(installationId),
        (body) =>
          parse(operation, invitations, body).map((invitation) => ({
            id: invitation.id,
            invitee: invitation.invitee,
            permissions: invitation.permissions,
            expired: invitation.expired,
            createdAt: invitation.created_at,
          })),
      );
    },

    async addCollaborator(installationId, owner, repo, username, permission) {
      const operation = "add collaborator";
      const response = await request(
        operation,
        "PUT",
        `${repoPath(owner, repo)}/collaborators/${encodeURIComponent(username)}`,
        installation(installationId),
        permission === undefined ? {} : { permission },
      );
      if (response.status === 204) return { status: 204 };
      if (response.status !== 201) {
        throw new GitHubApiError(
          "malformed_response",
          `GitHub ${operation} returned ${response.status}`,
          {
            status: response.status,
          },
        );
      }
      const body = parse(operation, invitationCreated, await json(response));
      return { status: 201, invitationId: body.id };
    },

    async removeCollaborator(installationId, owner, repo, username) {
      await request(
        "remove collaborator",
        "DELETE",
        `${repoPath(owner, repo)}/collaborators/${encodeURIComponent(username)}`,
        installation(installationId),
      );
      return 204;
    },

    async deleteInvitation(installationId, owner, repo, invitationId) {
      await request(
        "delete invitation",
        "DELETE",
        `${repoPath(owner, repo)}/invitations/${encodeURIComponent(invitationId)}`,
        installation(installationId),
      );
      return 204;
    },
  };
}

const tokenPath = (installationId: string) =>
  `/app/installations/${encodeURIComponent(installationId)}/access_tokens`;

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
 * The `rel="next"` URL from a Link header, only if it stays on the API origin: the request
 * carries a token, which must never be sent elsewhere.
 */
export function nextLink(header: string | null, apiBaseUrl: string): string | null {
  if (header === null) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match?.[2]?.split(/\s+/).includes("next")) {
      const url = match[1] as string;
      return url.startsWith(`${apiBaseUrl}/`) ? url : null;
    }
  }
  return null;
}

async function classify(
  operation: string,
  response: Response,
  clock: Clock,
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
  if (status === 404) return new GitHubApiError("not_found", message, details);
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
