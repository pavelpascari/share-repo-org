import { env } from "cloudflare:workers";
import {
  type Entitlement,
  listEntitlementsForWorkspace,
  listResourcesForConnection,
  markOutboxSent,
  type Resource,
} from "@sharerepo/db";
import { createFakeGitHubApp, type FakeGitHubApp } from "@sharerepo/integrations/testing";
import {
  addWorkspaceMember,
  completeGitHubConnection,
  createOffer,
  createSimulatedSubscriber,
  createWorkspace,
  decodeOfferKey,
  decodeRefreshKey,
  type OfferSummary,
  recomputeOffer,
  refreshSubscription,
  resyncConnection,
  type ServiceContext,
  type SimulatedSubscriptionSummary,
  type SimulationResult,
  simulatedEntitlementSource,
  simulateSubscriptionAction,
  startGitHubConnection,
  type UserActor,
} from "../../src/index.ts";
import {
  clock,
  db,
  nextGitHubUserId,
  serviceContext,
  signedUpUser,
  uniqueSlug,
} from "./context.ts";

export const DAY = 86_400_000;
export const SIMULATION = { simulation: { enabled: true } } as const;
export const source = simulatedEntitlementSource(db);

let nextNumber = Math.floor(Math.random() * 1e8);
const nextId = () => String(++nextNumber);

/** A creator's workspace with an active GitHub connection and synced repositories. */
export interface Shop extends UserActor {
  readonly slug: string;
  readonly workspaceId: string;
  readonly github: FakeGitHubApp;
  readonly installationId: string;
  readonly connection: { readonly workspaceId: string; readonly id: string };
  readonly resources: readonly Resource[];
}

export async function shop(repositoryCount = 1, github = createFakeGitHubApp()): Promise<Shop> {
  const user = await signedUpUser();
  const created = await createWorkspace(serviceContext(), user, {
    name: "Shop",
    slug: uniqueSlug(),
  });
  if (!created.ok) throw new Error("setup failed");
  const installationId = nextId();
  const login = user.profile.username;
  github.addInstallation({
    id: installationId,
    account: { id: user.profile.externalUserId, login, type: "User" },
    repositories: Array.from({ length: repositoryCount }, (_, i) => {
      const externalId = nextId();
      return {
        externalId,
        name: `${login}/repo-${i}-${externalId}`,
        ownerExternalId: user.profile.externalUserId,
        ownerType: "User" as const,
        private: true,
        archived: false,
      };
    }),
  });
  const slug = created.workspace.slug;
  const started = await startGitHubConnection(
    serviceContext(),
    user,
    slug,
    { acknowledgeWriteAccess: true },
    github,
  );
  if (!started.ok) throw new Error("setup failed");
  const state = new URL(started.installUrl).searchParams.get("state") ?? "";
  const completed = await completeGitHubConnection(
    serviceContext(),
    user,
    { state, installationId },
    github,
  );
  if (!completed.ok) throw new Error(completed.reason);
  const connection = { workspaceId: created.workspace.id, id: completed.connectionId };
  await resyncConnection(serviceContext(), connection, github, "setup");
  const resources = await listResourcesForConnection(db, {
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
  });
  return {
    userId: user.userId,
    slug,
    workspaceId: created.workspace.id,
    github,
    installationId,
    connection,
    resources,
  };
}

/** A GitHub user the fake can resolve, to name as a simulated subscriber. */
export function githubUser(shop: Shop, type: "User" | "Organization" | "Bot" = "User") {
  const user = { id: nextGitHubUserId(), login: `sub-${nextId()}`, type } as const;
  shop.github.addUser(user);
  return user;
}

