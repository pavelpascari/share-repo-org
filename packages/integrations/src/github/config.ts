import { ConfigurationError, parseEnv } from "@sharerepo/platform";
import { z } from "zod";

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_WEB_BASE_URL = "https://github.com";

export interface GitHubAppConfig {
  readonly appId: string;
  readonly slug?: string;
  /** PKCS#8 PEM with real newlines. */
  readonly privateKeyPem: string;
  readonly webhookSecret?: string;
  readonly apiBaseUrl: string;
  /** github.com's web base, for the App install URL. */
  readonly webBaseUrl: string;
}

export interface GitHubAppConfigOptions {
  readonly requireWebhookSecret: boolean;
  readonly requireSlug: boolean;
}

const OVERRIDES = ["GITHUB_API_BASE_URL", "GITHUB_OAUTH_BASE_URL"] as const;

const baseSchema = z
  .object({
    ENVIRONMENT: z.enum(["development", "e2e", "production"]),
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_API_BASE_URL: z.url().optional(),
    GITHUB_OAUTH_BASE_URL: z.url().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.ENVIRONMENT === "e2e") return;
    for (const key of OVERRIDES) {
      if (env[key] !== undefined)
        ctx.addIssue({ code: "custom", path: [key], message: "e2e only" });
    }
  });

const present = z.string().min(1);

function requiredSchema(options: GitHubAppConfigOptions) {
  return z.object({
    GITHUB_APP_ID: z.string().regex(/^[1-9]\d{0,15}$/),
    GITHUB_APP_PRIVATE_KEY: present,
    GITHUB_APP_SLUG: options.requireSlug ? present : present.optional(),
    GITHUB_WEBHOOK_SECRET: options.requireWebhookSecret ? present : present.optional(),
  });
}

const PKCS8 = /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----$/;
const KEY_PATH = "GITHUB_APP_PRIVATE_KEY";

/**
 * The GitHub App configuration, or `null` in local development when no App is configured
 * (connecting GitHub is then disabled). Errors name keys and issue codes, never values.
 */
export function parseGitHubAppConfig(
  env: unknown,
  options: GitHubAppConfigOptions,
): GitHubAppConfig | null {
  const base = parseEnv(baseSchema, env);
  if (base.ENVIRONMENT === "development" && !base.GITHUB_APP_ID) return null;
  const required = parseEnv(requiredSchema(options), env);

  return {
    appId: required.GITHUB_APP_ID,
    ...(required.GITHUB_APP_SLUG === undefined ? {} : { slug: required.GITHUB_APP_SLUG }),
    privateKeyPem: normalizePrivateKey(required.GITHUB_APP_PRIVATE_KEY),
    ...(required.GITHUB_WEBHOOK_SECRET === undefined
      ? {}
      : { webhookSecret: required.GITHUB_WEBHOOK_SECRET }),
    apiBaseUrl: trimSlash(base.GITHUB_API_BASE_URL ?? GITHUB_API_BASE_URL),
    webBaseUrl: trimSlash(base.GITHUB_OAUTH_BASE_URL ?? GITHUB_WEB_BASE_URL),
  };
}

/**
 * Accepts a PKCS#8 PEM, with real or literal `\n` line breaks (secrets are often stored on one
 * line). GitHub issues PKCS#1 keys, which WebCrypto cannot import: those are refused with a
 * pointer to the conversion in the runbook.
 */
export function normalizePrivateKey(raw: string): string {
  const pem = raw.replaceAll("\\n", "\n").replaceAll("\r", "").trim();
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new ConfigurationError(
      `${KEY_PATH} is a PKCS#1 key; convert it to PKCS#8 as described in docs/runbooks/github-app-setup.md`,
      [{ path: KEY_PATH, code: "pkcs1_private_key" }],
    );
  }
  if (!PKCS8.test(pem)) {
    throw new ConfigurationError(`${KEY_PATH} is not a PKCS#8 PEM private key`, [
      { path: KEY_PATH, code: "invalid_private_key" },
    ]);
  }
  return pem;
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");
