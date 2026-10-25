import * as repo from "@sharerepo/db";
import {
  dailyOffsetMs,
  type Instant,
  OutboxKind,
  SWEEP_LAG_ALERT_INTERVAL_MS,
  sweepLag,
} from "@sharerepo/domain";
import { atOneInstant, type ServiceContext } from "./context.ts";

// The scheduled sweeps' system-wide work (phase-6 plan § Sweep health, § Partitioning): the
// health check after each minute's tick, and the daily resync spread over the day.

/** The sweep's backlog after a tick, how late it is, and whether to raise `sweep_lagging` now. */
export interface SweepHealth {
  readonly evaluationDueAt: Instant | null;
  readonly reconcileDueAt: Instant | null;
  readonly outboxDueAt: Instant | null;
  readonly lagMs: number;
  /** The oldest due row is more than 15 minutes late (decision 0014). */
  readonly lagging: boolean;
  /** This tick raises the alert: lagging, and not raised in the last 15 minutes. */
  readonly alert: boolean;
}

/**
 * Reads what is still due once the tick's sweeps and drain ran. While lagging, takes the right to
 * raise the alert, at most once per 15 minutes across ticks, replays and concurrent runs (the
 * last time is unaudited `system_state` bookkeeping). `maxAttempts`: the drain's attempt limit,
 * past which a row is a failure rather than lag.
 */
export async function checkSweepHealth(
  context: ServiceContext,
  input: { readonly maxAttempts: number },
): Promise<SweepHealth> {
  const ctx = atOneInstant(context);
  const now = ctx.clock.now();
  const backlog = await repo.readSweepBacklog(ctx.db, { now, maxAttempts: input.maxAttempts });
  const { lagMs, lagging } = sweepLag(
    [backlog.evaluationDueAt, backlog.reconcileDueAt, backlog.outboxDueAt],
    now,
  );
  const alert =
    lagging &&
    (await repo.claimSweepLagAlert(ctx.db, { now, intervalMs: SWEEP_LAG_ALERT_INTERVAL_MS }));
  return { ...backlog, lagMs, lagging, alert };
}

/**
 * The daily repair path: queues a `resync_connection` for every connection that is not deleted,
 * each available at its connection's own offset into the day (`dailyOffsetMs`), so the resyncs
 * spread over the next 24 hours instead of all calling GitHub at once. A connection whose resync
 * is still pending is not queued again. Returns how many it queued.
 */
export async function queueDailyResyncs(context: ServiceContext): Promise<number> {
  const ctx = atOneInstant(context);
  const now = ctx.clock.now();
  let queued = 0;
  for (const connection of await repo.listActiveConnectionIds(ctx.db)) {
    const row: repo.NewOutboxRow = {
      id: ctx.ids.next(),
      kind: OutboxKind.ResyncConnection,
      subjectId: connection.id,
      createdAt: now,
      availableAt: now + dailyOffsetMs(OutboxKind.ResyncConnection, connection.id),
      workspaceId: connection.workspaceId,
    };
    if (await repo.enqueueOutboxOnce(ctx.db, row)) queued += 1;
  }
  return queued;
}
