import { env } from "cloudflare:workers";
import {
  findOffersForItems,
  getCustomer,
  getSimulatedSubscription,
  getSubscriptionByExternal,
  markOutboxSent,
} from "@sharerepo/db";
import { planEntitlements } from "@sharerepo/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { simulatedSnapshot } from "../src/entitlement-source.ts";
import {
  archiveOffer,
  createSimulatedSubscriber,
  type OfferSummary,
  queueDueEvaluations,
  refreshSubscription,
  SIMULATION_ACTIONS,
  type SimulationAction,
  type SourceSubscription,
  simulateSubscriptionAction,
  updateOffer,
} from "../src/index.ts";
import {
  DAY,
  drain,
  entitlementsOf,
  githubUser,
  live,
  offer,
  pendingWork,
  refresh,
  refreshRef,
  runWork,
  type Shop,
  SIMULATION,
  shop,
} from "./support/commerce.ts";
import { clock, db, serviceContext } from "./support/context.ts";

// First slice of the model-based convergence test (testing strategy § Model-based convergence):
// random simulator lifecycles, clock advances with the due-evaluation sweep, duplicate, delayed
// and reordered deliveries, replays of old snapshots, and offer edits. After every step the
// stored entitlements keep their invariants; after quiescence they equal what policy computes
// from scratch for the final facts.

const ITEMS = ["sim_a", "sim_b", "sim_c"] as const;

type Command =
  | { kind: "subscribe"; items: string[]; state: "trialing" | "active" }
  | { kind: "act"; sub: number; action: SimulationAction }
  | { kind: "advance"; ms: number }
  | { kind: "deliver"; pick: number; duplicate: boolean; markSent: boolean }
  | { kind: "replay"; sub: number; pick: number }
  | { kind: "edit"; offer: number; grace: number; resources: number[]; items: string[] }
  | { kind: "archive"; offer: number };

const subscribe: fc.Arbitrary<Command> = fc.record({
  kind: fc.constant("subscribe" as const),
  items: fc.subarray([...ITEMS], { minLength: 1 }),
  state: fc.constantFrom("trialing" as const, "active" as const),
});

const command: fc.Arbitrary<Command> = fc.oneof(
  subscribe,
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("act" as const),
      sub: fc.nat(),
      action: fc.constantFrom(...SIMULATION_ACTIONS),
    }),
  },
  fc.record({ kind: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 12 * DAY }) }),
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("deliver" as const),
      pick: fc.nat(),
      duplicate: fc.boolean(),
      markSent: fc.boolean(),
    }),
  },
  fc.record({ kind: fc.constant("replay" as const), sub: fc.nat(), pick: fc.nat() }),
  fc.record({
    kind: fc.constant("edit" as const),
    offer: fc.nat(),
    grace: fc.integer({ min: 0, max: 30 }),
    resources: fc.subarray([0, 1], { minLength: 1 }),
    items: fc.subarray([...ITEMS], { minLength: 1 }),
  }),
  fc.record({ kind: fc.constant("archive" as const), offer: fc.nat() }),
);

interface World {
  shop: Shop;
  offers: OfferSummary[];
  subs: string[];
  /** Every answer the source gave for each subscription, oldest first. */
  history: Map<string, SourceSubscription[]>;
}

const pick = <T>(items: readonly T[], index: number): T | undefined =>
  items.length === 0 ? undefined : items[index % items.length];

async function remember(world: World, id: string) {
  const row = await getSimulatedSubscription(db, { workspaceId: world.shop.workspaceId, id });
  if (row === null) throw new Error("simulated subscription vanished");
  world.history.set(id, [...(world.history.get(id) ?? []), simulatedSnapshot(row)]);
}

async function run(world: World, cmd: Command): Promise<void> {
  const s = world.shop;
  switch (cmd.kind) {
    case "subscribe": {
      const user = githubUser(s);
      const result = await createSimulatedSubscriber(
        serviceContext(),
        s,
        s.slug,
        { login: user.login, items: cmd.items, state: cmd.state, periodDays: 30 },
        { github: s.github, ...SIMULATION },
      );
      if (!result.ok) throw new Error(result.error);
      world.subs.push(result.subscription.id);
      await remember(world, result.subscription.id);
      return;
    }
    case "act": {
      const id = pick(world.subs, cmd.sub);
      if (id === undefined) return;
      await simulateSubscriptionAction(serviceContext(), s, s.slug, id, cmd.action, SIMULATION);
      await remember(world, id);
      return;
    }
    case "advance":
      clock.advance(cmd.ms);
      await queueDueEvaluations(serviceContext(), { limit: 1000 });
      return;
    case "deliver": {
      const row = pick(await pendingWork(s.workspaceId), cmd.pick);
      if (row === undefined) return;
      await runWork(row);
      if (cmd.duplicate) await runWork(row);
      if (cmd.markSent) await markOutboxSent(db, [row.id], clock.now());
      return;
    }
    case "replay": {
      const id = pick(world.subs, cmd.sub);
      const answer = id === undefined ? undefined : pick(world.history.get(id) ?? [], cmd.pick);
      if (id === undefined || answer === undefined) return;
      await refreshSubscription(serviceContext(), refreshRef(s, id), {
        source: "simulated",
        refreshSubscription: async () => answer,
      });
      return;
    }
    case "edit": {
      const target = pick(world.offers, cmd.offer);
      if (target === undefined) return;
      // Refusals (an item another offer sells, an archived offer) are part of the model.
      await updateOffer(serviceContext(), s, s.slug, target.id, {
        name: target.name,
        gracePeriodDays: cmd.grace,
        items: cmd.items.map((externalItemId) => ({ source: "simulated", externalItemId })),
        accesses: cmd.resources.map((i) => ({
          resourceId: s.resources[i]?.id,
          accessLevel: "write",
        })),
      });
      return;
    }
    case "archive": {
      const target = pick(world.offers, cmd.offer);
      if (target !== undefined) await archiveOffer(serviceContext(), s, s.slug, target.id);
      return;
    }
  }
}

