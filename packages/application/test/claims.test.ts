import { env } from "cloudflare:workers";
import {
  findCustomer,
  getCheckoutClaim,
  getClaimRequest,
  getCustomer,
  listCustomersWithLinks,
} from "@sharerepo/db";
import { createFakeMail } from "@sharerepo/integrations/testing";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  signClaimReference,
} from "@sharerepo/platform";
import { changedTables, snapshotTables } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  archiveOffer,
  confirmClaim,
  decodeClaimRequestKey,
  disconnectPaddle,
  getCheckoutView,
  linkCustomerManually,
  listCustomers,
  myAccess,
  refreshSubscription,
  requestClaim,
  type SourceSubscription,
  sendClaimEmail,
  startCheckout,
  type UserActor,
  viewClaim,
} from "../src/index.ts";
import { entitlementsOf, githubUser, live, memberOf, shop } from "./support/commerce.ts";
import { clock, db, serviceContext, signedUpUser } from "./support/context.ts";
import {
  auditOf,
  beforeFirstBatch,
  CLAIM_KEY,
  deliverSubscription,
  directSubscription,
  drainPaddle,
  liveFor,
  type PaddleShop,
  paddleCustomer,
  paddleShop,
  purchase,
} from "./support/paddle.ts";

const DAY = 86_400_000;

const signedUp = () => signedUpUser();

function transactionOf(checkoutUrl: string): string {
  return new URL(checkoutUrl).searchParams.get("_ptxn") as string;
}

async function customerRow(s: PaddleShop, externalCustomerId: string) {
  return findCustomer(db, { workspaceId: s.workspaceId, source: "paddle", externalCustomerId });
}

