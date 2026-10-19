import * as repo from "@sharerepo/db";
import {
  auditEvent,
  type Instant,
  OutboxKind,
  parseGitHubLogin,
  type SubscriptionState,
  type WorkspaceScope,
} from "@sharerepo/domain";
import { GitHubApiError, type GitHubAppPort } from "@sharerepo/integrations";
import { ConflictError, NotFoundError } from "@sharerepo/platform";
import { z } from "zod";
import { asAuditActor, atOneInstant, type ServiceContext, type UserActor } from "./context.ts";
import { encodeRefreshKey } from "./entitlement-source.ts";
import { openWorkspace } from "./workspaces.ts";

// The simulated entitlement source (decision 0009): a creator drives a subscription through its
// lifecycle outside production. Each change is recorded like a provider webhook receipt: the
// source row, a `refresh_subscription` outbox row and an audit event, in one batch.

/** Whether the simulator exists here. The caller passes `ENVIRONMENT !== "production"`. */
export interface SimulationOption {
  readonly enabled: boolean;
}

export const SIMULATION_ACTIONS = [
  "start_trial",
  "activate",
  "renew",
  "mark_past_due",
  "recover",
  "pause",
  "resume",
  "cancel_at_period_end",
  "cancel_now",
  "expire",
  "reactivate",
] as const;
export type SimulationAction = (typeof SIMULATION_ACTIONS)[number];

/** The lifecycle fields a simulator action changes. */
export type SimulatedState = Pick<
  repo.SimulatedSubscription,
  "state" | "currentPeriodStart" | "currentPeriodEnd" | "cancelAt" | "endedAt" | "pastDueSince"
>;

export type SimulationTransition =
  | { readonly ok: true; readonly value: SimulatedState }
  | { readonly ok: false; readonly error: "invalid_transition" };

const RUNNING: readonly SubscriptionState[] = ["trialing", "active", "past_due", "paused"];
const ENDED: readonly SubscriptionState[] = ["canceled", "expired"];

/**
 * Applies one lifecycle action, the way a billing provider would, keeping the stored invariants
 * (`pastDueSince` exactly when past due, `endedAt` exactly when canceled or expired, a positive
 * period):
 *
 * - `start_trial` (canceled, expired) and `reactivate` (canceled, expired): a fresh period from
 *   `now`, as trialing or active;
 * - `activate` (trialing): the trial converts, and the first paid period starts `now`;
 * - `renew` (active, no cancellation scheduled): the period advances by its own length;
 * - `mark_past_due` (active): past due since `now`; `recover` (past due): active again;
 * - `pause` (active), `resume` (paused): resuming starts a fresh period from `now`;
 * - `cancel_at_period_end` (trialing, active, none scheduled): `cancelAt` = period end;
 * - `cancel_now` (any running state): canceled, ended `now`;
 * - `expire` (anything but expired): expired, ended `now` unless already canceled.
 */
export function applySimulationAction(
  row: SimulatedState,
  action: SimulationAction,
  now: Instant,
): SimulationTransition {
  const length = row.currentPeriodEnd - row.currentPeriodStart;
  const base: SimulatedState = {
    state: row.state,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAt: row.cancelAt,
    endedAt: row.endedAt,
    pastDueSince: row.pastDueSince,
  };
  const fresh = (state: SubscriptionState): SimulatedState => ({
    state,
    currentPeriodStart: now,
    currentPeriodEnd: now + length,
    cancelAt: null,
    endedAt: null,
    pastDueSince: null,
  });
  const when = (allowed: boolean, next: () => SimulatedState): SimulationTransition =>
    allowed ? { ok: true, value: next() } : { ok: false, error: "invalid_transition" };
  const { state } = row;

  switch (action) {
    case "start_trial":
      return when(ENDED.includes(state), () => fresh("trialing"));
    case "reactivate":
      return when(ENDED.includes(state), () => fresh("active"));
    case "activate":
      return when(state === "trialing", () => ({
        ...base,
        state: "active",
        currentPeriodStart: now,
        currentPeriodEnd: now + length,
      }));
    case "renew":
      return when(state === "active" && row.cancelAt === null, () => ({
        ...base,
        currentPeriodStart: row.currentPeriodEnd,
        currentPeriodEnd: row.currentPeriodEnd + length,
      }));
    case "mark_past_due":
      return when(state === "active", () => ({ ...base, state: "past_due", pastDueSince: now }));
    case "recover":
      return when(state === "past_due", () => ({ ...base, state: "active", pastDueSince: null }));
    case "pause":
      return when(state === "active", () => ({ ...base, state: "paused" }));
    case "resume":
      return when(state === "paused", () => fresh("active"));
    case "cancel_at_period_end":
      return when((state === "trialing" || state === "active") && row.cancelAt === null, () => ({
        ...base,
        cancelAt: row.currentPeriodEnd,
      }));
    case "cancel_now":
      return when(RUNNING.includes(state), () => ({
        ...base,
        state: "canceled",
        cancelAt: null,
        endedAt: now,
        pastDueSince: null,
      }));
    case "expire":
      return when(state !== "expired", () => ({
        ...base,
        state: "expired",
        cancelAt: null,
        endedAt: row.endedAt ?? now,
        pastDueSince: null,
      }));
  }
}

