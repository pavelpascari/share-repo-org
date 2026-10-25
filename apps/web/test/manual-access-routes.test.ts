import { createOffer, linkCustomerManually } from "@sharerepo/application";
import type { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { providerOverrides } from "../app/commerce.server.ts";
import {
  LINK_VIA_LABELS,
  MANUAL_ACCESS_ERRORS,
  MANUAL_ACCESS_UPDATE_ERRORS,
  MANUAL_UNLINK_ERRORS,
} from "../app/commerce-messages.ts";
import * as customers from "../app/routes/w.$slug.customers.tsx";
import * as manual from "../app/routes/w.$slug.manual-access.tsx";
import { PaddleAccounts, paddleHarness, paddleShop, unclaimedPurchase } from "./support/paddle.ts";
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

// The Manual access page and the Customers page's "Remove the link" (decision 0016), called as
// React Router would, against local D1 and the fake GitHub App.

const args = (request: Request, s: Shop, context: RouterContextProvider) =>
  ({ request, params: { slug: s.slug }, context }) as never;

async function sellingShop() {
  const s = await shop();
  const created = await createOffer(services(), s.owner, s.slug, {
    name: "Course",
    items: [{ source: "simulated", externalItemId: `sim_${crypto.randomUUID()}` }],
    accesses: [{ resourceId: s.resources[0]?.id, accessLevel: "write" }],
  });
  if (!created.ok) throw new Error("offer setup");
  const user = {
    id: String(Math.floor(Math.random() * 1e9)),
    login: `early-${crypto.randomUUID().slice(0, 6)}`,
    type: "User" as const,
  };
  s.github.addUser(user);
  return { ...s, offerId: created.offer.id, user };
}

function withGitHub(s: Shop) {
  const h = harness();
  h.context.set(providerOverrides, { github: s.github });
  return h;
}

describe("manual access route", () => {
  it("manual/owner-grants-and-revokes-by-login: grants, lists, changes the end date and revokes", async () => {
    const s = await sellingShop();
    const { context, sent, settle } = withGitHub(s);
    const path = `/w/${s.slug}/manual-access`;
    const submit = (fields: Record<string, string>) =>
      manual.action(args(post(path, s.owner, fields), s, context));

    expect(
      await submit({
        intent: "grant",
        offerId: s.offerId,
        githubLogin: s.user.login,
        endsOn: "",
        note: "early buyer",
      }),
    ).toEqual({
      target: "new",
      notice: `Granted access to @${s.user.login}. ShareRepo is inviting them on GitHub.`,
      error: null,
    });
    // The reconciliation the grant requested goes straight to the queue.
    await settle();
    expect(sent).toEqual([
      expect.objectContaining({
        kind: "reconcile_resource",
        subjectId: `${s.workspaceId}:${s.resources[0]?.id}`,
      }),
    ]);
    // A resubmitted form grants nothing twice.
    expect(
      await submit({
        intent: "grant",
        offerId: s.offerId,
        githubLogin: s.user.login,
        endsOn: "",
        note: "",
      }),
    ).toEqual({ target: "new", notice: null, error: MANUAL_ACCESS_ERRORS.already_granted });

    const loaded = await manual.loader(args(get(path, s.owner), s, context));
    expect(loaded.offers).toEqual([{ id: s.offerId, name: "Course" }]);
    const [grant] = loaded.accesses;
    expect(grant).toMatchObject({ login: s.user.login, status: "active", note: "early buyer" });
    const manualAccessId = grant?.id as string;

    expect(await submit({ intent: "update", manualAccessId, endsOn: "2099-01-31" })).toEqual({
      target: manualAccessId,
      notice: "End date saved.",
      error: null,
    });
    expect(await submit({ intent: "update", manualAccessId, endsOn: "2099-01-31" })).toEqual({
      target: manualAccessId,
      notice: "The end date is unchanged.",
      error: null,
    });
    expect(await submit({ intent: "update", manualAccessId, endsOn: "2000-01-01" })).toEqual({
      target: manualAccessId,
      notice: null,
      error: MANUAL_ACCESS_UPDATE_ERRORS.end_not_in_future,
    });
    expect(await submit({ intent: "update", manualAccessId, endsOn: "soon" })).toMatchObject({
      error: "Enter the end date as a date, or leave it empty for no end.",
    });
    expect((await manual.loader(args(get(path, s.owner), s, context))).accesses[0]?.endsAt).toBe(
      Date.UTC(2099, 0, 31),
    );

    expect(await submit({ intent: "revoke", manualAccessId })).toEqual({
      target: manualAccessId,
      notice: "Access revoked. ShareRepo is removing it on GitHub.",
      error: null,
    });
    expect(await submit({ intent: "revoke", manualAccessId })).toEqual({
      target: manualAccessId,
      notice: "This access was already revoked.",
      error: null,
    });
    expect(await submit({ intent: "update", manualAccessId, endsOn: "" })).toEqual({
      target: manualAccessId,
      notice: null,
      error: MANUAL_ACCESS_UPDATE_ERRORS.revoked,
    });
  });

  it("explains bad forms, a missing GitHub App and the service's refusals", async () => {
    const s = await sellingShop();
    const path = `/w/${s.slug}/manual-access`;
    const configured = withGitHub(s).context;
    const submit = (fields: Record<string, string>, context = configured) =>
      manual.action(args(post(path, s.owner, fields), s, context));
    expect(await submit({ intent: "grant", offerId: "" })).toEqual({
      target: "new",
      notice: null,
      error: "Choose an offer and enter a GitHub login.",
    });
    expect(
      await submit({
        intent: "grant",
        offerId: s.offerId,
        githubLogin: "x",
        endsOn: "31/01",
        note: "",
      }),
    ).toMatchObject({ error: "Enter the end date as a date, or leave it empty for no end." });
    expect(
      await submit(
        { intent: "grant", offerId: s.offerId, githubLogin: "x", endsOn: "", note: "" },
        harness().context,
      ),
    ).toMatchObject({ error: MANUAL_ACCESS_ERRORS.connection_missing });
    expect(
      await submit({
        intent: "grant",
        offerId: s.offerId,
        githubLogin: "nobody-x",
        endsOn: "",
        note: "",
      }),
    ).toMatchObject({ error: MANUAL_ACCESS_ERRORS.login_not_found });
    expect(await submit({ intent: "revoke" })).toMatchObject({
      error: "Choose a grant to change.",
    });
    expect(await submit({ intent: "dance", manualAccessId: "x" })).toMatchObject({
      error: "Unknown action.",
    });
    expect(await thrownStatus(submit({ intent: "revoke", manualAccessId: "missing" }))).toBe(404);
    expect(
      await thrownStatus(
        submit({ intent: "grant", offerId: "missing", githubLogin: "x", endsOn: "", note: "" }),
      ),
    ).toBe(404);
  });

  it("isolation/cross-workspace-read-denied: owners only, same-origin posts only", async () => {
    const s = await sellingShop();
    const member = await memberOf(s);
    const stranger = await shop();
    const { context } = withGitHub(s);
    const path = `/w/${s.slug}/manual-access`;
    expect(await thrownStatus(manual.loader(args(get(path, member), s, context)))).toBe(403);
    expect(await thrownStatus(manual.loader(args(get(path, stranger.owner), s, context)))).toBe(
      404,
    );
    const fields = { intent: "revoke", manualAccessId: "x" };
    expect(await thrownStatus(manual.action(args(post(path, member, fields), s, context)))).toBe(
      403,
    );
    expect(
      await thrownStatus(manual.action(args(post(path, stranger.owner, fields), s, context))),
    ).toBe(404);
    expect(
      await thrownStatus(
        manual.action(args(post(path, s.owner, fields, "https://x.test"), s, context)),
      ),
    ).toBe(403);
  });
});

describe("customers route: removing a link", () => {
  it("shows how a link was made and removes it with a reason", async () => {
    const s = await paddleShop();
    await unclaimedPurchase(s);
    const accounts = new PaddleAccounts();
    const { context, sent, settle } = paddleHarness(accounts, { github: s.github });
    const path = `/w/${s.slug}/customers`;
    const [entry] = (await customers.loader(args(get(path, s.owner), s, context))).customers;
    const customerId = entry?.id as string;
    s.github.addUser({
      id: String(Math.floor(Math.random() * 1e9)),
      login: "buyer-x",
      type: "User",
    });
    await linkCustomerManually(
      services(),
      s.owner,
      s.slug,
      { customerId, githubLogin: "buyer-x", reason: "bank transfer" },
      { github: s.github },
    );
    const linked = (await customers.loader(args(get(path, s.owner), s, context))).customers[0];
    expect(linked?.linked?.via).toBe("manual");
    expect(LINK_VIA_LABELS.manual).toBe("linked by hand by an owner");

    const unlink = (reason: string) =>
      customers.action(
        args(post(path, s.owner, { intent: "unlink", customerId, reason }), s, context),
      );
    expect(await unlink(" ")).toEqual({
      ok: false,
      notice: null,
      customerId,
      error: MANUAL_UNLINK_ERRORS.reason_required,
    });
    expect(await unlink("wrong account")).toEqual({
      ok: true,
      notice: "Link removed. ShareRepo is removing the access it granted for this purchase.",
      customerId,
      error: null,
    });
    await settle();
    expect(sent).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "refresh_subscription" })]),
    );
    expect(await unlink("again")).toMatchObject({
      ok: true,
      notice: "This customer is not linked.",
    });
    expect(
      await customers.action(
        args(post(path, s.owner, { intent: "unlink", reason: "r" }), s, context),
      ),
    ).toEqual({ ok: false, notice: null, customerId: "", error: "Enter a reason." });
    expect(
      await thrownStatus(
        customers.action(
          args(
            post(path, s.owner, { intent: "unlink", customerId: "missing", reason: "r" }),
            s,
            context,
          ),
        ),
      ),
    ).toBe(404);
  });
});
