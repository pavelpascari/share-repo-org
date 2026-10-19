import { env } from "cloudflare:workers";
import {
  createOffer,
  createSimulatedSubscriber,
  resyncConnection,
  simulateSubscriptionAction,
} from "@sharerepo/application";
import {
  type Entitlement,
  listEntitlementsForWorkspace,
  listResourcesForConnection,
  markOutboxSent,
} from "@sharerepo/db";
import type { FakeGitHubApp } from "@sharerepo/integrations/testing";
import { clock, connectedCreator, db, outboxIdFor, serviceContext } from "./github.ts";

export const DAY = 86_400_000;
const SIMULATION = { simulation: { enabled: true } } as const;

let nextNumber = Math.floor(Math.random() * 1e8);
const nextId = () => String(++nextNumber);

export type Shop = Awaited<ReturnType<typeof shop>>;

/**
 * A connected creator whose repository is synced and sold by one offer for the simulated item
 * `sim_pro`. The connection's own resync and the new offer's recompute (no subscription carries
 * `sim_pro` yet) are done, so it leaves no due outbox work behind.
 */
export async function shop(github: FakeGitHubApp, options: { gracePeriodDays?: number } = {}) {
  const creator = await connectedCreator(github);
  await resyncConnection(serviceContext(), creator.connection, github, "test setup");
  await markOutboxSent(db, [await outboxIdFor(creator.connection.id)], clock.now());
  const resources = await listResourcesForConnection(db, {
    workspaceId: creator.connection.workspaceId,
    connectionId: creator.connection.id,
  });
  const created = await createOffer(serviceContext(), creator, creator.slug, {
    name: "Pro",
    gracePeriodDays: options.gracePeriodDays ?? 7,
    items: [{ source: "simulated", externalItemId: "sim_pro" }],
    accesses: resources.map((resource) => ({ resourceId: resource.id, accessLevel: "write" })),
  });
  if (!created.ok || created.outboxId === null) throw new Error("offer setup failed");
  await markOutboxSent(db, [created.outboxId], clock.now());
  return {
    ...creator,
    github,
    workspaceId: creator.connection.workspaceId,
    offerId: created.offer.id,
  };
}

/** A simulated subscriber to `sim_pro`; returns its ID and the refresh it left in the outbox. */
export async function subscribe(s: Shop) {
  const user = { id: nextId(), login: `sub-${nextId()}`, type: "User" } as const;
  s.github.addUser(user);
  const result = await createSimulatedSubscriber(
    serviceContext(),
    s,
    s.slug,
    { login: user.login, items: ["sim_pro"], state: "active", periodDays: 30 },
    { github: s.github, ...SIMULATION },
  );
  if (!result.ok) throw new Error(result.error);
  return { id: result.subscription.id, outboxId: result.outboxId };
}

/** Applies a simulator action; returns the refresh it left in the outbox. */
export async function act(s: Shop, id: string, action: string) {
  const result = await simulateSubscriptionAction(
    serviceContext(),
    s,
    s.slug,
    id,
    action,
    SIMULATION,
  );
  if (!result.ok) throw new Error(result.error);
  return { subscription: result.subscription, outboxId: result.outboxId };
}

export const refreshKey = (s: Shop, id: string) => `${s.workspaceId}:simulated:${id}`;

export const entitlementsOf = (s: Shop): Promise<Entitlement[]> =>
  listEntitlementsForWorkspace(db, s.workspaceId, { includeEnded: true });

export async function subscriptionVersion(s: Shop, id: string): Promise<number | undefined> {
  const row = await env.DB.prepare(
    "SELECT version FROM subscriptions WHERE workspace_id = ? AND external_subscription_id = ?",
  )
    .bind(s.workspaceId, id)
    .first<{ version: number }>();
  return row?.version;
}

/** The outbox row a `recompute_offer` for the shop's offer left, if any. */
export async function recomputeOutboxId(s: Shop): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT id FROM outbox WHERE kind = 'recompute_offer' AND subject_id = ?",
  )
    .bind(`${s.workspaceId}:${s.offerId}`)
    .first<{ id: string }>();
  if (row === null) throw new Error("no recompute queued");
  return row.id;
}
