import { parseEnv } from "@sharerepo/platform";
import { z } from "zod";

export const JOBS_ENVIRONMENTS = ["development", "production"] as const;
export type JobsEnvironment = (typeof JOBS_ENVIRONMENTS)[number];

export interface JobsConfig {
  readonly db: D1Database;
  readonly environment: JobsEnvironment;
}

const jobsEnvSchema = z
  .object({
    DB: z.custom<D1Database>(isD1Binding),
    ENVIRONMENT: z.enum(JOBS_ENVIRONMENTS),
  })
  .transform(({ DB, ENVIRONMENT }): JobsConfig => ({ db: DB, environment: ENVIRONMENT }));

/** Validates the jobs Worker bindings; failures name keys and issue codes, never values. */
export function parseJobsEnv(env: object): JobsConfig {
  return parseEnv(jobsEnvSchema, env);
}

function isD1Binding(value: unknown): value is D1Database {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function"
  );
}
