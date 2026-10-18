import {
  createOffer,
  createSimulatedSubscriber,
  decodeOfferKey,
  decodeRefreshKey,
  refreshSubscription,
  simulatedEntitlementSource,
} from "@sharerepo/application";
import { ConflictError } from "@sharerepo/platform";
import type { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { attempt } from "../app/entitlements.server.ts";
import * as access from "../app/routes/w.$slug.access.tsx";
import * as offers from "../app/routes/w.$slug.offers.tsx";
import * as simulator from "../app/routes/w.$slug.simulator.tsx";
import * as layout from "../app/routes/w.$slug.tsx";
import {
  get,
  harness,
  memberOf,
  post,
  type Shop,
  services,
  shop,
  thrownStatus,
} from "./support/shop.ts";
import { db } from "./support/sign-in.ts";

// Route loaders and actions called directly, as React Router would, against local D1.

// Only the fields our loaders and actions read; each route's generated args type differs.
const args = (request: Request, s: Shop, context: RouterContextProvider) =>
  ({ request, params: { slug: s.slug }, context }) as never;

const SIMULATION = { simulation: { enabled: true } } as const;

async function offerFor(s: Shop, item = `sim_${crypto.randomUUID().slice(0, 8)}`) {
  const sellable = s.resources.find((r) => r.private);
  const result = await createOffer(services(), s.owner, s.slug, {
    name: "Pro",
    items: [{ source: "simulated", externalItemId: item }],
    accesses: [{ resourceId: sellable?.id, accessLevel: "write" }],
  });
  if (!result.ok) throw new Error("setup failed");
  return { offer: result.offer, item, resourceId: sellable?.id as string };
}

describe("workspace layout", () => {
  it("shows the simulator outside production only", async () => {
    const s = await shop();
    const dev = harness();
    const loaded = await layout.loader(args(get(`/w/${s.slug}`, s.owner), s, dev.context));
    expect(loaded.data.simulatorEnabled).toBe(true);
    const prod = harness({ environment: "production" });
    const inProd = await layout.loader(args(get(`/w/${s.slug}`, s.owner), s, prod.context));
    expect(inProd.data.simulatorEnabled).toBe(false);
  });
});

describe("offers route", () => {
  it("lists offers and offerable repositories; only owners get the controls", async () => {
    const s = await shop();
    const { offer } = await offerFor(s);
    const member = await memberOf(s);
    const { context } = harness();

    const asOwner = await offers.loader(
      args(get(`/w/${s.slug}/offers?edit=${offer.id}`, s.owner), s, context),
    );
    expect(asOwner.canManage).toBe(true);
    expect(asOwner.editing).toBe(offer.id);
    expect(asOwner.offers.map((o) => o.name)).toEqual(["Pro"]);
    expect(asOwner.repositories.map((r) => r.sellable).sort()).toEqual([false, true]);

    const asMember = await offers.loader(args(get(`/w/${s.slug}/offers`, member), s, context));
    expect(asMember.canManage).toBe(false);
    expect(asMember.offers).toHaveLength(1);
  });

  it("creates an offer from the form, with items split on commas and lines", async () => {
    const s = await shop();
    const h = harness();
    const resourceId = s.resources.find((r) => r.private)?.id as string;
    const result = await offers.action(
      args(
        post(`/w/${s.slug}/offers`, s.owner, {
          intent: "create",
          name: "Course",
          gracePeriodDays: "3",
          repositories: [resourceId],
          items: "sim_a, sim_b\nsim_c",
        }),
        s,
        h.context,
      ),
    );
    expect(result).toMatchObject({ ok: true, notice: "Created “Course”." });
    await h.settle();
    const loaded = await offers.loader(args(get(`/w/${s.slug}/offers`, s.owner), s, h.context));
    expect(loaded.offers[0]).toMatchObject({
      name: "Course",
      gracePeriodDays: 3,
      items: [
        { source: "simulated", externalItemId: "sim_a" },
        { source: "simulated", externalItemId: "sim_b" },
        { source: "simulated", externalItemId: "sim_c" },
      ],
      accesses: [{ resourceId, accessLevel: "write" }],
    });
    // Subscriptions recorded with these items before the offer existed are recomputed.
    expect(h.sent).toEqual([
      {
        kind: "recompute_offer",
        subjectId: expect.any(String),
        outboxId: expect.any(String),
      },
    ]);
    const [message] = h.sent as { subjectId: string }[];
    expect(decodeOfferKey(message?.subjectId ?? "")).toEqual({
      ok: true,
      value: { workspaceId: s.workspaceId, offerId: loaded.offers[0]?.id },
    });
  });

  it("uses the default grace period when the field is empty", async () => {
    const s = await shop();
    const h = harness();
    const resourceId = s.resources.find((r) => r.private)?.id as string;
    const result = await offers.action(
      args(
        post(`/w/${s.slug}/offers`, s.owner, {
          intent: "create",
          name: "Default grace",
          gracePeriodDays: "",
          repositories: [resourceId],
        }),
        s,
        h.context,
      ),
    );
    expect(result.ok).toBe(true);
    await h.settle();
    // No items yet: nothing to recompute.
    expect(h.sent).toEqual([]);
    const loaded = await offers.loader(args(get(`/w/${s.slug}/offers`, s.owner), s, h.context));
    expect(loaded.offers[0]?.gracePeriodDays).toBe(7);
  });

  it("maps refused input to messages that name the repository", async () => {
    const s = await shop();
    const h = harness();
    const publicRepo = s.resources.find((r) => !r.private);
    const empty = await offers.action(
      args(
        post(`/w/${s.slug}/offers`, s.owner, { intent: "create", name: "X", gracePeriodDays: "9" }),
        s,
        h.context,
      ),
    );
    expect(empty).toEqual({
      ok: false,
      notice: null,
      errors: ["Choose at least one repository."],
      formKey: "new",
    });
    const unsellable = await offers.action(
      args(
        post(`/w/${s.slug}/offers`, s.owner, {
          intent: "create",
          name: "X",
          repositories: [publicRepo?.id as string],
        }),
        s,
        h.context,
      ),
    );
    expect(unsellable.errors).toEqual([
      `${publicRepo?.nameSnapshot} can't be sold right now: it must be private, not archived, and selected in the GitHub App.`,
    ]);
  });

  it("an update and an archive hand the recompute to the queue", async () => {
    const s = await shop();
    const { offer, resourceId } = await offerFor(s);
    const h = harness();
    const updated = await offers.action(
      args(
        post(`/w/${s.slug}/offers`, s.owner, {
          intent: "update",
          offerId: offer.id,
          name: "Pro Plus",
          gracePeriodDays: "10",
          repositories: [resourceId],
          items: offer.items.map((i) => i.externalItemId).join(","),
        }),
        s,
        h.context,
      ),
    );
    expect(updated).toMatchObject({
      ok: true,
      notice: "Saved “Pro Plus” (version 2).",
      formKey: offer.id,
    });
    const archived = await offers.action(
      args(
        post(`/w/${s.slug}/offers`, s.owner, { intent: "archive", offerId: offer.id }),
        s,
        h.context,
      ),
    );
    expect(archived).toMatchObject({ ok: true, notice: "Archived “Pro Plus”." });
    await h.settle();
    expect(h.sent).toHaveLength(2);
    for (const message of h.sent as { kind: string; subjectId: string; outboxId: string }[]) {
      expect(message.kind).toBe("recompute_offer");
      expect(decodeOfferKey(message.subjectId)).toEqual({
        ok: true,
        value: { workspaceId: s.workspaceId, offerId: offer.id },
      });
      expect(message.outboxId).toEqual(expect.any(String));
    }

    const again = await offers.action(
      args(
        post(`/w/${s.slug}/offers`, s.owner, {
          intent: "update",
          offerId: offer.id,
          name: "Too late",
          repositories: [resourceId],
        }),
        s,
        h.context,
      ),
    );
    expect(again.errors).toEqual(["This offer is archived and can't be edited."]);
  });

  it("crash/between-event-commit-and-enqueue: a failed queue send does not fail the request", async () => {
    const s = await shop();
    const { offer } = await offerFor(s);
    const h = harness({ sendFails: true });
    const result = await offers.action(
      args(
        post(`/w/${s.slug}/offers`, s.owner, { intent: "archive", offerId: offer.id }),
        s,
        h.context,
      ),
    );
    expect(result.ok).toBe(true);
    await h.settle();
    expect(h.logs()).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "queue send failed; the outbox drain will deliver",
        kind: "recompute_offer",
        errorName: "Error",
      }),
    );
    expect(JSON.stringify(h.logs())).not.toContain("secret-ish detail");
  });

  it("refuses members with 403 and changes nothing", async () => {
    const s = await shop();
    const { offer } = await offerFor(s);
    const member = await memberOf(s);
    const h = harness();
    for (const fields of [
      { intent: "create", name: "Mine", repositories: [s.resources[0]?.id as string] },
      { intent: "archive", offerId: offer.id },
    ]) {
      expect(
        await thrownStatus(
          offers.action(args(post(`/w/${s.slug}/offers`, member, fields), s, h.context)),
        ),
      ).toBe(403);
    }
    const loaded = await offers.loader(args(get(`/w/${s.slug}/offers`, s.owner), s, h.context));
    expect(loaded.offers.map((o) => o.status)).toEqual(["active"]);
  });

  it("refuses cross-origin posts and unknown intents", async () => {
    const s = await shop();
    const { offer } = await offerFor(s);
    const h = harness();
    const crossOrigin = post(
      `/w/${s.slug}/offers`,
      s.owner,
      { intent: "archive", offerId: offer.id },
      "https://evil.example",
    );
    expect(await thrownStatus(offers.action(args(crossOrigin, s, h.context)))).toBe(403);
    const unknown = post(`/w/${s.slug}/offers`, s.owner, { intent: "explode" });
    expect(await thrownStatus(offers.action(args(unknown, s, h.context)))).toBe(400);
    const missing = post(`/w/${s.slug}/offers`, s.owner, { intent: "archive", offerId: "nope" });
    expect(await thrownStatus(offers.action(args(missing, s, h.context)))).toBe(404);
    expect(
      (await offers.loader(args(get(`/w/${s.slug}/offers`, s.owner), s, h.context))).offers[0]
        ?.status,
    ).toBe("active");
  });
});

