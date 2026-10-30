import type {
  AccessLevel,
  CommercialSource,
  EntitlementState,
  GrantState,
  Instant,
  SubscriptionState,
} from "@sharerepo/domain";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import {
  customers,
  entitlements,
  externalIdentities,
  grants,
  manualAccesses,
  resources,
  subjects,
  subscriptions,
  workspaces,
} from "./schema/index.ts";

// "My access": a signed-in user's own subscriptions across workspaces. Every query starts from
// the user's GitHub identity and reaches subjects only through it (a subject is the workspace's
// principal for that GitHub account, keyed by its immutable ID), so nothing of another user can
// appear. A user who is not linked to any customer sees nothing.

/** What the provider shows for one repository the user is entitled to. */
export interface MyAccessGrant {
  state: GrantState;
  accessLevel: AccessLevel;
  /** The pending invitation's ID, while one is pending. */
  externalGrantId: string | null;
  expiresAt: Instant | null;
  lastErrorCode: string | null;
}

export interface MyAccessEntitlement {
  id: string;
  resourceId: string;
  /** `owner/name` as last seen. */
  repositoryName: string;
  accessLevel: AccessLevel;
  state: EntitlementState;
  validUntil: Instant | null;
  endedAt: Instant | null;
  /** The subject's grants on the repository (one per access level ever granted). */
  grants: MyAccessGrant[];
}

export interface MyAccessSubscription {
  workspace: { id: string; slug: string; name: string };
  subjectId: string;
  /** The customer, or null for a creator's manual access (decision 0016). */
  customerId: string | null;
  /** `manual` for a creator's manual access; the page shows it like any purchase. */
  source: CommercialSource | "manual";
  /** The subscription, or the manual access, by ShareRepo ID. */
  subscriptionId: string;
  externalSubscriptionId: string;
  state: SubscriptionState;
  currentPeriodEnd: Instant | null;
  cancelAt: Instant | null;
  endedAt: Instant | null;
  pastDueSince: Instant | null;
  /** Entitlements of this subscription for the user's subject, oldest first, ended included. */
  entitlements: MyAccessEntitlement[];
}

/** The user's subjects: one per workspace that has a subject for the user's GitHub account. */
const userSubjects = (userId: string) =>
  and(
    eq(externalIdentities.userId, userId),
    eq(externalIdentities.provider, "github"),
    eq(subjects.provider, externalIdentities.provider),
    eq(subjects.externalSubjectId, externalIdentities.externalUserId),
  );

