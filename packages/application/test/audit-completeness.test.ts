import { env } from "cloudflare:workers";
import {
  changedTables,
  expectAuditedChange,
  expectNoChangeOnFailure,
  snapshotTables,
  UNAUDITED_TABLES,
} from "@sharerepo/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addWorkspaceMember,
  archiveOffer,
  createOffer,
  createSimulatedSubscriber,
  createUserForSignIn,
  createWorkspace,
  type ProviderProfile,
  queueDueEvaluations,
  recomputeOffer,
  recordSignIn,
  recordSignOut,
  refreshSubscription,
  renameWorkspace,
  type ServiceContext,
  simulateSubscriptionAction,
  updateOffer,
} from "../src/index.ts";
import {
  act,
  DAY,
  drain,
  entitlementsOf,
  failingBatches,
  githubUser,
  live,
  memberOf,
  offer,
  refresh,
  refreshRef,
  SIMULATION,
  shop,
  source,
  subscribe,
} from "./support/commerce.ts";
import { clock, githubProfile, login, serviceContext, uniqueSlug } from "./support/context.ts";

// Scenario audit/every-state-change-has-audit-event: random sequences of every state-changing
// service, including invalid, conflicting and unauthorized calls. After each call, either an
// audited table changed and an audit event carries the call's correlation ID, or the call
// changed nothing (a rejected or no-op call). A thrown error never leaves a partial change.

interface World {
  users: { userId: string; profile: ProviderProfile }[];
  slugs: string[];
}

type Command = (ctx: ServiceContext, world: World) => Promise<unknown>;

const pick = <T>(items: readonly T[], index: number): T | undefined =>
  items.length === 0 ? undefined : items[index % items.length];

const command = fc.oneof(
  fc.constant<Command>(async (ctx, world) => {
    const { userId } = await createUserForSignIn(ctx);
    const profile = githubProfile();
    world.users.push({ userId, profile });
    return userId;
  }),
  fc.tuple(fc.nat(), fc.boolean()).map(
    ([i, rename]): Command =>
      async (ctx, world) => {
        const user = pick(world.users, i);
        if (user === undefined) return;
        if (rename) user.profile = { ...user.profile, username: login(`renamed-${i % 1000}`) };
        return recordSignIn(ctx, user, user.profile);
      },
  ),
  fc.tuple(fc.nat(), fc.nat()).map(
    ([i, j]): Command =>
      async (ctx, world) => {
        // A second account for a user, or another user's account: both must be refused cleanly.
        const user = pick(world.users, i);
        const other = pick(world.users, j);
        if (user === undefined || other === undefined) return;
        return recordSignIn(ctx, user, user === other ? githubProfile() : other.profile);
      },
  ),
  fc.nat().map(
    (i): Command =>
      async (ctx, world) => {
        const user = pick(world.users, i);
        if (user !== undefined) await recordSignOut(ctx, user);
      },
  ),
  fc.tuple(fc.nat(), fc.constantFrom("Acme", "", "x".repeat(101)), fc.nat()).map(
    ([i, name, s]): Command =>
      async (ctx, world) => {
        const user = pick(world.users, i);
        if (user === undefined) return;
        // Sometimes reuse a slug, so the slug_taken path is exercised.
        const slug = s % 3 === 0 ? (pick(world.slugs, s) ?? uniqueSlug()) : uniqueSlug();
        const result = await createWorkspace(ctx, user, { name, slug });
        if (result.ok) world.slugs.push(result.workspace.slug);
        return result;
      },
  ),
  fc.tuple(fc.nat(), fc.nat(), fc.constantFrom("Renamed", "", "Acme")).map(
    ([i, s, name]): Command =>
      async (ctx, world) => {
        const user = pick(world.users, i);
        const slug = pick(world.slugs, s);
        if (user === undefined || slug === undefined) return;
        return renameWorkspace(ctx, user, slug, { name });
      },
  ),
  fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.constantFrom("owner", "member")).map(
    ([i, j, s, role]): Command =>
      async (ctx, world) => {
        const actor = pick(world.users, i);
        const member = pick(world.users, j);
        const slug = pick(world.slugs, s);
        if (actor === undefined || member === undefined || slug === undefined) return;
        return addWorkspaceMember(ctx, actor, slug, { userId: member.userId, role });
      },
  ),
);

async function auditCount(correlationId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM audit_events WHERE correlation_id = ?",
  )
    .bind(correlationId)
    .first<{ n: number }>();
  return Number(row?.n);
}

describe("audit/every-state-change-has-audit-event", () => {
  it("holds for random sequences of service calls", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 15 }), async (commands) => {
        const world: World = { users: [], slugs: [] };
        for (const run of commands) {
          const ctx = serviceContext();
          const before = await snapshotTables(env.DB);
          const failed = await run(ctx, world).then(
            () => false,
            () => true,
          );
          const changed = changedTables(before, await snapshotTables(env.DB));
          const audited = await auditCount(ctx.correlationId);
          if (failed) expect({ changed, audited }).toEqual({ changed: [], audited: 0 });
          else if (changed.length > 0) expect(audited).toBeGreaterThan(0);
        }
      }),
      { numRuns: 30 },
    );
    // Each run snapshots every table around every command; this is slow by design.
  }, 60_000);
});

