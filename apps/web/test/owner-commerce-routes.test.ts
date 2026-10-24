import { getBillingView } from "@sharerepo/application";
import type { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import {
  MANUAL_LINK_ERRORS,
  PADDLE_NOT_CONFIGURED,
  PADDLE_UNREACHABLE,
} from "../app/commerce-messages.ts";
import * as billing from "../app/routes/w.$slug.billing.tsx";
import * as customers from "../app/routes/w.$slug.customers.tsx";
import * as offers from "../app/routes/w.$slug.offers.tsx";
import * as layout from "../app/routes/w.$slug.tsx";
import {
  connect,
  PaddleAccounts,
  type PaddleShop,
  paddleHarness,
  paddleShop,
  unclaimedPurchase,
} from "./support/paddle.ts";
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

// The owner's commerce pages (billing, customers, offers with Paddle prices), called as React
// Router would, against local D1 and FakePaddle.

const args = (request: Request, s: Shop, context: RouterContextProvider) =>
  ({ request, params: { slug: s.slug }, context }) as never;

const NOT_CONFIGURED = { CREDENTIAL_KEYS: undefined, CLAIM_SIGNING_KEY: undefined };
const EXPIRES = "2027-06-30";

describe("workspace navigation", () => {
  it("returns the workspace role the layout uses to show Billing and Customers to owners", async () => {
    const s = await shop();
    const member = await memberOf(s);
    const { context } = harness();
    const asOwner = await layout.loader(args(get(`/w/${s.slug}`, s.owner), s, context));
    expect(asOwner.data.workspace.role).toBe("owner");
    const asMember = await layout.loader(args(get(`/w/${s.slug}`, member), s, context));
    expect(asMember.data.workspace.role).toBe("member");
  });
});

describe("billing route", () => {
  it("is the owner's: members are forbidden and other workspaces are not found", async () => {
    const s = await shop();
    const member = await memberOf(s);
    const stranger = await shop();
    const { context } = harness();
    const path = `/w/${s.slug}/billing`;
    expect(await thrownStatus(billing.loader(args(get(path, member), s, context)))).toBe(403);
    expect(await thrownStatus(billing.loader(args(get(path, stranger.owner), s, context)))).toBe(
      404,
    );
    const form = { intent: "refresh" };
    expect(await thrownStatus(billing.action(args(post(path, member, form), s, context)))).toBe(
      403,
    );
    expect(
      await thrownStatus(billing.action(args(post(path, stranger.owner, form), s, context))),
    ).toBe(404);
  });

  it("refuses cross-origin posts", async () => {
    const s = await shop();
    const { context } = harness();
    const request = post(`/w/${s.slug}/billing`, s.owner, { intent: "refresh" }, "https://x.test");
    expect(await thrownStatus(billing.action(args(request, s, context)))).toBe(403);
  });

  it("says Paddle is not configured without the commerce secrets", async () => {
    const s = await shop();
    const { context } = harness({ env: NOT_CONFIGURED });
    const loaded = await billing.loader(args(get(`/w/${s.slug}/billing`, s.owner), s, context));
    expect(loaded).toMatchObject({ configured: false, view: null });
    const posted = await billing.action(
      args(post(`/w/${s.slug}/billing`, s.owner, { intent: "refresh" }), s, context),
    );
    expect(posted).toMatchObject({ ok: false, errors: { form: PADDLE_NOT_CONFIGURED } });
  });

  it("offers the connect form with the required permissions, sandbox outside production", async () => {
    const s = await shop();
    const { context } = paddleHarness(new PaddleAccounts());
    const loaded = await billing.loader(args(get(`/w/${s.slug}/billing`, s.owner), s, context));
    expect(loaded).toMatchObject({
      configured: true,
      view: { connection: null, prices: [] },
      environment: "sandbox",
      confirmDisconnect: false,
    });
    expect(loaded.requiredPermissions).toContain("notification_setting.write");
  });

  it("connects with a key and its expiry date, then shows the seller and catalog", async () => {
    const s = await shop();
    const accounts = new PaddleAccounts();
    const { fake, key } = accounts.seller();
    const price = fake.addPrice({ productName: "Course" });
    const { context } = paddleHarness(accounts);
    const path = `/w/${s.slug}/billing`;
    const result = await billing.action(
      args(
        post(path, s.owner, { intent: "connect", apiKey: ` ${key} `, apiKeyExpiresOn: EXPIRES }),
        s,
        context,
      ),
    );
    expect(result).toEqual({
      ok: true,
      notice: "Paddle is connected and the catalog is imported.",
      orphanedDestinationId: null,
      errors: {},
    });
    // The key is never echoed back.
    expect(JSON.stringify(result)).not.toContain(key);
    const loaded = await billing.loader(args(get(path, s.owner), s, context));
    expect(loaded.view?.connection).toMatchObject({
      status: "active",
      environment: "sandbox",
      sellerName: "Acme Seller",
      apiKeyExpiresOn: Date.parse(`${EXPIRES}T00:00:00Z`),
    });
    expect(loaded.view?.prices.map((p) => p.priceId)).toEqual([price.id]);
    expect(JSON.stringify(loaded)).not.toContain(key);
  });

  it("reports a refused key, missing fields and missing permissions as form errors", async () => {
    const s = await shop();
    const accounts = new PaddleAccounts();
    const { fake, key } = accounts.seller();
    const { context } = paddleHarness(accounts);
    const path = `/w/${s.slug}/billing`;
    const submit = (fields: Record<string, string>) =>
      billing.action(args(post(path, s.owner, { intent: "connect", ...fields }), s, context));

    expect(await submit({ apiKey: "", apiKeyExpiresOn: "" })).toMatchObject({
      ok: false,
      errors: {
        apiKey: "Paste the API key you created for ShareRepo.",
        apiKeyExpiresOn: "Enter the date the key expires, as Paddle shows it.",
      },
    });
    expect(await submit({ apiKey: "nope", apiKeyExpiresOn: EXPIRES })).toMatchObject({
      errors: {
        form: "That isn't a Paddle API key. Keys start with pdl_live_apikey_ or pdl_sdbx_apikey_.",
      },
    });
    fake.setPermissions(["product.read", "price.read"]);
    const missing = await submit({ apiKey: key, apiKeyExpiresOn: EXPIRES });
    expect(missing).toMatchObject({ ok: false });
    expect(missing.errors.form).toMatch(/^The key is missing these permissions: .*customer\.read/);
    fake.setPermissions([
      "product.read",
      "price.read",
      "customer.read",
      "subscription.read",
      "transaction.read",
      "transaction.write",
      "notification_setting.write",
    ]);
    fake.failNext("getApiRoot", "transient");
    expect(await submit({ apiKey: key, apiKeyExpiresOn: EXPIRES })).toMatchObject({
      errors: { form: PADDLE_UNREACHABLE },
    });
    fake.revokeKey();
    expect(await submit({ apiKey: key, apiKeyExpiresOn: EXPIRES })).toMatchObject({
      errors: { form: "Paddle refused this key. Check that it is active and has not expired." },
    });
  });

  it("refuses a second connect, reconnects with the same seller's key, refuses another seller's", async () => {
    const s = await shop();
    const accounts = new PaddleAccounts();
    const connected = await connect(s, accounts);
    const { context } = paddleHarness(accounts);
    const path = `/w/${s.slug}/billing`;
    const submit = (intent: string, key: string) =>
      billing.action(
        args(post(path, s.owner, { intent, apiKey: key, apiKeyExpiresOn: EXPIRES }), s, context),
      );
    expect(await submit("connect", accounts.issue(connected.paddle))).toMatchObject({
      errors: { form: "Paddle is already connected. Reconnect or disconnect it first." },
    });
    expect(await submit("reconnect", accounts.issue(connected.paddle))).toMatchObject({
      ok: true,
      notice: "Paddle is reconnected with the new API key.",
    });
    expect(await submit("reconnect", accounts.seller().key)).toMatchObject({
      errors: {
        form: "This key belongs to a different Paddle account. Disconnect first to connect another account.",
      },
    });
  });

  it("shows an unauthorized connection's reason after Paddle refuses its key", async () => {
    const s = await shop();
    const accounts = new PaddleAccounts();
    const connected = await connect(s, accounts);
    connected.paddle.revokeKey();
    const { context } = paddleHarness(accounts);
    const path = `/w/${s.slug}/billing`;
    const refreshed = await billing.action(
      args(post(path, s.owner, { intent: "refresh" }), s, context),
    );
    expect(refreshed).toMatchObject({ ok: false, errors: { form: PADDLE_UNREACHABLE } });
    const loaded = await billing.loader(args(get(path, s.owner), s, context));
    expect(loaded.view?.connection).toMatchObject({
      status: "unauthorized",
      statusReason: "key_refused",
    });
  });

  it("refreshes the catalog", async () => {
    const s = await shop();
    const accounts = new PaddleAccounts();
    const connected = await connect(s, accounts);
    connected.paddle.addPrice();
    const { context } = paddleHarness(accounts);
    const result = await billing.action(
      args(post(`/w/${s.slug}/billing`, s.owner, { intent: "refresh" }), s, context),
    );
    expect(result).toMatchObject({
      ok: true,
      notice: expect.stringMatching(/^Catalog refreshed: 1 added, \d+ updated, 0 archived\.$/),
    });
  });

  it("disconnects after the confirmation step, naming a destination it could not delete", async () => {
    const s = await shop();
    const accounts = new PaddleAccounts();
    const connected = await connect(s, accounts);
    const { context } = paddleHarness(accounts);
    const path = `/w/${s.slug}/billing`;
    const confirming = await billing.loader(
      args(get(`${path}?disconnect=confirm`, s.owner), s, context),
    );
    expect(confirming.confirmDisconnect).toBe(true);
    const destinationId = confirming.view?.connection?.destinationId;
    connected.paddle.failNext("deleteNotificationSetting", "transient");
    const result = await billing.action(
      args(post(path, s.owner, { intent: "disconnect" }), s, context),
    );
    expect(result).toMatchObject({ ok: true, orphanedDestinationId: destinationId });
    expect(
      await billing.action(args(post(path, s.owner, { intent: "disconnect" }), s, context)),
    ).toMatchObject({ ok: false, errors: { form: "Paddle isn't connected." } });
    expect(
      await billing.action(args(post(path, s.owner, { intent: "refresh" }), s, context)),
    ).toMatchObject({ ok: false, errors: { form: "Paddle isn't connected." } });
    const view = await getBillingView(services(), s.owner, s.slug);
    expect(view.connection).toBeNull();
  });

  it("disconnects cleanly when the destination is deleted", async () => {
    const s = await shop();
    const accounts = new PaddleAccounts();
    await connect(s, accounts);
    const { context } = paddleHarness(accounts);
    const result = await billing.action(
      args(post(`/w/${s.slug}/billing`, s.owner, { intent: "disconnect" }), s, context),
    );
    expect(result).toMatchObject({ ok: true, orphanedDestinationId: null });
  });

  it("answers an unknown intent with 400", async () => {
    const s = await shop();
    const { context } = paddleHarness(new PaddleAccounts());
    const request = post(`/w/${s.slug}/billing`, s.owner, { intent: "explode" });
    expect(await thrownStatus(billing.action(args(request, s, context)))).toBe(400);
  });
});

describe("customers route", () => {
  it("lists customers with their claim state and subscriptions, owners only", async () => {
    const s = await paddleShop();
    const { customer } = await unclaimedPurchase(s);
    const member = await memberOf(s);
    const stranger = await shop();
    const { context } = harness();
    const path = `/w/${s.slug}/customers`;
    const loaded = await customers.loader(args(get(path, s.owner), s, context));
    expect(loaded.customers).toEqual([
      expect.objectContaining({
        source: "paddle",
        externalCustomerId: customer.id,
        linked: null,
        subscriptions: [expect.objectContaining({ state: "active" })],
      }),
    ]);
    expect(await thrownStatus(customers.loader(args(get(path, member), s, context)))).toBe(403);
    expect(await thrownStatus(customers.loader(args(get(path, stranger.owner), s, context)))).toBe(
      404,
    );
    const fields = { customerId: "x", githubLogin: "octo", reason: "repair" };
    expect(await thrownStatus(customers.action(args(post(path, member, fields), s, context)))).toBe(
      403,
    );
    expect(
      await thrownStatus(
        customers.action(args(post(path, s.owner, fields, "https://x.test"), s, context)),
      ),
    ).toBe(403);
  });

  it("links a customer to a GitHub account by hand, with a reason", async () => {
    const s = await paddleShop();
    await unclaimedPurchase(s);
    const accounts = new PaddleAccounts();
    const { context } = paddleHarness(accounts, { github: s.github });
    const path = `/w/${s.slug}/customers`;
    const [entry] = (await customers.loader(args(get(path, s.owner), s, context))).customers;
    const customerId = entry?.id as string;
    s.github.addUser({
      id: String(Math.floor(Math.random() * 1e9)),
      login: "subscriber-1",
      type: "User",
    });
    const submit = (fields: Record<string, string>) =>
      customers.action(args(post(path, s.owner, { customerId, ...fields }), s, context));

    expect(await submit({ githubLogin: "subscriber-1", reason: "  " })).toMatchObject({
      ok: false,
      customerId,
      error: MANUAL_LINK_ERRORS.reason_required,
    });
    expect(await submit({ githubLogin: "subscriber-1", reason: "Paid by bank transfer" })).toEqual({
      ok: true,
      notice: "Linked the customer to @subscriber-1. Their access follows shortly.",
      customerId,
      error: null,
    });
    expect(await submit({ githubLogin: "subscriber-1", reason: "Again" })).toMatchObject({
      ok: true,
      notice: "This customer is already linked to @subscriber-1.",
    });
    const loaded = await customers.loader(args(get(path, s.owner), s, context));
    expect(loaded.customers[0]?.linked?.login).toBe("subscriber-1");
  });

  it("explains a missing GitHub App, a bad form and an unknown customer", async () => {
    const s = await paddleShop();
    const path = `/w/${s.slug}/customers`;
    const { context } = harness();
    expect(
      await customers.action(
        args(post(path, s.owner, { customerId: "c", githubLogin: "o", reason: "r" }), s, context),
      ),
    ).toMatchObject({ ok: false, error: MANUAL_LINK_ERRORS.connection_missing });
    expect(
      await customers.action(args(post(path, s.owner, { githubLogin: "o" }), s, context)),
    ).toMatchObject({ ok: false, customerId: "", error: "Enter a GitHub login and a reason." });
    const withGitHub = paddleHarness(new PaddleAccounts(), { github: s.github });
    expect(
      await thrownStatus(
        customers.action(
          args(
            post(path, s.owner, { customerId: "missing", githubLogin: "o", reason: "r" }),
            s,
            withGitHub.context,
          ),
        ),
      ),
    ).toBe(404);
  });
});

describe("offers route with Paddle", () => {
  it("lets the owner choose active recurring Paddle prices; members see no catalog", async () => {
    const s: PaddleShop = await paddleShop();
    s.paddle.addPrice({ billingCycle: null, productName: "One-off" });
    await import("@sharerepo/application").then(({ syncPaddleCatalog }) =>
      syncPaddleCatalog(services(), s.owner, s.slug, s.deps),
    );
    const member = await memberOf(s);
    const { context } = paddleHarness(s.accounts);
    const asOwner = await offers.loader(args(get(`/w/${s.slug}/offers`, s.owner), s, context));
    expect(asOwner.paddlePrices?.map((p) => p.billingInterval)).toContain(null);
    expect(asOwner.simulatedItems).toBe(true);
    expect(asOwner.origin).toBe("http://localhost:5173");
    const asMember = await offers.loader(args(get(`/w/${s.slug}/offers`, member), s, context));
    expect(asMember.paddlePrices).toBeNull();
  });

  it("creates an offer selling a Paddle price, and keeps free text simulated", async () => {
    const s = await paddleShop();
    const price = s.paddle.addPrice();
    const h = paddleHarness(s.accounts);
    const resourceId = s.resources.find((r) => r.private)?.id as string;
    const result = await offers.action(
      args(
        post(`/w/${s.slug}/offers`, s.owner, {
          intent: "create",
          name: "Team",
          gracePeriodDays: "3",
          repositories: [resourceId],
          paddlePrices: [price.id],
          items: "sim_team",
        }),
        s,
        h.context,
      ),
    );
    expect(result).toMatchObject({ ok: true, notice: "Created “Team”." });
    const loaded = await offers.loader(args(get(`/w/${s.slug}/offers`, s.owner), s, h.context));
    expect(loaded.offers.find((o) => o.name === "Team")?.items).toEqual([
      { source: "paddle", externalItemId: price.id },
      { source: "simulated", externalItemId: "sim_team" },
    ]);
  });

  it("ignores simulated item IDs in production", async () => {
    const s = await paddleShop();
    const price = s.paddle.addPrice();
    const h = paddleHarness(s.accounts, { environment: "production" });
    const resourceId = s.resources.find((r) => r.private)?.id as string;
    await offers.action(
      args(
        post(`/w/${s.slug}/offers`, s.owner, {
          intent: "create",
          name: "Live",
          gracePeriodDays: "3",
          repositories: [resourceId],
          paddlePrices: [price.id],
          items: "sim_should_be_ignored",
        }),
        s,
        h.context,
      ),
    );
    const loaded = await offers.loader(args(get(`/w/${s.slug}/offers`, s.owner), s, h.context));
    expect(loaded.simulatedItems).toBe(false);
    expect(loaded.offers.find((o) => o.name === "Live")?.items).toEqual([
      { source: "paddle", externalItemId: price.id },
    ]);
  });
});
