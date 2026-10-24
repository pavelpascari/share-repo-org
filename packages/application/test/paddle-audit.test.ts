import { env } from "cloudflare:workers";
import { createFakeMail } from "@sharerepo/integrations/testing";
import {
  captureLogs,
  expectAuditedChange,
  expectNoCanaryLeak,
  expectNoChangeOnFailure,
  UNAUDITED_TABLES,
} from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  checkPaddleConnection,
  confirmClaim,
  connectPaddle,
  decodeClaimRequestKey,
  disconnectPaddle,
  linkCustomerManually,
  paddleEntitlementSource,
  processPaddleEvent,
  queuePaddleSweeps,
  reconnectPaddle,
  refreshSubscription,
  requestClaim,
  type ServiceContext,
  sendClaimEmail,
  startCheckout,
  sweepPaddleSubscriptions,
  syncPaddleCatalog,
} from "../src/index.ts";
import { failingBatches, githubUser, memberOf, shop } from "./support/commerce.ts";
import { serviceContext, signedUpUser } from "./support/context.ts";
import {
  commerceDeps,
  connectionOf,
  deliverSubscription,
  directSubscription,
  drainPaddle,
  PaddleAccounts,
  paddleCustomer,
  paddleShop,
  post,
  purchase,
  ROTATED,
  settingOf,
  storedText,
} from "./support/paddle.ts";

/** Bookkeeping a Paddle service may write without an audit event (see src/paddle.ts). */
const BOOKKEEPING = {
  ...UNAUDITED_TABLES,
  paddle_connections:
    "last_event_at and last_checked_at stamps record observations, not decisions; status, credential and catalog changes are audited",
  claim_requests:
    "processing a request erases its email envelope (privacy bookkeeping); the request is audited as claim.requested and each link as claim.token_issued",
};

async function audited<T>(
  run: (ctx: ServiceContext) => Promise<T>,
  ignore: Readonly<Record<string, string>> = UNAUDITED_TABLES,
) {
  const ctx = serviceContext();
  const change = await expectAuditedChange(env.DB, ctx.correlationId, () => run(ctx), ignore);
  return change;
}

