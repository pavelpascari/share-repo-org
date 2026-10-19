import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { claimDueEvaluations, type NewOutboxRow, type Subscription } from "../src/index.ts";
import { outboxRow, subscribedWorkspace } from "./support/commerce.ts";
import { count, db } from "./support/connections.ts";
import { T0 } from "./support/rows.ts";

// Far in the future so subscriptions seeded by other tests in this file are never due.
const NOW = T0 + 10 * 365 * 86_400_000;

async function scheduled(nextEvaluationAt: number | null) {
  const ws = await subscribedWorkspace({ subscription: { nextEvaluationAt } });
  return ws.subscription;
}

const nextEvaluation = async (id: string) =>
  (
    await env.DB.prepare("SELECT next_evaluation_at AS n FROM subscriptions WHERE id = ?")
      .bind(id)
      .first<{ n: number | null }>()
  )?.n;

/** Records the outbox rows a claim builds, keyed by subscription. */
function recorder() {
  const rows = new Map<string, NewOutboxRow>();
  const makeOutboxRow = (subscription: Subscription) => {
    const row = outboxRow("refresh_subscription", subscription.id);
    rows.set(subscription.id, row);
    return row;
  };
  return { rows, makeOutboxRow };
}

const queued = (subscriptionId: string) =>
  count("outbox", "kind = 'refresh_subscription' AND subject_id = ?", subscriptionId);

describe("claimDueEvaluations", () => {
  it("queues a refresh for each due subscription in any workspace and clears its schedule", async () => {
    const due = await scheduled(NOW - 10);
    const exactlyDue = await scheduled(NOW + 1_000);
    // Beyond every other test's `now` too, since storage is shared within the file.
    const notDue = await scheduled(NOW + 1e9);
    const unscheduled = await scheduled(null);
    const { rows, makeOutboxRow } = recorder();

    const claimed = await claimDueEvaluations(db, { now: NOW + 1_000, limit: 10, makeOutboxRow });

    expect(claimed).toBe(2);
    expect([...rows.keys()]).toEqual([due.id, exactlyDue.id]);
    for (const subscription of [due, exactlyDue]) {
      expect(await nextEvaluation(subscription.id)).toBeNull();
      expect(await queued(subscription.id)).toBe(1);
    }
    expect(await nextEvaluation(notDue.id)).toBe(NOW + 1e9);
    expect(await queued(notDue.id)).toBe(0);
    expect(await queued(unscheduled.id)).toBe(0);

    // Claimed once: a second sweep finds nothing new.
    await expect(
      claimDueEvaluations(db, { now: NOW + 1_000, limit: 10, makeOutboxRow }),
    ).resolves.toBe(0);
    expect(await queued(due.id)).toBe(1);
  });

  it("claims at most `limit`, earliest first", async () => {
    const later = await scheduled(NOW + 2_002);
    const earlier = await scheduled(NOW + 2_001);
    const { rows, makeOutboxRow } = recorder();
    await expect(
      claimDueEvaluations(db, { now: NOW + 2_002, limit: 1, makeOutboxRow }),
    ).resolves.toBe(1);
    expect([...rows.keys()]).toEqual([earlier.id]);
    expect(await nextEvaluation(later.id)).toBe(NOW + 2_002);
    await expect(
      claimDueEvaluations(db, { now: NOW + 2_002, limit: 1, makeOutboxRow }),
    ).resolves.toBe(1);
    expect(await queued(later.id)).toBe(1);
  });

  it("does not queue a subscription a concurrent sweep claimed after this one read it", async () => {
    const subscription = await scheduled(NOW + 3_000);
    const races: Promise<unknown>[] = [];
    const claimed = await claimDueEvaluations(db, {
      now: NOW + 3_000,
      limit: 10,
      makeOutboxRow: (row) => {
        // Runs after the read and before the batch: another sweep claims it in between.
        races.push(
          env.DB.batch([
            env.DB.prepare("UPDATE subscriptions SET next_evaluation_at = NULL WHERE id = ?").bind(
              row.id,
            ),
            env.DB.prepare(
              "INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts) VALUES (?, 'refresh_subscription', ?, 0, 0, 0)",
            ).bind(crypto.randomUUID(), row.id),
          ]),
        );
        return outboxRow("refresh_subscription", row.id);
      },
    });
    await Promise.all(races);
    expect(claimed).toBe(0);
    expect(await queued(subscription.id)).toBe(1);
  });

  it("keeps a new schedule that a concurrent refresh wrote after this sweep read", async () => {
    const subscription = await scheduled(NOW + 4_000);
    const races: Promise<unknown>[] = [];
    const claimed = await claimDueEvaluations(db, {
      now: NOW + 4_000,
      limit: 10,
      makeOutboxRow: (row) => {
        races.push(
          env.DB.prepare("UPDATE subscriptions SET next_evaluation_at = ? WHERE id = ?")
            .bind(NOW + 9_000, row.id)
            .run(),
        );
        return outboxRow("refresh_subscription", row.id);
      },
    });
    await Promise.all(races);
    expect(claimed).toBe(0);
    expect(await nextEvaluation(subscription.id)).toBe(NOW + 9_000);
    expect(await queued(subscription.id)).toBe(0);
  });

  it("returns 0 without writing when nothing is due", async () => {
    await expect(
      claimDueEvaluations(db, {
        now: T0 - 1,
        limit: 10,
        makeOutboxRow: () => {
          throw new Error("not called");
        },
      }),
    ).resolves.toBe(0);
  });
});

