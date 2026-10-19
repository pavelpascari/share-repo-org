import { env } from "cloudflare:workers";
import { listAuditEventsByCorrelationId } from "@sharerepo/db";
import { GitHubApiError } from "@sharerepo/integrations";
import { ConflictError, ForbiddenError, NotFoundError } from "@sharerepo/platform";
import { expectAuditedChange, expectNoChangeOnFailure } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  applySimulationAction,
  createSimulatedSubscriber,
  createWorkspace,
  decodeRefreshKey,
  listSimulatedSubscriptions,
  SIMULATION_ACTIONS,
  type SimulatedState,
  type SimulationAction,
  simulateSubscriptionAction,
  type UserActor,
} from "../src/index.ts";
import {
  act,
  DAY,
  githubUser,
  memberOf,
  type Shop,
  SIMULATION,
  shop,
  subscribe,
} from "./support/commerce.ts";
import { clock, serviceContext, signedUpUser, uniqueSlug } from "./support/context.ts";

const NOW = Date.UTC(2026, 5, 1);
const PERIOD = 30 * DAY;

const running = (overrides: Partial<SimulatedState> = {}): SimulatedState => ({
  state: "active",
  currentPeriodStart: NOW - 10 * DAY,
  currentPeriodEnd: NOW - 10 * DAY + PERIOD,
  cancelAt: null,
  endedAt: null,
  pastDueSince: null,
  ...overrides,
});

const fresh = (state: "trialing" | "active") => ({
  ok: true,
  value: {
    state,
    currentPeriodStart: NOW,
    currentPeriodEnd: NOW + PERIOD,
    cancelAt: null,
    endedAt: null,
    pastDueSince: null,
  },
});

describe("applySimulationAction", () => {
  const canceled = running({ state: "canceled", endedAt: NOW - DAY });
  const expired = running({ state: "expired", endedAt: NOW - DAY });
  const pastDue = running({ state: "past_due", pastDueSince: NOW - DAY });
  const paused = running({ state: "paused" });
  const trialing = running({ state: "trialing" });
  const scheduled = running({ cancelAt: NOW + 20 * DAY });

  it.each<[string, SimulatedState, SimulationAction, unknown]>([
    ["start_trial from canceled", canceled, "start_trial", fresh("trialing")],
    ["reactivate from expired", expired, "reactivate", fresh("active")],
    [
      "activate a trial",
      trialing,
      "activate",
      {
        ok: true,
        value: {
          ...trialing,
          state: "active",
          currentPeriodStart: NOW,
          currentPeriodEnd: NOW + PERIOD,
        },
      },
    ],
    [
      "renew by one period",
      running(),
      "renew",
      {
        ok: true,
        value: running({
          currentPeriodStart: NOW + 20 * DAY,
          currentPeriodEnd: NOW + 20 * DAY + PERIOD,
        }),
      },
    ],
    [
      "mark past due",
      running(),
      "mark_past_due",
      { ok: true, value: running({ state: "past_due", pastDueSince: NOW }) },
    ],
    ["recover", pastDue, "recover", { ok: true, value: running() }],
    ["pause", running(), "pause", { ok: true, value: paused }],
    ["resume with a fresh period", paused, "resume", fresh("active")],
    [
      "cancel at period end",
      trialing,
      "cancel_at_period_end",
      { ok: true, value: { ...trialing, cancelAt: trialing.currentPeriodEnd } },
    ],
    [
      "cancel now while past due",
      pastDue,
      "cancel_now",
      { ok: true, value: running({ state: "canceled", endedAt: NOW }) },
    ],
    [
      "expire a running subscription",
      scheduled,
      "expire",
      { ok: true, value: running({ state: "expired", endedAt: NOW }) },
    ],
    [
      "expire a canceled subscription at its end",
      canceled,
      "expire",
      { ok: true, value: running({ state: "expired", endedAt: NOW - DAY }) },
    ],
  ])("%s", (_, row, action, expected) => {
    expect(applySimulationAction(row, action, NOW)).toEqual(expected);
  });

  it.each<[SimulatedState, SimulationAction]>([
    [running(), "start_trial"],
    [running(), "reactivate"],
    [running(), "activate"],
    [scheduled, "renew"],
    [trialing, "renew"],
    [pastDue, "mark_past_due"],
    [running(), "recover"],
    [paused, "pause"],
    [running(), "resume"],
    [scheduled, "cancel_at_period_end"],
    [pastDue, "cancel_at_period_end"],
    [canceled, "cancel_now"],
    [expired, "expire"],
  ])("refuses %s → %s", (row, action) => {
    expect(applySimulationAction(row, action, NOW)).toEqual({
      ok: false,
      error: "invalid_transition",
    });
  });
});

