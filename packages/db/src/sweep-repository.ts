import type { Instant } from "@sharerepo/domain";
import { and, isNotNull, isNull, lt, lte, min, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { rateLimitedConnection } from "./reconcile-repository.ts";
import { outbox, resources, subscriptions, systemState } from "./schema/index.ts";

// The per-minute sweep's health (phase-6 plan § Sweep health; decision 0014): what is still due
// after a tick, and when the lag alert was last raised. Reads across every workspace, like the
// sweeps themselves, and returns instants only: never a workspace's IDs or data.

/** The oldest instant still due of each kind the sweep handles; null when none is due. */
export interface SweepBacklog {
  /** The oldest `subscriptions.next_evaluation_at` at or before now. */
  readonly evaluationDueAt: Instant | null;
  /**
   * The oldest `resources.next_reconcile_at` at or before now, of connections GitHub is not
   * rate-limiting (those wait for the reset on purpose).
   */
  readonly reconcileDueAt: Instant | null;
  /**
   * The oldest `outbox.available_at` at or before now of pending rows a drain may still claim
   * (rows that used every attempt are failures, not lag).
   */
  readonly outboxDueAt: Instant | null;
}

/** What is still due at `now`. Each query uses its column's index. */
export async function readSweepBacklog(
  db: Db,
  input: { now: Instant; maxAttempts: number },
): Promise<SweepBacklog> {
  const { now } = input;
  const [evaluation, reconcile, work] = await db.batch([
    db
      .select({ at: min(subscriptions.nextEvaluationAt) })
      .from(subscriptions)
      .where(
        and(isNotNull(subscriptions.nextEvaluationAt), lte(subscriptions.nextEvaluationAt, now)),
      ),
    db
      .select({ at: min(resources.nextReconcileAt) })
      .from(resources)
      .where(
        and(
          isNotNull(resources.nextReconcileAt),
          lte(resources.nextReconcileAt, now),
          sql`NOT ${rateLimitedConnection(now)}`,
        ),
      ),
    db
      .select({ at: min(outbox.availableAt) })
      .from(outbox)
      .where(
        and(
          isNull(outbox.sentAt),
          isNull(outbox.failedAt),
          lte(outbox.availableAt, now),
          lt(outbox.attempts, input.maxAttempts),
        ),
      ),
  ]);
  return {
    evaluationDueAt: evaluation[0]?.at ?? null,
    reconcileDueAt: reconcile[0]?.at ?? null,
    outboxDueAt: work[0]?.at ?? null,
  };
}

/** The `system_state` key holding when `sweep_lagging` was last raised (`{"at": <instant>}`). */
export const SWEEP_LAG_ALERT_STATE_KEY = "sweep.lag_alerted";

/**
 * Takes the right to raise `sweep_lagging` now: true when it was never raised, or last raised at
 * least `intervalMs` ago. One conditional upsert, so concurrent or replayed ticks raise it at most
 * once per interval. Unaudited bookkeeping (`system_state`, decision 0014).
 */
export async function claimSweepLagAlert(
  db: Db,
  input: { now: Instant; intervalMs: number },
): Promise<boolean> {
  const value = JSON.stringify({ at: input.now });
  const result = await db
    .insert(systemState)
    .values({ key: SWEEP_LAG_ALERT_STATE_KEY, value, updatedAt: input.now })
    .onConflictDoUpdate({
      target: systemState.key,
      set: { value, updatedAt: input.now },
      setWhere: lte(systemState.updatedAt, input.now - input.intervalMs),
    });
  return result.meta.changes === 1;
}
