import { z } from "zod";
import { parseEnv } from "./env.ts";
import { ConfigurationError } from "./errors.ts";

/** A GitHub account's immutable numeric ID, as GitHub and `external_identities` store it. */
const GITHUB_ID = /^[1-9][0-9]{0,19}$/;
const KEY = "OPERATOR_GITHUB_IDS";

const schema = z.object({ [KEY]: z.string().optional() });

/**
 * The operators (decision 0014): GitHub account IDs from `OPERATOR_GITHUB_IDS`, comma-separated,
 * with optional spaces. Unset or empty means no operators. IDs, never logins: a login can be
 * renamed and taken by someone else. Errors name the key and an issue code, never the value.
 */
export function parseOperatorGitHubIds(env: unknown): ReadonlySet<string> {
  const raw = parseEnv(schema, env)[KEY] ?? "";
  if (raw.trim() === "") return new Set();
  const ids = raw.split(",").map((id) => id.trim());
  if (!ids.every((id) => GITHUB_ID.test(id))) {
    throw new ConfigurationError(`Invalid environment configuration: ${KEY} (invalid_format)`, [
      { path: KEY, code: "invalid_format" },
    ]);
  }
  return new Set(ids);
}