describe("createSimulatedSubscriber", () => {
  it("records the subscriber with an outbox refresh and an audit event, in one batch", async () => {
    const s = await shop();
    const user = githubUser(s);
    const ctx = serviceContext();
    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      createSimulatedSubscriber(
        ctx,
        s,
        s.slug,
        {
          login: user.login.toUpperCase(),
          items: ["sim_a", "sim_b"],
          state: "trialing",
          periodDays: 14,
        },
        { github: s.github, ...SIMULATION },
      ),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.subscription).toMatchObject({
      customerGithubId: user.id,
      customerLogin: user.login,
      items: ["sim_a", "sim_b"],
      state: "trialing",
      currentPeriodStart: clock.now(),
      currentPeriodEnd: clock.now() + 14 * DAY,
    });
    expect(
      await listAuditEventsByCorrelationId(serviceContext().db, ctx.correlationId),
    ).toMatchObject([
      {
        action: "simulation.subscription_changed",
        details: { action: "create", state: "trialing" },
        actor: { type: "user", id: s.userId },
      },
    ]);
    const work = await env.DB.prepare("SELECT kind, subject_id FROM outbox WHERE id = ?")
      .bind(result.outboxId)
      .first<{ kind: string; subject_id: string }>();
    expect(work?.kind).toBe("refresh_subscription");
    expect(decodeRefreshKey(work?.subject_id ?? "")).toEqual({
      ok: true,
      value: {
        workspaceId: s.workspaceId,
        source: "simulated",
        externalSubscriptionId: result.subscription.id,
      },
    });
  });

  it.each([
    ["an invalid login", { login: "not a login!" }],
    ["no items", { items: [] }],
    ["duplicate items", { items: ["sim_a", "sim_a"] }],
    ["a malformed item", { items: ["bad item"] }],
    ["an unsupported state", { state: "past_due" }],
    ["a zero-length period", { periodDays: 0 }],
  ])("refuses %s without asking GitHub", async (_, overrides) => {
    const s = await shop();
    const user = githubUser(s);
    const calls = s.github.calls.length;
    await expect(
      createSimulatedSubscriber(
        serviceContext(),
        s,
        s.slug,
        {
          login: user.login,
          items: ["sim_a"],
          state: "active",
          periodDays: 30,
          ...overrides,
        } as never,
        { github: s.github, ...SIMULATION },
      ),
    ).resolves.toEqual({ ok: false, error: "input_invalid" });
    expect(s.github.calls.length).toBe(calls);
  });

  it("needs an active GitHub connection to resolve the login", async () => {
    const owner = await signedUpUser();
    const created = await createWorkspace(serviceContext(), owner, {
      name: "Bare",
      slug: uniqueSlug(),
    });
    if (!created.ok) throw new Error("setup");
    const s = await shop();
    await expect(
      createSimulatedSubscriber(
        serviceContext(),
        owner,
        created.workspace.slug,
        { login: "octocat", items: ["sim_a"], state: "active", periodDays: 30 },
        { github: s.github, ...SIMULATION },
      ),
    ).resolves.toEqual({ ok: false, error: "connection_missing" });
  });

  it.each<[string, string, (s: Shop) => string]>([
    ["an unknown login", "login_not_found", () => "ghost-user"],
    ["an organization", "account_not_user", (s) => githubUser(s, "Organization").login],
    ["a bot", "account_not_user", (s) => githubUser(s, "Bot").login],
  ])("refuses %s", async (_, error, login) => {
    const s = await shop();
    const ctx = serviceContext();
    const { result, changedTables } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      createSimulatedSubscriber(
        ctx,
        s,
        s.slug,
        { login: login(s), items: ["sim_a"], state: "active", periodDays: 30 },
        { github: s.github, ...SIMULATION },
      ),
    );
    expect(result).toEqual({ ok: false, error });
    expect(changedTables).toEqual([]);
  });

  it("propagates other GitHub failures and writes nothing", async () => {
    const s = await shop();
    const user = githubUser(s);
    s.github.failNext("transient");
    const error = await expectNoChangeOnFailure(env.DB, () =>
      createSimulatedSubscriber(
        serviceContext(),
        s,
        s.slug,
        { login: user.login, items: ["sim_a"], state: "active", periodDays: 30 },
        { github: s.github, ...SIMULATION },
      ),
    );
    expect(error).toBeInstanceOf(GitHubApiError);
  });

  it("is refused for members and non-members", async () => {
    const s = await shop();
    const user = githubUser(s);
    const member = await memberOf(s);
    const stranger = await signedUpUser();
    const create = (actor: UserActor) =>
      createSimulatedSubscriber(
        serviceContext(),
        actor,
        s.slug,
        { login: user.login, items: ["sim_a"], state: "active", periodDays: 30 },
        { github: s.github, ...SIMULATION },
      );
    await expect(create(member)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(create(stranger)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("simulateSubscriptionAction", () => {
  it("applies an action with a newer source timestamp, audited and queued", async () => {
    const s = await shop();
    const sub = await subscribe(s, { items: ["sim_a"] });
    const ctx = serviceContext();
    const { result } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
      simulateSubscriptionAction(ctx, s, s.slug, sub.id, "mark_past_due", SIMULATION),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.subscription).toMatchObject({ state: "past_due", pastDueSince: clock.now() });
    // Same instant as creation, yet the source timestamp still moves forward.
    expect(result.subscription.updatedAt).toBe(sub.updatedAt + 1);
    expect(await listAuditEventsByCorrelationId(ctx.db, ctx.correlationId)).toMatchObject([
      {
        action: "simulation.subscription_changed",
        details: { action: "mark_past_due", state: "past_due" },
      },
    ]);
    clock.advance(DAY);
    const recovered = await act(s, sub.id, "recover");
    expect(recovered.updatedAt).toBe(clock.now());
  });

  it("refuses an unknown action and an invalid transition, writing nothing", async () => {
    const s = await shop();
    const sub = await subscribe(s, { items: ["sim_a"] });
    for (const [action, error] of [
      ["explode", "action_invalid"],
      ["recover", "invalid_transition"],
    ] as const) {
      const ctx = serviceContext();
      const { result, changedTables } = await expectAuditedChange(env.DB, ctx.correlationId, () =>
        simulateSubscriptionAction(ctx, s, s.slug, sub.id, action, SIMULATION),
      );
      expect([result, changedTables]).toEqual([{ ok: false, error }, []]);
    }
  });

  it("is not found for an unknown or foreign subscription, and refused for members", async () => {
    const s = await shop();
    const other = await shop();
    const foreign = await subscribe(other, { items: ["sim_a"] });
    for (const id of ["missing", foreign.id]) {
      await expect(
        simulateSubscriptionAction(serviceContext(), s, s.slug, id, "pause", SIMULATION),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
    const member = await memberOf(other);
    await expect(
      simulateSubscriptionAction(
        serviceContext(),
        member,
        other.slug,
        foreign.id,
        "pause",
        SIMULATION,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("raises a conflict for concurrent actions instead of applying both", async () => {
    const s = await shop();
    const sub = await subscribe(s, { items: ["sim_a"] });
    const results = await Promise.allSettled([
      simulateSubscriptionAction(serviceContext(), s, s.slug, sub.id, "pause", SIMULATION),
      simulateSubscriptionAction(serviceContext(), s, s.slug, sub.id, "mark_past_due", SIMULATION),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
  });

  it("accepts every action name", () => {
    expect(SIMULATION_ACTIONS).toHaveLength(11);
  });
});

describe("listSimulatedSubscriptions", () => {
  it("lists the workspace's subscriptions for any member", async () => {
    const s = await shop();
    const first = await subscribe(s, { items: ["sim_a"] });
    clock.advance(1);
    const second = await subscribe(s, { items: ["sim_b", "sim_c"] });
    const member = await memberOf(s);
    const listed = await listSimulatedSubscriptions(serviceContext(), member, s.slug, SIMULATION);
    expect(listed.map((row) => [row.id, row.items])).toEqual([
      [first.id, ["sim_a"]],
      [second.id, ["sim_b", "sim_c"]],
    ]);
  });
});

describe("the simulator outside development", () => {
  it("is not found in production, before anything is read or written", async () => {
    const s = await shop();
    const sub = await subscribe(s, { items: ["sim_a"] });
    const off = { simulation: { enabled: false } };
    const calls = s.github.calls.length;
    for (const run of [
      () =>
        createSimulatedSubscriber(
          serviceContext(),
          s,
          s.slug,
          { login: "octocat", items: ["sim_a"], state: "active", periodDays: 30 },
          { github: s.github, ...off },
        ),
      () => simulateSubscriptionAction(serviceContext(), s, s.slug, sub.id, "pause", off),
      () => listSimulatedSubscriptions(serviceContext(), s, s.slug, off),
    ]) {
      expect(await expectNoChangeOnFailure(env.DB, run)).toBeInstanceOf(NotFoundError);
    }
    expect(s.github.calls.length).toBe(calls);
  });
});
