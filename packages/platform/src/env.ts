import type { z } from "zod";
import { ConfigurationError, type ConfigurationIssue } from "./errors.ts";

/**
 * Validates Worker bindings and vars. On failure the error names the failing keys and
 * issue codes only: Zod messages and the ZodError are discarded because custom messages
 * can interpolate the (possibly secret) input.
 */
export function parseEnv<S extends z.ZodType>(schema: S, env: unknown): z.output<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;

  const issues = result.error.issues.flatMap((issue): ConfigurationIssue[] => {
    const base = issue.path.map(String);
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({ path: [...base, key].join("."), code: issue.code }));
    }
    return [{ path: base.length > 0 ? base.join(".") : "(root)", code: issue.code }];
  });
  const summary = issues.map((issue) => `${issue.path} (${issue.code})`).join(", ");
  throw new ConfigurationError(`Invalid environment configuration: ${summary}`, issues);
}