describe("audit/every-state-change-has-audit-event (Paddle and claims)", () => {
  it("audits connecting, syncing, probing, re-wrapping, reconnecting and disconnecting", async () => {
    const s = await shop();
    const accounts = new PaddleAccounts();
    const { fake, key } = accounts.seller();
    fake.addPrice();
    const deps = commerceDeps(accounts);
    const connected = await audited((ctx) =>
      connectPaddle(ctx, s, s.slug, { apiKey: key, apiKeyExpiresOn: null }, deps),
    );
    expect(connected.changedTables).toEqual(["paddle_connections", "paddle_prices"]);
    const ref = {
      workspaceId: s.workspaceId,
      connectionId: (connected.result as { connectionId: string }).connectionId,
    };
    fake.addPrice();
    expect(
      (await audited((ctx) => syncPaddleCatalog(ctx, s, s.slug, deps))).changedTables,
    ).toContain("paddle_prices");
    const probed = await audited((ctx) => checkPaddleConnection(ctx, ref, deps), BOOKKEEPING);
    expect(probed.changedTables).toEqual([]);
    fake.revokeKey();
    expect((await audited((ctx) => checkPaddleConnection(ctx, ref, deps))).changedTables).toEqual([
      "paddle_connections",
    ]);
    fake.restoreKey();
    const rewrapped = await audited((ctx) =>
      checkPaddleConnection(ctx, ref, { ...deps, credentialKeys: ROTATED }),
    );
    expect(rewrapped.auditEventCount).toBe(2);
    const reconnected = await audited((ctx) =>
      reconnectPaddle(
        ctx,
        s,
        s.slug,
        { apiKey: accounts.issue(fake), apiKeyExpiresOn: null },
        { ...deps, credentialKeys: ROTATED },
      ),
    );
    expect(reconnected.changedTables).toEqual(["paddle_connections"]);
    const disconnected = await audited((ctx) =>
      disconnectPaddle(ctx, s, s.slug, { ...deps, credentialKeys: ROTATED }),
    );
    expect(disconnected.changedTables).toEqual(["paddle_connections"]);
  });

  it("webhooks, processing and sweeps only record receipts and queue work", async () => {
    const s = await paddleShop();
    const sub = directSubscription(s, paddleCustomer(s).id);
    const delivery = await s.paddle.emitSubscriptionEvent(
      await settingOf(s),
      "subscription.created",
      sub.id,
    );
    const ingested = await audited((ctx) => post(s, delivery, ctx), BOOKKEEPING);
    expect(ingested.changedTables).toEqual([]);
    const { eventId } = ingested.result as { eventId: string };
    expect((await audited((ctx) => processPaddleEvent(ctx, eventId))).changedTables).toEqual([]);
    const ref = { workspaceId: s.workspaceId, connectionId: s.connectionId };
    expect(
      (await audited((ctx) => sweepPaddleSubscriptions(ctx, ref, s.deps))).changedTables,
    ).toEqual([]);
    expect((await audited((ctx) => queuePaddleSweeps(ctx))).changedTables).toEqual([]);
    // The refresh itself is audited like any other source's.
    const refreshed = await audited((ctx) =>
      refreshSubscription(
        ctx,
        { workspaceId: s.workspaceId, source: "paddle", externalSubscriptionId: sub.id },
        paddleEntitlementSource(ctx, s.deps),
      ),
    );
    expect(refreshed.changedTables).toEqual(expect.arrayContaining(["customers", "subscriptions"]));
  });

  it("audits checkout, claims and manual links", async () => {
    const s = await paddleShop();
    const user = await signedUpUser();
    const started = await audited((ctx) =>
      startCheckout(ctx, { offerId: s.offer.id, priceId: s.price.id, user }, s.deps),
    );
    expect(started.changedTables).toEqual(["checkout_claims"]);

    const customer = paddleCustomer(s);
    const sub = directSubscription(s, customer.id);
    await deliverSubscription(s, "subscription.created", sub.id);
    const requested = await audited((ctx) =>
      requestClaim(
        ctx,
        { workspaceSlug: s.slug, email: customer.email, user, ip: "192.0.2.1" },
        s.deps,
      ),
    );
    expect(requested.changedTables).toEqual(["claim_requests"]);
    const { outboxId } = requested.result as { outboxId: string };
    const subject = await env.DB.prepare("SELECT subject_id FROM outbox WHERE id = ?")
      .bind(outboxId)
      .first<{ subject_id: string }>();
    const ref = decodeClaimRequestKey(subject?.subject_id as string);
    if (!ref.ok) throw new Error("key");
    const mail = createFakeMail();
    const sent = await audited(
      (ctx) => sendClaimEmail(ctx, ref.value, { ...s.deps, mail }),
      BOOKKEEPING,
    );
    expect(sent.changedTables).toEqual(["claim_tokens"]);
    const token = mail.sent[0]?.text.match(/\/claim\/([A-Za-z0-9_-]+)/)?.[1] as string;
    const confirmed = await audited((ctx) => confirmClaim(ctx, { token, user }));
    expect(confirmed.changedTables).toEqual(["claim_tokens", "customers", "subjects"]);
    const rejected = await audited((ctx) => confirmClaim(ctx, { token, user }));
    expect(rejected.auditEventCount).toBe(1);
    await drainPaddle(s);

    const other = githubUser(s);
    const customerId = (
      await env.DB.prepare("SELECT id FROM customers WHERE external_customer_id = ?")
        .bind(customer.id)
        .first<{ id: string }>()
    )?.id as string;
    const linked = await audited((ctx) =>
      linkCustomerManually(
        ctx,
        s,
        s.slug,
        { customerId, githubLogin: other.login, reason: "Support ticket" },
        { github: s.github },
      ),
    );
    expect(linked.changedTables).toEqual(["customers", "subjects"]);
  });

  it("refused and failed Paddle and claim changes leave no trace", async () => {
    const s = await paddleShop();
    const member = await memberOf(s);
    const accounts = new PaddleAccounts();
    const fresh = accounts.seller();
    const bare = await shop();
    for (const run of [
      () =>
        connectPaddle(
          failingBatches(),
          bare,
          bare.slug,
          { apiKey: fresh.key, apiKeyExpiresOn: null },
          commerceDeps(accounts),
        ),
      () => syncPaddleCatalog(serviceContext(), member, s.slug, s.deps),
      () => disconnectPaddle(serviceContext(), member, s.slug, s.deps),
      () =>
        startCheckout(
          failingBatches(),
          { offerId: s.offer.id, priceId: s.price.id, user: member },
          s.deps,
        ),
    ]) {
      await expectNoChangeOnFailure(env.DB, run);
    }
    expect(fresh.fake.notificationSettings()).toEqual([]);
  });
});

