import { env } from "cloudflare:workers";
import { NotFoundError } from "@sharerepo/platform";
import { expectNoChangeOnFailure } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  addWorkspaceMember,
  archiveOffer,
  createOffer,
  createSimulatedSubscriber,
  createWorkspace,
  listAccess,
  listMyWorkspaces,
  listOfferableResources,
  listOffers,
  listSimulatedSubscriptions,
  openWorkspace,
  refreshSubscription,
  renameWorkspace,
  simulateSubscriptionAction,
  type UserActor,
  updateOffer,
} from "../src/index.ts";
import {
  drain,
  entitlementsOf,
  offer,
  SIMULATION,
  shop,
  source,
  subscribe,
} from "./support/commerce.ts";
import { serviceContext, signedUpUser, uniqueSlug } from "./support/context.ts";

// Horizontal privilege escalation: user B, a full owner of their own workspace, targets
// workspace A by its slug. Every path must behave as if A does not exist.

async function twoTenants() {
  const alice = await signedUpUser();
  const bob = await signedUpUser();
  const create = async (owner: UserActor) => {
    const result = await createWorkspace(serviceContext(), owner, {
      name: "Tenant",
      slug: uniqueSlug(),
    });
    if (!result.ok) throw new Error("setup failed");
    return result.workspace;
  };
  return { alice, bob, aliceWorkspace: await create(alice), bobWorkspace: await create(bob) };
}

describe("isolation/cross-workspace-read-denied", () => {
  it.each(["workspace.read", "workspace.manage"] as const)(
    "opening another tenant's workspace for %s is not found",
    async (permission) => {
      const { bob, aliceWorkspace } = await twoTenants();
      await expect(
        openWorkspace(serviceContext(), bob, aliceWorkspace.slug, permission),
      ).rejects.toBeInstanceOf(NotFoundError);
    },
  );

  it("another tenant's workspace never appears in the actor's list", async () => {
    const { bob, bobWorkspace } = await twoTenants();
    expect(await listMyWorkspaces(serviceContext(), bob)).toEqual([bobWorkspace]);
  });

  it("not found for another tenant is identical to not found for a missing slug", async () => {
    const { bob, aliceWorkspace } = await twoTenants();
    const errorFor = (slug: string) =>
      openWorkspace(serviceContext(), bob, slug, "workspace.read").catch((error: unknown) => error);
    const [foreign, missing] = await Promise.all([
      errorFor(aliceWorkspace.slug),
      errorFor(uniqueSlug()),
    ]);
    expect(foreign).toEqual(missing);
  });
});

describe("isolation/cross-workspace-mutation-denied", () => {
  it("renaming another tenant's workspace is not found and changes nothing", async () => {
    const { bob, aliceWorkspace } = await twoTenants();
    const error = await expectNoChangeOnFailure(env.DB, () =>
      renameWorkspace(serviceContext(), bob, aliceWorkspace.slug, { name: "Pwned" }),
    );
    expect(error).toBeInstanceOf(NotFoundError);
  });

  it("adding oneself to another tenant's workspace is not found and changes nothing", async () => {
    const { bob, aliceWorkspace } = await twoTenants();
    const error = await expectNoChangeOnFailure(env.DB, () =>
      addWorkspaceMember(serviceContext(), bob, aliceWorkspace.slug, {
        userId: bob.userId,
        role: "owner",
      }),
    );
    expect(error).toBeInstanceOf(NotFoundError);
  });
});

// Phase 3: offers, simulated subscriptions, subscriptions and access. Bob owns a fully set-up
// workspace of his own; Alice's data must never be visible or mutable through it, nor through
// Alice's slug.
async function twoShops() {
  const alice = await shop();
  const bob = await shop();
  const aliceOffer = await offer(alice, { items: ["sim_iso"] });
  const aliceSub = await subscribe(alice, { items: ["sim_iso"] });
  await drain(alice.workspaceId);
  // Bob sells the same item ID: items are scoped to a workspace.
  await offer(bob, { items: ["sim_iso"] });
  return { alice, bob, aliceOffer, aliceSub };
}

