import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigurationError, parseEnv } from "../src/index.ts";

const CANARY = "canary-env-5f1e8c2a-secret-value";

const schema = z.object({
  ENVIRONMENT: z.enum(["local", "dev", "production"]),
  GITHUB_WEBHOOK_SECRET: z.string().min(64),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive(),
  DB: z.custom<{ prepare: unknown }>(
    (value) => typeof value === "object" && value !== null && "prepare" in value,
    { message: "Expected a D1 binding" },
  ),
});

const fakeDb = { prepare: () => undefined };

function captureError(fn: () => unknown): ConfigurationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error("expected parseEnv to throw");
}

describe("parseEnv", () => {
  it("returns the parsed, typed environment", () => {
    const env = parseEnv(schema, {
      ENVIRONMENT: "dev",
      GITHUB_WEBHOOK_SECRET: "x".repeat(64),
      SESSION_TTL_SECONDS: "3600",
      DB: fakeDb,
      UNRELATED_BINDING: "ignored",
    });
    expect(env.ENVIRONMENT).toBe("dev");
    expect(env.SESSION_TTL_SECONDS).toBe(3600);
    expect(env.DB).toBe(fakeDb);
  });

  it("lists every failing key with its issue type", () => {
    const error = captureError(() =>
      parseEnv(schema, { ENVIRONMENT: "staging", SESSION_TTL_SECONDS: "-1" }),
    );
    expect(error.message).toBe(
      "Invalid environment configuration: ENVIRONMENT (invalid_value), " +
        "GITHUB_WEBHOOK_SECRET (invalid_type), SESSION_TTL_SECONDS (too_small), DB (custom)",
    );
    expect(error.issues).toEqual([
      { path: "ENVIRONMENT", code: "invalid_value" },
      { path: "GITHUB_WEBHOOK_SECRET", code: "invalid_type" },
      { path: "SESSION_TTL_SECONDS", code: "too_small" },
      { path: "DB", code: "custom" },
    ]);
    expect(error.httpStatus).toBe(500);
  });

  it("never echoes secret values in the message, stack, cause or issues", () => {
    const error = captureError(() =>
      parseEnv(schema, {
        ENVIRONMENT: CANARY,
        GITHUB_WEBHOOK_SECRET: CANARY,
        SESSION_TTL_SECONDS: CANARY,
        DB: CANARY,
      }),
    );
    expect(error.message).not.toContain(CANARY);
    expect(error.stack ?? "").not.toContain(CANARY);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error.issues)).not.toContain(CANARY);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  });

  it("does not echo values from custom refinement messages", () => {
    const leaky = z.object({
      API_KEY: z.string().refine((value) => value.startsWith("pdl_"), {
        error: (issue) => `bad key ${String(issue.input)}`,
      }),
    });
    const error = captureError(() => parseEnv(leaky, { API_KEY: CANARY }));
    expect(error.message).toBe("Invalid environment configuration: API_KEY (custom)");
    expect(error.message).not.toContain(CANARY);
  });

  it("reports nested paths and unrecognised keys", () => {
    const strict = z.strictObject({ NESTED: z.object({ PORT: z.number() }) });
    const error = captureError(() => parseEnv(strict, { NESTED: { PORT: "80" }, EXTRA: CANARY }));
    expect(error.issues).toEqual([
      { path: "NESTED.PORT", code: "invalid_type" },
      { path: "EXTRA", code: "unrecognized_keys" },
    ]);
    expect(error.message).not.toContain(CANARY);
  });

  it("reports a missing environment object at the root", () => {
    const error = captureError(() => parseEnv(schema, undefined));
    expect(error.issues).toEqual([{ path: "(root)", code: "invalid_type" }]);
  });
});
