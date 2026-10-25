import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyCustomerLink,
  createCheckoutClaim,
  createClaimTokens,
  type ExternalIdentity,
  findOrCreateSubjectForIdentity,
  getCheckoutClaim,
  getCustomer,
  insertExternalIdentity,
  listCustomersWithLinks,
  listMyAccess,
  type NewOutboxRow,
  schema,
} from "../src/index.ts";
import { accountEvent, auditCount, workspaceEvent } from "./support/audit.ts";
import {
  customerRow,
  entitlementRow,
  seedSubject,
  subscribedWorkspace,
  subscriptionRow,
} from "./support/commerce.ts";
import { count, db, workspaceWithOwner } from "./support/connections.ts";
import { hexDigest } from "./support/paddle.ts";
import { grantRow, seedGrant } from "./support/reconcile.ts";
import { insertUserRow, T0, uniqueId } from "./support/rows.ts";

const NOW = T0 + 60_000;
const DAY = 86_400_000;

/** A ShareRepo user signed in with a GitHub account (`externalUserId`). */
async function githubUser(externalUserId = String(Math.floor(Math.random() * 1e12))) {
  const userId = uniqueId("usr");
  await insertUserRow(userId);
  const identity: ExternalIdentity = {
    id: uniqueId("eid"),
    userId,
    provider: "github",
    externalUserId,
    usernameSnapshot: `user-${externalUserId}`,
    displayNameSnapshot: null,
    avatarUrlSnapshot: null,
    verifiedAt: T0,
    createdAt: T0,
    updatedAt: T0,
  };
  const result = await insertExternalIdentity(db, identity, [accountEvent()]);
  if (!result.ok) throw new Error(result.reason);
  return { userId, identity };
}

const refreshRow =
  (workspaceId: string) =>
  (subscription: { source: string; externalSubscriptionId: string }): NewOutboxRow => ({
    id: uniqueId("obx"),
    kind: "refresh_subscription",
    subjectId: `${workspaceId}:${subscription.source}:${subscription.externalSubscriptionId}`,
    createdAt: NOW,
    availableAt: NOW,
  });