describe("audit/no-secrets-in-logs-or-audit (Paddle and claims)", () => {
  it("keys, webhook secrets, emails, claim tokens and references never leave their envelopes", async () => {
    const logs = captureLogs();
    const outputs: unknown[] = [];
    let secrets: string[] = [];
    try {
      const s = await paddleShop();
      const webhookSecret = s.paddle.secretOf(await settingOf(s));
      const user = await signedUpUser();
      const bought = await purchase(s, user);
      const reference = s.paddle.transaction(bought.transactionId).customData
        .sharerepo_claim as string;

      const customer = paddleCustomer(s, `private-${crypto.randomUUID()}@example.com`);
      const sub = directSubscription(s, customer.id);
      await deliverSubscription(s, "subscription.created", sub.id);
      const claimant = await signedUpUser();
      const requested = await requestClaim(
        serviceContext(),
        { workspaceSlug: s.slug, email: customer.email, user: claimant, ip: "198.51.100.77" },
        s.deps,
      );
      outputs.push(requested);
      const row = await env.DB.prepare("SELECT subject_id FROM outbox WHERE id = ?")
        .bind((requested as { outboxId: string }).outboxId)
        .first<{ subject_id: string }>();
      const ref = decodeClaimRequestKey(row?.subject_id as string);
      if (!ref.ok) throw new Error("key");
      const mail = createFakeMail();
      outputs.push(await sendClaimEmail(serviceContext(), ref.value, { ...s.deps, mail }));
      const token = mail.sent[0]?.text.match(/\/claim\/([A-Za-z0-9_-]+)/)?.[1] as string;
      outputs.push(await confirmClaim(serviceContext(), { token, user: claimant }));
      outputs.push(await confirmClaim(serviceContext(), { token, user: claimant }));
      await drainPaddle(s);

      // Failures carry no secret either.
      s.paddle.revokeKey();
      outputs.push(
        await syncPaddleCatalog(serviceContext(), s, s.slug, s.deps).catch((error) => error),
      );
      outputs.push(
        await connectPaddle(
          serviceContext(),
          s,
          s.slug,
          { apiKey: s.key, apiKeyExpiresOn: null },
          s.deps,
        ),
      );
      outputs.push(
        await reconnectPaddle(
          serviceContext(),
          s,
          s.slug,
          { apiKey: s.key, apiKeyExpiresOn: null },
          s.deps,
        ),
      );
      outputs.push(await connectionOf(s).then((c) => c.statusReason));
      secrets = [s.key, webhookSecret, reference, customer.email, token, "198.51.100.77"];
    } finally {
      logs.restore();
    }
    expect(secrets).toHaveLength(6);
    expectNoCanaryLeak([logs.entries, outputs, await storedText()], secrets);
  });
});
