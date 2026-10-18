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