describe("findOrCreateSubjectForIdentity", () => {
  it("creates the workspace's subject for a user's GitHub account once, with audit", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const { identity } = await githubUser();
    const event = workspaceEvent(workspaceId);
    const subjectId = uniqueId("sub");
    const first = await findOrCreateSubjectForIdentity(
      db,
      { workspaceId, identity, subjectId, now: NOW },
      [event],
    );
    expect(first).toEqual({
      created: true,
      subject: {
        id: subjectId,
        workspaceId,
        provider: "github",
        type: "user",
        externalSubjectId: identity.externalUserId,
        loginSnapshot: identity.usernameSnapshot,
        externalIdentityId: identity.id,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    const again = workspaceEvent(workspaceId);
    expect(
      await findOrCreateSubjectForIdentity(
        db,
        { workspaceId, identity, subjectId: uniqueId("sub"), now: NOW + 1 },
        [again],
      ),
    ).toEqual({ created: false, subject: first.subject });
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
    expect(await auditCount(env.DB, again.correlationId)).toBe(0);
  });

  it("returns a subject recorded earlier from commercial data for the same account", async () => {
    const { workspaceId } = await workspaceWithOwner();
    const existing = await seedSubject(workspaceId);
    const { identity } = await githubUser(existing.externalSubjectId);
    expect(
      await findOrCreateSubjectForIdentity(
        db,
        { workspaceId, identity, subjectId: uniqueId("sub"), now: NOW },
        [workspaceEvent(workspaceId)],
      ),
    ).toEqual({ created: false, subject: existing });
  });

  it("isolation/cross-workspace-read-denied: keeps one subject per workspace", async () => {
    const a = await workspaceWithOwner();
    const b = await workspaceWithOwner();
    const { identity } = await githubUser();
    const inA = await findOrCreateSubjectForIdentity(
      db,
      { workspaceId: a.workspaceId, identity, subjectId: uniqueId("sub"), now: NOW },
      [workspaceEvent(a.workspaceId)],
    );
    const inB = await findOrCreateSubjectForIdentity(
      db,
      { workspaceId: b.workspaceId, identity, subjectId: uniqueId("sub"), now: NOW },
      [workspaceEvent(b.workspaceId)],
    );
    expect(inB.created).toBe(true);
    expect(inB.subject.id).not.toBe(inA.subject.id);
    expect(inB.subject.workspaceId).toBe(b.workspaceId);
  });
});

describe("listCustomersWithLinks", () => {
  it("lists customers with their linked subject and subscription states", async () => {
    const ws = await subscribedWorkspace();
    const unclaimed = customerRow(ws.workspaceId, { createdAt: T0 + 1, updatedAt: T0 + 1 });
    await db.insert(schema.customers).values(unclaimed);
    const second = subscriptionRow(ws.workspaceId, ws.customer.id, {
      externalSubscriptionId: `zz-${uniqueId("ext")}`,
      state: "canceled",
      endedAt: T0 + 5,
    });
    await db.insert(schema.subscriptions).values(second);
    expect(await listCustomersWithLinks(db, { workspaceId: ws.workspaceId })).toEqual([
      {
        customer: ws.customer,
        subject: {
          id: ws.subject.id,
          externalSubjectId: ws.subject.externalSubjectId,
          login: ws.subject.loginSnapshot,
        },
        subscriptions: [
          {
            id: ws.subscription.id,
            externalSubscriptionId: ws.subscription.externalSubscriptionId,
            state: "active",
            cancelAt: null,
            endedAt: null,
          },
          {
            id: second.id,
            externalSubscriptionId: second.externalSubscriptionId,
            state: "canceled",
            cancelAt: null,
            endedAt: T0 + 5,
          },
        ],
      },
      { customer: unclaimed, subject: null, subscriptions: [] },
    ]);
  });

  it("isolation/cross-workspace-read-denied: lists only the workspace's customers", async () => {
    await subscribedWorkspace();
    const { workspaceId } = await workspaceWithOwner();
    expect(await listCustomersWithLinks(db, { workspaceId })).toEqual([]);
  });
});

describe("applyCustomerLink", () => {
  async function unclaimedCustomer() {
    const ws = await subscribedWorkspace();
    const customer = customerRow(ws.workspaceId, { source: "paddle" });
    await db.insert(schema.customers).values(customer);
    const subscription = subscriptionRow(ws.workspaceId, customer.id, { source: "paddle" });
    await db.insert(schema.subscriptions).values(subscription);
    const subject = await seedSubject(ws.workspaceId);
    return { ...ws, customer, paddleSubscription: subscription, newSubject: subject };
  }

  const refreshKey = (s: { workspaceId: string; source: string; externalSubscriptionId: string }) =>
    `${s.workspaceId}:${s.source}:${s.externalSubscriptionId}`;

  it("links an unlinked customer with audit and a refresh of its subscriptions, once", async () => {
    const ws = await unclaimedCustomer();
    const input = {
      workspaceId: ws.workspaceId,
      customerId: ws.customer.id,
      expectedSubjectId: null,
      subjectId: ws.newSubject.id,
      now: NOW,
      makeRefreshRow: refreshRow(ws.workspaceId),
    };
    const event = workspaceEvent(ws.workspaceId);
    expect(await applyCustomerLink(db, input, [event])).toEqual({ ok: true });
    expect(
      await getCustomer(db, { workspaceId: ws.workspaceId, customerId: ws.customer.id }),
    ).toMatchObject({ subjectId: ws.newSubject.id, updatedAt: NOW });
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
    const key = refreshKey(ws.paddleSubscription);
    expect(await count("outbox", "kind = 'refresh_subscription' AND subject_id = ?", key)).toBe(1);

    const again = workspaceEvent(ws.workspaceId);
    expect(await applyCustomerLink(db, input, [again])).toEqual({ ok: false, reason: "stale" });
    expect(await auditCount(env.DB, again.correlationId)).toBe(0);
    expect(await count("outbox", "subject_id = ?", key)).toBe(1);
  });

  it("identity/unlink-relink-moves-subject-safely: relinks only from the expected subject", async () => {
    const ws = await subscribedWorkspace();
    const next = await seedSubject(ws.workspaceId);
    const base = {
      workspaceId: ws.workspaceId,
      customerId: ws.customer.id,
      subjectId: next.id,
      now: NOW,
      makeRefreshRow: refreshRow(ws.workspaceId),
    };
    const stale = workspaceEvent(ws.workspaceId);
    expect(await applyCustomerLink(db, { ...base, expectedSubjectId: null }, [stale])).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(await auditCount(env.DB, stale.correlationId)).toBe(0);
    const event = workspaceEvent(ws.workspaceId);
    expect(
      await applyCustomerLink(db, { ...base, expectedSubjectId: ws.subject.id }, [event]),
    ).toEqual({ ok: true });
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
    expect(await count("outbox", "subject_id = ?", refreshKey(ws.subscription))).toBe(1);
  });

  it("isolation/cross-workspace-read-denied: links nothing in another workspace", async () => {
    const ws = await unclaimedCustomer();
    const other = await subscribedWorkspace();
    const event = workspaceEvent(other.workspaceId);
    expect(
      await applyCustomerLink(
        db,
        {
          workspaceId: other.workspaceId,
          customerId: ws.customer.id,
          expectedSubjectId: null,
          subjectId: other.subject.id,
          now: NOW,
          makeRefreshRow: refreshRow(other.workspaceId),
        },
        [event],
      ),
    ).toEqual({ ok: false, reason: "stale" });
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("isolation/composite-fk-rejects-cross-tenant-link: refuses another workspace's subject", async () => {
    const ws = await unclaimedCustomer();
    const other = await subscribedWorkspace();
    const event = workspaceEvent(ws.workspaceId);
    await expect(
      applyCustomerLink(
        db,
        {
          workspaceId: ws.workspaceId,
          customerId: ws.customer.id,
          expectedSubjectId: null,
          subjectId: other.subject.id,
          now: NOW,
          makeRefreshRow: refreshRow(ws.workspaceId),
        },
        [event],
      ),
    ).rejects.toThrow();
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
    expect(await count("customers", "id = ? AND subject_id IS NULL", ws.customer.id)).toBe(1);
  });

  it("claim/token-single-use-and-expiring: consumes the claim token in the same batch", async () => {
    const ws = await unclaimedCustomer();
    const buyer = uniqueId("usr");
    await insertUserRow(buyer);
    const [token, expired] = await createClaimTokens(
      db,
      [
        {
          id: uniqueId("clt"),
          workspaceId: ws.workspaceId,
          customerId: ws.customer.id,
          tokenHash: hexDigest(),
          createdAt: T0,
          expiresAt: NOW + DAY,
        },
        {
          id: uniqueId("clt"),
          workspaceId: ws.workspaceId,
          customerId: ws.customer.id,
          tokenHash: hexDigest(),
          createdAt: T0,
          expiresAt: NOW,
        },
      ],
      [workspaceEvent(ws.workspaceId)],
    );
    const link = (tokenId: string, expectedSubjectId: string | null, subjectId: string) =>
      applyCustomerLink(
        db,
        {
          workspaceId: ws.workspaceId,
          customerId: ws.customer.id,
          expectedSubjectId,
          subjectId,
          now: NOW,
          makeRefreshRow: refreshRow(ws.workspaceId),
          consume: { kind: "claim_token", id: tokenId, userId: buyer },
        },
        [workspaceEvent(ws.workspaceId, { correlationId: `link-${tokenId}-${subjectId}` })],
      );
    const expiredId = expired?.id as string;
    expect(await link(expiredId, null, ws.newSubject.id)).toEqual({ ok: false, reason: "stale" });
    expect(await count("claim_tokens", "id = ? AND consumed_at IS NULL", expiredId)).toBe(1);

    const tokenId = token?.id as string;
    expect(await link(tokenId, null, ws.newSubject.id)).toEqual({ ok: true });
    expect(await auditCount(env.DB, `link-${tokenId}-${ws.newSubject.id}`)).toBe(1);
    expect(
      await count(
        "claim_tokens",
        "id = ? AND consumed_at = ? AND consumed_by_user_id = ?",
        tokenId,
        NOW,
        buyer,
      ),
    ).toBe(1);
    // A used token moves nothing, even from the right subject.
    expect(await link(tokenId, ws.newSubject.id, ws.subject.id)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(await auditCount(env.DB, `link-${tokenId}-${ws.subject.id}`)).toBe(0);
  });

  it("does not consume a token when the link is stale", async () => {
    const ws = await unclaimedCustomer();
    const buyer = uniqueId("usr");
    await insertUserRow(buyer);
    const [token] = await createClaimTokens(
      db,
      [
        {
          id: uniqueId("clt"),
          workspaceId: ws.workspaceId,
          customerId: ws.customer.id,
          tokenHash: hexDigest(),
          createdAt: T0,
          expiresAt: NOW + DAY,
        },
      ],
      [workspaceEvent(ws.workspaceId)],
    );
    expect(
      await applyCustomerLink(
        db,
        {
          workspaceId: ws.workspaceId,
          customerId: ws.customer.id,
          expectedSubjectId: ws.subject.id,
          subjectId: ws.newSubject.id,
          now: NOW,
          makeRefreshRow: refreshRow(ws.workspaceId),
          consume: { kind: "claim_token", id: token?.id as string, userId: buyer },
        },
        [workspaceEvent(ws.workspaceId)],
      ),
    ).toEqual({ ok: false, reason: "stale" });
    expect(await count("claim_tokens", "id = ? AND consumed_at IS NULL", token?.id)).toBe(1);
  });

  it("claim/checkout-reference-tamper-rejected: consumes a checkout claim for this customer only", async () => {
    const ws = await unclaimedCustomer();
    const buyer = uniqueId("usr");
    await insertUserRow(buyer);
    const claim = await createCheckoutClaim(
      db,
      {
        id: uniqueId("ckc"),
        workspaceId: ws.workspaceId,
        userId: buyer,
        offerId: ws.offer.offer.id,
        priceId: "pri_01",
        createdAt: T0,
        expiresAt: NOW + DAY,
      },
      [workspaceEvent(ws.workspaceId)],
    );
    const event = workspaceEvent(ws.workspaceId);
    expect(
      await applyCustomerLink(
        db,
        {
          workspaceId: ws.workspaceId,
          customerId: ws.customer.id,
          expectedSubjectId: null,
          subjectId: ws.newSubject.id,
          now: NOW,
          makeRefreshRow: refreshRow(ws.workspaceId),
          consume: { kind: "checkout_claim", id: claim.id },
        },
        [event],
      ),
    ).toEqual({ ok: true });
    expect(await getCheckoutClaim(db, { workspaceId: ws.workspaceId, id: claim.id })).toMatchObject(
      { consumedByCustomerId: ws.customer.id, consumedAt: NOW },
    );
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);

    // Another customer presenting the consumed claim is not linked.
    const second = customerRow(ws.workspaceId, { source: "paddle" });
    await db.insert(schema.customers).values(second);
    const refused = workspaceEvent(ws.workspaceId);
    expect(
      await applyCustomerLink(
        db,
        {
          workspaceId: ws.workspaceId,
          customerId: second.id,
          expectedSubjectId: null,
          subjectId: ws.newSubject.id,
          now: NOW + 1,
          makeRefreshRow: refreshRow(ws.workspaceId),
          consume: { kind: "checkout_claim", id: claim.id },
        },
        [refused],
      ),
    ).toEqual({ ok: false, reason: "stale" });
    expect(await auditCount(env.DB, refused.correlationId)).toBe(0);
    expect(await count("customers", "id = ? AND subject_id IS NULL", second.id)).toBe(1);
  });
});

describe("listMyAccess", () => {
  it("lists the user's linked subscriptions with entitlements and grants, across workspaces", async () => {
    const ws = await subscribedWorkspace();
    const { userId } = await githubUser(ws.subject.externalSubjectId);
    const grant = grantRow(
      {
        workspaceId: ws.workspaceId,
        connectionId: ws.connection.id,
        subjectId: ws.subject.id,
        resourceId: ws.resource.id,
      },
      {
        state: "pending_invitation",
        managed: true,
        externalGrantId: "inv_1",
        expiresAt: T0 + 7 * DAY,
      },
    );
    await seedGrant(grant);
    // The same GitHub account in a second workspace, with an ended entitlement.
    const second = await subscribedWorkspace();
    await env.DB.prepare("UPDATE subjects SET external_subject_id = ? WHERE id = ?")
      .bind(ws.subject.externalSubjectId, second.subject.id)
      .run();
    const ended = entitlementRow(
      {
        workspaceId: second.workspaceId,
        subjectId: second.subject.id,
        resourceId: second.resource.id,
        subscriptionId: second.subscription.id,
        offerId: second.offer.offer.id,
      },
      { state: "revoked", endedAt: T0 + 2, createdAt: T0 + 1, updatedAt: T0 + 2 },
    );
    await db.insert(schema.entitlements).values(ended);

    const access = await listMyAccess(db, { userId });
    const workspaceSlugs = await env.DB.prepare(
      "SELECT id, slug, name FROM workspaces WHERE id IN (?, ?)",
    )
      .bind(ws.workspaceId, second.workspaceId)
      .all<{ id: string; slug: string; name: string }>();
    const ordered = [...workspaceSlugs.results].sort((a, b) => (a.slug < b.slug ? -1 : 1));
    expect(access.map((a) => a.workspace)).toEqual(ordered);
    const first = access.find((a) => a.workspace.id === ws.workspaceId);
    expect(first).toEqual({
      workspace: expect.objectContaining({ id: ws.workspaceId }),
      subjectId: ws.subject.id,
      customerId: ws.customer.id,
      source: "simulated",
      subscriptionId: ws.subscription.id,
      externalSubscriptionId: ws.subscription.externalSubscriptionId,
      state: "active",
      currentPeriodEnd: ws.subscription.currentPeriodEnd,
      cancelAt: null,
      endedAt: null,
      pastDueSince: null,
      entitlements: [
        {
          id: ws.entitlement.id,
          resourceId: ws.resource.id,
          repositoryName: ws.resource.nameSnapshot,
          accessLevel: "write",
          state: "active",
          validUntil: null,
          endedAt: null,
          grants: [
            {
              state: "pending_invitation",
              accessLevel: "write",
              externalGrantId: "inv_1",
              expiresAt: T0 + 7 * DAY,
              lastErrorCode: null,
            },
          ],
        },
      ],
    });
    const other = access.find((a) => a.workspace.id === second.workspaceId);
    expect(other?.entitlements.map((e) => [e.id, e.state, e.grants])).toEqual([
      [second.entitlement.id, "active", []],
      [ended.id, "revoked", []],
    ]);
  });

  it("isolation/cross-workspace-read-denied: shows nothing of other users or unlinked customers", async () => {
    const ws = await subscribedWorkspace();
    await githubUser(ws.subject.externalSubjectId);
    const stranger = await githubUser();
    expect(await listMyAccess(db, { userId: stranger.userId })).toEqual([]);
    // A user whose subject exists but whose customer is unlinked sees nothing.
    const unlinked = await subscribedWorkspace();
    await env.DB.prepare("UPDATE customers SET subject_id = NULL WHERE id = ?")
      .bind(unlinked.customer.id)
      .run();
    const owner = await githubUser(unlinked.subject.externalSubjectId);
    expect(await listMyAccess(db, { userId: owner.userId })).toEqual([]);
    expect(await listMyAccess(db, { userId: uniqueId("usr") })).toEqual([]);
  });

  it("omits entitlements of a subscription that belong to another subject after a relink", async () => {
    const ws = await subscribedWorkspace();
    const previous = await githubUser(ws.subject.externalSubjectId);
    const next = await seedSubject(ws.workspaceId);
    const nextUser = await githubUser(next.externalSubjectId);
    await env.DB.prepare("UPDATE customers SET subject_id = ? WHERE id = ?")
      .bind(next.id, ws.customer.id)
      .run();
    expect(await listMyAccess(db, { userId: previous.userId })).toEqual([]);
    const [mine] = await listMyAccess(db, { userId: nextUser.userId });
    expect(mine?.subscriptionId).toBe(ws.subscription.id);
    expect(mine?.entitlements).toEqual([]);
  });
});
