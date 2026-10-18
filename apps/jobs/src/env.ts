import { ConfigurationError, type ConfigurationIssue } from "@sharerepo/platform";

export const JOBS_ENVIRONMENTS = ["development", "production"] as const;
export type JobsEnvironment = (typeof JOBS_ENVIRONMENTS)[number];

export interface JobsConfig {
  readonly db: D1Database;
  readonly environment: JobsEnvironment;
}

// Hand-written rather than a Zod schema through `parseEnv`: `zod` is not a dependency of this
// app yet. Issues use the same `{ path, code }` shape and Zod codes, and never carry values.
export function parseJobsEnv(env: object): JobsConfig {
  const { DB: db, ENVIRONMENT: environment } = env as { DB?: unknown; ENVIRONMENT?: unknown };
  if (isD1Binding(db) && isJobsEnvironment(environment)) return { db, environment };

  const issues: ConfigurationIssue[] = [];
  if (!isD1Binding(db)) issues.push({ path: "DB", code: "invalid_type" });
  if (!isJobsEnvironment(environment)) issues.push({ path: "ENVIRONMENT", code: "invalid_value" });
  const summary = issues.map((issue) => `${issue.path} (${issue.code})`).join(", ");
  throw new ConfigurationError(`Invalid environment configuration: ${summary}`, issues);
}

function isD1Binding(value: unknown): value is D1Database {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function"
  );
}

function isJobsEnvironment(value: unknown): value is JobsEnvironment {
  return (JOBS_ENVIRONMENTS as readonly unknown[]).includes(value);
}
