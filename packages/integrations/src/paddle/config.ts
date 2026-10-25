import type { PaddleEnvironment } from "@sharerepo/domain";
import { parseEnv } from "@sharerepo/platform";
import { z } from "zod";

/** Paddle Billing's API per environment; a connection's environment comes from its key. */
export const PADDLE_API_BASE_URLS = {
  sandbox: "https://sandbox-api.paddle.com",
  live: "https://api.paddle.com",
} as const satisfies Record<PaddleEnvironment, string>;

export interface PaddleConfig {
  /** Where to call Paddle for a connection in each environment. */
  readonly apiBaseUrls: Readonly<Record<PaddleEnvironment, string>>;
}

const paddleEnvSchema = z
  .object({
    ENVIRONMENT: z.enum(["development", "e2e", "production"]),
    PADDLE_API_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.ENVIRONMENT !== "e2e" && env.PADDLE_API_BASE_URL !== undefined) {
      ctx.addIssue({ code: "custom", path: ["PADDLE_API_BASE_URL"], message: "e2e only" });
    }
  });

/**
 * Paddle endpoints. `PADDLE_API_BASE_URL` points both environments at the E2E fake and is
 * accepted only when ENVIRONMENT is `e2e` (decision 0006), so a deployed Worker only ever sends
 * creators' keys to Paddle. Errors name keys and issue codes, never values.
 */
export function parsePaddleConfig(env: unknown): PaddleConfig {
  const { PADDLE_API_BASE_URL: override } = parseEnv(paddleEnvSchema, env);
  if (override === undefined) return { apiBaseUrls: PADDLE_API_BASE_URLS };
  const url = override.replace(/\/+$/, "");
  return { apiBaseUrls: { sandbox: url, live: url } };
}
