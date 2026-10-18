import { parseEnv } from "@sharerepo/platform";
import { z } from "zod";

const webEnvSchema = z.object({
  DB: z.custom<D1Database>(isD1Binding),
  ENVIRONMENT: z.enum(["development", "e2e", "production"]),
});

/** The bindings and vars this Worker relies on, after validation. Unvalidated keys are dropped. */
export type WebEnv = z.output<typeof webEnvSchema>;

/** Validates the Worker env; failures name keys and issue codes, never values. */
export function parseWebEnv(env: unknown): WebEnv {
  return parseEnv(webEnvSchema, env);
}

function isD1Binding(value: unknown): value is D1Database {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function"
  );
}
