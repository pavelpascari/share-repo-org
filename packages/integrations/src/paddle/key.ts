import type { PaddleEnvironment, ParseResult } from "@sharerepo/domain";
import { z } from "zod";

/**
 * A Paddle API key as Paddle issues them since 2025-05-06: 69 characters, `pdl_live_apikey_…` or
 * `pdl_sdbx_apikey_…` (research § 1). The environment comes from the prefix.
 */
export const PADDLE_API_KEY_PATTERN =
  /^pdl_(live|sdbx)_apikey_[a-z\d]{26}_[a-zA-Z\d]{22}_[a-zA-Z\d]{3}$/;

/**
 * Keys created before 2025-05-06: 50 characters, no prefix and no permissions. Refused (decision
 * 0011) because their access cannot be scoped. The exact alphabet is not documented; any
 * 50-character alphanumeric string is reported as legacy so the creator gets a useful message.
 */
const LEGACY_API_KEY_PATTERN = /^[a-zA-Z\d]{50}$/;

export interface PaddleApiKey {
  readonly key: string;
  readonly environment: PaddleEnvironment;
}

export type PaddleApiKeyError = "api_key_invalid" | "api_key_legacy";

const keySchema = z
  .string()
  .regex(PADDLE_API_KEY_PATTERN)
  .transform(
    (key): PaddleApiKey => ({ key, environment: key.startsWith("pdl_live_") ? "live" : "sandbox" }),
  );

/**
 * Validates a pasted key and derives its environment. Surrounding whitespace is trimmed (keys are
 * pasted); nothing else is altered, since keys are case-sensitive. Errors never echo the value.
 */
export function parsePaddleApiKey(value: unknown): ParseResult<PaddleApiKey, PaddleApiKeyError> {
  const trimmed = typeof value === "string" ? value.trim() : value;
  const parsed = keySchema.safeParse(trimmed);
  if (parsed.success) return { ok: true, value: parsed.data };
  const legacy = typeof trimmed === "string" && LEGACY_API_KEY_PATTERN.test(trimmed);
  return { ok: false, error: legacy ? "api_key_legacy" : "api_key_invalid" };
}
