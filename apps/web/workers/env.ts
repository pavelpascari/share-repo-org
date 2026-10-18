import { ConfigurationError, type ConfigurationIssue } from "@sharerepo/platform";

/** The bindings and vars this Worker relies on, after validation. */
export interface WebEnv {
  readonly DB: D1Database;
  readonly ENVIRONMENT: "development" | "production";
}

const ENVIRONMENTS: readonly string[] = ["development", "production"];

/**
 * Validates the Worker env. Issues name keys and Zod-style codes only, never values.
 *
 * Hand-written rather than `parseEnv` from @sharerepo/platform because `zod` is not a
 * dependency of this app yet. Switch to `parseEnv` with a Zod schema once it is added; the
 * thrown `ConfigurationError` keeps the same shape.
 */
export function parseWebEnv(env: unknown): WebEnv {
  if (typeof env !== "object" || env === null) {
    throw invalid([{ path: "(root)", code: "invalid_type" }]);
  }
  const { DB, ENVIRONMENT } = env as Record<string, unknown>;
  const issues: ConfigurationIssue[] = [];
  if (!isD1Binding(DB)) issues.push({ path: "DB", code: "invalid_type" });
  if (typeof ENVIRONMENT !== "string" || !ENVIRONMENTS.includes(ENVIRONMENT)) {
    issues.push({ path: "ENVIRONMENT", code: "invalid_value" });
  }
  if (issues.length > 0) throw invalid(issues);
  return env as WebEnv;
}

function isD1Binding(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function"
  );
}

function invalid(issues: ConfigurationIssue[]): ConfigurationError {
  const summary = issues.map((issue) => `${issue.path} (${issue.code})`).join(", ");
  return new ConfigurationError(`Invalid environment configuration: ${summary}`, issues);
}
