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
