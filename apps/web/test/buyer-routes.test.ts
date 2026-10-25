import { createOffer } from "@sharerepo/application";
import type { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { returnToCookie, safeReturnPath } from "../app/auth/return-to.server.ts";
import {
  CHECKOUT_ERRORS,
  CHECKOUT_FAILED,
  CLAIM_EMAIL_UNAVAILABLE,
  CLAIM_ERRORS,
  PADDLE_NOT_CONFIGURED,
} from "../app/commerce-messages.ts";
import * as buy from "../app/routes/buy.$offerId.tsx";
import * as buyerLayout from "../app/routes/buyer-layout.tsx";
import * as claimRequest from "../app/routes/c.$slug.claim.tsx";
import * as claim from "../app/routes/claim.$token.tsx";
import * as home from "../app/routes/home.tsx";
import * as myAccess from "../app/routes/me.access.tsx";
import * as signIn from "../app/routes/sign-in.ts";
import {
  claimState,
  claimToken,
  drain,
  type PaddleShop,
  paddleHarness,
  paddleShop,
  unclaimedPurchase,
} from "./support/paddle.ts";
import {
  get,
  harness,
  post,
  type SignedIn,
  services,
  shop,
  signedIn,
  thrownStatus,
} from "./support/shop.ts";
import { BASE } from "./support/sign-in.ts";

// The buyer's pages (checkout, claim request, claim link, my access) and the sign-in round trip,
// called as React Router would, against local D1 and FakePaddle.

const call = (request: Request, context: RouterContextProvider, params: Record<string, string>) =>
  ({ request, params, context }) as never;

const anonymous = (path: string, init: RequestInit = {}) => new Request(`${BASE}${path}`, init);

const anonymousPost = (path: string, fields: Record<string, string>) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { origin: new URL(BASE).origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

/** A POST from a buyer with their own client IP, so rate-limit buckets do not collide. */
function buyerPost(path: string, who: SignedIn, fields: Record<string, string>, origin?: string) {
  const request = post(path, who, fields, origin);
  request.headers.set("cf-connecting-ip", `192.0.2.${Math.floor(Math.random() * 250)}`);
  return request;
}

const MAIL = { EMAIL: { send: async () => undefined } };

describe("buyer layout", () => {
  it("knows whether the visitor is signed in", async () => {
    const buyer = await signedIn();
    const { context } = harness();
    expect(await buyerLayout.loader(call(anonymous("/buy/x"), context, {}))).toEqual({
      user: null,
    });
    expect(await buyerLayout.loader(call(get("/buy/x", buyer), context, {}))).toEqual({
      user: { name: "Mona Lisa" },
    });
  });
});

describe("checkout page (/buy/:offerId)", () => {
  it("asks a signed-out visitor to sign in and come back", async () => {
    const s = await paddleShop();
    const { context } = harness();
    const path = `/buy/${s.offer.id}`;
    expect(await buy.loader(call(anonymous(path), context, { offerId: s.offer.id }))).toEqual({
      signedIn: false,
      returnTo: path,
      view: null,
      unavailable: false,
    });
  });

  it("shows the offer, its repositories and prices, and the GitHub account getting access", async () => {
    const s = await paddleShop();
    const buyer = await signedIn();
    const { context } = harness();
    const loaded = await buy.loader(
      call(get(`/buy/${s.offer.id}`, buyer), context, { offerId: s.offer.id }),
    );
    expect(loaded).toMatchObject({
      signedIn: true,
      unavailable: false,
      view: {
        offer: { id: s.offer.id, name: "Pro" },
        account: { login: buyer.login },
        prices: [expect.objectContaining({ priceId: s.price.id })],
        repositories: [expect.stringContaining("/repo-0")],
      },
    });
  });

  it("is not found for an unknown offer and unavailable for an offer without Paddle", async () => {
    const s = await shop();
    const buyer = await signedIn();
    const { context } = harness();
    expect(
      await thrownStatus(buy.loader(call(get("/buy/nope", buyer), context, { offerId: "nope" }))),
    ).toBe(404);
    const simulated = await createOffer(services(), s.owner, s.slug, {
      name: "Sim",
      items: [{ source: "simulated", externalItemId: `sim_${crypto.randomUUID().slice(0, 8)}` }],
      accesses: [{ resourceId: s.resources.find((r) => r.private)?.id, accessLevel: "write" }],
    });
    if (!simulated.ok) throw new Error("setup failed");
    const offerId = simulated.offer.id;
    expect(
      await buy.loader(call(get(`/buy/${offerId}`, buyer), context, { offerId })),
    ).toMatchObject({ signedIn: true, view: null, unavailable: true });
  });

  it("starts checkout with a same-origin POST and redirects to Paddle", async () => {
    const s = await paddleShop();
    const buyer = await signedIn();
    const { context } = paddleHarness(s.accounts);
    const params = { offerId: s.offer.id };
    const path = `/buy/${s.offer.id}`;
    const thrown = await buy
      .action(call(post(path, buyer, { priceId: s.price.id }), context, params))
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Response);
    const location = (thrown as Response).headers.get("location") ?? "";
    expect(location).toContain("_ptxn=");
    expect(
      await thrownStatus(
        buy.action(
          call(post(path, buyer, { priceId: s.price.id }, "https://x.test"), context, params),
        ),
      ),
    ).toBe(403);
    expect(
      await thrownStatus(
        buy.action(call(anonymousPost(path, { priceId: s.price.id }), context, params)),
      ),
    ).toBe(401);
    expect(
      await thrownStatus(
        buy.action(
          call(post("/buy/nope", buyer, { priceId: s.price.id }), context, { offerId: "nope" }),
        ),
      ),
    ).toBe(404);
  });

  it("explains a missing price, a missing default payment link, Paddle failing and no configuration", async () => {
    const s = await paddleShop();
    const buyer = await signedIn();
    const { context } = paddleHarness(s.accounts);
    const params = { offerId: s.offer.id };
    const path = `/buy/${s.offer.id}`;
    const submit = (fields: Record<string, string>, ctx = context) =>
      buy.action(call(post(path, buyer, fields), ctx, params));
    expect(await submit({})).toEqual({ error: CHECKOUT_ERRORS.price_invalid });
    expect(await submit({ priceId: "pri_other" })).toEqual({
      error: CHECKOUT_ERRORS.price_invalid,
    });
    s.paddle.setDefaultPaymentLink(null);
    expect(await submit({ priceId: s.price.id })).toEqual({
      error: CHECKOUT_ERRORS.no_default_payment_link,
    });
    s.paddle.failNext("createTransaction", "transient");
    expect(await submit({ priceId: s.price.id })).toEqual({ error: CHECKOUT_FAILED });
    const unconfigured = harness({
      env: { CREDENTIAL_KEYS: undefined, CLAIM_SIGNING_KEY: undefined },
    });
    expect(await submit({ priceId: s.price.id }, unconfigured.context)).toEqual({
      error: PADDLE_NOT_CONFIGURED,
    });
  });

  it("says when the buyer started too many checkouts", async () => {
    const s = await paddleShop();
    const buyer = await signedIn();
    const { context } = paddleHarness(s.accounts);
    const params = { offerId: s.offer.id };
    const path = `/buy/${s.offer.id}`;
    const submit = () =>
      buy.action(call(buyerPost(path, buyer, { priceId: s.price.id }), context, params));
    // Without a default payment link nothing is stored to reuse, so each attempt is new.
    s.paddle.setDefaultPaymentLink(null);
    for (let i = 0; i < 10; i += 1) {
      expect(await submit()).toEqual({ error: CHECKOUT_ERRORS.no_default_payment_link });
    }
    expect(await submit()).toEqual({ error: CHECKOUT_ERRORS.rate_limited });
    expect(CHECKOUT_ERRORS.rate_limited).toBe("Too many checkout attempts; try again later.");
  });
});

describe("claim request page (/c/:slug/claim)", () => {
  it("asks a signed-out visitor to sign in, and says when email claims are unavailable", async () => {
    const s = await paddleShop();
    const buyer = await signedIn();
    const path = `/c/${s.slug}/claim`;
    const params = { slug: s.slug };
    expect(
      await claimRequest.loader(call(anonymous(path), harness({ env: MAIL }).context, params)),
    ).toEqual({ signedIn: false, returnTo: path, available: true });
    const noMail = harness();
    expect(await claimRequest.loader(call(get(path, buyer), noMail.context, params))).toEqual({
      signedIn: true,
      returnTo: path,
      available: false,
    });
    expect(
      await claimRequest.action(
        call(buyerPost(path, buyer, { email: "a@example.com" }), noMail.context, params),
      ),
    ).toEqual({ requested: false, error: CLAIM_EMAIL_UNAVAILABLE });
  });

  it("claim/request-does-not-reveal-purchases: the same answer with and without a purchase", async () => {
    const s = await paddleShop();
    const { customer } = await unclaimedPurchase(s);
    const buyer = await signedIn();
    const h = paddleHarness(s.accounts, { env: MAIL });
    const path = `/c/${s.slug}/claim`;
    const params = { slug: s.slug };
    const matched = await claimRequest.action(
      call(buyerPost(path, buyer, { email: customer.email }), h.context, params),
    );
    const unmatched = await claimRequest.action(
      call(buyerPost(path, buyer, { email: "nobody@example.com" }), h.context, params),
    );
    expect(matched).toEqual({ requested: true, error: null });
    expect(unmatched).toEqual(matched);
    await h.settle();
    // Each request's job is handed to the queue off the response path.
    expect(h.sent).toEqual([
      {
        kind: "send_claim_email",
        subjectId: expect.stringContaining(s.workspaceId),
        outboxId: expect.any(String),
      },
      {
        kind: "send_claim_email",
        subjectId: expect.stringContaining(s.workspaceId),
        outboxId: expect.any(String),
      },
    ]);
    expect(JSON.stringify(h.logs())).not.toContain(customer.email);
  });

  it("refuses an invalid email, a cross-origin or signed-out post, and an unknown workspace", async () => {
    const s = await paddleShop();
    const buyer = await signedIn();
    const { context } = paddleHarness(s.accounts, { env: MAIL });
    const path = `/c/${s.slug}/claim`;
    const params = { slug: s.slug };
    const invalid = { requested: false, error: "Enter the email address you paid with." };
    expect(
      await claimRequest.action(call(buyerPost(path, buyer, { email: "nope" }), context, params)),
    ).toEqual(invalid);
    expect(
      await claimRequest.action(
        call(buyerPost(path, buyer, { email: "x".repeat(400) }), context, params),
      ),
    ).toEqual(invalid);
    expect(
      await thrownStatus(
        claimRequest.action(
          call(buyerPost(path, buyer, { email: "a@b.co" }, "https://x.test"), context, params),
        ),
      ),
    ).toBe(403);
    expect(
      await thrownStatus(
        claimRequest.action(call(anonymousPost(path, { email: "a@b.co" }), context, params)),
      ),
    ).toBe(401);
    expect(
      await thrownStatus(
        claimRequest.action(
          call(buyerPost("/c/no-such-shop/claim", buyer, { email: "a@b.co" }), context, {
            slug: "no-such-shop",
          }),
        ),
      ),
    ).toBe(404);
  });

  it("logs nothing when the queue hand-off fails; the outbox drain delivers", async () => {
    const s = await paddleShop();
    const buyer = await signedIn();
    const h = paddleHarness(s.accounts, { env: MAIL, sendFails: true });
    await claimRequest.action(
      call(buyerPost(`/c/${s.slug}/claim`, buyer, { email: "c@example.com" }), h.context, {
        slug: s.slug,
      }),
    );
    await h.settle();
    const warnings = h.logs().filter((line) => line.level === "warn");
    expect(warnings).toEqual([
      expect.objectContaining({
        msg: "queue send failed; the outbox drain will deliver",
        errorName: "Error",
      }),
    ]);
    expect(JSON.stringify(h.logs())).not.toContain("c@example.com");
  });
});

async function claimable(): Promise<{ s: PaddleShop; buyer: SignedIn; token: string }> {
  const s = await paddleShop();
  const { customer } = await unclaimedPurchase(s);
  const buyer = await signedIn();
  const token = await claimToken(s, buyer, customer.email);
  return { s, buyer, token };
}

describe("claim link (/claim/:token)", () => {
  it("claim/get-never-mutates: GET renders only, signed in or out, known token or not", async () => {
    const { s, buyer, token } = await claimable();
    const { context } = harness();
    const before = await claimState(s.workspaceId, buyer.userId);

    const view = await claim.loader(call(get(`/claim/${token}`, buyer), context, { token }));
    expect(view.data).toMatchObject({
      signedIn: true,
      error: null,
      view: {
        workspace: { slug: s.slug },
        offers: ["Pro"],
        account: { login: buyer.login },
        linked: "none",
      },
    });
    const unknown = await claim.loader(
      call(get("/claim/not-a-token", buyer), context, { token: "not-a-token" }),
    );
    expect(unknown.data).toMatchObject({ view: null, error: CLAIM_ERRORS.unknown_claim });
    const signedOut = await claim.loader(call(anonymous(`/claim/${token}`), context, { token }));
    expect(signedOut.data).toEqual({
      signedIn: false,
      returnTo: `/claim/${token}`,
      view: null,
      error: null,
    });

    expect(await claimState(s.workspaceId, buyer.userId)).toEqual(before);
  });

  it("sends Referrer-Policy: no-referrer on GET and POST responses", async () => {
    const { buyer, token } = await claimable();
    const { context } = harness();
    expect(claim.headers({} as never)).toEqual({ "Referrer-Policy": "no-referrer" });
    const loaded = await claim.loader(call(get(`/claim/${token}`, buyer), context, { token }));
    expect(loaded.init?.headers).toEqual({ "Referrer-Policy": "no-referrer" });
    const signedOut = await claim.loader(call(anonymous(`/claim/${token}`), context, { token }));
    expect(signedOut.init?.headers).toEqual({ "Referrer-Policy": "no-referrer" });
    const posted = await claim.action(call(post(`/claim/${token}`, buyer, {}), context, { token }));
    expect(posted.init?.headers).toEqual({ "Referrer-Policy": "no-referrer" });
    const refused = await claim
      .action(call(anonymousPost(`/claim/${token}`, {}), context, { token }))
      .catch((e: unknown) => e as { init: ResponseInit });
    expect(refused).toMatchObject({
      init: { status: 401, headers: { "Referrer-Policy": "no-referrer" } },
    });
  });

  it("claims with a same-origin POST, once, and the purchase shows in My access", async () => {
    const { s, buyer, token } = await claimable();
    const { context, sent, settle } = harness();
    const params = { token };
    expect(
      await thrownStatus(
        claim.action(call(post(`/claim/${token}`, buyer, {}, "https://x.test"), context, params)),
      ),
    ).toBe(403);
    const claimed = await claim.action(call(post(`/claim/${token}`, buyer, {}), context, params));
    expect(claimed.data).toEqual({
      ok: true,
      workspaceSlug: s.slug,
      outcome: "linked",
      error: null,
    });
    // Submitting again (a double click, a lost response) is the same success, linking nothing
    // more; the token is used up for anyone else.
    const again = await claim.action(call(post(`/claim/${token}`, buyer, {}), context, params));
    expect(again.data).toEqual({
      ok: true,
      workspaceSlug: s.slug,
      outcome: "already_linked",
      error: null,
    });
    // The link's refresh goes straight to the queue, once.
    await settle();
    expect(sent).toEqual([
      expect.objectContaining({
        kind: "refresh_subscription",
        subjectId: expect.stringMatching(new RegExp(`^${s.workspaceId}:paddle:sub_`)),
      }),
    ]);

    await drain(s);
    const access = await myAccess.loader(call(get("/me/access", buyer), context, {}));
    expect(access.subscriptions).toEqual([
      expect.objectContaining({
        workspace: expect.objectContaining({ slug: s.slug }),
        state: "active",
        entitlements: [
          expect.objectContaining({
            state: "active",
            repositoryName: expect.stringContaining("/repo-0"),
          }),
        ],
      }),
    ]);
    expect(access.githubWeb).toBe("https://github.com");
  });

  it("logs a failed queue hand-off of the claim's refresh; the outbox drain delivers", async () => {
    const { buyer, token } = await claimable();
    const h = harness({ sendFails: true });
    const claimed = await claim.action(
      call(post(`/claim/${token}`, buyer, {}), h.context, { token }),
    );
    expect(claimed.data).toMatchObject({ ok: true, outcome: "linked" });
    await h.settle();
    expect(h.logs().filter((line) => line.level === "warn")).toEqual([
      expect.objectContaining({
        msg: "queue send failed; the outbox drain will deliver",
        errorName: "Error",
      }),
    ]);
  });

  it("tells the buyer when the purchase is linked to someone else, and relinks on claim", async () => {
    const { s, buyer, token } = await claimable();
    const first = await signedIn();
    const { customer } = await unclaimedPurchase(s);
    const firstToken = await claimToken(s, first, customer.email);
    const { context } = harness();
    await claim.action(
      call(post(`/claim/${firstToken}`, first, {}), context, { token: firstToken }),
    );
    const secondToken = await claimToken(s, buyer, customer.email);
    const view = await claim.loader(
      call(get(`/claim/${secondToken}`, buyer), context, { token: secondToken }),
    );
    expect(view.data.view?.linked).toBe("other");
    const relinked = await claim.action(
      call(post(`/claim/${secondToken}`, buyer, {}), context, { token: secondToken }),
    );
    expect(relinked.data).toMatchObject({ ok: true, outcome: "relinked" });
    expect(token).not.toBe(secondToken);
  });
});

describe("my access", () => {
  it("is empty for a user with no purchases and requires sign-in", async () => {
    const buyer = await signedIn();
    const { context } = harness();
    expect(
      (await myAccess.loader(call(get("/me/access", buyer), context, {}))).subscriptions,
    ).toEqual([]);
    expect(await thrownStatus(myAccess.loader(call(anonymous("/me/access"), context, {})))).toBe(
      302,
    );
  });
});

describe("sign-in round trip", () => {
  it("accepts only same-origin paths to return to", () => {
    expect(safeReturnPath("/claim/abc?x=1", BASE)).toBe("/claim/abc?x=1");
    expect(safeReturnPath("/buy/offer-1", BASE)).toBe("/buy/offer-1");
    expect(safeReturnPath("/c/shop/claim", BASE)).toBe("/c/shop/claim");
    expect(safeReturnPath("/a/./b/../c", BASE)).toBe("/a/c");
    for (const bad of [
      "//evil.test/x",
      "/\\evil.test",
      // Dot segments that normalise into a protocol-relative path.
      "/.//evil.example/x",
      "/..//evil.example/x",
      "/%2e//evil.example/x",
      "/a/..//evil.example",
      // Characters URL parsers strip or that browsers treat as separators.
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/ /evil.example",
      "/claim/x\u0000",
      "/claim/x\u007f",
      "https://evil.test/",
      "claim/x",
      42,
      null,
    ]) {
      expect(safeReturnPath(bad, BASE)).toBeNull();
    }
    expect(safeReturnPath(`/${"a".repeat(600)}`, BASE)).toBeNull();
  });

  it("remembers the page in a cookie, and the home page returns there once", async () => {
    const { context } = harness();
    const started = await signIn.action(
      call(anonymousPost("/sign-in", { returnTo: "/claim/tok" }), context, {}),
    );
    const remembered = started.headers
      .getSetCookie()
      .find((c) => c.startsWith("sharerepo_return_to="));
    expect(remembered).toMatch(/HttpOnly/);
    expect(remembered).toMatch(/Max-Age=600/);

    const plain = await signIn.action(
      call(anonymousPost("/sign-in", { returnTo: "//evil.test" }), context, {}),
    );
    expect(plain.headers.getSetCookie().some((c) => c.startsWith("sharerepo_return_to="))).toBe(
      false,
    );

    const buyer = await signedIn();
    const cookie = `${buyer.cookie}; ${(remembered ?? "").split(";")[0]}`;
    const thrown = await home
      .loader(call(new Request(`${BASE}/`, { headers: { cookie } }), context, {}))
      .catch((e: unknown) => e as Response);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("location")).toBe("/claim/tok");
    expect((thrown as Response).headers.get("set-cookie")).toMatch(
      /sharerepo_return_to=;.*Max-Age=0/,
    );
    expect(await returnToCookie(context).parse(cookie)).toBe("/claim/tok");

    // A cookie set some other way is checked again before the redirect.
    const forged = (await returnToCookie(context).serialize("/.//evil.example/x")).split(";")[0];
    const result = await home
      .loader(
        call(
          new Request(`${BASE}/`, { headers: { cookie: `${buyer.cookie}; ${forged}` } }),
          context,
          {},
        ),
      )
      .catch((e: unknown) => e);
    const location = result instanceof Response ? result.headers.get("location") : null;
    expect(location ?? "").not.toContain("evil.example");
  });
});
