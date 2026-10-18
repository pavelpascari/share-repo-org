import type { ParseResult } from "./workspace.ts";

/** Identity providers a user can sign in with. Keyed by the provider's immutable user ID. */
export const IDENTITY_PROVIDERS = ["github"] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** GitHub's immutable numeric user ID, held as its canonical decimal string. */
export type GitHubUserId = Brand<string, "GitHubUserId">;

const CANONICAL_POSITIVE_INTEGER = /^[1-9][0-9]*$/;

export function parseGitHubUserId(
  value: unknown,
): ParseResult<GitHubUserId, "github_user_id_invalid"> {
  const id =
    typeof value === "number" ? value : typeof value === "string" ? canonicalNumber(value) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) return { ok: false, error: "github_user_id_invalid" };
  return { ok: true, value: String(id) as GitHubUserId };
}

function canonicalNumber(value: string): number {
  return CANONICAL_POSITIVE_INTEGER.test(value) ? Number(value) : NaN;
}

export const GITHUB_LOGIN_MAX_LENGTH = 39;

/**
 * A GitHub login (username). Only a snapshot: it can change and be reused, so it is never a key.
 * Hyphen placement is not checked because legacy logins break GitHub's current rules.
 */
export type GitHubLogin = Brand<string, "GitHubLogin">;
export type GitHubLoginError = "login_empty" | "login_too_long" | "login_invalid_format";

const LOGIN_CHARACTERS = /^[A-Za-z0-9-]+$/;

export function parseGitHubLogin(value: unknown): ParseResult<GitHubLogin, GitHubLoginError> {
  if (typeof value !== "string") return { ok: false, error: "login_invalid_format" };
  if (value === "") return { ok: false, error: "login_empty" };
  if (value.length > GITHUB_LOGIN_MAX_LENGTH) return { ok: false, error: "login_too_long" };
  if (!LOGIN_CHARACTERS.test(value)) return { ok: false, error: "login_invalid_format" };
  return { ok: true, value: value as GitHubLogin };
}
