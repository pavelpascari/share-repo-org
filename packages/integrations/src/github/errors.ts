/**
 * How a GitHub API failure should be handled. Messages carry the operation and status only:
 * never tokens, JWTs, keys or response bodies.
 *
 * | kind                 | cause                                                         |
 * |----------------------|---------------------------------------------------------------|
 * | `not_found`          | 404; repository calls say whether the `target` is the repository |
 * |                      | (resync it) or the account, collaborator or invitation        |
 * | `suspended`          | 403 saying the installation is suspended                      |
 * | `rate_limited`       | 429, or 403 with `x-ratelimit-remaining: 0` or `retry-after`  |
 * | `transient`          | 5xx or a network failure                                      |
 * | `rejected`           | any other 4xx (401, 403, 422, …)                              |
 * | `malformed_response` | a 2xx body that does not match the expected shape             |
 */
export const GITHUB_API_ERROR_KINDS = [
  "not_found",
  "suspended",
  "rate_limited",
  "transient",
  "rejected",
  "malformed_response",
] as const;
export type GitHubApiErrorKind = (typeof GITHUB_API_ERROR_KINDS)[number];

export interface GitHubApiErrorDetails {
  readonly status?: number;
  /** For `rate_limited`: how long to wait before retrying. */
  readonly retryAfterMs?: number;
  /** For 422: GitHub's validation error codes (for example `custom`, `invalid`), never messages. */
  readonly githubErrorCodes?: readonly string[];
  /**
   * For `not_found` from repository calls: whether the repository itself is gone (or renamed),
   * which needs a resync, or the account, collaborator or invitation (already gone).
   */
  readonly target?: GitHubNotFoundTarget;
}

export type GitHubNotFoundTarget = "repository" | "account";

export class GitHubApiError extends Error {
  readonly kind: GitHubApiErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly githubErrorCodes: readonly string[];
  readonly target: GitHubNotFoundTarget | undefined;

  constructor(kind: GitHubApiErrorKind, message: string, details: GitHubApiErrorDetails = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.kind = kind;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.githubErrorCodes = details.githubErrorCodes ?? [];
    this.target = details.target;
  }
}

/** A webhook request whose headers or payload do not have GitHub's envelope shape. */
export class InvalidWebhookError extends Error {
  constructor() {
    super("GitHub webhook envelope is invalid");
    this.name = "InvalidWebhookError";
  }
}
