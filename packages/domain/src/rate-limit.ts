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
  /**
   * The same limit's counters under claim signing keys being rotated out (Phase 6, secret
   * rotation): their counts in the current window add to this bucket's, so a rotation does not
   * reset a limit. Only `bucket` itself is counted. Empty outside a rotation.
   */
  readonly retired: readonly string[];
}

/**
 * An HMAC under the current claim signing key, and under every other key still listed while the
 * key is rotated (decision 0012 amendment). Rate limits count under `current` and consult the
 * rest.
 */
export interface KeyedHash {
  readonly current: string;
  readonly retired: readonly string[];
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
 * another. The user and IP limits hold across workspaces. Hashes under retired keys name the
 * `retired` buckets.
 */
export function claimRateLimitBuckets(keys: {
  readonly workspaceId: string;
  readonly emailHash: KeyedHash;
  readonly userId: string;
  readonly ipHash: KeyedHash;
}): readonly RateLimitBucket[] {
  const email = (hash: string) => `${keys.workspaceId}:${hash}`;
  const values = {
    email: { current: email(keys.emailHash.current), retired: keys.emailHash.retired.map(email) },
    user: { current: keys.userId, retired: [] },
    ip: keys.ipHash,
  };
  return CLAIM_RATE_LIMITS.map(({ key, window, windowMs, limit }) => ({
    bucket: `${key}:${values[key].current}:${window}`,
    windowMs,
    limit,
    retired: values[key].retired.map((value) => `${key}:${value}:${window}`),
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
  readonly ipHash: KeyedHash;
}): readonly RateLimitBucket[] {
  const values = { user: { current: keys.userId, retired: [] }, ip: keys.ipHash };
  return CHECKOUT_RATE_LIMITS.map(({ key, window, windowMs, limit }) => ({
    bucket: `checkout:${key}:${values[key].current}:${window}`,
    windowMs,
    limit,
    retired: values[key].retired.map((value) => `checkout:${key}:${value}:${window}`),
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
 * and a counter from an earlier window is stale). A bucket's `retired` counters in the same
 * window count towards its limit. This is the rule the database applies atomically
 * (`takeRateLimits` in `packages/db`, tested against this function): a request that any bucket
 * refuses changes no counter, so refused requests never use up a limit.
 */
export function rateLimitDecision(
  buckets: readonly RateLimitBucket[],
  stored: readonly RateLimitCounter[],
  now: Instant,
): RateLimitDecision {
  const counters: RateLimitCounter[] = [];
  let retryAt: Instant | null = null;
  for (const { bucket, windowMs, limit, retired } of buckets) {
    const windowStart = rateLimitWindowStart(windowMs, now);
    const countOf = (name: string) =>
      stored.find((c) => c.bucket === name && c.windowStart === windowStart)?.count ?? 0;
    const count = countOf(bucket);
    const earlier = retired.reduce((sum, name) => sum + countOf(name), 0);
    if (count + earlier >= limit) {
      retryAt = Math.max(retryAt ?? 0, windowStart + windowMs);
    }
    counters.push({ bucket, windowStart, count: count + 1 });
  }
  return retryAt === null ? { allowed: true, counters } : { allowed: false, retryAt };
}
