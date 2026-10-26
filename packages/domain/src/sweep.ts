import type { Instant } from "./time.ts";

// The per-minute sweep's health and the spreading of daily work (phase-6 plan § Sweep health,
// § Partitioning; decisions 0013 and 0014).

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** How late the oldest due sweep row may be before `sweep_lagging` is raised. */
export const SWEEP_LAG_ALERT_MS = 15 * MINUTE_MS;
/** `sweep_lagging` is raised at most once per this interval while the lag lasts. */
export const SWEEP_LAG_ALERT_INTERVAL_MS = 15 * MINUTE_MS;
/**
 * How long a GitHub rate limit excuses a repository's reconcile from counting as lag: one hour,
 * GitHub's primary rate-limit window, so an installation that used its hourly budget waits out
 * one reset without an alert. A connection still rate-limited past this is stuck, and is lag.
 */
export const RATE_LIMIT_EXCUSE_MS = 60 * MINUTE_MS;

/** How far behind the sweep is: the oldest due instant's age, and whether it needs a person. */
export interface SweepLag {
  readonly lagMs: number;
  readonly lagging: boolean;
}

/**
 * The sweep's lag at `now`, from the oldest due instant of each thing it sweeps (null: nothing
 * of that kind is due). A row due at `now` is not late; one due in the future counts as none.
 */
export function sweepLag(oldestDue: readonly (Instant | null)[], now: Instant): SweepLag {
  const lags = oldestDue.map((at) => (at === null ? 0 : now - at));
  const lagMs = Math.max(0, ...lags);
  return { lagMs, lagging: lagMs > SWEEP_LAG_ALERT_MS };
}

/**
 * When a repository's reconcile is due for lag purposes (decision 0014, amended): its
 * `next_reconcile_at`, pushed back to its connection's `rate_limited_until` while GitHub
 * rate-limits the installation, but by at most {@link RATE_LIMIT_EXCUSE_MS}. A reset already in
 * the past (`rate_limited_until` only ever moves later, and is never cleared) changes nothing.
 * The sweep repositories compute the same in SQL.
 */
export function excusedReconcileDueAt(
  nextReconcileAt: Instant,
  rateLimitedUntil: Instant | null,
): Instant {
  const excusedUntil = Math.min(rateLimitedUntil ?? 0, nextReconcileAt + RATE_LIMIT_EXCUSE_MS);
  return Math.max(nextReconcileAt, excusedUntil);
}

/**
 * Where in the day one subject's daily job runs, as an offset from the daily cron: a stable hash
 * of the job's kind and subject (32-bit FNV-1a) modulo 24 hours. Daily work for many connections
 * is spread over the day instead of all starting at once, each connection at the same time every
 * day, and each kind of daily job on its own hash.
 */
export function dailyOffsetMs(kind: string, subjectId: string): number {
  const key = `${kind}:${subjectId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash % DAY_MS;
}
