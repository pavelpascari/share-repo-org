import { env } from "cloudflare:workers";
import { simulatedEntitlementSource } from "@sharerepo/application";
import { enqueueOutbox } from "@sharerepo/db";
import { PaddleApiError } from "@sharerepo/integrations";
import { createFakeGitHubApp, type FakeGitHubApp } from "@sharerepo/integrations/testing";
import { ConflictError } from "@sharerepo/platform";
import { captureLogs, type LogCapture } from "@sharerepo/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CRONS, type JobsWorkerDeps } from "../src/handlers.ts";
import {
  act,
  DAY,
  entitlementsOf,
  refreshKey,
  type Shop,
  shop,
  subscribe,
} from "./support/commerce.ts";
import { clock, db } from "./support/github.ts";
import { deliver, jobsWorker, runCron } from "./support/worker.ts";

// Expiry confirmation at the entry points (decision 0013; phase-6 plan, T2): the cron, the queue
// and the outbox drain, over the fake GitHub App and the simulated entitlement source.

const MINUTE = 60_000;
/** Each test drives several cron ticks through the Worker; slow under a loaded machine. */
const ENTRY_POINT_TIMEOUT = 30_000;
const HOUR = 60 * MINUTE;
/** The expiry confirmation window (decision 0013). */
const WINDOW = 6 * HOUR;

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});

/** One per-minute cron tick at the clock's current instant. */
const tick = (s: Shop, overrides: Partial<JobsWorkerDeps> = {}) =>
  runCron(jobsWorker(s.github, overrides), CRONS.drainOutbox);

async function repositoryOf(s: Shop) {
  const row = await env.DB.prepare(
    "SELECT id, name_snapshot AS name FROM resources WHERE workspace_id = ?",
  )
    .bind(s.workspaceId)
    .first<{ id: string; name: string }>();
  if (row === null) throw new Error("no repository");
  return row;
}

const removals = (fake: FakeGitHubApp) =>
  fake.calls.filter(
    (call) => call.startsWith("removeCollaborator:") || call.startsWith("cancelInvitation:"),
  );

/**
 * A subscriber who is a collaborator on the shop's repository through ShareRepo: subscribed,
 * invited by the reconcile the refresh queued, accepted, and observed as active.
 */
async function collaborator(options: { gracePeriodDays?: number } = {}) {
  const s = await shop(createFakeGitHubApp({ clock }), options);
  const sub = await subscribe(s);
  const repository = await repositoryOf(s);
  await tick(s); // The refresh creates the entitlement and queues the repository's reconcile.
  clock.advance(MINUTE);
  await tick(s); // The reconcile invites.
  const [invitation] = s.github.repositoryAccess(repository.name).invitations;
  if (invitation === undefined) throw new Error("no invitation");
  s.github.acceptInvitation(repository.name, invitation.inviteeId);
  const subscriberId = invitation.inviteeId;
  // Observed as a collaborator on the next scheduled check.
  await reconcileNow(s);
  expect(await grantState(s)).toBe("active");
  const isCollaborator = () =>
    s.github
      .repositoryAccess(repository.name)
      .collaborators.some((collaborator) => collaborator.id === subscriberId);
  return { s, sub, repository, isCollaborator };
}

/** A reconcile of the shop's repository through the queue, as a webhook or the sweep asks. */
async function reconcileNow(s: Shop) {
  const repository = await repositoryOf(s);
  const subjectId = `${s.workspaceId}:${repository.id}`;
  const outboxId = `row-${crypto.randomUUID()}`;
  await enqueueOutbox(db, {
    id: outboxId,
    kind: "reconcile_resource",
    subjectId,
    createdAt: clock.now(),
    availableAt: clock.now(),
    workspaceId: s.workspaceId,
  });
  const result = await deliver(jobsWorker(s.github), [
    { kind: "reconcile_resource", subjectId, outboxId },
  ]);
  expect(result.explicitAcks).toHaveLength(1);
}

/** A refresh of the subscription through the queue, as its provider's webhook asks. */
async function refreshNow(s: Shop, subscriptionId: string) {
  const subjectId = refreshKey(s, subscriptionId);
  const outboxId = `row-${crypto.randomUUID()}`;
  await enqueueOutbox(db, {
    id: outboxId,
    kind: "refresh_subscription",
    subjectId,
    createdAt: clock.now(),
    availableAt: clock.now(),
    workspaceId: s.workspaceId,
  });
  await deliver(jobsWorker(s.github), [{ kind: "refresh_subscription", subjectId, outboxId }]);
}

/** A webhook that never arrives: its refresh is marked delivered without running. */
async function lose(outboxId: string) {
  await env.DB.prepare("UPDATE outbox SET sent_at = ? WHERE id = ?")
    .bind(clock.now(), outboxId)
    .run();
}