/** The user's linked subscriptions, by workspace slug then subscription, with their access. */
export async function listMyAccess(
  db: Db,
  key: { userId: string; now: Instant },
): Promise<MyAccessSubscription[]> {
  const mine = userSubjects(key.userId);
  const [subscriptionRows, entitlementRows, grantRows, manualRows] = await Promise.all([
    db
      .select({
        workspace: { id: workspaces.id, slug: workspaces.slug, name: workspaces.name },
        subjectId: subjects.id,
        customerId: customers.id,
        subscription: subscriptions,
      })
      .from(externalIdentities)
      .innerJoin(subjects, mine)
      .innerJoin(workspaces, eq(workspaces.id, subjects.workspaceId))
      .innerJoin(
        customers,
        and(eq(customers.workspaceId, subjects.workspaceId), eq(customers.subjectId, subjects.id)),
      )
      .innerJoin(
        subscriptions,
        and(
          eq(subscriptions.workspaceId, customers.workspaceId),
          eq(subscriptions.customerId, customers.id),
        ),
      )
      .orderBy(asc(workspaces.slug), asc(subscriptions.createdAt), asc(subscriptions.id)),
    db
      .select({ entitlement: entitlements, repositoryName: resources.nameSnapshot })
      .from(externalIdentities)
      .innerJoin(subjects, mine)
      .innerJoin(
        entitlements,
        and(
          eq(entitlements.workspaceId, subjects.workspaceId),
          eq(entitlements.subjectId, subjects.id),
        ),
      )
      .innerJoin(
        resources,
        and(
          eq(resources.workspaceId, entitlements.workspaceId),
          eq(resources.id, entitlements.resourceId),
        ),
      )
      .orderBy(asc(entitlements.createdAt), asc(entitlements.id)),
    db
      .select({ grant: grants })
      .from(externalIdentities)
      .innerJoin(subjects, mine)
      .innerJoin(
        grants,
        and(eq(grants.workspaceId, subjects.workspaceId), eq(grants.subjectId, subjects.id)),
      )
      .orderBy(asc(grants.accessLevel), asc(grants.id)),
    // A creator's manual access to the user's GitHub account (decision 0016), reached through
    // the same identity and subjects as a purchase.
    db
      .select({
        workspace: { id: workspaces.id, slug: workspaces.slug, name: workspaces.name },
        access: manualAccesses,
      })
      .from(externalIdentities)
      .innerJoin(subjects, mine)
      .innerJoin(workspaces, eq(workspaces.id, subjects.workspaceId))
      .innerJoin(
        manualAccesses,
        and(
          eq(manualAccesses.workspaceId, subjects.workspaceId),
          eq(manualAccesses.subjectId, subjects.id),
        ),
      )
      .orderBy(asc(workspaces.slug), asc(manualAccesses.createdAt), asc(manualAccesses.id)),
  ]);

  const grantsOf = new Map<string, MyAccessGrant[]>();
  for (const { grant } of grantRows) {
    const at = `${grant.workspaceId}:${grant.subjectId}:${grant.resourceId}`;
    const list = grantsOf.get(at) ?? [];
    list.push({
      state: grant.state,
      accessLevel: grant.accessLevel,
      externalGrantId: grant.externalGrantId,
      expiresAt: grant.expiresAt,
      lastErrorCode: grant.lastErrorCode,
    });
    grantsOf.set(at, list);
  }
  const entitlementsOf = new Map<string, MyAccessEntitlement[]>();
  for (const { entitlement: e, repositoryName } of entitlementRows) {
    // Keyed by subject too: after a relink, the subscription's entitlements for another subject
    // are not the user's.
    const at = `${e.workspaceId}:${e.subjectId}:${e.sourceId}`;
    const list = entitlementsOf.get(at) ?? [];
    list.push({
      id: e.id,
      resourceId: e.resourceId,
      repositoryName,
      accessLevel: e.accessLevel,
      state: e.state,
      validUntil: e.validUntil,
      endedAt: e.endedAt,
      grants: grantsOf.get(`${e.workspaceId}:${e.subjectId}:${e.resourceId}`) ?? [],
    });
    entitlementsOf.set(at, list);
  }
  const purchased = subscriptionRows.map(
    ({ workspace, subjectId, customerId, subscription: s }) => ({
      workspace,
      subjectId,
      customerId,
      source: s.source,
      subscriptionId: s.id,
      externalSubscriptionId: s.externalSubscriptionId,
      state: s.state,
      currentPeriodEnd: s.currentPeriodEnd,
      cancelAt: s.cancelAt,
      endedAt: s.endedAt,
      pastDueSince: s.pastDueSince,
      entitlements: entitlementsOf.get(`${s.workspaceId}:${subjectId}:${s.id}`) ?? [],
      createdAt: s.createdAt,
    }),
  );
  // A manual access reads exactly like a purchase (decision 0016): active, with its end date as a
  // scheduled cancellation; once it ended or was revoked, canceled with that end.
  const manual = manualRows.map(({ workspace, access: a }) => {
    const ended = a.revokedAt ?? (a.endsAt !== null && a.endsAt <= key.now ? a.endsAt : null);
    return {
      workspace,
      subjectId: a.subjectId,
      customerId: null,
      source: "manual" as const,
      subscriptionId: a.id,
      externalSubscriptionId: a.id,
      state: ended === null ? ("active" as const) : ("canceled" as const),
      currentPeriodEnd: null,
      cancelAt: ended === null ? a.endsAt : null,
      endedAt: ended,
      pastDueSince: null,
      entitlements: entitlementsOf.get(`${a.workspaceId}:${a.subjectId}:${a.id}`) ?? [],
      createdAt: a.createdAt,
    };
  });
  // By workspace slug, then creation, then ID, as the queries order each list: one key in
  // code-unit order (NUL never occurs in slugs or IDs; instants are padded to compare as text).
  const keyOf = (x: { workspace: { slug: string }; createdAt: Instant; subscriptionId: string }) =>
    [x.workspace.slug, String(x.createdAt).padStart(16, "0"), x.subscriptionId].join("\u0000");
  const byKey = new Map([...purchased, ...manual].map((item) => [keyOf(item), item]));
  return [...byKey.keys()].sort().map((k) => {
    const { createdAt: _createdAt, ...item } = byKey.get(k) as (typeof purchased)[number];
    return item;
  });
}