async function count(query: string, ...params: string[]): Promise<number> {
  const row = await env.DB.prepare(query)
    .bind(...params)
    .first<{ n: number }>();
  return Number(row?.n);
}

/** Invariants that hold after every step, whatever is still queued. */
async function expectInvariants(workspaceId: string) {
  // Provenance: every entitlement refers to an existing offer version, policy 1, and a reason.
  expect(
    await count(
      `SELECT count(*) AS n FROM entitlements e
       LEFT JOIN offer_versions v ON v.workspace_id = e.workspace_id
         AND v.offer_id = e.offer_id AND v.version = e.offer_version
       WHERE e.workspace_id = ? AND (v.id IS NULL OR e.policy_version != 1
         OR e.source_type != 'subscription' OR length(e.decision_reason) = 0
         OR (e.valid_until IS NOT NULL AND e.valid_until <= e.valid_from))`,
      workspaceId,
    ),
  ).toBe(0);
  // At most one live entitlement per subscription, offer, repository and subscriber.
  expect(
    await count(
      `SELECT count(*) AS n FROM (SELECT 1 FROM entitlements WHERE workspace_id = ?
         AND state = 'active' GROUP BY source_id, offer_id, resource_id, subject_id
         HAVING count(*) > 1)`,
      workspaceId,
    ),
  ).toBe(0);
  // No record links across workspaces, anywhere.
  expect(
    await count(
      `SELECT count(*) AS n FROM entitlements e
       JOIN subjects s ON s.id = e.subject_id JOIN resources r ON r.id = e.resource_id
       JOIN subscriptions sub ON sub.id = e.source_id JOIN offers o ON o.id = e.offer_id
       WHERE s.workspace_id != e.workspace_id OR r.workspace_id != e.workspace_id
         OR sub.workspace_id != e.workspace_id OR o.workspace_id != e.workspace_id`,
    ),
  ).toBe(0);
  expect(
    await count(
      `SELECT count(*) AS n FROM customers c JOIN subjects s ON s.id = c.subject_id
       WHERE s.workspace_id != c.workspace_id`,
    ),
  ).toBe(0);
}

/** Live entitlements as policy computes them from scratch for the stored facts. */
async function expectedFromScratch(s: Shop, id: string) {
  const stored = await getSubscriptionByExternal(db, refreshRef(s, id));
  if (stored === null) throw new Error("subscription not recorded");
  const customer = await getCustomer(db, {
    workspaceId: s.workspaceId,
    customerId: stored.customerId,
  });
  const offers = await findOffersForItems(db, {
    workspaceId: s.workspaceId,
    source: "simulated",
    externalItemIds: stored.items,
  });
  const plan = planEntitlements({
    now: clock.now(),
    subscription: stored,
    subjectId: customer?.subjectId ?? null,
    offers: offers.map((o) => ({
      offerId: o.id,
      version: o.version,
      status: o.status,
      gracePeriodDays: o.gracePeriodDays,
      items: o.items.map((item) => item.externalItemId),
      accesses: o.accesses,
    })),
    live: [],
  });
  return plan.create.map((e) => ({
    offerId: e.offerId,
    offerVersion: e.offerVersion,
    resourceId: e.resourceId,
    subjectId: e.subjectId,
    accessLevel: e.accessLevel,
    validUntil: e.validUntil,
    decisionReason: e.decisionReason,
    policyVersion: e.policyVersion,
  }));
}

const sortedKeys = <T extends { offerId: string; resourceId: string }>(rows: T[]) =>
  [...rows].sort((a, b) =>
    `${a.offerId}/${a.resourceId}`.localeCompare(`${b.offerId}/${b.resourceId}`),
  );

describe("entitlement convergence (model, first slice)", () => {
  it("keeps invariants at every step and converges to policy from scratch", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(subscribe, { minLength: 1, maxLength: 3 }),
        fc.array(command, { minLength: 5, maxLength: 25 }),
        async (subscribers, steps) => {
          const commands = [...subscribers, ...steps];
          const s = await shop(2);
          const world: World = {
            shop: s,
            offers: [
              await offer(s, { items: ["sim_a"], resources: [s.resources[0]] as never, name: "A" }),
              await offer(s, { items: ["sim_b"], name: "B", gracePeriodDays: 3 }),
            ],
            subs: [],
            history: new Map(),
          };
          for (const cmd of commands) {
            await run(world, cmd);
            await expectInvariants(s.workspaceId);
          }

          // Quiescence: deliver everything queued, then re-evaluate every subscription now.
          await drain(s.workspaceId);
          for (const id of world.subs) await refresh(s, id);
          await drain(s.workspaceId);
          await expectInvariants(s.workspaceId);
          for (const id of world.subs) {
            const actual = live(await entitlementsOf(s.workspaceId, id)).map((e) => ({
              offerId: e.offerId,
              offerVersion: e.offerVersion,
              resourceId: e.resourceId,
              subjectId: e.subjectId,
              accessLevel: e.accessLevel,
              validUntil: e.validUntil,
              decisionReason: e.decisionReason,
              policyVersion: e.policyVersion,
            }));
            expect(sortedKeys(actual)).toEqual(sortedKeys(await expectedFromScratch(s, id)));
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 180_000);
});