/** What the simulator page shows of a simulated subscription. */
export interface SimulatedSubscriptionSummary extends SimulatedState {
  readonly id: string;
  readonly customerGithubId: string;
  readonly customerLogin: string;
  readonly items: readonly string[];
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

/**
 * Why a simulator request was refused:
 * - `input_invalid`: the login, items, state or period are malformed;
 * - `connection_missing`: the workspace has no active GitHub connection to resolve logins with;
 * - `login_not_found`: GitHub has no account with that login;
 * - `account_not_user`: the login is an organization or bot, not a person;
 * - `action_invalid`: not a simulator action;
 * - `invalid_transition`: the action does not apply to the subscription's current state.
 */
export type SimulationError =
  | "input_invalid"
  | "connection_missing"
  | "login_not_found"
  | "account_not_user"
  | "action_invalid"
  | "invalid_transition";

export type SimulationResult =
  | {
      readonly ok: true;
      readonly subscription: SimulatedSubscriptionSummary;
      /** The `refresh_subscription` outbox row to hand to the queue. */
      readonly outboxId: string;
    }
  | { readonly ok: false; readonly error: SimulationError };

const DAY_MS = 86_400_000;
export const SIMULATED_PERIOD_DAYS_MAX = 366;
/** The same shape as offer item IDs (`parseOfferInput`). */
const ITEM_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

const subscriberSchema = z.object({
  login: z.string(),
  items: z
    .array(z.string().regex(ITEM_ID))
    .min(1)
    .max(100)
    .refine((items) => new Set(items).size === items.length),
  state: z.enum(["trialing", "active"]),
  periodDays: z.number().int().min(1).max(SIMULATED_PERIOD_DAYS_MAX),
});

async function openSimulator(
  ctx: ServiceContext,
  actor: UserActor,
  slug: string,
  simulation: SimulationOption,
  permission: "workspace.read" | "workspace.manage",
): Promise<WorkspaceScope> {
  if (!simulation.enabled) throw new NotFoundError("the simulator is disabled");
  return (await openWorkspace(ctx, actor, slug, permission)).scope;
}

function summary(row: repo.SimulatedSubscription): SimulatedSubscriptionSummary {
  return {
    id: row.id,
    customerGithubId: row.customerGithubId,
    customerLogin: row.customerLogin,
    items: z.array(z.string()).parse(JSON.parse(row.items)),
    state: row.state,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAt: row.cancelAt,
    endedAt: row.endedAt,
    pastDueSince: row.pastDueSince,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function refreshRow(ctx: ServiceContext, workspaceId: string, id: string) {
  const now = ctx.clock.now();
  return {
    id: ctx.ids.next(),
    kind: OutboxKind.RefreshSubscription,
    subjectId: encodeRefreshKey({ workspaceId, source: "simulated", externalSubscriptionId: id }),
    createdAt: now,
    availableAt: now,
  } as const;
}

/**
 * Creates a simulated subscriber, named by GitHub login and resolved to an immutable user ID
 * through the workspace's active GitHub connection. Needs `workspace.manage`.
 */
export async function createSimulatedSubscriber(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  input: {
    readonly login: string;
    readonly items: readonly string[];
    readonly state: "trialing" | "active";
    readonly periodDays: number;
  },
  deps: { readonly github: GitHubAppPort; readonly simulation: SimulationOption },
): Promise<SimulationResult> {
  const ctx = atOneInstant(context);
  const scope = await openSimulator(ctx, actor, slug, deps.simulation, "workspace.manage");
  const parsed = subscriberSchema.safeParse(input);
  const login = parseGitHubLogin(input.login);
  if (!parsed.success || !login.ok) return { ok: false, error: "input_invalid" };

  const connection = (await repo.listConnectionsForWorkspace(ctx.db, scope.workspaceId)).find(
    (candidate) => candidate.status === "active",
  );
  if (connection === undefined) return { ok: false, error: "connection_missing" };
  let user: Awaited<ReturnType<GitHubAppPort["getUserByLogin"]>>;
  try {
    user = await deps.github.getUserByLogin(connection.installationId, login.value);
  } catch (error) {
    if (error instanceof GitHubApiError && error.kind === "not_found") {
      return { ok: false, error: "login_not_found" };
    }
    throw error;
  }
  if (user.type !== "User") return { ok: false, error: "account_not_user" };

  const now = ctx.clock.now();
  const id = ctx.ids.next();
  const row: repo.SimulatedSubscription = {
    id,
    workspaceId: scope.workspaceId,
    customerGithubId: user.id,
    customerLogin: user.login,
    items: JSON.stringify(parsed.data.items),
    state: parsed.data.state,
    currentPeriodStart: now,
    currentPeriodEnd: now + parsed.data.periodDays * DAY_MS,
    cancelAt: null,
    endedAt: null,
    pastDueSince: null,
    createdAt: now,
    updatedAt: now,
  };
  const outbox = refreshRow(ctx, scope.workspaceId, id);
  await repo.createSimulatedSubscription(ctx.db, row, { outbox: [outbox] }, [
    auditEvent(
      "simulation.subscription_changed",
      {
        workspaceId: scope.workspaceId,
        actor: asAuditActor(actor),
        targetId: id,
        details: { action: "create", state: row.state },
      },
      ctx,
    ),
  ]);
  return { ok: true, subscription: summary(row), outboxId: outbox.id };
}

/**
 * Applies a lifecycle action to a simulated subscription. Needs `workspace.manage`. The source's
 * `updated_at` always moves forward, even within one millisecond, so every action is a newer
 * snapshot. A concurrent action makes it a ConflictError for the user to retry.
 */
export async function simulateSubscriptionAction(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  id: string,
  action: string,
  deps: { readonly simulation: SimulationOption },
): Promise<SimulationResult> {
  const ctx = atOneInstant(context);
  const scope = await openSimulator(ctx, actor, slug, deps.simulation, "workspace.manage");
  if (!(SIMULATION_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, error: "action_invalid" };
  }
  const row = await repo.getSimulatedSubscription(ctx.db, { workspaceId: scope.workspaceId, id });
  if (row === null) throw new NotFoundError("simulated subscription not found in workspace");
  const now = ctx.clock.now();
  const next = applySimulationAction(row, action as SimulationAction, now);
  if (!next.ok) return next;

  const set = { ...next.value, updatedAt: Math.max(now, row.updatedAt + 1) };
  const outbox = refreshRow(ctx, scope.workspaceId, id);
  const result = await repo.updateSimulatedSubscription(
    ctx.db,
    { workspaceId: scope.workspaceId, id, expectedUpdatedAt: row.updatedAt, set },
    { outbox: [outbox] },
    [
      auditEvent(
        "simulation.subscription_changed",
        {
          workspaceId: scope.workspaceId,
          actor: asAuditActor(actor),
          targetId: id,
          details: { action, state: set.state },
        },
        ctx,
      ),
    ],
  );
  if (!result.ok) throw new ConflictError("simulated subscription changed concurrently; retry");
  return { ok: true, subscription: summary({ ...row, ...set }), outboxId: outbox.id };
}

/** The workspace's simulated subscriptions, oldest first, for any member. */
export async function listSimulatedSubscriptions(
  context: ServiceContext,
  actor: UserActor,
  slug: string,
  deps: { readonly simulation: SimulationOption },
): Promise<SimulatedSubscriptionSummary[]> {
  const scope = await openSimulator(context, actor, slug, deps.simulation, "workspace.read");
  return (await repo.listSimulatedSubscriptions(context.db, scope.workspaceId)).map(summary);
}