async function grantState(s: Shop) {
  const row = await env.DB.prepare("SELECT state FROM grants WHERE workspace_id = ?")
    .bind(s.workspaceId)
    .first<{ state: string }>();
  return row?.state;
}

describe("expiry confirmation at the entry points", () => {
  it(
    "timing/stale-workflow-cannot-revoke-renewed: a reconcile after the boundary keeps a subscriber whose renewal webhook was lost",
    async () => {
      const { s, sub, isCollaborator } = await collaborator({ gracePeriodDays: 7 });
      const pastDue = await act(s, sub.id, "mark_past_due");
      await tick(s);
      const since = pastDue.subscription.pastDueSince as number;
      const [entitlement] = await entitlementsOf(s);
      expect(entitlement).toMatchObject({ state: "active", validUntil: since + 7 * DAY });

      // The payment is recovered in the source, and the webhook that says so is lost.
      clock.advance(DAY);
      const recovered = await act(s, sub.id, "recover");
      await lose(recovered.outboxId);

      // After the old boundary, a reconcile runs before anything re-reads the source: the
      // expiry is pending, so it revokes nothing.
      clock.set(since + 7 * DAY + 30_000);
      await reconcileNow(s);
      expect(removals(s.github)).toEqual([]);
      expect(isCollaborator()).toBe(true);

      // The sweep's refresh of the boundary finds the renewal: the same entitlement goes on.
      clock.advance(30_000);
      await tick(s);
      expect(await entitlementsOf(s)).toMatchObject([
        { id: entitlement?.id, state: "active", validUntil: null, decisionReason: "active" },
      ]);
      // Past the confirmation window too: access was never revoked.
      clock.advance(WINDOW);
      await tick(s);
      await reconcileNow(s);
      expect(removals(s.github)).toEqual([]);
      expect(isCollaborator()).toBe(true);
      expect(await grantState(s)).toBe("active");
    },
    ENTRY_POINT_TIMEOUT,
  );

  it(
    "timing/renewal-during-scheduled-revocation: a renewal before the effective time keeps access at the entry points",
    async () => {
      const { s, sub, isCollaborator } = await collaborator();
      const scheduled = await act(s, sub.id, "cancel_at_period_end");
      await tick(s);
      const effective = scheduled.subscription.cancelAt as number;
      const [entitlement] = await entitlementsOf(s);
      expect(entitlement).toMatchObject({
        validUntil: effective,
        decisionReason: "cancel_scheduled",
      });

      // A day before, the subscriber renews: the source drops the cancellation and its webhook
      // arrives.
      clock.set(effective - DAY);
      await env.DB.prepare(
        "UPDATE simulated_subscriptions SET cancel_at = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?",
      )
        .bind(clock.now(), s.workspaceId, sub.id)
        .run();
      await refreshNow(s, sub.id);
      expect(await entitlementsOf(s)).toMatchObject([
        { id: entitlement?.id, state: "active", validUntil: null },
      ]);

      // The effective time passes with nothing to revoke.
      clock.set(effective + 30_000);
      await tick(s);
      clock.advance(MINUTE);
      await tick(s);
      await reconcileNow(s);
      expect(await entitlementsOf(s)).toMatchObject([{ id: entitlement?.id, state: "active" }]);
      expect(removals(s.github)).toEqual([]);
      expect(isCollaborator()).toBe(true);
    },
    ENTRY_POINT_TIMEOUT,
  );

  it(
    "timing/grace-expiry-revokes: the sweep confirms the grace expiry and the next tick revokes",
    async () => {
      const { s, sub, isCollaborator } = await collaborator({ gracePeriodDays: 7 });
      const pastDue = await act(s, sub.id, "mark_past_due");
      await tick(s);
      const since = pastDue.subscription.pastDueSince as number;

      // At the boundary the sweep refreshes the subscription: still past due, so it ends.
      clock.set(since + 7 * DAY + 30_000);
      await tick(s);
      expect(await entitlementsOf(s)).toMatchObject([
        { state: "expired", decisionReason: "grace_expired" },
      ]);
      // The refresh queued the repository's reconcile: the next tick revokes, well within the
      // confirmation window.
      clock.advance(MINUTE);
      await tick(s);
      expect(removals(s.github)).toHaveLength(1);
      expect(isCollaborator()).toBe(false);
    },
    ENTRY_POINT_TIMEOUT,
  );

  it(
    "timing/expiry-revokes-after-confirmation-window: an unreadable source revokes once the window ends",
    async () => {
      const { s, sub, isCollaborator } = await collaborator({ gracePeriodDays: 7 });
      const pastDue = await act(s, sub.id, "mark_past_due");
      await tick(s);
      const since = pastDue.subscription.pastDueSince as number;
      // From the boundary on, the source cannot be read (retryably), as in a provider outage.
      const unreadable: Partial<JobsWorkerDeps> = {
        simulatedSource: () => ({
          source: "simulated",
          refreshSubscription: () => Promise.reject(new ConflictError("source unavailable (test)")),
        }),
      };

      clock.set(since + 7 * DAY + 30_000);
      await tick(s, unreadable);
      expect(await entitlementsOf(s)).toMatchObject([{ state: "active" }]);
      // Within the window, a reconcile waits.
      clock.advance(HOUR);
      await reconcileNow(s);
      expect(removals(s.github)).toEqual([]);
      expect(isCollaborator()).toBe(true);
      const next = await env.DB.prepare(
        "SELECT next_reconcile_at AS n FROM resources WHERE workspace_id = ?",
      )
        .bind(s.workspaceId)
        .first<{ n: number }>();
      // It scheduled the bounded check for the end of the window.
      expect(next?.n).toBe(since + 7 * DAY + WINDOW);

      // The window ends: the scheduled reconcile revokes on the last known facts.
      clock.set(since + 7 * DAY + WINDOW);
      await tick(s, unreadable);
      expect(removals(s.github)).toHaveLength(1);
      expect(isCollaborator()).toBe(false);
      expect(await entitlementsOf(s)).toMatchObject([{ state: "active" }]);
    },
    ENTRY_POINT_TIMEOUT,
  );
});

