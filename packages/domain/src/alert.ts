/**
 * Conditions that need a person (decision 0014). Code logs one structured line with
 * `alert: "<name>"` for each, and a Cloudflare Monitor emails on any of them, so the names are
 * a closed vocabulary: add names, never rename them. Alert lines carry IDs and codes only.
 */
export const AlertName = {
  /** A job failed for good, ran out of attempts, or was dead-lettered. */
  JobFailed: "job_failed",
  /** A repository reached 3 consecutive reconcile failures. */
  ReconcileFailing: "reconcile_failing",
  /** A GitHub installation was suspended or deleted, or a Paddle connection became unauthorized. */
  ConnectionLost: "connection_lost",
  /** The oldest due sweep row is more than 15 minutes late. */
  SweepLagging: "sweep_lagging",
} as const;
export type AlertName = (typeof AlertName)[keyof typeof AlertName];
/** Every alert name. */
export const ALERT_NAMES = [
  AlertName.JobFailed,
  AlertName.ReconcileFailing,
  AlertName.ConnectionLost,
  AlertName.SweepLagging,
] as const;
