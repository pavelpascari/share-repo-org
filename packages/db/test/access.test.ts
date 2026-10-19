import { describe, expect, it } from "vitest";
import { readAccessState, schema } from "../src/index.ts";
import { entitlementRow, seedSubject, subscribedWorkspace } from "./support/commerce.ts";
import { db, resourceRow } from "./support/connections.ts";
import { T0, uniqueId } from "./support/rows.ts";

describe("access state", () => {
  it("lists each pair with desired or observed access once, by login then repository name", async () => {
    const ws = await subscribedWorkspace();
    const other = await subscribedWorkspace();
    const alpha = resourceRow(ws.workspaceId, ws.connection.id, { nameSnapshot: "octocat/alpha" });
    const zeta = resourceRow(ws.workspaceId, ws.connection.id, { nameSnapshot: "octocat/Zeta" });
    for (const resource of [alpha, zeta]) await db.insert(schema.resources).values(resource);
    const alice = await seedSubject(ws.workspaceId, { loginSnapshot: "Alice" });
    const bob = await seedSubject(ws.workspaceId, { loginSnapshot: "bob" });
    const carol = await seedSubject(ws.workspaceId, { loginSnapshot: "carol" });
    const entitlement = (
      subjectId: string,
      resourceId: string,
      overrides: Parameters<typeof entitlementRow>[1] = {},
    ) =>
      entitlementRow(
        {
          workspaceId: ws.workspaceId,
          subjectId,
          resourceId,
          subscriptionId: ws.subscription.id,
          offerId: ws.offer.offer.id,
        },
        overrides,
      );
    const ended = (endedAt: number) => ({ state: "expired" as const, endedAt });
    const bobZeta = entitlement(bob.id, zeta.id, { createdAt: T0 + 2, updatedAt: T0 + 2 });
    const bobAlpha = entitlement(bob.id, alpha.id);
    // A live and a recently ended entitlement for the same pair: one pair. The ended one is newer.
    const aliceLive = entitlement(alice.id, zeta.id);
    const aliceEnded = entitlement(alice.id, zeta.id, {
      ...ended(T0 + 1),
      createdAt: T0 + 1,
      updatedAt: T0 + 1,
    });
    await db.insert(schema.entitlements).values([
      bobZeta,
      bobAlpha,
      aliceLive,
      aliceEnded,
      // Ended before the window: not listed.
      entitlement(carol.id, alpha.id, ended(T0 - 1)),
    ]);
    const grant = (subjectId: string, resourceId: string) => ({
      id: uniqueId("gra"),
      workspaceId: ws.workspaceId,
      connectionId: ws.connection.id,
      subjectId,
      resourceId,
      accessLevel: "write" as const,
      state: "active" as const,
      managed: false,
      createdAt: T0,
      updatedAt: T0,
    });
    // Observed without desired access, and observed alongside it.
    await db
      .insert(schema.grants)
      .values([
        grant(carol.id, zeta.id),
        { ...grant(bob.id, alpha.id), createdAt: T0 + 1, updatedAt: T0 + 1 },
      ]);

    const { pairs, entitlements, grants } = await readAccessState(db, ws.workspaceId, {
      endedSince: T0,
    });

    expect(pairs.map((p) => `${p.subjectLogin} ${p.resourceName}`)).toEqual([
      "Alice octocat/Zeta",
      "bob octocat/alpha",
      "bob octocat/Zeta",
      "carol octocat/Zeta",
      "monalisa octocat/repo-0",
    ]);
    expect(pairs[0]).toEqual({
      subjectId: alice.id,
      subjectLogin: "Alice",
      resourceId: zeta.id,
      resourceName: "octocat/Zeta",
    });
    // Live first, then newest first.
    expect(entitlements.map((e) => e.id)).toEqual([
      bobZeta.id,
      ...[bobAlpha.id, aliceLive.id, ws.entitlement.id].sort(),
      aliceEnded.id,
    ]);
    expect(grants.map((g) => g.subjectId)).toEqual([carol.id, bob.id]);
    expect((await readAccessState(db, other.workspaceId, { endedSince: T0 })).pairs).toEqual([
      {
        subjectId: other.subject.id,
        subjectLogin: other.subject.loginSnapshot,
        resourceId: other.resource.id,
        resourceName: other.resource.nameSnapshot,
      },
    ]);
  });

  it("orders pairs that share a login and repository name by their IDs", async () => {
    const ws = await subscribedWorkspace();
    const renamed = await seedSubject(ws.workspaceId, {
      id: `sub_${"0".repeat(8)}-${crypto.randomUUID()}`,
      loginSnapshot: ws.subject.loginSnapshot,
    });
    await db.insert(schema.entitlements).values(
      entitlementRow({
        workspaceId: ws.workspaceId,
        subjectId: renamed.id,
        resourceId: ws.resource.id,
        subscriptionId: ws.subscription.id,
        offerId: ws.offer.offer.id,
      }),
    );
    const ids = [renamed.id, ws.subject.id].sort();
    const { pairs } = await readAccessState(db, ws.workspaceId, { endedSince: T0 });
    expect(pairs.map((p) => p.subjectId)).toEqual(ids);
  });
});
