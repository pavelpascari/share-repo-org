import { env } from "cloudflare:workers";
import { ConfigurationError } from "@sharerepo/platform";
import { createSecretCanaries, expectNoCanaryLeak } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import { parseJobsEnv } from "../src/env.ts";
import { GITHUB_APP } from "./support/github.ts";

function configurationError(input: object): ConfigurationError {
  try {
    parseJobsEnv(input);
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error("expected parseJobsEnv to throw");
}

const envWithGitHubApp = (environment: string) => ({
  ...env,
  ...GITHUB_APP,
  ENVIRONMENT: environment,
});

describe("parseJobsEnv", () => {
  it("accepts the local bindings", () => {
    const config = parseJobsEnv(env);
    expect(config.environment).toBe("development");
    expect(config.db).toBe(env.DB);
  });

  it("has no GitHub App locally until one is configured", () => {
    expect(parseJobsEnv(env).github).toBeNull();
  });

  it("accepts production with a GitHub App", () => {
    const config = parseJobsEnv({ ...env, ...GITHUB_APP, ENVIRONMENT: "production" });
    expect(config.environment).toBe("production");
    expect(config.github).toMatchObject({ appId: "1000", apiBaseUrl: "https://api.github.com" });
  });

  it("fails closed in production without a GitHub App", () => {
    const error = configurationError({ ...env, ENVIRONMENT: "production" });
    expect(error.issues.map((issue) => issue.path)).toContain("GITHUB_APP_ID");
  });

  it("decodes the commerce secrets and uses Paddle's own API without mail", () => {
    const config = parseJobsEnv(env);
    expect(config.commerce?.credentialKeys.current).toBe("test-1");
    expect(config.commerce?.claimSigningKey.length).toBeGreaterThanOrEqual(32);
    expect(config.paddle.apiBaseUrls.live).toBe("https://api.paddle.com");
    expect(config.mail).toBeNull();
  });

  it("has no commerce secrets locally until they are configured", () => {
    const { CREDENTIAL_KEYS: _keys, CLAIM_SIGNING_KEY: _signing, ...local } = env;
    expect(parseJobsEnv(local).commerce).toBeNull();
  });

  it("fails closed in production without the commerce secrets", () => {
    const { CREDENTIAL_KEYS: _keys, ...rest } = envWithGitHubApp("production");
    const error = configurationError(rest);
    expect(error.issues).toEqual([{ path: "CREDENTIAL_KEYS", code: "invalid_type" }]);
  });

  it("accepts the Paddle and mail overrides only in e2e", () => {
    const overrides = {
      PADDLE_API_BASE_URL: "http://localhost:5191/api",
      MAIL_CAPTURE_URL: "http://localhost:5191/mail",
    };
    const e2e = parseJobsEnv({ ...envWithGitHubApp("e2e"), ...overrides });
    expect(e2e.paddle.apiBaseUrls.sandbox).toBe("http://localhost:5191/api");
    expect(e2e.mail).toEqual({ kind: "capture", url: "http://localhost:5191/mail" });
    expect(configurationError({ ...envWithGitHubApp("production"), ...overrides }).issues).toEqual([
      { path: "PADDLE_API_BASE_URL", code: "custom" },
    ]);
  });

  it("never echoes a rejected commerce secret", () => {
    const canaries = createSecretCanaries(["keyring"]);
    const error = configurationError({
      ...envWithGitHubApp("production"),
      CREDENTIAL_KEYS: canaries.keyring,
      CLAIM_SIGNING_KEY: "too-short",
    });
    expect(error.issues).toEqual([
      { path: "CREDENTIAL_KEYS", code: "custom" },
      { path: "CLAIM_SIGNING_KEY", code: "custom" },
    ]);
    expectNoCanaryLeak(error, canaries);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["not a D1 binding", { name: "DB" }],
  ])("rejects a DB binding that is %s", (_label, db) => {
    const error = configurationError({ ...env, DB: db });
    expect(error.issues).toEqual([{ path: "DB", code: "custom" }]);
    expect(error.message).toBe("Invalid environment configuration: DB (custom)");
  });

  it("rejects an unknown ENVIRONMENT and reports every failing key", () => {
    const error = configurationError({ ENVIRONMENT: "staging" });
    expect(error.code).toBe("configuration_error");
    expect(error.issues).toEqual([
      { path: "DB", code: "custom" },
      { path: "ENVIRONMENT", code: "invalid_value" },
    ]);
  });

  it("never echoes the rejected value", () => {
    const canaries = createSecretCanaries(["environment"]);
    const error = configurationError({ ...env, ENVIRONMENT: canaries.environment });
    expect(error.issues).toEqual([{ path: "ENVIRONMENT", code: "invalid_value" }]);
    expectNoCanaryLeak(error, canaries);
  });
});