// The entitlement services (Phase 3), one by one: each change carries an audit event with the
// call's correlation ID, and each refusal leaves no trace.
describe("audit/every-state-change-has-audit-event (entitlement services)", () => {
  const audited = async <T>(run: (ctx: ServiceContext) => Promise<T>) => {
    const ctx = serviceContext();
    const { result, changedTables, auditEventCount } = await expectAuditedChange(
      env.DB,
      ctx.correlationId,
      () => run(ctx),
    );
    expect(changedTables.length > 0 ? auditEventCount > 0 : true).toBe(true);
    return { result, changedTables };
  };

  it("audits offer changes, the simulator and subscription refreshes", async () => {
    const s = await shop(2);
    const created = await audited((ctx) =>
      createOffer(ctx, s, s.slug, {
        name: "Pro",
        items: [{ source: "simulated", externalItemId: "sim_audit" }],
        accesses: [{ resourceId: s.resources[0]?.id, accessLevel: "write" }],
      }),
    );
    expect(created.changedTables).toContain("offers");
    if (!created.result.ok) throw new Error("setup");
    const offerId = created.result.offer.id;

    const subscriber = githubUser(s);
    const simulated = await audited((ctx) =>
      createSimulatedSubscriber(
        ctx,
        s,
        s.slug,
        { login: subscriber.login, items: ["sim_audit"], state: "active", periodDays: 30 },
        { github: s.github, ...SIMULATION },
      ),
    );
    expect(simulated.changedTables).toEqual(["simulated_subscriptions"]);
    if (!simulated.result.ok) throw new Error("setup");
    const id = simulated.result.subscription.id;

    const first = await audited((ctx) => refresh(s, id, ctx));
    expect(first.changedTables).toEqual(
      expect.arrayContaining(["customers", "entitlements", "subjects", "subscriptions"]),
    );
    await audited((ctx) =>
      simulateSubscriptionAction(ctx, s, s.slug, id, "mark_past_due", SIMULATION),
    );
    await audited((ctx) => refresh(s, id, ctx));
    await audited((ctx) =>
      updateOffer(ctx, s, s.slug, offerId, {
        name: "Pro",
        gracePeriodDays: 2,
        items: [{ source: "simulated", externalItemId: "sim_audit" }],
        accesses: s.resources.map((r) => ({ resourceId: r.id, accessLevel: "write" })),
      }),
    );
    // Recomputing only queues work (outbox bookkeeping).
    const recomputed = await audited((ctx) =>
      recomputeOffer(ctx, { workspaceId: s.workspaceId, offerId }),
    );
    expect(recomputed.changedTables).toEqual([]);
    await audited((ctx) => refresh(s, id, ctx));
    await audited((ctx) => archiveOffer(ctx, s, s.slug, offerId));
    await audited((ctx) => refresh(s, id, ctx));
    expect(live(await entitlementsOf(s.workspaceId))).toEqual([]);
  });

  it("the due-evaluation sweep changes only its scheduling hint", async () => {
    const s = await shop();
    await offer(s, { items: ["sim_due"] });
    const sub = await subscribe(s, { items: ["sim_due"] });
    await act(s, sub.id, "cancel_at_period_end");
    await drain(s.workspaceId);
    clock.advance(31 * DAY);
    const ignore = {
      ...UNAUDITED_TABLES,
      subscriptions:
        "the sweep clears next_evaluation_at, a scheduling hint (claimDueEvaluations); the queued refresh is audited",
    };
    const ctx = serviceContext();
    const { result, changedTables } = await expectAuditedChange(
      env.DB,
      ctx.correlationId,
      () => queueDueEvaluations(ctx, { limit: 1000 }),
      ignore,
    );
    expect(result).toBeGreaterThan(0);
    expect(changedTables).toEqual([]);
    const after = await audited((c) => refresh(s, sub.id, c));
    expect(after.changedTables).toContain("entitlements");
  });

  it("refused and failed entitlement changes leave no trace", async () => {
    const s = await shop();
    const created = await offer(s, { items: ["sim_refused"] });
    const sub = await subscribe(s, { items: ["sim_refused"] });
    const member = await memberOf(s);
    const off = { simulation: { enabled: false } };
    for (const run of [
      () => createOffer(serviceContext(), member, s.slug, created),
      () => updateOffer(serviceContext(), member, s.slug, created.id, created),
      () => archiveOffer(serviceContext(), member, s.slug, created.id),
      () =>
        simulateSubscriptionAction(serviceContext(), member, s.slug, sub.id, "pause", SIMULATION),
      () => simulateSubscriptionAction(serviceContext(), s, s.slug, sub.id, "pause", off),
      () =>
        createSimulatedSubscriber(
          serviceContext(),
          s,
          s.slug,
          { login: sub.login, items: ["sim_refused"], state: "active", periodDays: 30 },
          { github: s.github, ...off },
        ),
      () => refreshSubscription(failingBatches(), refreshRef(s, sub.id), source),
    ]) {
      await expectNoChangeOnFailure(env.DB, run);
    }
  });
});
