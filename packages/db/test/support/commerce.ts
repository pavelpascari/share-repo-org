import {
  applySubscriptionRefresh,
  type Customer,
  createOffer,
  type Entitlement,
  type NewOffer,
  type NewOutboxRow,
  type OfferAccess,
  type OfferItem,
  type SimulatedSubscription,
  type Subject,
  type Subscription,
  schema,
} from "../../src/index.ts";
import { workspaceEvent } from "./audit.ts";
import { connectedWorkspace, db, resourceRow } from "./connections.ts";
import { T0, uniqueId } from "./rows.ts";

/** A connected workspace with `resourceCount` repositories, as rows. */
export async function commerceWorkspace(resourceCount = 1) {
  const ws = await connectedWorkspace();
  const resources = Array.from({ length: resourceCount }, (_, i) =>
    resourceRow(ws.workspaceId, ws.connection.id, { nameSnapshot: `octocat/repo-${i}` }),
  );
  for (const resource of resources) await db.insert(schema.resources).values(resource);
  return { ...ws, resources };
}

export function offerItemRow(
  workspaceId: string,
  offerId: string,
  overrides: Partial<OfferItem> = {},
): OfferItem {
  return {
    id: uniqueId("oit"),
    workspaceId,
    offerId,
    source: "simulated",
    externalItemId: uniqueId("sim"),
    createdAt: T0,
    ...overrides,
  };
}

export function offerAccessRow(
  workspaceId: string,
  offerId: string,
  resourceId: string,
  overrides: Partial<OfferAccess> = {},
): OfferAccess {
  return {
    id: uniqueId("oac"),
    workspaceId,
    offerId,
    resourceId,
    accessLevel: "write",
    createdAt: T0,
    ...overrides,
  };
}

/** A version-1 offer with one item per `itemIds` and one write access per resource. */
export function newOffer(input: {
  workspaceId: string;
  userId: string;
  resourceIds: readonly string[];
  itemIds?: readonly string[];
  name?: string;
}): NewOffer {
  const { workspaceId } = input;
  const id = uniqueId("off");
  const items = (input.itemIds ?? [uniqueId("sim")]).map((externalItemId) =>
    offerItemRow(workspaceId, id, { externalItemId }),
  );
  const accesses = input.resourceIds.map((resourceId) =>
    offerAccessRow(workspaceId, id, resourceId),
  );
  const name = input.name ?? "Pro";
  return {
    offer: {
      id,
      workspaceId,
      name,
      status: "active",
      gracePeriodDays: 7,
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    },
    version: {
      id: uniqueId("ofv"),
      workspaceId,
      offerId: id,
      version: 1,
      snapshot: JSON.stringify({ name, items: [], accesses: [] }),
      createdAt: T0,
      createdByUserId: input.userId,
    },
    items,
    accesses,
    outbox: [],
  };
}

export async function seedOffer(input: Parameters<typeof newOffer>[0]) {
  const offer = newOffer(input);
  await createOffer(db, offer, [workspaceEvent(input.workspaceId)]);
  return offer;
}

export function subjectRow(workspaceId: string, overrides: Partial<Subject> = {}): Subject {
  return {
    id: uniqueId("sub"),
    workspaceId,
    provider: "github",
    type: "user",
    externalSubjectId: String(Math.floor(Math.random() * 1e12)),
    loginSnapshot: "monalisa",
    externalIdentityId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export async function seedSubject(workspaceId: string, overrides: Partial<Subject> = {}) {
  const subject = subjectRow(workspaceId, overrides);
  await db.insert(schema.subjects).values(subject);
  return subject;
}

export function customerRow(workspaceId: string, overrides: Partial<Customer> = {}): Customer {
  return {
    id: uniqueId("cus"),
    workspaceId,
    source: "simulated",
    externalCustomerId: uniqueId("ext"),
    subjectId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function subscriptionRow(
  workspaceId: string,
  customerId: string,
  overrides: Partial<Subscription> = {},
): Subscription {
  return {
    id: uniqueId("sbs"),
    workspaceId,
    source: "simulated",
    externalSubscriptionId: uniqueId("ext"),
    customerId,
    state: "active",
    providerState: "active",
    currentPeriodStart: T0,
    currentPeriodEnd: T0 + 30 * 86_400_000,
    cancelAt: null,
    endedAt: null,
    pastDueSince: null,
    sourceUpdatedAt: T0,
    lastObservedAt: T0,
    nextEvaluationAt: null,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function entitlementRow(
  input: {
    workspaceId: string;
    subjectId: string;
    resourceId: string;
    subscriptionId: string;
    offerId: string;
  },
  overrides: Partial<Entitlement> = {},
): Entitlement {
  return {
    id: uniqueId("ent"),
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    resourceId: input.resourceId,
    accessLevel: "write",
    sourceType: "subscription",
    sourceId: input.subscriptionId,
    offerId: input.offerId,
    offerVersion: 1,
    policyVersion: 1,
    state: "active",
    validFrom: T0,
    validUntil: null,
    decisionReason: "active",
    endedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function outboxRow(kind: NewOutboxRow["kind"], subjectId: string): NewOutboxRow {
  return { id: uniqueId("obx"), kind, subjectId, createdAt: T0, availableAt: T0 };
}

/**
 * A workspace with a repository, an offer for it, a linked subject, and a new subscription
 * carrying the offer's item with one live entitlement, recorded through the refresh write.
 */
export async function subscribedWorkspace(
  overrides: { subscription?: Partial<Subscription> } = {},
) {
  const ws = await commerceWorkspace();
  const resource = ws.resources[0] as (typeof ws.resources)[number];
  const offer = await seedOffer({
    workspaceId: ws.workspaceId,
    userId: ws.userId,
    resourceIds: [resource.id],
  });
  const subject = await seedSubject(ws.workspaceId);
  const customer = customerRow(ws.workspaceId, { subjectId: subject.id });
  const subscription = subscriptionRow(ws.workspaceId, customer.id, overrides.subscription);
  const item = (offer.items[0] as OfferItem).externalItemId;
  const entitlement = entitlementRow({
    workspaceId: ws.workspaceId,
    subjectId: subject.id,
    resourceId: resource.id,
    subscriptionId: subscription.id,
    offerId: offer.offer.id,
  });
  const result = await applySubscriptionRefresh(
    db,
    {
      workspaceId: ws.workspaceId,
      now: T0,
      expectedVersion: 0,
      customer,
      subscription,
      items: [item],
      offers: [{ offerId: offer.offer.id, version: 1 }],
      entitlements: { create: [entitlement], update: [], end: [] },
    },
    [workspaceEvent(ws.workspaceId)],
  );
  if (!result.ok) throw new Error(result.reason);
  const subscriptionKey = { workspaceId: ws.workspaceId, subscriptionId: subscription.id };
  return {
    ...ws,
    resource,
    offer,
    subject,
    customer,
    subscription,
    subscriptionKey,
    item,
    entitlement,
  };
}

export function simulatedRow(
  workspaceId: string,
  overrides: Partial<SimulatedSubscription> = {},
): SimulatedSubscription {
  return {
    id: uniqueId("sim"),
    workspaceId,
    customerGithubId: "583231",
    customerLogin: "monalisa",
    items: JSON.stringify(["sim_monthly"]),
    state: "trialing",
    currentPeriodStart: T0,
    currentPeriodEnd: T0 + 30 * 86_400_000,
    cancelAt: null,
    endedAt: null,
    pastDueSince: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}
