import { env } from "cloudflare:workers";
import { ConfigurationError } from "@sharerepo/platform";
import { createSecretCanaries, expectNoCanaryLeak } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import { parseJobsEnv } from "../src/env.ts";

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

  it("accepts production", () => {
    expect(parseJobsEnv({ ...env, ENVIRONMENT: "production" }).environment).toBe("production");
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["not a D1 binding", { name: "DB" }],
  ])("rejects a DB binding that is %s", (_label, db) => {
    const error = configurationError({ ...env, DB: db });
    expect(error.issues).toEqual([{ path: "DB", code: "invalid_type" }]);
    expect(error.message).toBe("Invalid environment configuration: DB (invalid_type)");
  });

  it("rejects an unknown ENVIRONMENT and reports every failing key", () => {
    const error = configurationError({ ENVIRONMENT: "staging" });
    expect(error.code).toBe("configuration_error");
    expect(error.issues).toEqual([
      { path: "DB", code: "invalid_type" },
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