describe("claimDueEvaluations: repairing lapsed entitlements", () => {
  // Each test uses its own instant, since storage is shared within the file: after the earlier
  // tests' schedules (up to NOW + 4_000) and before the one they leave due (NOW + 9_000).
  const keyOf = (s: Subscription) => `${s.workspaceId}:${s.source}:${s.externalSubscriptionId}`;
  const keyed = (s: Subscription) => outboxRow("refresh_subscription", keyOf(s));
  const queuedFor = (s: Subscription, where = "1") =>
    count("outbox", `kind = 'refresh_subscription' AND subject_id = ? AND ${where}`, keyOf(s));

  /** A subscription that is not due, with a live entitlement valid until `validUntil`. */
  async function lapsing(validUntil: number, nextEvaluationAt: number | null = null) {
    const ws = await subscribedWorkspace({ subscription: { nextEvaluationAt } });
    await env.DB.prepare("UPDATE entitlements SET valid_until = ? WHERE id = ?")
      .bind(validUntil, ws.entitlement.id)
      .run();
    return ws.subscription;
  }

  it("queues a refresh for a live entitlement past its end, once while one is pending", async () => {
    const at = NOW + 5_000;
    const lapsed = await lapsing(at);
    const live = await lapsing(at + 1);
    await expect(
      claimDueEvaluations(db, { now: at, limit: 10, makeOutboxRow: keyed }),
    ).resolves.toBe(1);
    expect(await queuedFor(lapsed)).toBe(1);
    expect(await queuedFor(live)).toBe(0);

    // Pending: the minutely sweep does not queue it again.
    await expect(
      claimDueEvaluations(db, { now: at, limit: 10, makeOutboxRow: keyed }),
    ).resolves.toBe(0);
    expect(await queuedFor(lapsed)).toBe(1);

    // The refresh failed for good: the next sweep repairs it with a new row.
    await env.DB.prepare(
      "UPDATE outbox SET failed_at = ?, last_error_code = 'internal_error' WHERE kind = 'refresh_subscription' AND subject_id = ?",
    )
      .bind(at, keyOf(lapsed))
      .run();
    await expect(
      claimDueEvaluations(db, { now: at, limit: 10, makeOutboxRow: keyed }),
    ).resolves.toBe(1);
    expect(await queuedFor(lapsed, "failed_at IS NULL")).toBe(1);
  });

  it("never repairs an ended entitlement, nor one without an end", async () => {
    const at = NOW + 6_000;
    const ended = await lapsing(at - 1);
    await env.DB.prepare(
      "UPDATE entitlements SET state = 'expired', ended_at = ? WHERE source_id = ?",
    )
      .bind(at - 1, ended.id)
      .run();
    const open = await scheduled(null);
    await claimDueEvaluations(db, { now: at, limit: 10, makeOutboxRow: keyed });
    expect(await queuedFor(ended)).toBe(0);
    expect(await queuedFor(open)).toBe(0);
  });

  it("claims due subscriptions first and repairs within what is left of the limit", async () => {
    const at = NOW + 7_000;
    const due = await lapsing(at - 1, at - 1);
    const first = await lapsing(at - 1);
    const second = await lapsing(at - 1);
    const { rows, makeOutboxRow } = recorder();
    const keyedRecorder = (s: Subscription) => {
      makeOutboxRow(s);
      return keyed(s);
    };
    await expect(
      claimDueEvaluations(db, { now: at, limit: 2, makeOutboxRow: keyedRecorder }),
    ).resolves.toBe(2);
    // The due one is cleared and queued once, not again as a repair.
    expect(rows.has(due.id)).toBe(true);
    expect(await nextEvaluation(due.id)).toBeNull();
    expect(await queuedFor(due)).toBe(1);
    const repaired = [first, second].filter((s) => rows.has(s.id));
    expect(repaired).toHaveLength(1);
    await expect(
      claimDueEvaluations(db, { now: at, limit: 2, makeOutboxRow: keyed }),
    ).resolves.toBe(1);
    expect(await queuedFor(first)).toBe(1);
    expect(await queuedFor(second)).toBe(1);
  });

  it("does not repair a subscription whose refresh was queued after this sweep read it", async () => {
    const at = NOW + 8_000;
    const lapsed = await lapsing(at - 1);
    const races: Promise<unknown>[] = [];
    const claimed = await claimDueEvaluations(db, {
      now: at,
      limit: 10,
      makeOutboxRow: (row) => {
        // Runs after the read and before the batch: another sweep queues it in between.
        const work = keyed(row);
        races.push(
          env.DB.prepare(
            "INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts) VALUES (?, 'refresh_subscription', ?, 0, 0, 0)",
          )
            .bind(`${work.id}-race`, work.subjectId)
            .run(),
        );
        return work;
      },
    });
    await Promise.all(races);
    expect(claimed).toBe(0);
    expect(await queuedFor(lapsed)).toBe(1);
  });
});
