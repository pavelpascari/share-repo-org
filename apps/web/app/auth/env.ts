import { parseEnv, secretText } from "@sharerepo/platform";
import { z } from "zod";
import { GITHUB_ENDPOINTS, type GitHubEndpoints } from "./github.ts";

// Authentication configuration (decision 0006). The GitHub endpoint overrides exist only for the
// local E2E environment and are rejected everywhere else, so a deployed Worker can only send
// users and their authorization codes to github.com.

const ENVIRONMENTS = ["development", "e2e", "production"] as const;
/** Environments that run on localhost and may use plain http. */
const LOCAL_ENVIRONMENTS: ReadonlySet<string> = new Set(["development", "e2e"]);
const E2E_ONLY_KEYS = ["GITHUB_OAUTH_BASE_URL", "GITHUB_API_BASE_URL"] as const;

const authEnvSchema = z
  .object({
    ENVIRONMENT: z.enum(ENVIRONMENTS),
    BETTER_AUTH_SECRET: secretText(32),
    BETTER_AUTH_URL: z.url({ protocol: /^https?$/ }),
    GITHUB_CLIENT_ID: z.string().min(1),
    GITHUB_CLIENT_SECRET: secretText(),
    GITHUB_OAUTH_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
    GITHUB_API_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  })
  .superRefine((env, ctx) => {
    if (!LOCAL_ENVIRONMENTS.has(env.ENVIRONMENT) && env.BETTER_AUTH_URL.startsWith("http://")) {
      ctx.addIssue({ code: "custom", path: ["BETTER_AUTH_URL"], message: "must be https" });
    }
    if (env.ENVIRONMENT === "e2e") return;
    for (const key of E2E_ONLY_KEYS) {
      if (env[key] !== undefined)
        ctx.addIssue({ code: "custom", path: [key], message: "e2e only" });
    }
  })
  .transform((env) => ({
    environment: env.ENVIRONMENT,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    github: {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      endpoints: endpointsFor(env.GITHUB_OAUTH_BASE_URL, env.GITHUB_API_BASE_URL),
    },
  }));

function endpointsFor(oauthBase?: string, apiBase?: string): GitHubEndpoints {
  const trim = (url: string) => url.replace(/\/+$/, "");
  return {
    authorizeUrl:
      oauthBase === undefined
        ? GITHUB_ENDPOINTS.authorizeUrl
        : `${trim(oauthBase)}/login/oauth/authorize`,
    tokenUrl:
      oauthBase === undefined
        ? GITHUB_ENDPOINTS.tokenUrl
        : `${trim(oauthBase)}/login/oauth/access_token`,
    apiBaseUrl: apiBase === undefined ? GITHUB_ENDPOINTS.apiBaseUrl : trim(apiBase),
  };
}

export type AuthConfig = z.output<typeof authEnvSchema>;

/** Throws a ConfigurationError that names failing keys and issue codes, never values. */
export function parseAuthEnv(env: unknown): AuthConfig {
  return parseEnv(authEnvSchema, env);
}
