import { env } from "cloudflare:workers";
import {
  claimOutbox,
  findSubjectByExternalId,
  getSimulatedSubscription,
  getSubscriptionByExternal,
  listAuditEventsByCorrelationId,
} from "@sharerepo/db";
import { ConflictError } from "@sharerepo/platform";
import { expectAuditedChange, expectNoChangeOnFailure } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import { simulatedSnapshot } from "../src/entitlement-source.ts";
import {
  archiveOffer,
  createOffer,
  decodeRefreshKey,
  type EntitlementSourcePort,
  encodeRefreshKey,
  listAccess,
  queueDueEvaluations,
  recomputeOffer,
  refreshSubscription,
  type ServiceContext,
  type SourceSubscription,
  updateOffer,
} from "../src/index.ts";
import {
  act,
  DAY,
  drain,
  entitlementsOf,
  failingBatches,
  live,
  offer,
  pendingWork,
  refresh,
  refreshRef,
  runWork,
  type Shop,
  shop,
  source,
  subscribe,
} from "./support/commerce.ts";
import { clock, db, serviceContext } from "./support/context.ts";

const actions = async (correlationId: string) =>
  (await listAuditEventsByCorrelationId(db, correlationId)).map((e) => e.action);

/** A shop selling one repository for `sim_pro`, with one active subscriber, refreshed. */
async function subscribed(options: { gracePeriodDays?: number; periodDays?: number } = {}) {
  const s = await shop();
  const sold = await offer(s, { items: ["sim_pro"], gracePeriodDays: options.gracePeriodDays });
  const sub = await subscribe(s, { items: ["sim_pro"], periodDays: options.periodDays });
  await drain(s.workspaceId);
  return { shop: s, offer: sold, sub };
}

const stored = (s: Shop, id: string) => getSubscriptionByExternal(db, refreshRef(s, id));

/** The source's current answer, frozen, to replay later as an old or duplicate delivery. */
async function captured(s: Shop, id: string): Promise<SourceSubscription> {
  const row = await getSimulatedSubscription(db, { workspaceId: s.workspaceId, id });
  if (row === null) throw new Error("setup");
  return simulatedSnapshot(row);
}

const replaying = (answer: SourceSubscription): EntitlementSourcePort => ({
  source: "simulated",
  refreshSubscription: async () => answer,
});