/**
 * The simulated source, unreachable until `until`: every refresh fails `transient`, as a Paddle
 * outage does at the real source.
 */
const sourceDownUntil =
  (until: number): JobsWorkerDeps["simulatedSource"] =>
  (database) => {
    const source = simulatedEntitlementSource(database);
    return {
      ...source,
      refreshSubscription: (ref) =>
        clock.now() < until
          ? Promise.reject(new PaddleApiError("transient", "source down (test)"))
          : source.refreshSubscription(ref),
    };
  };

describe("provider outages at the entry points", () => {
  it(
    "an outage of the source and of GitHub across the boundary revokes no one, and the sweeps converge once both answer",
    async () => {
      const { s, sub, isCollaborator } = await collaborator({ gracePeriodDays: 7 });
      const pastDue = await act(s, sub.id, "mark_past_due");
      await tick(s);
      const boundary = (pastDue.subscription.pastDueSince as number) + 7 * DAY;
      const [entitlement] = await entitlementsOf(s);
      expect(entitlement).toMatchObject({ state: "active", validUntil: boundary });

      // The payment is recovered just before the boundary and its webhook is lost. Then the
      // source is down for three hours from the boundary, and GitHub for the first hour.
      clock.set(boundary - HOUR);
      const recovered = await act(s, sub.id, "recover");
      await lose(recovered.outboxId);
      const sourceBack = boundary + 3 * HOUR;
      s.github.outage(boundary + HOUR);
      const down = { simulatedSource: sourceDownUntil(sourceBack) };

      // Every quarter hour through the outage: the boundary refresh and the reconciles fail and
      // are retried; the entitlement is expiry pending, so nothing is revoked.
      for (clock.set(boundary); clock.now() < sourceBack; clock.advance(15 * MINUTE)) {
        await tick(s, down);
        expect(removals(s.github)).toEqual([]);
        expect(isCollaborator()).toBe(true);
      }
      expect(await entitlementsOf(s)).toMatchObject([
        { id: entitlement?.id, state: "active", validUntil: boundary },
      ]);
      expect(
        (
          await env.DB.prepare(
            "SELECT kind, attempts, last_error_code, created_at, failed_at FROM outbox WHERE workspace_id = ? AND failed_at IS NOT NULL",
          )
            .bind(s.workspaceId)
            .all()
        ).results,
      ).toEqual([]);

      // Both answer again: the retried refresh finds the renewal and the same entitlement goes
      // on, within the confirmation window. Access was never revoked.
      for (let i = 0; i < 8; i += 1) {
        clock.advance(15 * MINUTE);
        await tick(s, down);
      }
      expect(await entitlementsOf(s)).toMatchObject([
        { id: entitlement?.id, state: "active", validUntil: null, decisionReason: "active" },
      ]);
      clock.set(boundary + WINDOW + MINUTE);
      await tick(s, down);
      await reconcileNow(s);
      expect(removals(s.github)).toEqual([]);
      expect(isCollaborator()).toBe(true);
      expect(await grantState(s)).toBe("active");
    },
    ENTRY_POINT_TIMEOUT * 2,
  );
});
