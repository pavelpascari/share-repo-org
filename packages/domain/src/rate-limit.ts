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
 * window: `email:<workspaceId>:<hash>:h` and `email:<workspaceId>:<hash>:d` are separate
 * counters.
 */
export const CLAIM_RATE_LIMITS = [
  { key: "email", window: "h", windowMs: HOUR_MS, limit: 3 },
  { key: "email", window: "d", windowMs: DAY_MS, limit: 10 },
  { key: "user", window: "h", windowMs: HOUR_MS, limit: 5 },
  { key: "ip", window: "h", windowMs: HOUR_MS, limit: 20 },
] as const;

/**
 * The buckets one claim request counts against. `emailHash` and `ipHash` are HMACs; neither an
 * email nor an IP address ever reaches a bucket name. Anyone can type anyone's email, so the
 * email's buckets are per workspace: requests in one workspace never use up its limits in
 * another. The user and IP limits hold across workspaces.
 */
export function claimRateLimitBuckets(keys: {
  readonly workspaceId: string;
  readonly emailHash: string;
  readonly userId: string;
  readonly ipHash: string;
}): readonly RateLimitBucket[] {
  const values = {
    email: `${keys.workspaceId}:${keys.emailHash}`,
    user: keys.userId,
    ip: keys.ipHash,
  };
  return CLAIM_RATE_LIMITS.map(({ key, window, windowMs, limit }) => ({
    bucket: `${key}:${values[key]}:${window}`,
    windowMs,
    limit,
  }));
}

/**
 * The limits on starting a checkout (decision 0012, path 1): each new checkout creates a Paddle
 * transaction and a checkout claim, so a signed-in user cannot create them without bound.
 */
export const CHECKOUT_RATE_LIMITS = [
  { key: "user", window: "h", windowMs: HOUR_MS, limit: 10 },
  { key: "ip", window: "h", windowMs: HOUR_MS, limit: 30 },
] as const;

/** The buckets one new checkout counts against: `checkout:user:<id>:h` and `checkout:ip:<hash>:h`. */
export function checkoutRateLimitBuckets(keys: {
  readonly userId: string;
  readonly ipHash: string;
}): readonly RateLimitBucket[] {
  const values = { user: keys.userId, ip: keys.ipHash };
  return CHECKOUT_RATE_LIMITS.map(({ key, window, windowMs, limit }) => ({
    bucket: `checkout:${key}:${values[key]}:${window}`,
    windowMs,
    limit,
  }));
}

/** The limit on workspace exports (decision 0015): 5 an hour per workspace, for all its owners. */
export const EXPORT_RATE_LIMIT = { windowMs: HOUR_MS, limit: 5 } as const;

/** The bucket one workspace export counts against: `export:<workspaceId>:h`. */
export function exportRateLimitBuckets(workspaceId: string): readonly RateLimitBucket[] {
  return [{ bucket: `export:${workspaceId}:h`, ...EXPORT_RATE_LIMIT }];
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
 * and a counter from an earlier window is stale). This is the rule the database applies
 * atomically (`takeRateLimits` in `packages/db`, tested against this function): a request that
 * any bucket refuses changes no counter, so refused requests never use up a limit.
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
