import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CHECKOUT_RATE_LIMITS,
  CLAIM_RATE_LIMITS,
  checkoutRateLimitBuckets,
  claimRateLimitBuckets,
  type RateLimitBucket,
  type RateLimitCounter,
  rateLimitDecision,
  rateLimitWindowStart,
} from "../src/index.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// An instant inside a day, 30 minutes into an hour.
const DAY_START = 1_699_920_000_000;
const NOW = DAY_START + 5 * HOUR + 30 * 60_000;

const EMAIL_HASH = "e".repeat(64);
const IP_HASH = "i".repeat(64);
const KEYS = {
  workspaceId: "w1",
  emailHash: { current: EMAIL_HASH, retired: [] },
  userId: "u1",
  ipHash: { current: IP_HASH, retired: [] },
};
// The claim buckets for KEYS, written out rather than built: a top-level call to
// claimRateLimitBuckets would run at module load, where a failure fails no test.
const EMAIL_H = `email:w1:${EMAIL_HASH}:h`;
const EMAIL_D = `email:w1:${EMAIL_HASH}:d`;
const USER_H = "user:u1:h";
const IP_H = `ip:${IP_HASH}:h`;
const BUCKETS: readonly RateLimitBucket[] = [
  { bucket: EMAIL_H, windowMs: HOUR, limit: 3, retired: [] },
  { bucket: EMAIL_D, windowMs: DAY, limit: 10, retired: [] },
  { bucket: USER_H, windowMs: HOUR, limit: 5, retired: [] },
  { bucket: IP_H, windowMs: HOUR, limit: 20, retired: [] },
];

describe("claim rate limits (decision 0012, threat T5)", () => {
  it("are 3 an hour and 10 a day per email, 5 an hour per user, 20 an hour per IP", () => {
    expect(CLAIM_RATE_LIMITS).toEqual([
      { key: "email", window: "h", windowMs: HOUR, limit: 3 },
      { key: "email", window: "d", windowMs: DAY, limit: 10 },
      { key: "user", window: "h", windowMs: HOUR, limit: 5 },
      { key: "ip", window: "h", windowMs: HOUR, limit: 20 },
    ]);
  });

  it("name one bucket per key and window, the email's within its workspace", () => {
    expect(claimRateLimitBuckets(KEYS)).toEqual(BUCKETS);
  });

  // Anyone can type anyone's email: requests in one workspace must not use up its limits in
  // another (review F1). The user and IP limits stay global.
  it("scope the email's buckets to the workspace, and only those", () => {
    const other = claimRateLimitBuckets({ ...KEYS, workspaceId: "w2" }).map((b) => b.bucket);
    expect(other).toEqual([`email:w2:${EMAIL_HASH}:h`, `email:w2:${EMAIL_HASH}:d`, USER_H, IP_H]);
  });

  it("rotation/old-and-new-secret-both-accepted: name the retired keys' buckets of each limit", () => {
    const buckets = claimRateLimitBuckets({
      ...KEYS,
      emailHash: { current: EMAIL_HASH, retired: ["o1", "o2"] },
      ipHash: { current: IP_HASH, retired: ["p1"] },
    });
    expect(buckets).toEqual([
      { ...BUCKETS[0], retired: ["email:w1:o1:h", "email:w1:o2:h"] },
      { ...BUCKETS[1], retired: ["email:w1:o1:d", "email:w1:o2:d"] },
      { ...BUCKETS[2], retired: [] },
      { ...BUCKETS[3], retired: ["ip:p1:h"] },
    ]);
  });
});

describe("checkout rate limits (review F2)", () => {
  it("are 10 an hour per user and 30 an hour per IP", () => {
    expect(CHECKOUT_RATE_LIMITS).toEqual([
      { key: "user", window: "h", windowMs: HOUR, limit: 10 },
      { key: "ip", window: "h", windowMs: HOUR, limit: 30 },
    ]);
  });

  it("name their own buckets, apart from the claim request's", () => {
    const buckets = checkoutRateLimitBuckets({ userId: "u1", ipHash: KEYS.ipHash });
    expect(buckets).toEqual([
      { bucket: "checkout:user:u1:h", windowMs: HOUR, limit: 10, retired: [] },
      { bucket: `checkout:ip:${IP_HASH}:h`, windowMs: HOUR, limit: 30, retired: [] },
    ]);
    const claimBuckets = new Set(BUCKETS.map((b) => b.bucket));
    expect(buckets.some((b) => claimBuckets.has(b.bucket))).toBe(false);
  });

  it("name the retired keys' IP buckets", () => {
    const buckets = checkoutRateLimitBuckets({
      userId: "u1",
      ipHash: { current: IP_HASH, retired: ["p1"] },
    });
    expect(buckets.map((b) => b.retired)).toEqual([[], ["checkout:ip:p1:h"]]);
  });
});

describe("rateLimitWindowStart", () => {
  it("aligns windows to the epoch", () => {
    expect(rateLimitWindowStart(HOUR, NOW)).toBe(DAY_START + 5 * HOUR);
    expect(rateLimitWindowStart(DAY, NOW)).toBe(DAY_START);
    expect(rateLimitWindowStart(HOUR, DAY_START)).toBe(DAY_START);
  });
});