describe("refreshSubscription", () => {
  it("records the subscription, subscriber and entitlement on first sight, audited", async () => {
    const s = await shop();
    const sold = await offer(s, { items: ["sim_pro"] });
    const sub = await subscribe(s, { items: ["sim_pro"] });
    const ctx = serviceContext();
    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      refresh(s, sub.id, ctx),
    );
    expect(result).toEqual({ outcome: "written", created: 1, updated: 0, ended: 0 });
    expect(await actions(ctx.correlationId)).toEqual([
      "subject.created",
      "customer.created",
      "customer.linked",
      "subscription.recorded",
      "entitlement.created",
    ]);
    const events = await listAuditEventsByCorrelationId(db, ctx.correlationId);
    expect(events.every((e) => e.actor.type === "system" && e.workspaceId === s.workspaceId)).toBe(
      true,
    );
    expect(await stored(s, sub.id)).toMatchObject({
      state: "active",
      providerState: "active",
      sourceUpdatedAt: sub.updatedAt,
      items: ["sim_pro"],
      version: 1,
      nextEvaluationAt: null,
    });
    expect(await entitlementsOf(s.workspaceId, sub.id)).toMatchObject([
      {
        state: "active",
        resourceId: s.resources[0]?.id,
        offerId: sold.id,
        offerVersion: 1,
        policyVersion: 1,
        accessLevel: "write",
        sourceType: "subscription",
        validUntil: null,
        decisionReason: "active",
      },
    ]);
  });

  it("propagates storage failures and writes nothing", async () => {
    const s = await shop();
    await offer(s, { items: ["sim_pro"] });
    const sub = await subscribe(s, { items: ["sim_pro"] });
    const error = await expectNoChangeOnFailure(env.DB, () =>
      refreshSubscription(failingBatches(), refreshRef(s, sub.id), source),
    );
    expect(error).toMatchObject({ message: "d1 down" });
  });

  it("is a no-op for a subscription neither the source nor ShareRepo has", async () => {
    const s = await shop();
    await expect(refresh(s, "never-existed")).resolves.toEqual({
      outcome: "absent",
      created: 0,
      updated: 0,
      ended: 0,
    });
  });

  it("refuses a source that does not match the reference", async () => {
    const s = await shop();
    await expect(
      refreshSubscription(serviceContext(), { ...refreshRef(s, "x"), source: "paddle" }, source),
    ).rejects.toThrow("does not match");
  });

  it("webhook/out-of-order-does-not-regress", async () => {
    const { shop: s, sub } = await subscribed();
    const older = await captured(s, sub.id);
    await act(s, sub.id, "pause");
    await drain(s.workspaceId);
    const newer = await captured(s, sub.id);
    const before = {
      subscription: await stored(s, sub.id),
      rows: await entitlementsOf(s.workspaceId),
    };
    expect(before.subscription?.state).toBe("paused");

    // The older snapshot arrives late: nothing changes.
    const ctx = serviceContext();
    const { result, changedTables } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      refreshSubscription(ctx, refreshRef(s, sub.id), replaying(older)),
    );
    expect(result.outcome).toBe("unchanged");
    expect(changedTables).toEqual([]);
    // A duplicate of the newest snapshot is a no-op too.
    await expect(
      refreshSubscription(serviceContext(), refreshRef(s, sub.id), replaying(newer)),
    ).resolves.toMatchObject({ outcome: "unchanged" });
    await expect(refresh(s, sub.id)).resolves.toMatchObject({ outcome: "unchanged" });
    expect({
      subscription: await stored(s, sub.id),
      rows: await entitlementsOf(s.workspaceId),
    }).toEqual(before);
  });

  it("ends entitlements when the source no longer has the subscription", async () => {
    const { shop: s, sub } = await subscribed();
    await env.DB.prepare("DELETE FROM simulated_subscriptions WHERE id = ?").bind(sub.id).run();
    const ctx = serviceContext();
    await expect(refresh(s, sub.id, ctx)).resolves.toMatchObject({ outcome: "written", ended: 1 });
    expect(await actions(ctx.correlationId)).toEqual(["entitlement.ended"]);
    expect(await entitlementsOf(s.workspaceId, sub.id)).toMatchObject([
      { state: "revoked", decisionReason: "subscription_missing" },
    ]);
    await expect(refresh(s, sub.id)).resolves.toMatchObject({ outcome: "unchanged" });
  });

  it("audits a write that only reschedules evaluation", async () => {
    const s = await shop();
    const sub = await subscribe(s, { items: ["sim_unsold"] });
    await drain(s.workspaceId);
    await env.DB.prepare(
      "UPDATE subscriptions SET next_evaluation_at = 1 WHERE external_subscription_id = ?",
    )
      .bind(sub.id)
      .run();
    const ctx = serviceContext();
    await expect(refresh(s, sub.id, ctx)).resolves.toMatchObject({ outcome: "written" });
    expect(await actions(ctx.correlationId)).toEqual(["subscription.updated"]);
    expect((await stored(s, sub.id))?.nextEvaluationAt).toBeNull();
  });

  it("links a customer to a newly reported subject, and keeps it when the source reports none", async () => {
    const { shop: s, sub } = await subscribed();
    const answer = await captured(s, sub.id);
    if (!answer.found) throw new Error("setup");
    const relinked: SourceSubscription = {
      ...answer,
      snapshot: { ...answer.snapshot, sourceUpdatedAt: answer.snapshot.sourceUpdatedAt + 1 },
      customerLink: { provider: "github", externalSubjectId: "987654321", login: "someone-else" },
    };
    const ctx = serviceContext();
    await expect(
      refreshSubscription(ctx, refreshRef(s, sub.id), replaying(relinked)),
    ).resolves.toMatchObject({ outcome: "written", created: 1, ended: 1 });
    expect(await actions(ctx.correlationId)).toEqual([
      "subject.created",
      "customer.linked",
      "subscription.updated",
      "entitlement.created",
      "entitlement.ended",
    ]);
    expect(live(await entitlementsOf(s.workspaceId))).toHaveLength(1);
    const [ended] = (await entitlementsOf(s.workspaceId)).filter((e) => e.state !== "active");
    expect(ended?.decisionReason).toBe("customer_unlinked");

    // A source that knows no link (as Paddle) leaves the claimed link alone.
    const unlinked: SourceSubscription = {
      ...relinked,
      snapshot: { ...relinked.snapshot, sourceUpdatedAt: relinked.snapshot.sourceUpdatedAt + 1 },
      customerLink: null,
    };
    const after = serviceContext();
    await refreshSubscription(after, refreshRef(s, sub.id), replaying(unlinked));
    expect(await actions(after.correlationId)).toEqual(["subscription.updated"]);
    expect(live(await entitlementsOf(s.workspaceId))).toHaveLength(1);
  });

  it("records a customer the source does not link, without access", async () => {
    const s = await shop();
    await offer(s, { items: ["sim_pro"] });
    const sub = await subscribe(s, { items: ["sim_pro"] });
    const answer = await captured(s, sub.id);
    const ctx = serviceContext();
    await refreshSubscription(
      ctx,
      refreshRef(s, sub.id),
      replaying({ ...answer, customerLink: null } as SourceSubscription),
    );
    expect(await actions(ctx.correlationId)).toEqual(["customer.created", "subscription.recorded"]);
    expect(await entitlementsOf(s.workspaceId)).toEqual([]);
  });

  it("updates the subject's login snapshot when the source reports a renamed account", async () => {
    const { shop: s, sub } = await subscribed();
    const answer = await captured(s, sub.id);
    if (!answer.found || answer.customerLink === null) throw new Error("setup");
    const renamed: SourceSubscription = {
      ...answer,
      snapshot: { ...answer.snapshot, sourceUpdatedAt: answer.snapshot.sourceUpdatedAt + 1 },
      customerLink: { ...answer.customerLink, login: "renamed-login" },
    };
    const ctx = serviceContext();
    await refreshSubscription(ctx, refreshRef(s, sub.id), replaying(renamed));
    const events = await listAuditEventsByCorrelationId(db, ctx.correlationId);
    expect(events.map((e) => e.action)).toEqual(["subject.login_updated", "subscription.updated"]);
    expect(events[0]?.details).toEqual({
      provider: "github",
      externalSubjectId: answer.customerLink.externalSubjectId,
      previousLogin: answer.customerLink.login,
      login: "renamed-login",
    });
    const subject = await findSubjectByExternalId(db, {
      workspaceId: s.workspaceId,
      provider: "github",
      externalSubjectId: answer.customerLink.externalSubjectId,
    });
    expect(subject?.loginSnapshot).toBe("renamed-login");
    // The same subject keeps its access; a repeat reports nothing new.
    expect(live(await entitlementsOf(s.workspaceId))).toMatchObject([{ subjectId: subject?.id }]);
    const again = serviceContext();
    await refreshSubscription(again, refreshRef(s, sub.id), replaying(renamed));
    expect(await actions(again.correlationId)).toEqual([]);
  });

  it("refreshes a subscription carrying more items than D1 binds in one statement", async () => {
    const s = await shop();
    await offer(s, { items: ["sim_099"] });
    const items = Array.from({ length: 100 }, (_, i) => `sim_${String(i).padStart(3, "0")}`);
    const sub = await subscribe(s, { items });
    await expect(refresh(s, sub.id)).resolves.toMatchObject({ outcome: "written", created: 1 });
    expect(live(await entitlementsOf(s.workspaceId))).toHaveLength(1);
  });

  /** A port that lets `during` run between the refresh's read of the source and its write. */
  function racing(during: () => Promise<unknown>): EntitlementSourcePort {
    let remaining = 1;
    return {
      source: "simulated",
      async refreshSubscription(ref) {
        const answer = await source.refreshSubscription(ref);
        if (remaining > 0) {
          remaining -= 1;
          await during();
        }
        return answer;
      },
    };
  }

  it("retries from fresh state when another refresh wrote in between", async () => {
    const { shop: s, sub } = await subscribed();
    await act(s, sub.id, "pause");
    const port = racing(() => refresh(s, sub.id));
    await expect(
      refreshSubscription(serviceContext(), refreshRef(s, sub.id), port),
    ).resolves.toMatchObject({ outcome: "unchanged" });
    expect(live(await entitlementsOf(s.workspaceId))).toEqual([]);
  });

  it("gives up with a retryable conflict when the subscription keeps changing", async () => {
    const { shop: s, sub } = await subscribed();
    let paused = false;
    // Every attempt reads a snapshot newer than anything stored, and every time another
    // refresh records a change before the attempt can write.
    const port: EntitlementSourcePort = {
      source: "simulated",
      async refreshSubscription(ref) {
        const answer = await source.refreshSubscription(ref);
        paused = !paused;
        await act(s, sub.id, paused ? "pause" : "resume");
        await refresh(s, sub.id);
        if (!answer.found) throw new Error("setup");
        return {
          ...answer,
          snapshot: { ...answer.snapshot, sourceUpdatedAt: answer.snapshot.sourceUpdatedAt + DAY },
        };
      },
    };
    await expect(
      refreshSubscription(serviceContext(), refreshRef(s, sub.id), port),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("converges when two first refreshes race for the subscriber and subscription", async () => {
    const s = await shop();
    await offer(s, { items: ["sim_pro"] });
    const sub = await subscribe(s, { items: ["sim_pro"] });
    let arrived = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port: EntitlementSourcePort = {
      source: "simulated",
      async refreshSubscription(ref) {
        const answer = await source.refreshSubscription(ref);
        arrived += 1;
        if (arrived === 2) release();
        await barrier;
        return answer;
      },
    };
    const results = await Promise.all([
      refreshSubscription(serviceContext(), refreshRef(s, sub.id), port),
      refreshSubscription(serviceContext(), refreshRef(s, sub.id), port),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["unchanged", "written"]);
    const subjects = await env.DB.prepare(
      "SELECT count(*) AS n FROM subjects WHERE workspace_id = ?",
    )
      .bind(s.workspaceId)
      .first<{ n: number }>();
    expect(subjects?.n).toBe(1);
    expect(live(await entitlementsOf(s.workspaceId))).toHaveLength(1);
  });
});

describe("offer changes racing a refresh", () => {
  /**
   * A service context whose refresh write (the batch that replaces the subscription's items)
   * first lets `during` run, once: after the refresh read the offers, before it writes.
   */
  function racingWrite(during: () => Promise<unknown>): ServiceContext {
    let pending = true;
    const racing = new Proxy(db, {
      get: (target, property, receiver) => {
        if (property !== "batch") return Reflect.get(target, property, receiver);
        return async (statements: { toSQL(): { sql: string } }[]) => {
          if (pending && statements.some((st) => st.toSQL().sql.includes('"subscription_items"'))) {
            pending = false;
            await during();
          }
          return target.batch(statements as never);
        };
      },
    });
    return { ...serviceContext(), db: racing };
  }

  it("does not record access under an offer archived (and recomputed) between read and write", async () => {
    const s = await shop();
    const sold = await offer(s, { items: ["sim_pro"] });
    // A new subscription: the recompute below cannot find it, since it is not recorded yet.
    const sub = await subscribe(s, { items: ["sim_pro"] });
    let recomputed = -1;
    const ctx = racingWrite(async () => {
      await archiveOffer(serviceContext(), s, s.slug, sold.id);
      recomputed = await recomputeOffer(serviceContext(), {
        workspaceId: s.workspaceId,
        offerId: sold.id,
      });
    });
    await expect(refresh(s, sub.id, ctx)).resolves.toMatchObject({
      outcome: "written",
      created: 0,
    });
    expect(recomputed).toBe(0);
    expect(await entitlementsOf(s.workspaceId)).toEqual([]);
  });

  it("grants access under an offer created (and recomputed) between read and write", async () => {
    const s = await shop();
    const sub = await subscribe(s, { items: ["sim_late"] });
    const ctx = racingWrite(async () => {
      const created = await offer(s, { items: ["sim_late"] });
      await recomputeOffer(serviceContext(), { workspaceId: s.workspaceId, offerId: created.id });
    });
    await expect(refresh(s, sub.id, ctx)).resolves.toMatchObject({
      outcome: "written",
      created: 1,
    });
    expect(live(await entitlementsOf(s.workspaceId))).toHaveLength(1);
  });

  it("applies an edit to an existing subscription's offer made between read and write", async () => {
    const { shop: s, offer: sold, sub } = await subscribed({ gracePeriodDays: 7 });
    await act(s, sub.id, "mark_past_due");
    const ctx = racingWrite(() =>
      updateOffer(serviceContext(), s, s.slug, sold.id, {
        name: "Pro",
        gracePeriodDays: 3,
        items: [{ source: "simulated", externalItemId: "sim_pro" }],
        accesses: [{ resourceId: s.resources[0]?.id, accessLevel: "write" }],
      }),
    );
    await refresh(s, sub.id, ctx);
    expect(live(await entitlementsOf(s.workspaceId))).toMatchObject([
      { offerVersion: 2, decisionReason: "past_due_in_grace" },
    ]);
  });
});

describe("a subscription recorded before its offer existed", () => {
  it("gains access once an offer selling its item is created", async () => {
    const s = await shop();
    const sub = await subscribe(s, { items: ["sim_early"] });
    await drain(s.workspaceId);
    expect(await entitlementsOf(s.workspaceId)).toEqual([]);
    // Open-ended and active: nothing is scheduled to look at it again.
    expect((await stored(s, sub.id))?.nextEvaluationAt).toBeNull();

    await offer(s, { items: ["sim_early"] });
    await drain(s.workspaceId);
    expect(live(await entitlementsOf(s.workspaceId, sub.id))).toMatchObject([
      { decisionReason: "active", validUntil: null },
    ]);
  });

  it("gains access from a new offer reusing an archived offer's item", async () => {
    const { shop: s, offer: sold, sub } = await subscribed();
    await archiveOffer(serviceContext(), s, s.slug, sold.id);
    await drain(s.workspaceId);
    expect(live(await entitlementsOf(s.workspaceId))).toEqual([]);
    const result = await createOffer(serviceContext(), s, s.slug, {
      name: "Pro 2",
      gracePeriodDays: 7,
      items: [{ source: "simulated", externalItemId: "sim_pro" }],
      accesses: [{ resourceId: s.resources[0]?.id, accessLevel: "write" }],
    });
    expect(result.ok).toBe(true);
    await drain(s.workspaceId);
    expect(live(await entitlementsOf(s.workspaceId, sub.id))).toHaveLength(1);
  });
});

describe("entitlement lifecycle", () => {
  it("creates, extends, expires and removes entitlements as the subscription changes", async () => {
    const { shop: s, sub } = await subscribed({ gracePeriodDays: 7 });
    const [first] = live(await entitlementsOf(s.workspaceId));
    expect(first).toMatchObject({ validUntil: null, decisionReason: "active" });

    // Past due: access continues within the grace period.
    const pastDue = await act(s, sub.id, "mark_past_due");
    await drain(s.workspaceId);
    expect(live(await entitlementsOf(s.workspaceId))).toMatchObject([
      {
        id: first?.id,
        validUntil: (pastDue.pastDueSince as number) + 7 * DAY,
        decisionReason: "past_due_in_grace",
      },
    ]);
    // Recovery extends it again, open-ended, on the same row.
    await act(s, sub.id, "recover");
    await drain(s.workspaceId);
    expect(live(await entitlementsOf(s.workspaceId))).toMatchObject([
      { id: first?.id, validUntil: null, decisionReason: "active" },
    ]);
    // Renewal changes nothing about access.
    await act(s, sub.id, "renew");
    const renewed = serviceContext();
    await expect(refresh(s, sub.id, renewed)).resolves.toMatchObject({ created: 0, updated: 0 });
    expect(await actions(renewed.correlationId)).toEqual(["subscription.updated"]);
    // Pausing removes it.
    await act(s, sub.id, "pause");
    await drain(s.workspaceId);
    expect(await entitlementsOf(s.workspaceId)).toMatchObject([
      { id: first?.id, state: "revoked", decisionReason: "paused" },
    ]);
  });

  it("expires access when the subscription is canceled now, and reactivation creates a new entitlement", async () => {
    const { shop: s, sub } = await subscribed();
    const [first] = live(await entitlementsOf(s.workspaceId));
    await act(s, sub.id, "cancel_now");
    const ctx = serviceContext();
    await refresh(s, sub.id, ctx);
    expect(await actions(ctx.correlationId)).toEqual(["subscription.updated", "entitlement.ended"]);
    expect(await entitlementsOf(s.workspaceId)).toMatchObject([
      { id: first?.id, state: "expired", decisionReason: "canceled" },
    ]);

    await act(s, sub.id, "reactivate");
    await drain(s.workspaceId);
    const rows = await entitlementsOf(s.workspaceId);
    expect(rows).toHaveLength(2);
    expect(rows.find((e) => e.id === first?.id)?.state).toBe("expired");
    expect(live(rows)).toMatchObject([{ decisionReason: "active", validUntil: null }]);
    expect(live(rows)[0]?.id).not.toBe(first?.id);
  });

  it("removes access when the offer stops including the repository", async () => {
    const s = await shop(2);
    const sold = await offer(s, { items: ["sim_pro"] });
    const sub = await subscribe(s, { items: ["sim_pro"] });
    await drain(s.workspaceId);
    expect(live(await entitlementsOf(s.workspaceId))).toHaveLength(2);
    const [kept] = s.resources;
    const updated = await updateOffer(serviceContext(), s, s.slug, sold.id, {
      name: "Pro",
      gracePeriodDays: 7,
      items: [{ source: "simulated", externalItemId: "sim_pro" }],
      accesses: [{ resourceId: kept?.id, accessLevel: "write" }],
    });
    expect(updated.ok).toBe(true);
    await drain(s.workspaceId);
    const rows = await entitlementsOf(s.workspaceId, sub.id);
    expect(live(rows)).toMatchObject([{ resourceId: kept?.id, offerVersion: 2 }]);
    expect(rows.find((e) => e.state === "revoked")?.decisionReason).toBe("offer_access_removed");
  });

  it("removes access when the offer is archived, via recomputeOffer", async () => {
    const { shop: s, offer: sold, sub } = await subscribed();
    await archiveOffer(serviceContext(), s, s.slug, sold.id);
    const [work] = await pendingWork(s.workspaceId);
    expect(work?.kind).toBe("recompute_offer");
    await expect(
      recomputeOffer(serviceContext(), { workspaceId: s.workspaceId, offerId: sold.id }),
    ).resolves.toBe(1);
    await drain(s.workspaceId);
    expect(await entitlementsOf(s.workspaceId, sub.id)).toMatchObject([
      { state: "revoked", decisionReason: "offer_archived" },
    ]);
    // The archive released the item and no entitlement is live: later recomputes find nothing.
    await expect(
      recomputeOffer(serviceContext(), { workspaceId: s.workspaceId, offerId: sold.id }),
    ).resolves.toBe(0);
    await drain(s.workspaceId);
    expect(live(await entitlementsOf(s.workspaceId))).toEqual([]);
  });

  it("queues nothing for an offer no subscription carries", async () => {
    const s = await shop();
    const sold = await offer(s, { items: ["sim_none"] });
    await expect(
      recomputeOffer(serviceContext(), { workspaceId: s.workspaceId, offerId: sold.id }),
    ).resolves.toBe(0);
  });

  it("applies a changed grace period to past-due access on the next recompute", async () => {
    const { shop: s, offer: sold, sub } = await subscribed({ gracePeriodDays: 7 });
    const pastDue = await act(s, sub.id, "mark_past_due");
    await drain(s.workspaceId);
    const since = pastDue.pastDueSince as number;
    expect(live(await entitlementsOf(s.workspaceId))).toMatchObject([
      { validUntil: since + 7 * DAY, offerVersion: 1 },
    ]);
    await updateOffer(serviceContext(), s, s.slug, sold.id, {
      name: "Pro",
      gracePeriodDays: 3,
      items: [{ source: "simulated", externalItemId: "sim_pro" }],
      accesses: [{ resourceId: s.resources[0]?.id, accessLevel: "write" }],
    });
    await drain(s.workspaceId);
    expect(live(await entitlementsOf(s.workspaceId))).toMatchObject([
      { validUntil: since + 3 * DAY, offerVersion: 2, decisionReason: "past_due_in_grace" },
    ]);
    expect((await stored(s, sub.id))?.nextEvaluationAt).toBe(since + 3 * DAY);
  });
});

describe("time-based evaluation", () => {
  /** Runs the sweep, then the queued work, as the cron and jobs Worker will. */
  async function sweep(s: Shop) {
    const queued = await queueDueEvaluations(serviceContext(), { limit: 1000 });
    const ours = (await pendingWork(s.workspaceId)).length;
    await drain(s.workspaceId);
    return { queued, ours };
  }

  it("timing/cancellation-revokes-at-effective-time", async () => {
    const { shop: s, sub } = await subscribed({ periodDays: 30 });
    const scheduled = await act(s, sub.id, "cancel_at_period_end");
    await drain(s.workspaceId);
    const effective = scheduled.cancelAt as number;
    expect(live(await entitlementsOf(s.workspaceId))).toMatchObject([
      { validUntil: effective, decisionReason: "cancel_scheduled" },
    ]);
    expect((await stored(s, sub.id))?.nextEvaluationAt).toBe(effective);

    clock.set(effective - 1);
    expect((await sweep(s)).ours).toBe(0);
    expect(live(await entitlementsOf(s.workspaceId))).toHaveLength(1);

    clock.set(effective);
    // Before the sweep, the access view already treats the access as over.
    const [row] = await listAccess(serviceContext(), s, s.slug);
    expect(row?.planned).toBeNull();
    const { queued, ours } = await sweep(s);
    expect([queued >= 1, ours]).toEqual([true, 1]);
    expect(await entitlementsOf(s.workspaceId)).toMatchObject([
      { state: "expired", decisionReason: "cancellation_effective" },
    ]);
    expect((await stored(s, sub.id))?.nextEvaluationAt).toBeNull();
  });

  it("timing/past-due-within-grace-keeps-access", async () => {
    const { shop: s, sub } = await subscribed({ gracePeriodDays: 7 });
    const pastDue = await act(s, sub.id, "mark_past_due");
    await drain(s.workspaceId);
    clock.set((pastDue.pastDueSince as number) + 6 * DAY);
    expect((await sweep(s)).ours).toBe(0);
    expect(live(await entitlementsOf(s.workspaceId))).toMatchObject([
      { decisionReason: "past_due_in_grace" },
    ]);
    const [row] = await listAccess(serviceContext(), s, s.slug);
    expect(row?.planned).toEqual({ action: "provision", reason: "grant_missing" });
  });

  it("repairs a lapsed entitlement whose scheduled evaluation was lost, queueing it once", async () => {
    const { shop: s, sub } = await subscribed({ periodDays: 30 });
    const scheduled = await act(s, sub.id, "cancel_at_period_end");
    await drain(s.workspaceId);
    const effective = scheduled.cancelAt as number;
    // A sweep claimed the evaluation and its refresh then failed for good.
    await env.DB.prepare(
      "UPDATE subscriptions SET next_evaluation_at = NULL WHERE workspace_id = ?",
    )
      .bind(s.workspaceId)
      .run();
    clock.set(effective + 60_000);
    await queueDueEvaluations(serviceContext(), { limit: 1000 });
    const work = await pendingWork(s.workspaceId);
    expect(work.map((row) => row.subject_id)).toEqual([encodeRefreshKey(refreshRef(s, sub.id))]);
    // Already queued, under the key the application encodes: not queued again.
    await queueDueEvaluations(serviceContext(), { limit: 1000 });
    expect(await pendingWork(s.workspaceId)).toHaveLength(1);
    await drain(s.workspaceId);
    expect(await entitlementsOf(s.workspaceId)).toMatchObject([
      { state: "expired", decisionReason: "cancellation_effective" },
    ]);
  });

  it("timing/grace-expiry-revokes", async () => {
    const { shop: s, sub } = await subscribed({ gracePeriodDays: 7 });
    const pastDue = await act(s, sub.id, "mark_past_due");
    await drain(s.workspaceId);
    clock.set((pastDue.pastDueSince as number) + 7 * DAY);
    expect((await sweep(s)).ours).toBe(1);
    expect(await entitlementsOf(s.workspaceId)).toMatchObject([
      { state: "expired", decisionReason: "grace_expired" },
    ]);
  });
});

describe("outbox recovery", () => {
  it("crash/between-event-commit-and-enqueue", async () => {
    const s = await shop();
    await offer(s, { items: ["sim_pro"] });
    // The simulator action commits its outbox row; the queue send after it never happens.
    const sub = await subscribe(s, { items: ["sim_pro"] });
    expect(await entitlementsOf(s.workspaceId)).toEqual([]);

    // The outbox drain later claims the committed row and the work converges.
    const claimed = await claimOutbox(db, {
      now: clock.now(),
      limit: 1000,
      leaseMs: 60_000,
      maxAttempts: 10,
    });
    const ours = claimed.filter(
      (row) => decodeRefreshKey(row.subjectId).ok && row.subjectId.startsWith(`${s.workspaceId}:`),
    );
    expect(ours.map((row) => row.kind)).toEqual(["refresh_subscription"]);
    const [row] = ours;
    if (row === undefined) throw new Error("no claimed row");
    await runWork({ kind: row.kind, subject_id: row.subjectId });
    expect(live(await entitlementsOf(s.workspaceId, sub.id))).toHaveLength(1);
    // Redelivering the same row (the claimer crashed before marking it sent) changes nothing.
    const before = await entitlementsOf(s.workspaceId);
    await runWork({ kind: row.kind, subject_id: row.subjectId });
    expect(await entitlementsOf(s.workspaceId)).toEqual(before);
  });
});
