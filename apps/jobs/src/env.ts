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
  /** `PUBLIC_BASE_URL`: the web Worker's public origin (its `BETTER_AUTH_URL`), for claim links. */
  readonly publicBaseUrl: string;
  /** `MAIL_FROM`: the claim emails' sender, such as `ShareRepo <claims@sharerepo.org>`. */
  readonly mailFrom: string;
}

/** `name@domain`, or `Display Name <name@domain>`. */
const MAIL_FROM = /^(?:[^<>\r\n]{1,64} <[^\s@<>]+@[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+)$/;

const jobsEnvSchema = z
  .object({
    DB: z.custom<D1Database>(isD1Binding),
    ENVIRONMENT: z.enum(JOBS_ENVIRONMENTS),
    PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }),
    MAIL_FROM: z.string().max(254).regex(MAIL_FROM),
  })
  .superRefine((env, ctx) => {
    // Claim links sent from production must be https.
    if (env.ENVIRONMENT === "production" && !env.PUBLIC_BASE_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "https required" });
    }
  });

/**
 * Validates the jobs Worker bindings; failures name keys and issue codes, never values. Outside
 * local development a missing or invalid GitHub App or commerce configuration fails closed.
 */
export function parseJobsEnv(env: object): JobsConfig {
  const { DB, ENVIRONMENT, PUBLIC_BASE_URL, MAIL_FROM } = parseEnv(jobsEnvSchema, env);
  const github = parseGitHubAppConfig(env, { requireWebhookSecret: false, requireSlug: false });
  return {
    db: DB,
    environment: ENVIRONMENT,
    github,
    commerce: parseCommerceSecrets(env),
    paddle: parsePaddleConfig(env),
    mail: parseMailConfig(env),
    publicBaseUrl: PUBLIC_BASE_URL.replace(/\/+$/, ""),
    mailFrom: MAIL_FROM,
  };
}

function isD1Binding(value: unknown): value is D1Database {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function"
  );
}
