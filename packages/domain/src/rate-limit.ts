import type { Instant } from "./time.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * One fixed-window limit: at most `limit` requests in each `windowMs` window, counted in one
 * stored bucket. Windows are aligned to the epoch, so concurrent writers agree on a window's start.
 */
export interface RateLimitBucket {
  /** The stored counter's key. It names the window too, since one key holds one counter. */
  readonly bucket: string;
  readonly windowMs: number;
  readonly limit: number;
}

/** A stored counter (`claim_rate_limits`): requests counted in the window starting at `windowStart`. */
export interface RateLimitCounter {
  readonly bucket: string;
  readonly windowStart: Instant;
  readonly count: number;
}

/**
 * The claim request limits (decision 0012, threat T5), as data. Each key's suffix names its
 * window: `email:<hash>:h` and `email:<hash>:d` are separate counters.
 */
export const CLAIM_RATE_LIMITS = [
  { key: "email", window: "h", windowMs: HOUR_MS, limit: 3 },
  { key: "email", window: "d", windowMs: DAY_MS, limit: 10 },
  { key: "user", window: "h", windowMs: HOUR_MS, limit: 5 },
  { key: "ip", window: "h", windowMs: HOUR_MS, limit: 20 },
] as const;

/**
 * The buckets one claim request counts against. `emailHash` and `ipHash` are HMACs; neither an
 * email nor an IP address ever reaches a bucket name.
 */
export function claimRateLimitBuckets(keys: {
  readonly emailHash: string;
  readonly userId: string;
  readonly ipHash: string;
}): readonly RateLimitBucket[] {
  const values = { email: keys.emailHash, user: keys.userId, ip: keys.ipHash };
  return CLAIM_RATE_LIMITS.map(({ key, window, windowMs, limit }) => ({
    bucket: `${key}:${values[key]}:${window}`,
    windowMs,
    limit,
  }));
}

/** The start of the window containing `now`. */
export function rateLimitWindowStart(windowMs: number, now: Instant): Instant {
  return now - (now % windowMs);
}

/**
 * The outcome of one request against its buckets. An allowed request counts against every
 * bucket, and `counters` are the rows to write; a refused one counts against none, and `retryAt`
 * is when every exhausted bucket's window has ended.
 */
export type RateLimitDecision =
  | { readonly allowed: true; readonly counters: readonly RateLimitCounter[] }
  | { readonly allowed: false; readonly retryAt: Instant };

/**
 * Decides one request against `buckets`, given the stored counters (missing ones count as zero,
 * and a counter from an earlier window is stale). Writers must apply `counters` with a guarded
 * upsert (`count < limit` within the same window) so concurrent requests cannot overshoot.
 */
export function rateLimitDecision(
  buckets: readonly RateLimitBucket[],
  stored: readonly RateLimitCounter[],
  now: Instant,
): RateLimitDecision {
  const counters: RateLimitCounter[] = [];
  let retryAt: Instant | null = null;
  for (const { bucket, windowMs, limit } of buckets) {
    const windowStart = rateLimitWindowStart(windowMs, now);
    const current = stored.find((c) => c.bucket === bucket && c.windowStart === windowStart);
    const count = current?.count ?? 0;
    if (count >= limit) {
      retryAt = Math.max(retryAt ?? 0, windowStart + windowMs);
    }
    counters.push({ bucket, windowStart, count: count + 1 });
  }
  return retryAt === null ? { allowed: true, counters } : { allowed: false, retryAt };
}
