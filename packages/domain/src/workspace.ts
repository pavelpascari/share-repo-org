/**
 * Workspace rules shared by the domain and the database schema.
 * The CHECK constraints in `packages/db` mirror these rules; change both together.
 */

/** Outcome of parsing untrusted input. Expected validation failures are values, not exceptions. */
export type ParseResult<T, E extends string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export const WORKSPACE_SLUG_MIN_LENGTH = 3;
export const WORKSPACE_SLUG_MAX_LENGTH = 48;
export const WORKSPACE_NAME_MAX_LENGTH = 100;

/** Lowercase ASCII letters and digits in hyphen-separated groups: no leading, trailing, or double hyphens. */
const SLUG_FORMAT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type WorkspaceSlug = Brand<string, "WorkspaceSlug">;
export type WorkspaceSlugError = "slug_too_short" | "slug_too_long" | "slug_invalid_format";

export function normalizeWorkspaceSlug(input: string): string {
  return input.trim().toLowerCase();
}

export function parseWorkspaceSlug(input: string): ParseResult<WorkspaceSlug, WorkspaceSlugError> {
  const slug = normalizeWorkspaceSlug(input);
  if (slug.length < WORKSPACE_SLUG_MIN_LENGTH) return { ok: false, error: "slug_too_short" };
  if (slug.length > WORKSPACE_SLUG_MAX_LENGTH) return { ok: false, error: "slug_too_long" };
  if (!SLUG_FORMAT.test(slug)) return { ok: false, error: "slug_invalid_format" };
  return { ok: true, value: slug as WorkspaceSlug };
}

export type WorkspaceName = Brand<string, "WorkspaceName">;
export type WorkspaceNameError = "name_empty" | "name_too_long";

/** Length is counted in Unicode code points, which is what SQLite's `length()` counts. */
export function parseWorkspaceName(input: string): ParseResult<WorkspaceName, WorkspaceNameError> {
  const name = input.trim();
  if (name === "") return { ok: false, error: "name_empty" };
  if ([...name].length > WORKSPACE_NAME_MAX_LENGTH) return { ok: false, error: "name_too_long" };
  return { ok: true, value: name as WorkspaceName };
}

export const WORKSPACE_ROLES = ["owner", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly unknown[]).includes(value);
}

export function parseWorkspaceRole(value: unknown): ParseResult<WorkspaceRole, "role_invalid"> {
  return isWorkspaceRole(value) ? { ok: true, value } : { ok: false, error: "role_invalid" };
}

export const WORKSPACE_STATUSES = ["active", "suspended"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export function isWorkspaceStatus(value: unknown): value is WorkspaceStatus {
  return (WORKSPACE_STATUSES as readonly unknown[]).includes(value);
}

export function parseWorkspaceStatus(
  value: unknown,
): ParseResult<WorkspaceStatus, "status_invalid"> {
  return isWorkspaceStatus(value) ? { ok: true, value } : { ok: false, error: "status_invalid" };
}