describe("startCheckout and getCheckoutView (path 1)", () => {
  it("shows the offer and the account that will receive access", async () => {
    const s = await paddleShop();
    const user = await signedUp();
    const result = await getCheckoutView(serviceContext(), { offerId: s.offer.id, user });
    expect(result).toEqual({
      ok: true,
      view: {
        offer: { id: s.offer.id, name: "Pro" },
        workspace: { slug: s.slug, name: "Shop" },
        repositories: s.resources.map((r) => r.nameSnapshot),
        prices: [expect.objectContaining({ priceId: s.price.id, unitAmount: "1000" })],
        account: { login: user.profile.username, avatarUrl: user.profile.avatarUrl },
      },
    });
    expect(await getCheckoutView(serviceContext(), { offerId: "nope", user })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("starts a Paddle checkout carrying a signed claim reference, audited", async () => {
    const s = await paddleShop();
    const user = await signedUp();
    const result = await startCheckout(
      serviceContext(),
      { offerId: s.offer.id, priceId: s.price.id, user },
      s.deps,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.checkoutUrl).toMatch(/^https:\/\/seller\.example\/pay\?_ptxn=txn_/);
    const transactionId = transactionOf(result.checkoutUrl);
    const claim = await getCheckoutClaim(db, {
      workspaceId: s.workspaceId,
      id: result.checkoutClaimId,
    });
    expect(claim).toMatchObject({
      userId: user.userId,
      offerId: s.offer.id,
      priceId: s.price.id,
      transactionId,
      expiresAt: clock.now() + 7 * DAY,
      consumedByCustomerId: null,
    });
    const reference = await signClaimReference({
      key: CLAIM_KEY,
      workspaceId: s.workspaceId,
      checkoutClaimId: result.checkoutClaimId,
      userId: user.userId,
      offerId: s.offer.id,
    });
    expect(s.paddle.transaction(transactionId).customData).toEqual({ sharerepo_claim: reference });
    expect(await auditOf(s.workspaceId, "checkout.started")).toEqual([
      expect.objectContaining({
        actor_id: user.userId,
        target_id: result.checkoutClaimId,
        details: { offerId: s.offer.id, priceId: s.price.id },
      }),
    ]);
  });

  it("links the paying customer to the buyer and grants the offer's repositories", async () => {
    const s = await paddleShop();
    const user = await signedUp();
    const { customer, subscription, checkoutClaimId } = await purchase(s, user);
    const stored = await customerRow(s, customer.id);
    expect(live(await entitlementsOf(s.workspaceId, subscription.id))).toHaveLength(
      s.resources.length,
    );
    expect(await liveFor(s.workspaceId, user.profile.externalUserId)).toHaveLength(
      s.resources.length,
    );
    expect(
      await getCheckoutClaim(db, { workspaceId: s.workspaceId, id: checkoutClaimId }),
    ).toMatchObject({ consumedByCustomerId: stored?.id, consumedAt: clock.now() });
    const [completed] = await auditOf(s.workspaceId, "claim.completed");
    expect(completed).toMatchObject({
      actor_type: "system",
      target_id: stored?.id,
      details: { path: "checkout", claimId: checkoutClaimId, userId: user.userId },
    });
    expect(await auditOf(s.workspaceId, "subject.created")).toHaveLength(1);

    // Renewals carry the same reference: still linked, nothing more is recorded.
    clock.advance(31 * DAY);
    s.paddle.renew(subscription.id);
    await deliverSubscription(s, "subscription.updated", subscription.id);
    expect(await auditOf(s.workspaceId, "claim.completed")).toHaveLength(1);
    expect(await auditOf(s.workspaceId, "claim.rejected")).toEqual([]);
    expect(await liveFor(s.workspaceId, user.profile.externalUserId)).toHaveLength(
      s.resources.length,
    );
  });

  it("refuses unknown, archived and unsellable offers, other prices and a missing payment link", async () => {
    const s = await paddleShop();
    const user = await signedUp();
    const start = (offerId: string, priceId: string) =>
      startCheckout(serviceContext(), { offerId, priceId, user }, s.deps);
    expect(await start("nope", s.price.id)).toEqual({ ok: false, reason: "not_found" });
    const other = s.paddle.addPrice();
    expect(await start(s.offer.id, other.id)).toEqual({ ok: false, reason: "price_invalid" });
    s.paddle.setDefaultPaymentLink(null);
    expect(await start(s.offer.id, s.price.id)).toEqual({
      ok: false,
      reason: "no_default_payment_link",
    });
    s.paddle.setDefaultPaymentLink("https://seller.example/pay");
    s.paddle.failNext("createTransaction", "transient");
    await expect(start(s.offer.id, s.price.id)).rejects.toMatchObject({ kind: "transient" });
    expect(await auditOf(s.workspaceId, "checkout.started")).toEqual([]);

    await disconnectPaddle(serviceContext(), s, s.slug, s.deps);
    expect(await start(s.offer.id, s.price.id)).toEqual({ ok: false, reason: "unavailable" });
    expect(await getCheckoutView(serviceContext(), { offerId: s.offer.id, user })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    await archiveOffer(serviceContext(), s, s.slug, s.offer.id);
    expect(await start(s.offer.id, s.price.id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("names the missing payment link when Paddle returns no checkout URL", async () => {
    const s = await paddleShop();
    const deps = {
      ...s.deps,
      paddle: (credentials: Parameters<typeof s.deps.paddle>[0]) => {
        const client = s.deps.paddle(credentials);
        return {
          ...client,
          createTransaction: async (input: Parameters<typeof client.createTransaction>[0]) => ({
            ...(await client.createTransaction(input)),
            checkoutUrl: null,
          }),
        };
      },
    };
    expect(
      await startCheckout(
        serviceContext(),
        { offerId: s.offer.id, priceId: s.price.id, user: await signedUp() },
        deps,
      ),
    ).toEqual({ ok: false, reason: "no_default_payment_link" });
  });
});

describe("claim/checkout-reference-tamper-rejected", () => {
  /** A subscription carrying `reference`, delivered and processed. */
  async function presented(s: PaddleShop, reference: unknown, customerId?: string) {
    const customer = customerId ?? paddleCustomer(s).id;
    const sub = s.paddle.createSubscription({
      customerId: customer,
      priceIds: [s.price.id],
      customData: { sharerepo_claim: reference },
    });
    await deliverSubscription(s, "subscription.created", sub.id);
    return {
      sub,
      customer: (await customerRow(s, customer)) as NonNullable<unknown> as {
        id: string;
        subjectId: string | null;
      },
    };
  }

  const rejections = async (s: PaddleShop) =>
    (await auditOf(s.workspaceId, "claim.rejected")).map((event) => event.details);

  it("a malformed, forged or unknown reference links nothing", async () => {
    const s = await paddleShop();
    const user = await signedUp();
    const started = await startCheckout(
      serviceContext(),
      { offerId: s.offer.id, priceId: s.price.id, user },
      s.deps,
    );
    if (!started.ok) throw new Error(started.reason);
    const genuine = s.paddle.transaction(transactionOf(started.checkoutUrl)).customData
      .sharerepo_claim as string;
    const forged = `${genuine.slice(0, -2)}${genuine.endsWith("AA") ? "BA" : "AA"}`;
    const unknown = await signClaimReference({
      key: CLAIM_KEY,
      workspaceId: s.workspaceId,
      checkoutClaimId: "no-such-claim",
      userId: user.userId,
      offerId: s.offer.id,
    });
    const withOtherKey = await signClaimReference({
      key: new TextEncoder().encode("another-key-another-key-another-key!"),
      workspaceId: s.workspaceId,
      checkoutClaimId: started.checkoutClaimId,
      userId: user.userId,
      offerId: s.offer.id,
    });
    for (const reference of ["garbage", forged, unknown, withOtherKey]) {
      const { customer } = await presented(s, reference);
      expect(customer.subjectId).toBeNull();
    }
    expect(await rejections(s)).toEqual([
      { path: "checkout", claimId: null, reason: "signature_invalid" },
      { path: "checkout", claimId: null, reason: "signature_invalid" },
      { path: "checkout", claimId: null, reason: "unknown_claim" },
      { path: "checkout", claimId: null, reason: "signature_invalid" },
    ]);
    expect(await liveFor(s.workspaceId, user.profile.externalUserId)).toEqual([]);
    expect(
      await getCheckoutClaim(db, { workspaceId: s.workspaceId, id: started.checkoutClaimId }),
    ).toMatchObject({ consumedByCustomerId: null });
  });

  it("another workspace's reference links nothing", async () => {
    const a = await paddleShop();
    const b = await paddleShop();
    const user = await signedUp();
    const started = await startCheckout(
      serviceContext(),
      { offerId: a.offer.id, priceId: a.price.id, user },
      a.deps,
    );
    if (!started.ok) throw new Error(started.reason);
    const reference = a.paddle.transaction(transactionOf(started.checkoutUrl)).customData
      .sharerepo_claim;
    const { customer } = await presented(b, reference);
    expect(customer.subjectId).toBeNull();
    expect(await rejections(b)).toEqual([
      { path: "checkout", claimId: null, reason: "unknown_claim" },
    ]);
  });

  it("an expired reference, or one consumed by another customer, links nothing", async () => {
    const s = await paddleShop();
    const user = await signedUp();
    const first = await purchase(s, user);
    const reference = s.paddle.transaction(first.transactionId).customData.sharerepo_claim;
    const { customer } = await presented(s, reference);
    expect(customer.subjectId).toBeNull();

    const late = await startCheckout(
      serviceContext(),
      { offerId: s.offer.id, priceId: s.price.id, user },
      s.deps,
    );
    if (!late.ok) throw new Error(late.reason);
    clock.advance(7 * DAY);
    const lateTransaction = transactionOf(late.checkoutUrl);
    const sub = s.paddle.completeCheckout(lateTransaction, { customerId: paddleCustomer(s).id });
    await deliverSubscription(s, "subscription.created", sub.id);
    expect(await rejections(s)).toEqual([
      { path: "checkout", claimId: first.checkoutClaimId, reason: "consumed_by_other_customer" },
      { path: "checkout", claimId: late.checkoutClaimId, reason: "expired" },
    ]);
  });

  it("never moves a customer linked to someone else: claim.conflict", async () => {
    const s = await paddleShop();
    const owner = await signedUp();
    const { customer } = await purchase(s, owner);
    const linked = await customerRow(s, customer.id);
    const intruder = await signedUp();
    const started = await startCheckout(
      serviceContext(),
      { offerId: s.offer.id, priceId: s.price.id, user: intruder },
      s.deps,
    );
    if (!started.ok) throw new Error(started.reason);
    // The same Paddle customer pays again through the intruder's checkout.
    const sub = s.paddle.completeCheckout(transactionOf(started.checkoutUrl), {
      customerId: customer.id,
    });
    await deliverSubscription(s, "subscription.created", sub.id);
    expect((await customerRow(s, customer.id))?.subjectId).toBe(linked?.subjectId);
    expect(await auditOf(s.workspaceId, "claim.conflict")).toEqual([
      expect.objectContaining({
        details: {
          path: "checkout",
          claimId: started.checkoutClaimId,
          subjectId: linked?.subjectId,
          userId: intruder.userId,
        },
      }),
    ]);
    expect(await liveFor(s.workspaceId, intruder.profile.externalUserId)).toEqual([]);
  });

  it("a source without a signing key never links", async () => {
    const s = await paddleShop();
    const sub = directSubscription(s, paddleCustomer(s).id);
    const port = {
      source: "paddle" as const,
      async refreshSubscription(): Promise<SourceSubscription> {
        const snapshot = {
          externalSubscriptionId: sub.id,
          externalCustomerId: sub.customerId,
          items: [s.price.id],
          state: "active" as const,
          providerState: "active",
          currentPeriodStart: clock.now(),
          currentPeriodEnd: clock.now() + 30 * DAY,
          cancelAt: null,
          endedAt: null,
          pastDueSince: null,
          sourceUpdatedAt: clock.now(),
        };
        return { found: true, snapshot, customerLink: null, claimReference: "v1.x.y" };
      },
    };
    await refreshSubscription(
      serviceContext(),
      { workspaceId: s.workspaceId, source: "paddle", externalSubscriptionId: sub.id },
      port,
    );
    expect(await auditOf(s.workspaceId, "claim.rejected")).toEqual([]);
  });
});

describe("identity/unverified-email-match-grants-nothing", () => {
  it("a user whose GitHub email equals the Paddle email gets nothing without a claim", async () => {
    const s = await paddleShop();
    const user = await signedUp();
    // The buyer's GitHub account shares the payment email; sign-in stored it as a snapshot only.
    const email = `${user.profile.username}@example.com`;
    const customer = paddleCustomer(s, email);
    const sub = directSubscription(s, customer.id);
    await deliverSubscription(s, "subscription.created", sub.id);
    expect((await customerRow(s, customer.id))?.subjectId).toBeNull();
    expect(live(await entitlementsOf(s.workspaceId, sub.id))).toEqual([]);
    expect(await liveFor(s.workspaceId, user.profile.externalUserId)).toEqual([]);
    expect(await myAccess(serviceContext(), user)).toEqual([]);
  });
});

/** A paid subscription bought through a shared Paddle link, known to ShareRepo but unclaimed. */
async function unclaimed(s: PaddleShop, email?: string) {
  const customer = paddleCustomer(s, email);
  const sub = directSubscription(s, customer.id);
  await deliverSubscription(s, "subscription.created", sub.id);
  return { customer, sub };
}

const IP = "203.0.113.7";

/** Requests a claim and runs the job, returning the claim link's token (or null). */
async function claimByEmail(s: PaddleShop, user: UserActor, email: string) {
  const mail = createFakeMail();
  const requested = await requestClaim(
    serviceContext(),
    { workspaceSlug: s.slug, email, user, ip: IP },
    s.deps,
  );
  if (requested.status !== "requested" || requested.outboxId === null) throw new Error("limited");
  const row = await env.DB.prepare("SELECT subject_id FROM outbox WHERE id = ?")
    .bind(requested.outboxId)
    .first<{ subject_id: string }>();
  const ref = decodeClaimRequestKey(row?.subject_id as string);
  if (!ref.ok) throw new Error("key");
  const result = await sendClaimEmail(serviceContext(), ref.value, { ...s.deps, mail });
  const link = mail.sent[0]?.text.match(/\/claim\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
  return { result, mail, token: link, claimRequestId: ref.value.claimRequestId };
}

describe("claims by email (path 2)", () => {
  it("emails a one-time link to the address Paddle holds, and erases the requested email", async () => {
    const s = await paddleShop();
    const { customer } = await unclaimed(s);
    const user = await signedUp();
    const { result, mail, token, claimRequestId } = await claimByEmail(s, user, customer.email);
    expect(result).toEqual({ outcome: "finished", sent: 1 });
    expect(mail.sent[0]).toMatchObject({ to: customer.email });
    expect(mail.sent[0]?.text).toContain(`https://sharerepo.test/claim/${token}`);
    expect(mail.sent[0]?.html).toContain(`https://sharerepo.test/claim/${token}`);
    expect(
      await getClaimRequest(db, { workspaceId: s.workspaceId, id: claimRequestId }),
    ).toMatchObject({ emailEnvelope: null, processedAt: clock.now() });
    const stored = await customerRow(s, customer.id);
    expect(await auditOf(s.workspaceId, "claim.token_issued")).toEqual([
      expect.objectContaining({ details: { claimRequestId, customerId: stored?.id } }),
    ]);
    // Done once: a redelivered job sends nothing.
    expect(
      await sendClaimEmail(
        serviceContext(),
        { workspaceId: s.workspaceId, claimRequestId },
        { ...s.deps, mail },
      ),
    ).toEqual({ outcome: "already_done", sent: 0 });
  });

  it("claim/request-does-not-reveal-purchases", async () => {
    const s = await paddleShop();
    const { customer } = await unclaimed(s);
    const user = await signedUp();
    const ask = (email: string) =>
      requestClaim(serviceContext(), { workspaceSlug: s.slug, email, user, ip: IP }, s.deps);
    const match = await ask(customer.email);
    const none = await ask("nobody@example.com");
    // The same response, and the same audit, with and without a purchase.
    expect(Object.keys(match)).toEqual(Object.keys(none));
    expect(match.status).toBe(none.status);
    const requested = await auditOf(s.workspaceId, "claim.requested");
    expect(requested.map(({ details, actor_id }) => ({ details, actor_id }))).toEqual([
      { details: {}, actor_id: user.userId },
      { details: {}, actor_id: user.userId },
    ]);
    // Nothing matched: the job finishes the same way, sending nothing.
    const mail = createFakeMail();
    const [, second] = requested;
    const result = await sendClaimEmail(
      serviceContext(),
      { workspaceId: s.workspaceId, claimRequestId: second?.target_id as string },
      { ...s.deps, mail },
    );
    expect(result).toEqual({ outcome: "finished", sent: 0 });
    expect(mail.sent).toEqual([]);
  });

  it("claim/request-rate-limited", async () => {
    const s = await paddleShop();
    const user = await signedUp();
    const ask = (email: string, who: UserActor = user, ip = IP) =>
      requestClaim(serviceContext(), { workspaceSlug: s.slug, email, user: who, ip }, s.deps);
    const email = `limited-${crypto.randomUUID()}@example.com`;
    // Per email: 3 an hour.
    for (let i = 0; i < 3; i += 1) {
      expect((await ask(email, await signedUp(), `198.51.100.${i}`)).status).toBe("requested");
    }
    const limited = await ask(email, await signedUp(), "198.51.100.9");
    expect(limited).toEqual({ status: "requested", outboxId: null });
    // Per user: 5 an hour, whatever the email.
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await ask(`u${i}-${crypto.randomUUID()}@example.com`, user, `192.0.2.${i}`));
    }
    expect(results.map((r) => r.status === "requested" && r.outboxId !== null)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    // Per IP: 20 an hour.
    const ip = `10.${Math.floor(Math.random() * 255)}.0.1`;
    let allowed = 0;
    for (let i = 0; i < 21; i += 1) {
      const r = await ask(`ip${i}-${crypto.randomUUID()}@example.com`, await signedUp(), ip);
      if (r.status === "requested" && r.outboxId !== null) allowed += 1;
    }
    expect(allowed).toBe(20);
    // A new window allows the email again.
    clock.advance(3_600_000);
    expect(await ask(email, await signedUp(), "198.51.100.10")).toMatchObject({
      outboxId: expect.any(String),
    });
  }, 30_000);

  it("refuses an invalid email, and an unknown or suspended workspace", async () => {
    const s = await paddleShop();
    const user = await signedUp();
    const ask = (workspaceSlug: string, email: string) =>
      requestClaim(serviceContext(), { workspaceSlug, email, user, ip: IP }, s.deps);
    expect(await ask(s.slug, "not an email")).toEqual({ status: "invalid_email" });
    await expect(ask("no-such-shop", "a@example.com")).rejects.toBeInstanceOf(NotFoundError);
    await expect(ask("Not A Slug!", "a@example.com")).rejects.toBeInstanceOf(NotFoundError);
    await env.DB.prepare("UPDATE workspaces SET status = 'suspended' WHERE id = ?")
      .bind(s.workspaceId)
      .run();
    await expect(ask(s.slug, "a@example.com")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("finishes without sending when mail or Paddle is unavailable, erasing the email", async () => {
    const s = await paddleShop();
    const { customer } = await unclaimed(s);
    const request = async (email = `other-${crypto.randomUUID()}@example.com`) => {
      const user = await signedUp();
      const r = await requestClaim(
        serviceContext(),
        { workspaceSlug: s.slug, email, user, ip: IP },
        s.deps,
      );
      const id = (await auditOf(s.workspaceId, "claim.requested")).at(-1)?.target_id as string;
      expect(r).toEqual({ status: "requested", outboxId: expect.any(String) });
      return { workspaceId: s.workspaceId, claimRequestId: id };
    };
    const noMail = await request();
    expect(await sendClaimEmail(serviceContext(), noMail, { ...s.deps, mail: null })).toEqual({
      outcome: "unavailable",
      sent: 0,
    });
    const failing = await request();
    s.paddle.failNext("listCustomersByEmail", "transient");
    expect(
      await sendClaimEmail(serviceContext(), failing, { ...s.deps, mail: createFakeMail() }),
    ).toEqual({ outcome: "unavailable", sent: 0 });
    const bounced = await request(customer.email);
    const mail = createFakeMail();
    mail.failNext("rejected");
    expect(await sendClaimEmail(serviceContext(), bounced, { ...s.deps, mail })).toEqual({
      outcome: "finished",
      sent: 0,
    });
    const disconnected = await request();
    await disconnectPaddle(serviceContext(), s, s.slug, s.deps);
    expect(
      await sendClaimEmail(serviceContext(), disconnected, { ...s.deps, mail: createFakeMail() }),
    ).toEqual({ outcome: "unavailable", sent: 0 });
    for (const ref of [noMail, failing, bounced, disconnected]) {
      expect(
        await getClaimRequest(db, { workspaceId: ref.workspaceId, id: ref.claimRequestId }),
      ).toMatchObject({ emailEnvelope: null });
    }
  });

  it("does nothing more when a concurrent job finished the request first", async () => {
    const s = await paddleShop();
    const { customer } = await unclaimed(s);
    const user = await signedUp();
    await requestClaim(
      serviceContext(),
      { workspaceSlug: s.slug, email: customer.email, user, ip: IP },
      s.deps,
    );
    const ref = {
      workspaceId: s.workspaceId,
      claimRequestId: (await auditOf(s.workspaceId, "claim.requested")).at(-1)?.target_id as string,
    };
    const mail = createFakeMail();
    const ctx = beforeFirstBatch(() =>
      sendClaimEmail(serviceContext(), ref, { ...s.deps, mail: null }),
    );
    expect(await sendClaimEmail(ctx, ref, { ...s.deps, mail })).toEqual({
      outcome: "already_done",
      sent: 0,
    });
    expect(mail.sent).toEqual([]);
    // The same when the job finds no match while another finishes first.
    await requestClaim(
      serviceContext(),
      { workspaceSlug: s.slug, email: customer.email, user, ip: IP },
      s.deps,
    );
    const next = {
      workspaceId: s.workspaceId,
      claimRequestId: (await auditOf(s.workspaceId, "claim.requested")).at(-1)?.target_id as string,
    };
    const racing = beforeFirstBatch(() =>
      sendClaimEmail(serviceContext(), next, { ...s.deps, mail: null }),
    );
    expect(await sendClaimEmail(racing, next, { ...s.deps, mail: null })).toEqual({
      outcome: "already_done",
      sent: 0,
    });
  });

  it("a customer ShareRepo does not know yet gets no link", async () => {
    const s = await paddleShop();
    const stranger = paddleCustomer(s);
    const { result, mail } = await claimByEmail(s, await signedUp(), stranger.email);
    expect(result).toEqual({ outcome: "finished", sent: 0 });
    expect(mail.sent).toEqual([]);
  });

  it("links the customer on confirmation and grants access; viewing first changes nothing", async () => {
    const s = await paddleShop();
    const { customer, sub } = await unclaimed(s);
    const user = await signedUp();
    const { token } = await claimByEmail(s, user, customer.email);
    const view = await viewClaim(serviceContext(), { token: token as string, user });
    expect(view).toEqual({
      ok: true,
      view: {
        workspace: { slug: s.slug, name: "Shop" },
        offers: ["Pro"],
        account: { login: user.profile.username, avatarUrl: user.profile.avatarUrl },
        linked: "none",
      },
    });
    const confirmed = await confirmClaim(serviceContext(), { token: token as string, user });
    expect(confirmed).toEqual({ ok: true, workspaceSlug: s.slug, outcome: "linked" });
    await drainPaddle(s);
    expect(live(await entitlementsOf(s.workspaceId, sub.id))).toHaveLength(s.resources.length);
    const stored = await customerRow(s, customer.id);
    expect(await auditOf(s.workspaceId, "claim.completed")).toEqual([
      expect.objectContaining({
        actor_id: user.userId,
        target_id: stored?.id,
        details: {
          path: "email",
          claimId: expect.any(String),
          userId: user.userId,
          subjectId: stored?.subjectId,
        },
      }),
    ]);
  });

  it("claim/get-never-mutates: viewing a claim link writes nothing", async () => {
    const s = await paddleShop();
    const { customer } = await unclaimed(s);
    const user = await signedUp();
    const { token } = await claimByEmail(s, user, customer.email);
    const before = await snapshotTables(env.DB, {});
    await viewClaim(serviceContext(), { token: token as string, user });
    await viewClaim(serviceContext(), { token: "x".repeat(43), user });
    expect(changedTables(before, await snapshotTables(env.DB, {}))).toEqual([]);
  });

  it("claim/token-single-use-and-expiring", async () => {
    const s = await paddleShop();
    const { customer } = await unclaimed(s);
    const user = await signedUp();
    const { token } = await claimByEmail(s, user, customer.email);
    const value = token as string;
    expect((await confirmClaim(serviceContext(), { token: value, user })).ok).toBe(true);
    const other = await signedUp();
    expect(await confirmClaim(serviceContext(), { token: value, user: other })).toEqual({
      ok: false,
      reason: "already_used",
    });
    expect(await viewClaim(serviceContext(), { token: value, user: other })).toEqual({
      ok: false,
      reason: "already_used",
    });

    const second = await claimByEmail(s, user, customer.email);
    clock.advance(DAY);
    expect(await confirmClaim(serviceContext(), { token: second.token as string, user })).toEqual({
      ok: false,
      reason: "expired",
    });
    for (const bogus of ["", "short", "A".repeat(43)]) {
      expect(await confirmClaim(serviceContext(), { token: bogus, user })).toEqual({
        ok: false,
        reason: "unknown_claim",
      });
    }
    expect(
      (await auditOf(s.workspaceId, "claim.rejected")).map(({ details }) => details.reason),
    ).toEqual(["already_used", "expired"]);
  });

  it("identity/unlink-relink-moves-subject-safely", async () => {
    const s = await paddleShop();
    const first = await signedUp();
    const { customer, subscription } = await purchase(s, first);
    expect(await liveFor(s.workspaceId, first.profile.externalUserId)).toHaveLength(
      s.resources.length,
    );
    const linked = await customerRow(s, customer.id);
    // The payment mailbox's owner claims with another GitHub account: the link moves.
    const second = await signedUp();
    const { token } = await claimByEmail(s, second, customer.email);
    expect(
      await viewClaim(serviceContext(), { token: token as string, user: second }),
    ).toMatchObject({ ok: true, view: { linked: "other" } });
    expect(await confirmClaim(serviceContext(), { token: token as string, user: second })).toEqual({
      ok: true,
      workspaceSlug: s.slug,
      outcome: "relinked",
    });
    await drainPaddle(s);
    expect(await liveFor(s.workspaceId, first.profile.externalUserId)).toEqual([]);
    expect(await liveFor(s.workspaceId, second.profile.externalUserId)).toHaveLength(
      s.resources.length,
    );
    const moved = await customerRow(s, customer.id);
    expect(await auditOf(s.workspaceId, "customer.relinked")).toEqual([
      expect.objectContaining({
        actor_id: second.userId,
        details: {
          path: "email",
          previousSubjectId: linked?.subjectId,
          subjectId: moved?.subjectId,
        },
      }),
    ]);
    expect(live(await entitlementsOf(s.workspaceId, subscription.id))).toHaveLength(
      s.resources.length,
    );
  });

  it("confirming a customer already linked to the claimant uses the token up", async () => {
    const s = await paddleShop();
    const user = await signedUp();
    const { customer } = await purchase(s, user);
    const { token } = await claimByEmail(s, user, customer.email);
    expect(await viewClaim(serviceContext(), { token: token as string, user })).toMatchObject({
      ok: true,
      view: { linked: "you" },
    });
    expect(await confirmClaim(serviceContext(), { token: token as string, user })).toEqual({
      ok: true,
      workspaceSlug: s.slug,
      outcome: "already_linked",
    });
    expect(await confirmClaim(serviceContext(), { token: token as string, user })).toEqual({
      ok: false,
      reason: "already_used",
    });
  });

  it("a concurrent confirmation of the same token is a conflict", async () => {
    const s = await paddleShop();
    const { customer } = await unclaimed(s);
    const user = await signedUp();
    const other = await signedUp();
    const { token } = await claimByEmail(s, user, customer.email);
    const value = token as string;
    const ctx = beforeFirstBatch(() =>
      confirmClaim(serviceContext(), { token: value, user: other }),
    );
    await expect(confirmClaim(ctx, { token: value, user })).rejects.toBeInstanceOf(ConflictError);
    expect((await customerRow(s, customer.id))?.subjectId).not.toBeNull();

    // Also on the already-linked path.
    const owner = await signedUp();
    const bought = await purchase(s, owner);
    const again = await claimByEmail(s, owner, bought.customer.email);
    const racing = beforeFirstBatch(() =>
      confirmClaim(serviceContext(), { token: again.token as string, user: owner }),
    );
    await expect(
      confirmClaim(racing, { token: again.token as string, user: owner }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("linkCustomerManually (path 3)", () => {
  it("links a customer to a GitHub login with a reason, audited, and grants access", async () => {
    const s = await paddleShop();
    const { customer, sub } = await unclaimed(s);
    const stored = await customerRow(s, customer.id);
    const account = githubUser(s);
    const result = await linkCustomerManually(
      serviceContext(),
      s,
      s.slug,
      {
        customerId: stored?.id as string,
        githubLogin: ` ${account.login} `,
        reason: " Support #42 ",
      },
      { github: s.github },
    );
    expect(result).toEqual({ ok: true, outcome: "linked" });
    await drainPaddle(s);
    expect(await liveFor(s.workspaceId, account.id)).toHaveLength(s.resources.length);
    expect(live(await entitlementsOf(s.workspaceId, sub.id))).toHaveLength(s.resources.length);
    const linked = await customerRow(s, customer.id);
    expect(await auditOf(s.workspaceId, "customer.linked_manually")).toEqual([
      expect.objectContaining({
        actor_id: s.userId,
        reason: "Support #42",
        details: { previousSubjectId: null, subjectId: linked?.subjectId },
      }),
    ]);
    expect(
      await linkCustomerManually(
        serviceContext(),
        s,
        s.slug,
        { customerId: stored?.id as string, githubLogin: account.login, reason: "again" },
        { github: s.github },
      ),
    ).toEqual({ ok: true, outcome: "already_linked" });
    // It moves an existing link, recording the previous subject.
    const next = githubUser(s);
    await linkCustomerManually(
      serviceContext(),
      s,
      s.slug,
      { customerId: stored?.id as string, githubLogin: next.login, reason: "Moved" },
      { github: s.github },
    );
    expect((await auditOf(s.workspaceId, "customer.linked_manually"))[1]?.details).toEqual({
      previousSubjectId: linked?.subjectId,
      subjectId: (await customerRow(s, customer.id))?.subjectId,
    });
  });

  it("refuses a missing reason, bad logins, organizations and a missing GitHub connection", async () => {
    const s = await paddleShop();
    const { customer } = await unclaimed(s);
    const customerId = (await customerRow(s, customer.id))?.id as string;
    const link = (githubLogin: string, reason = "Support", slug = s.slug) =>
      linkCustomerManually(
        serviceContext(),
        s,
        slug,
        { customerId, githubLogin, reason },
        { github: s.github },
      );
    expect(await link("someone", "  ")).toEqual({ ok: false, error: "reason_required" });
    expect(await link("someone", "x".repeat(501))).toEqual({ ok: false, error: "reason_required" });
    expect(await link("bad login!")).toEqual({ ok: false, error: "login_invalid" });
    expect(await link("no-such-login")).toEqual({ ok: false, error: "login_not_found" });
    expect(await link(githubUser(s, "Organization").login)).toEqual({
      ok: false,
      error: "account_not_user",
    });
    s.github.failNext("transient");
    await expect(link(githubUser(s).login)).rejects.toMatchObject({ kind: "transient" });
    await expect(
      linkCustomerManually(
        serviceContext(),
        s,
        s.slug,
        { customerId: "nope", githubLogin: "someone", reason: "Support" },
        { github: s.github },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await env.DB.prepare("UPDATE connections SET status = 'suspended' WHERE id = ?")
      .bind(s.connection.id)
      .run();
    expect(await link("someone")).toEqual({ ok: false, error: "connection_missing" });
    expect(await auditOf(s.workspaceId, "customer.linked_manually")).toEqual([]);
  });

  it("is a conflict when the link changed meanwhile", async () => {
    const s = await paddleShop();
    const { customer } = await unclaimed(s);
    const customerId = (await customerRow(s, customer.id))?.id as string;
    const first = githubUser(s);
    const second = githubUser(s);
    const ctx = beforeFirstBatch(() =>
      linkCustomerManually(
        serviceContext(),
        s,
        s.slug,
        { customerId, githubLogin: first.login, reason: "first" },
        { github: s.github },
      ),
    );
    await expect(
      linkCustomerManually(
        ctx,
        s,
        s.slug,
        { customerId, githubLogin: second.login, reason: "second" },
        { github: s.github },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("is for owners only", async () => {
    const s = await paddleShop();
    const member = await memberOf(s);
    await expect(
      linkCustomerManually(
        serviceContext(),
        member,
        s.slug,
        { customerId: "x", githubLogin: "someone", reason: "r" },
        { github: s.github },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("listCustomers and myAccess", () => {
  it("lists the workspace's customers with their links, for owners", async () => {
    const s = await paddleShop();
    const user = await signedUp();
    const { customer, subscription } = await purchase(s, user);
    const { customer: stranger } = await unclaimed(s);
    const customers = await listCustomers(serviceContext(), s, s.slug);
    const linked = await customerRow(s, customer.id);
    expect(customers).toHaveLength(2);
    expect(customers).toEqual(
      expect.arrayContaining([
        {
          id: linked?.id,
          source: "paddle",
          externalCustomerId: customer.id,
          linked: {
            subjectId: linked?.subjectId,
            login: user.profile.username,
            externalSubjectId: user.profile.externalUserId,
          },
          subscriptions: [
            expect.objectContaining({ externalSubscriptionId: subscription.id, state: "active" }),
          ],
        },
        expect.objectContaining({ externalCustomerId: stranger.id, linked: null }),
      ]),
    );
    const member = await memberOf(s);
    await expect(listCustomers(serviceContext(), member, s.slug)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("shows a subscriber their own access only", async () => {
    const s = await paddleShop();
    const user = await signedUp();
    const { subscription } = await purchase(s, user);
    const mine = await myAccess(serviceContext(), user);
    expect(mine).toEqual([
      expect.objectContaining({
        workspace: { id: s.workspaceId, slug: s.slug, name: "Shop" },
        externalSubscriptionId: subscription.id,
        state: "active",
        entitlements: s.resources.map((r) =>
          expect.objectContaining({ resourceId: r.id, repositoryName: r.nameSnapshot }),
        ),
      }),
    ]);
    expect(await myAccess(serviceContext(), await signedUp())).toEqual([]);
  });
});

describe("isolation/cross-workspace-mutation-denied (claims)", () => {
  it("another tenant's owner cannot list or link this workspace's customers", async () => {
    const s = await paddleShop();
    const { customer } = await unclaimed(s);
    const bob = await signedUpUser();
    const customerId = (await customerRow(s, customer.id))?.id as string;
    await expect(listCustomers(serviceContext(), bob, s.slug)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      linkCustomerManually(
        serviceContext(),
        bob,
        s.slug,
        { customerId, githubLogin: "someone", reason: "r" },
        { github: s.github },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Bob's own workspace cannot reach the customer either.
    const other = await shop();
    await expect(
      linkCustomerManually(
        serviceContext(),
        other,
        other.slug,
        { customerId, githubLogin: "someone", reason: "r" },
        { github: other.github },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      (await getCustomer(db, { workspaceId: s.workspaceId, customerId }))?.subjectId,
    ).toBeNull();
  });

  it("a claim token links only its own workspace's customer", async () => {
    const a = await paddleShop();
    const b = await paddleShop();
    const { customer } = await unclaimed(a);
    const user = await signedUp();
    const { token } = await claimByEmail(a, user, customer.email);
    expect(await confirmClaim(serviceContext(), { token: token as string, user })).toMatchObject({
      ok: true,
      workspaceSlug: a.slug,
    });
    expect(await listCustomersWithLinks(db, { workspaceId: b.workspaceId })).toEqual([]);
  });
});