describe("isolation/cross-workspace-read-denied (entitlements)", () => {
  it("another tenant's offers, simulator rows and access rows are not found through its slug", async () => {
    const { alice, bob } = await twoShops();
    for (const read of [
      () => listOffers(serviceContext(), bob, alice.slug),
      () => listOfferableResources(serviceContext(), bob, alice.slug),
      () => listSimulatedSubscriptions(serviceContext(), bob, alice.slug, SIMULATION),
      () => listAccess(serviceContext(), bob, alice.slug),
    ]) {
      await expect(read()).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("another tenant's data never appears in the actor's own workspace", async () => {
    const { alice, bob, aliceOffer, aliceSub } = await twoShops();
    const offers = await listOffers(serviceContext(), bob, bob.slug);
    expect(offers.map((o) => o.id)).not.toContain(aliceOffer.id);
    const resources = await listOfferableResources(serviceContext(), bob, bob.slug);
    expect(resources.map((r) => r.id)).toEqual(bob.resources.map((r) => r.id));
    expect(await listSimulatedSubscriptions(serviceContext(), bob, bob.slug, SIMULATION)).toEqual(
      [],
    );
    expect(await listAccess(serviceContext(), bob, bob.slug)).toEqual([]);
    // Alice's own view is unaffected by Bob's offer for the same item ID.
    const [row] = await listAccess(serviceContext(), alice, alice.slug);
    expect(row?.subjectLogin).toBe(aliceSub.login);
    expect(row?.entitlements.map((e) => e.offerId)).toEqual([aliceOffer.id]);
  });
});

describe("isolation/cross-workspace-mutation-denied (entitlements)", () => {
  it("another tenant's offers cannot be changed through the actor's workspace", async () => {
    const { bob, aliceOffer } = await twoShops();
    for (const change of [
      () => updateOffer(serviceContext(), bob, bob.slug, aliceOffer.id, aliceOffer),
      () => archiveOffer(serviceContext(), bob, bob.slug, aliceOffer.id),
    ]) {
      expect(await expectNoChangeOnFailure(env.DB, change)).toBeInstanceOf(NotFoundError);
    }
  });

  it("another tenant's simulated subscription cannot be driven", async () => {
    const { bob, aliceSub } = await twoShops();
    const error = await expectNoChangeOnFailure(env.DB, () =>
      simulateSubscriptionAction(
        serviceContext(),
        bob,
        bob.slug,
        aliceSub.id,
        "cancel_now",
        SIMULATION,
      ),
    );
    expect(error).toBeInstanceOf(NotFoundError);
  });

  it("another tenant's repositories cannot be sold", async () => {
    const { alice, bob } = await twoShops();
    await expect(
      createOffer(serviceContext(), bob, bob.slug, {
        name: "Stolen",
        items: [{ source: "simulated", externalItemId: "sim_stolen" }],
        accesses: [{ resourceId: alice.resources[0]?.id, accessLevel: "write" }],
      }),
    ).resolves.toEqual({
      ok: false,
      errors: [{ field: "access", resourceId: alice.resources[0]?.id, code: "resource_not_found" }],
    });
  });

  it("nothing is created through another tenant's slug", async () => {
    const { alice, bob, aliceOffer, aliceSub } = await twoShops();
    for (const change of [
      () => createOffer(serviceContext(), bob, alice.slug, aliceOffer),
      () => updateOffer(serviceContext(), bob, alice.slug, aliceOffer.id, aliceOffer),
      () => archiveOffer(serviceContext(), bob, alice.slug, aliceOffer.id),
      () =>
        createSimulatedSubscriber(
          serviceContext(),
          bob,
          alice.slug,
          { login: aliceSub.login, items: ["sim_iso"], state: "active", periodDays: 30 },
          { github: alice.github, ...SIMULATION },
        ),
      () =>
        simulateSubscriptionAction(
          serviceContext(),
          bob,
          alice.slug,
          aliceSub.id,
          "pause",
          SIMULATION,
        ),
    ]) {
      expect(await expectNoChangeOnFailure(env.DB, change)).toBeInstanceOf(NotFoundError);
    }
  });

  it("a refresh in one workspace never reads another workspace's source rows", async () => {
    const { bob, aliceSub } = await twoShops();
    await expect(
      refreshSubscription(
        serviceContext(),
        { workspaceId: bob.workspaceId, source: "simulated", externalSubscriptionId: aliceSub.id },
        source,
      ),
    ).resolves.toMatchObject({ outcome: "absent" });
    expect(await entitlementsOf(bob.workspaceId)).toEqual([]);
  });
});