describe("rateLimitDecision", () => {
  const hour = DAY_START + 5 * HOUR;
  const counter = (bucket: string, count: number, windowStart = hour): RateLimitCounter => ({
    bucket,
    windowStart,
    count,
  });

  it("allows a first request and counts it in every bucket", () => {
    expect(rateLimitDecision(BUCKETS, [], NOW)).toEqual({
      allowed: true,
      counters: [
        counter(EMAIL_H, 1),
        counter(EMAIL_D, 1, DAY_START),
        counter(USER_H, 1),
        counter(IP_H, 1),
      ],
    });
  });

  it("adds to counters of the current window", () => {
    const stored = [counter(EMAIL_H, 2), counter(EMAIL_D, 4, DAY_START), counter(USER_H, 1)];
    expect(rateLimitDecision(BUCKETS, stored, NOW)).toEqual({
      allowed: true,
      counters: [
        counter(EMAIL_H, 3),
        counter(EMAIL_D, 5, DAY_START),
        counter(USER_H, 2),
        counter(IP_H, 1),
      ],
    });
  });

  it("restarts a counter from an earlier window", () => {
    const stored = [counter(EMAIL_H, 3, hour - HOUR)];
    const decision = rateLimitDecision(BUCKETS, stored, NOW);
    expect(decision).toMatchObject({ allowed: true });
    expect(decision.allowed && decision.counters[0]).toEqual(counter(EMAIL_H, 1));
  });

  it("ignores other buckets' counters", () => {
    const stored = [counter("email:other:h", 3)];
    expect(rateLimitDecision(BUCKETS, stored, NOW)).toMatchObject({ allowed: true });
  });

  it("refuses at the limit until the window ends", () => {
    const stored = [counter(EMAIL_H, 3)];
    expect(rateLimitDecision(BUCKETS, stored, NOW)).toEqual({
      allowed: false,
      retryAt: hour + HOUR,
    });
  });

  it("refuses until every exhausted window has ended", () => {
    const stored = [counter(EMAIL_D, 10, DAY_START), counter(USER_H, 5)];
    expect(rateLimitDecision(BUCKETS, stored, NOW)).toEqual({
      allowed: false,
      retryAt: DAY_START + DAY,
    });
    const reversed: RateLimitBucket[] = [BUCKETS[2], BUCKETS[1]] as RateLimitBucket[];
    expect(rateLimitDecision(reversed, stored, NOW)).toEqual({
      allowed: false,
      retryAt: DAY_START + DAY,
    });
  });

  it("rotation/old-and-new-secret-both-accepted: adds retired keys' counts of the window", () => {
    const bucket: RateLimitBucket = {
      bucket: "cur",
      windowMs: HOUR,
      limit: 5,
      retired: ["old1", "old2"],
    };
    const at = (old1: number, old2: number, cur: number, stale = 0) =>
      rateLimitDecision(
        [bucket],
        [
          counter("old1", old1),
          counter("old2", old2),
          counter("cur", cur),
          counter("old1", stale, hour - HOUR),
        ],
        NOW,
      );
    // 1 + 2 + 1 = 4 < 5: allowed, and only the current bucket is counted.
    expect(at(1, 2, 1)).toEqual({ allowed: true, counters: [counter("cur", 2)] });
    // 2 + 2 + 1 = 5: refused, though the current bucket alone is under its limit.
    expect(at(2, 2, 1)).toEqual({ allowed: false, retryAt: hour + HOUR });
    expect(at(5, 0, 0)).toEqual({ allowed: false, retryAt: hour + HOUR });
    // Retired counters from an earlier window do not count.
    expect(at(0, 0, 0, 9)).toEqual({ allowed: true, counters: [counter("cur", 1)] });
    // A bucket without retired names counts alone.
    const plain = { bucket: "cur", windowMs: HOUR, limit: 1, retired: [] };
    expect(rateLimitDecision([plain], [counter("old1", 3)], NOW)).toMatchObject({
      allowed: true,
    });
  });

  it("refuses at the IP limit", () => {
    expect(rateLimitDecision(BUCKETS, [counter(IP_H, 20)], NOW)).toEqual({
      allowed: false,
      retryAt: hour + HOUR,
    });
  });

  it("never allows more than a bucket's limit in one window", () => {
    const bucket = fc.record({
      bucket: fc.constantFrom("a", "b"),
      windowMs: fc.constantFrom(1_000, 60_000, HOUR),
      limit: fc.integer({ min: 1, max: 5 }),
      retired: fc.constant([]),
    });
    const buckets = fc.uniqueArray(bucket, {
      minLength: 1,
      maxLength: 2,
      selector: (b) => b.bucket,
    });
    // Request times, in increasing order, across a few windows.
    const times = fc
      .array(fc.integer({ min: 0, max: 3 * HOUR }), { maxLength: 60 })
      .map((ts) => ts.sort((x, y) => x - y).map((t) => DAY_START + t));
    fc.assert(
      fc.property(buckets, times, (bs, ts) => {
        let stored: RateLimitCounter[] = [];
        const allowed: number[] = [];
        for (const t of ts) {
          const decision = rateLimitDecision(bs, stored, t);
          if (!decision.allowed) {
            expect(decision.retryAt).toBeGreaterThan(t);
            continue;
          }
          allowed.push(t);
          const updated = new Map(decision.counters.map((c) => [c.bucket, c]));
          stored = [...stored.filter((c) => !updated.has(c.bucket)), ...updated.values()];
        }
        for (const { windowMs, limit } of bs) {
          const perWindow = new Map<number, number>();
          for (const t of allowed) {
            const start = rateLimitWindowStart(windowMs, t);
            perWindow.set(start, (perWindow.get(start) ?? 0) + 1);
          }
          for (const n of perWindow.values()) expect(n).toBeLessThanOrEqual(limit);
        }
      }),
    );
  });
});
