import type { Instant } from "./time.ts";

// The per-minute sweep's health and the spreading of daily work (phase-6 plan § Sweep health,
// § Partitioning; decisions 0013 and 0014).

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** How late the oldest due sweep row may be before `sweep_lagging` is raised. */
export const SWEEP_LAG_ALERT_MS = 15 * MINUTE_MS;
/** `sweep_lagging` is raised at most once per this interval while the lag lasts. */
export const SWEEP_LAG_ALERT_INTERVAL_MS = 15 * MINUTE_MS;

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
