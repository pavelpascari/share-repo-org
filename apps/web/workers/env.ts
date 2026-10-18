import { type GitHubAppConfig, parseGitHubAppConfig } from "@sharerepo/integrations";
import { parseEnv } from "@sharerepo/platform";
import { z } from "zod";
import { type AuthConfig, parseAuthEnv } from "../app/auth/env.ts";

const webEnvSchema = z.object({
  DB: z.custom<D1Database>(isD1Binding),
  // Webhook receipts hand work to the jobs Worker through this queue (decision 0003).
  EVENTS: z.custom<Queue>(isQueueBinding),
  ENVIRONMENT: z.enum(["development", "e2e", "production"]),
});

/** The bindings and vars this Worker relies on, after validation. Unvalidated keys are dropped. */
export type WebEnv = z.output<typeof webEnvSchema> & {
  /** Sign-in configuration. Required: the Worker fails closed without it (decision 0006). */
  readonly auth: AuthConfig;
  /** The GitHub App, or null when it is not configured in local development. */
  readonly github: GitHubAppConfig | null;
};

/** Validates the Worker env; failures name keys and issue codes, never values. */
export function parseWebEnv(env: unknown): WebEnv {
  return {
    ...parseEnv(webEnvSchema, env),
    auth: parseAuthEnv(env),
    github: parseGitHubAppConfig(env, { requireWebhookSecret: true, requireSlug: true }),
  };
}

function isD1Binding(value: unknown): value is D1Database {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function"
  );
}

function isQueueBinding(value: unknown): value is Queue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { send?: unknown }).send === "function"
  );
}
