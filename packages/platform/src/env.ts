import { z } from "zod";
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

/**
 * A secret given as text: at least `minLength` characters, and at least one that is not
 * whitespace. A value of only spaces or newlines is always a paste mistake, never a secret, so it
 * fails the configuration closed (issue code `invalid_format`) rather than becoming a key that
 * anyone could guess.
 */
// An empty value is reported once, as too short; the pattern then accepts it.
export const secretText = (minLength = 1) => z.string().min(minLength).regex(/^$|\S/);

/**
 * An optional secret that may also be set to the empty string, which counts as unset (for a value
 * set only during a rotation). A non-empty value must still have a visible character.
 */
export const optionalSecretText = () => z.string().regex(/^$|\S/).optional();