describe("attempt", () => {
  it("turns a concurrent change into a message and other expected errors into responses", async () => {
    expect(await attempt(async () => 1)).toEqual({ ok: true, value: 1 });
    expect(
      await attempt(() => Promise.reject(new ConflictError("offer changed concurrently"))),
    ).toEqual({ ok: false, error: "Something changed; reload and try again." });
    const boom = new Error("boom");
    await expect(attempt(() => Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe("simulator route", () => {
  async function subscriber(s: Shop, items: string[]) {
    const login = `sub-${crypto.randomUUID().slice(0, 8)}`;
    s.github.addUser({ id: String(Math.floor(Math.random() * 1e9)), login, type: "User" });
    const created = await createSimulatedSubscriber(
      services(),
      s.owner,
      s.slug,
      { login, items, state: "trialing", periodDays: 30 },
      { github: s.github, ...SIMULATION },
    );
    if (!created.ok) throw new Error(created.error);
    return created.subscription;
  }

  it("is not found in production, for loads and posts", async () => {
    const s = await shop();
    const h = harness({ environment: "production" });
    expect(
      await thrownStatus(
        simulator.loader(args(get(`/w/${s.slug}/simulator`, s.owner), s, h.context)),
      ),
    ).toBe(404);
    const create = post(`/w/${s.slug}/simulator`, s.owner, { intent: "create", login: "x" });
    expect(await thrownStatus(simulator.action(args(create, s, h.context)))).toBe(404);
  });

  it("lists subscriptions with only the actions valid now; members see no controls", async () => {
    const s = await shop();
    const created = await subscriber(s, ["sim_monthly"]);
    const member = await memberOf(s);
    const h = harness();
    const asOwner = await simulator.loader(
      args(get(`/w/${s.slug}/simulator`, s.owner), s, h.context),
    );
    expect(asOwner.canManage).toBe(true);
    expect(asOwner.subscriptions).toMatchObject([
      {
        id: created.id,
        state: "trialing",
        actions: ["activate", "cancel_at_period_end", "cancel_now", "expire"],
      },
    ]);
    const asMember = await simulator.loader(
      args(get(`/w/${s.slug}/simulator`, member), s, h.context),
    );
    expect(asMember.canManage).toBe(false);
  });

  it("applies an action and hands the refresh to the queue", async () => {
    const s = await shop();
    const created = await subscriber(s, ["sim_monthly"]);
    const h = harness();
    const result = await simulator.action(
      args(
        post(`/w/${s.slug}/simulator`, s.owner, {
          intent: "action",
          id: created.id,
          action: "activate",
        }),
        s,
        h.context,
      ),
    );
    expect(result).toEqual({
      target: created.id,
      error: null,
      notice: `${created.customerLogin}'s subscription is now active.`,
    });
    await h.settle();
    expect(h.sent).toHaveLength(1);
    const [message] = h.sent as { kind: string; subjectId: string }[];
    expect(message?.kind).toBe("refresh_subscription");
    expect(decodeRefreshKey(message?.subjectId ?? "")).toEqual({
      ok: true,
      value: {
        workspaceId: s.workspaceId,
        source: "simulated",
        externalSubscriptionId: created.id,
      },
    });
  });

  it("maps refusals to messages", async () => {
    const s = await shop();
    const created = await subscriber(s, ["sim_monthly"]);
    const h = harness();
    const call = (fields: Record<string, string>) =>
      simulator.action(args(post(`/w/${s.slug}/simulator`, s.owner, fields), s, h.context));

    expect(await call({ intent: "action", id: created.id, action: "renew" })).toMatchObject({
      error: "That action doesn't apply to the subscription's current state.",
    });
    expect(await call({ intent: "action", id: created.id, action: "explode" })).toMatchObject({
      error: "That action doesn't exist. Reload and try again.",
    });
    // The test Worker has no GitHub App configured, so there is nothing to look logins up with.
    expect(
      await call({ intent: "create", login: "octocat", items: "sim_monthly", periodDays: "" }),
    ).toEqual({
      target: "new",
      error: "Connect GitHub first: ShareRepo looks up subscribers' GitHub accounts.",
      notice: null,
    });
    await h.settle();
    expect(h.sent).toEqual([]);
  });

  it("refuses members, cross-origin posts and unknown subscriptions", async () => {
    const s = await shop();
    const created = await subscriber(s, ["sim_monthly"]);
    const member = await memberOf(s);
    const h = harness();
    const fields = { intent: "action", id: created.id, action: "cancel_now" };
    expect(
      await thrownStatus(
        simulator.action(args(post(`/w/${s.slug}/simulator`, member, fields), s, h.context)),
      ),
    ).toBe(403);
    const crossOrigin = post(`/w/${s.slug}/simulator`, s.owner, fields, "https://evil.example");
    expect(await thrownStatus(simulator.action(args(crossOrigin, s, h.context)))).toBe(403);
    const unknown = { ...fields, id: "nope" };
    expect(
      await thrownStatus(
        simulator.action(args(post(`/w/${s.slug}/simulator`, s.owner, unknown), s, h.context)),
      ),
    ).toBe(404);
  });
});

describe("access route", () => {
  it("shows desired access, observed access and the planned action to any member", async () => {
    const s = await shop();
    const { item, resourceId } = await offerFor(s);
    const login = `sub-${crypto.randomUUID().slice(0, 8)}`;
    s.github.addUser({ id: String(Math.floor(Math.random() * 1e9)), login, type: "User" });
    const created = await createSimulatedSubscriber(
      services(),
      s.owner,
      s.slug,
      { login, items: [item], state: "active", periodDays: 30 },
      { github: s.github, ...SIMULATION },
    );
    if (!created.ok) throw new Error(created.error);
    // What the jobs Worker does with the queued refresh.
    await refreshSubscription(
      services(),
      {
        workspaceId: s.workspaceId,
        source: "simulated",
        externalSubscriptionId: created.subscription.id,
      },
      simulatedEntitlementSource(db),
    );
    const member = await memberOf(s);
    const h = harness();
    const loaded = await access.loader(args(get(`/w/${s.slug}/access`, member), s, h.context));
    expect(loaded.simulatorEnabled).toBe(true);
    expect(loaded.rows).toMatchObject([
      {
        subjectLogin: login,
        resourceId,
        grant: null,
        planned: { action: "provision", reason: "grant_missing" },
        entitlements: [{ state: "active", offerName: "Pro", offerVersion: 1, policyVersion: 1 }],
      },
    ]);
  });

  it("is not found for someone outside the workspace", async () => {
    const s = await shop();
    const outsider = await shop();
    const h = harness();
    expect(
      await thrownStatus(
        access.loader(args(get(`/w/${s.slug}/access`, outsider.owner), s, h.context)),
      ),
    ).toBe(404);
  });
});
