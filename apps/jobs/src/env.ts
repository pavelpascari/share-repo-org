import {
  type GitHubAppConfig,
  type MailTransportConfig,
  type PaddleConfig,
  parseGitHubAppConfig,
  parseMailConfig,
  parsePaddleConfig,
} from "@sharerepo/integrations";
import { type CommerceSecrets, parseCommerceSecrets, parseEnv } from "@sharerepo/platform";
import { z } from "zod";

export const JOBS_ENVIRONMENTS = ["development", "e2e", "production"] as const;
export type JobsEnvironment = (typeof JOBS_ENVIRONMENTS)[number];

export interface JobsConfig {
  readonly db: D1Database;
  readonly environment: JobsEnvironment;
  /** The GitHub App, or null in local development when none is configured. */
  readonly github: GitHubAppConfig | null;
  /** Keys for Paddle credentials and claims, or null when not configured in local development. */
  readonly commerce: CommerceSecrets | null;
  readonly paddle: PaddleConfig;
  /**
   * How claim emails are sent: the optional `EMAIL` send_email binding, declared in wrangler.jsonc
   * once the sending domain is onboarded, or the E2E capture. Null when neither is configured.
   */
  readonly mail: MailTransportConfig | null;
}

const jobsEnvSchema = z.object({
  DB: z.custom<D1Database>(isD1Binding),
  ENVIRONMENT: z.enum(JOBS_ENVIRONMENTS),
});

/**
 * Validates the jobs Worker bindings; failures name keys and issue codes, never values. Outside
 * local development a missing or invalid GitHub App or commerce configuration fails closed.
 */
export function parseJobsEnv(env: object): JobsConfig {
  const { DB, ENVIRONMENT } = parseEnv(jobsEnvSchema, env);
  const github = parseGitHubAppConfig(env, { requireWebhookSecret: false, requireSlug: false });
  return {
    db: DB,
    environment: ENVIRONMENT,
    github,
    commerce: parseCommerceSecrets(env),
    paddle: parsePaddleConfig(env),
    mail: parseMailConfig(env),
  };
}

function isD1Binding(value: unknown): value is D1Database {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function"
  );
}
