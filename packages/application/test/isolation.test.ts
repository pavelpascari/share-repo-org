import { env } from "cloudflare:workers";
import { NotFoundError } from "@sharerepo/platform";
import { expectNoChangeOnFailure } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  addWorkspaceMember,
  createWorkspace,
  listMyWorkspaces,
  openWorkspace,
  renameWorkspace,
  type UserActor,
} from "../src/index.ts";
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
