import { env } from "cloudflare:workers";
import { NotFoundError } from "@sharerepo/platform";
import { describe, expect, it } from "vitest";
import { ENDED_ACCESS_VISIBLE_MS, listAccess } from "../src/index.ts";
import {
  act,
  DAY,
  drain,
  entitlementsOf,
  live,
  memberOf,
  offer,
  type Shop,
  shop,
  subscribe,
} from "./support/commerce.ts";
import { clock, serviceContext, signedUpUser } from "./support/context.ts";

async function grant(s: Shop, subjectId: string, resourceId: string, state: string) {
  await env.DB.prepare(
    `INSERT INTO grants (id, workspace_id, connection_id, subject_id, resource_id, access_level,
       state, managed, observed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'write', ?, 1, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      s.workspaceId,
      s.connection.id,
      subjectId,
      resourceId,
      state,
      clock.now(),
      clock.now(),
      clock.now(),
    )
    .run();
}

describe("listAccess", () => {
  it("shows desired access, observed access and the planned action per subscriber and repository", async () => {
    const s = await shop(2);
    const sold = await offer(s, { items: ["sim_pro"], name: "Pro" });
    const sub = await subscribe(s, { items: ["sim_pro"] });
    await drain(s.workspaceId);
    const rows = (await listAccess(serviceContext(), s, s.slug)).rows;
    const names = [...s.resources].map((r) => r.nameSnapshot).sort();
    expect(rows.map((row) => row.resourceName)).toEqual(names);
    expect(rows[0]).toMatchObject({
      subjectLogin: sub.login,
      grant: null,
      planned: { action: "provision", reason: "grant_missing" },
      entitlements: [
        {
          state: "active",
          accessLevel: "write",
          offerId: sold.id,
          offerName: "Pro",
          offerVersion: 1,
          policyVersion: 1,
          validUntil: null,
          reason: "active",
          endedAt: null,
        },
      ],
    });
  });

  it("shows an observed grant and verifies it", async () => {
    const s = await shop();
    await offer(s, { items: ["sim_pro"] });
    await subscribe(s, { items: ["sim_pro"] });
    await drain(s.workspaceId);
    const [entitlement] = await entitlementsOf(s.workspaceId);
    await grant(s, entitlement?.subjectId ?? "", entitlement?.resourceId ?? "", "active");
    const [row] = (await listAccess(serviceContext(), s, s.slug)).rows;
    expect(row).toMatchObject({
      grant: { state: "active", accessLevel: "write", managed: true, observedAt: clock.now() },
      planned: { action: "verify", reason: "grant_active" },
    });
  });

  it("keeps ended entitlements for 30 days, live ones first, and plans revocation of leftover grants", async () => {
    const s = await shop();
    await offer(s, { items: ["sim_pro"] });
    const sub = await subscribe(s, { items: ["sim_pro"] });
    await drain(s.workspaceId);
    await act(s, sub.id, "cancel_now");
    await drain(s.workspaceId);
    clock.advance(DAY);
    await act(s, sub.id, "reactivate");
    await drain(s.workspaceId);
    const [row] = (await listAccess(serviceContext(), s, s.slug)).rows;
    expect(row?.entitlements.map((e) => [e.state, e.reason])).toEqual([
      ["active", "active"],
      ["expired", "canceled"],
    ]);

    await act(s, sub.id, "pause");
    await drain(s.workspaceId);
    const [ended] = (await listAccess(serviceContext(), s, s.slug)).rows;
    expect(ended?.entitlements.map((e) => e.state)).toEqual(["revoked", "expired"]);
    expect(ended?.planned).toBeNull();
    // A managed grant that is no longer desired is planned for revocation.
    const [any] = await entitlementsOf(s.workspaceId);
    await grant(s, any?.subjectId ?? "", any?.resourceId ?? "", "active");
    const [withGrant] = (await listAccess(serviceContext(), s, s.slug)).rows;
    expect(withGrant?.planned).toEqual({ action: "revoke", reason: "not_entitled" });

    clock.advance(ENDED_ACCESS_VISIBLE_MS + DAY);
    const [later] = (await listAccess(serviceContext(), s, s.slug)).rows;
    expect(later?.entitlements).toEqual([]);
    expect(live(await entitlementsOf(s.workspaceId))).toEqual([]);
  });

  it("lets any member read it; strangers see nothing", async () => {
    const s = await shop();
    const member = await memberOf(s);
    expect((await listAccess(serviceContext(), member, s.slug)).rows).toEqual([]);
    const stranger = await signedUpUser();
    await expect(listAccess(serviceContext(), stranger, s.slug)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