export async function offer(
  shop: Shop,
  input: {
    items: readonly string[];
    resources?: readonly Resource[];
    gracePeriodDays?: number | undefined;
    name?: string;
  },
): Promise<OfferSummary> {
  const result = await createOffer(serviceContext(), shop, shop.slug, {
    name: input.name ?? "Pro",
    gracePeriodDays: input.gracePeriodDays ?? 7,
    items: input.items.map((externalItemId) => ({ source: "simulated", externalItemId })),
    accesses: (input.resources ?? shop.resources).map((resource) => ({
      resourceId: resource.id,
      accessLevel: "write",
    })),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.offer;
}

function expectOk(result: SimulationResult): SimulatedSubscriptionSummary {
  if (!result.ok) throw new Error(result.error);
  return result.subscription;
}

export async function subscribe(
  shop: Shop,
  input: {
    items: readonly string[];
    state?: "trialing" | "active";
    periodDays?: number | undefined;
  },
  ctx: ServiceContext = serviceContext(),
): Promise<SimulatedSubscriptionSummary & { login: string }> {
  const user = githubUser(shop);
  const subscription = expectOk(
    await createSimulatedSubscriber(
      ctx,
      shop,
      shop.slug,
      {
        login: user.login,
        items: input.items,
        state: input.state ?? "active",
        periodDays: input.periodDays ?? 30,
      },
      { github: shop.github, ...SIMULATION },
    ),
  );
  return { ...subscription, login: user.login };
}

export async function act(
  shop: Shop,
  id: string,
  action: string,
  ctx: ServiceContext = serviceContext(),
): Promise<SimulatedSubscriptionSummary> {
  return expectOk(await simulateSubscriptionAction(ctx, shop, shop.slug, id, action, SIMULATION));
}

export const refreshRef = (shop: Shop, externalSubscriptionId: string) => ({
  workspaceId: shop.workspaceId,
  source: "simulated" as const,
  externalSubscriptionId,
});

/** Refreshes one simulated subscription now, as its outbox row would. */
export const refresh = (shop: Shop, id: string, ctx: ServiceContext = serviceContext()) =>
  refreshSubscription(ctx, refreshRef(shop, id), source);

interface PendingRow {
  id: string;
  kind: string;
  subject_id: string;
}

/** The workspace's unsent outbox rows of the entitlement kinds, oldest first. */
export async function pendingWork(workspaceId: string): Promise<PendingRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, subject_id FROM outbox
     WHERE kind IN ('refresh_subscription', 'recompute_offer') AND sent_at IS NULL
       AND failed_at IS NULL AND substr(subject_id, 1, length(?1) + 1) = ?1 || ':'
     ORDER BY created_at, id`,
  )
    .bind(workspaceId)
    .all<PendingRow>();
  return results;
}

/** Runs one outbox row's work, as the jobs Worker will. */
export async function runWork(row: { kind: string; subject_id: string }): Promise<void> {
  if (row.kind === "recompute_offer") {
    const key = decodeOfferKey(row.subject_id);
    if (!key.ok) throw new Error("bad offer key");
    await recomputeOffer(serviceContext(), key.value);
    return;
  }
  const key = decodeRefreshKey(row.subject_id);
  if (!key.ok) throw new Error("bad refresh key");
  await refreshSubscription(serviceContext(), key.value, source);
}

/** Delivers every pending entitlement work row of the workspace until none is left. */
export async function drain(workspaceId: string): Promise<number> {
  let delivered = 0;
  for (let rows = await pendingWork(workspaceId); rows.length > 0; ) {
    for (const row of rows) {
      await runWork(row);
      await markOutboxSent(db, [row.id], clock.now());
      delivered += 1;
    }
    rows = await pendingWork(workspaceId);
  }
  return delivered;
}

export async function entitlementsOf(
  workspaceId: string,
  subscriptionExternalId?: string,
): Promise<Entitlement[]> {
  const all = await listEntitlementsForWorkspace(db, workspaceId, { includeEnded: true });
  if (subscriptionExternalId === undefined) return all;
  const row = await env.DB.prepare(
    "SELECT id FROM subscriptions WHERE workspace_id = ? AND external_subscription_id = ?",
  )
    .bind(workspaceId, subscriptionExternalId)
    .first<{ id: string }>();
  return all.filter((e) => e.sourceId === row?.id);
}

export const live = (rows: readonly Entitlement[]) => rows.filter((e) => e.state === "active");

/** Adds a workspace member with the `member` role. */
export async function memberOf(shop: Shop): Promise<UserActor> {
  const member = await signedUpUser();
  await addWorkspaceMember(serviceContext(), shop, shop.slug, {
    userId: member.userId,
    role: "member",
  });
  return member;
}

/** A service context whose database batches fail, as during an outage. */
export function failingBatches(): ServiceContext {
  const failing = new Proxy(db, {
    get: (target, property, receiver) =>
      property === "batch"
        ? () => Promise.reject(new Error("d1 down"))
        : Reflect.get(target, property, receiver),
  });
  return { ...serviceContext(), db: failing };
}
