import { env } from "cloudflare:workers";
import { getPaddleConnection, listAuditEventsByCorrelationId } from "@sharerepo/db";
import { PaddleApiError } from "@sharerepo/integrations";
import {
  type ClaimSigningKeyring,
  ConflictError,
  type CredentialKeyring,
  envelopeAad,
  ForbiddenError,
  openSecret,
  sealSecret,
} from "@sharerepo/platform";
import { describe, expect, it } from "vitest";
import {
  type CommerceDeps,
  checkPaddleConnection,
  decodeRewrapKey,
  disconnectPaddle,
  encodeRewrapKey,
  getBillingView,
  queueCredentialRewrap,
  REWRAP_BATCH,
  requestClaim,
  rewrapCredentials,
  rotatePaddleWebhookSecret,
  startCheckout,
} from "../src/index.ts";
import { memberOf } from "./support/commerce.ts";
import { clock, db, serviceContext, signedUpUser } from "./support/context.ts";
import {
  auditOf,
  beforeFirstBatch,
  buyerIp,
  connectionOf,
  deliverSubscription,
  drainPaddle,
  liveFor,
  type PaddleShop,
  paddleCustomer,
  paddleShop,
  post,
} from "./support/paddle.ts";

// Phase 6, secret rotation: `CLAIM_SIGNING_KEY` and `CREDENTIAL_KEYS` keyrings, the Paddle
// webhook secret, and the `rewrap_credentials` job.

let keys = Math.floor(Math.random() * 1e8);
const randomKey = () => crypto.getRandomValues(new Uint8Array(32));

/**
 * A keyring rotation of its own: `before` has only the old key, `during` both with the new one
 * current, `after` only the new key. Key IDs are unique, so no other test's envelopes match.
 */
function rotation() {
  const n = ++keys;
  const [oldId, newId] = [`old${n}`, `new${n}`];
  const [oldKey, newKey] = [randomKey(), randomKey()];
  return {
    oldId,
    newId,
    before: { current: oldId, keys: { [oldId]: oldKey } },
    during: { current: newId, keys: { [oldId]: oldKey, [newId]: newKey } },
    after: { current: newId, keys: { [newId]: newKey } },
  } satisfies Record<string, unknown> & {
    before: CredentialKeyring;
    during: CredentialKeyring;
    after: CredentialKeyring;
  };
}

const withDeps = (s: PaddleShop, overrides: Partial<CommerceDeps>): PaddleShop => ({
  ...s,
  deps: { ...s.deps, ...overrides },
});

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => error,
  );
}

const rotate = (s: PaddleShop, ctx = serviceContext()) =>
  rotatePaddleWebhookSecret(ctx, s, s.slug, s.deps);

/** One `api_key.updated` event, delivered by Paddle to every active destination. */
const deliveries = (s: PaddleShop) =>
  s.paddle.emitToAll({ eventType: "api_key.updated", data: { id: `apikey_${"0".repeat(26)}` } });

const statusesOf = async (s: PaddleShop, all: Awaited<ReturnType<typeof deliveries>>) => {
  const results = [];
  for (const delivery of all) results.push((await post(s, delivery)).status);
  return results;
};

describe("rotation/old-and-new-secret-both-accepted: CLAIM_SIGNING_KEY", () => {
  const OLD = new TextEncoder().encode("old-claim-signing-key-0123456789abcdef");
  const NEW = new TextEncoder().encode("new-claim-signing-key-0123456789abcdef");
  const before = { current: "c1", keys: { c1: OLD } };
  const during = { current: "c2", keys: { c1: OLD, c2: NEW } };
  const after = { current: "c2", keys: { c2: NEW } };

  /** A checkout started (and its reference signed) under `signing`, paid by a new customer. */
  async function paidCheckout(s: PaddleShop, signing: ClaimSigningKeyring) {
    const user = await signedUpUser();
    const started = await startCheckout(
      serviceContext(),
      { offerId: s.offer.id, priceId: s.price.id, user, ip: buyerIp() },
      { ...s.deps, claimSigningKeys: signing },
    );
    if (!started.ok) throw new Error(started.reason);
    const transactionId = new URL(started.checkoutUrl).searchParams.get("_ptxn") as string;
    const customer = paddleCustomer(s);
    const subscription = s.paddle.completeCheckout(transactionId, { customerId: customer.id });
    return { user, customer, subscription };
  }

  it("links a purchase whose reference was signed under the old key while both are listed", async () => {
    const s = await paddleShop({ deps: { claimSigningKeys: before } });
    const old = await paidCheckout(s, before);
    const fresh = await paidCheckout(s, during);
    const rotating = withDeps(s, { claimSigningKeys: during });
    await deliverSubscription(rotating, "subscription.created", old.subscription.id);
    await deliverSubscription(rotating, "subscription.created", fresh.subscription.id);
    const completed = await auditOf(s.workspaceId, "claim.completed");
    expect(completed.map((event) => event.details.userId).sort()).toEqual(
      [old.user.userId, fresh.user.userId].sort(),
    );
    expect(await auditOf(s.workspaceId, "claim.rejected")).toEqual([]);
  });

  it("refuses a reference signed under a removed key, but keeps renewals of linked customers silent", async () => {
    const s = await paddleShop({ deps: { claimSigningKeys: before } });
    const linked = await paidCheckout(s, before);
    await deliverSubscription(s, "subscription.created", linked.subscription.id);
    const pending = await paidCheckout(s, before);
    const rotated = withDeps(s, { claimSigningKeys: after });
    // A reference only the removed key signed no longer verifies.
    await deliverSubscription(rotated, "subscription.created", pending.subscription.id);
    expect(await auditOf(s.workspaceId, "claim.rejected")).toEqual([
      expect.objectContaining({
        target_id: expect.any(String),
        details: { path: "checkout", claimId: null, reason: "signature_invalid" },
      }),
    ]);
    // The linked customer's renewal carries the same reference: it is not checked again.
    clock.advance(60_000);
    s.paddle.renew(linked.subscription.id);
    await deliverSubscription(rotated, "subscription.updated", linked.subscription.id);
    expect(await auditOf(s.workspaceId, "claim.rejected")).toHaveLength(1);
    const identity = await env.DB.prepare(
      "SELECT external_user_id FROM external_identities WHERE user_id = ?",
    )
      .bind(linked.user.userId)
      .first<{ external_user_id: string }>();
    expect(await liveFor(s.workspaceId, identity?.external_user_id as string)).not.toEqual([]);
  });

  it("counts claim requests made under the old key towards the limits under the new one", async () => {
    const s = await paddleShop({ deps: { claimSigningKeys: before } });
    const email = `rotated-${crypto.randomUUID()}@example.com`;
    const ask = async (signing: ClaimSigningKeyring) =>
      requestClaim(
        serviceContext(),
        { workspaceSlug: s.slug, email, user: await signedUpUser(), ip: buyerIp() },
        { ...s.deps, claimSigningKeys: signing },
      );
    // Two requests before the rotation, one during: the per-email limit of 3 an hour is used up.
    expect((await ask(before)).status).toBe("requested");
    expect((await ask(before)).status).toBe("requested");
    expect(await ask(during)).toMatchObject({ outboxId: expect.any(String) });
    expect(await ask(during)).toEqual({ status: "requested", outboxId: null });
    // Without the old key its counters no longer count: the limit restarts under the new key.
    expect(await ask(after)).toMatchObject({ outboxId: expect.any(String) });
  });
});

describe("rotatePaddleWebhookSecret", () => {
  it("replaces the destination and its secret, audited, accepting only the new secret after", async () => {
    const s = await paddleShop();
    const before = await connectionOf(s);
    const oldSecret = s.paddle.secretOf(before.destinationId as string);
    const result = await rotate(s);
    const after = await connectionOf(s);
    expect(result).toEqual({ ok: true, destinationId: after.destinationId });
    expect(after.destinationId).not.toBe(before.destinationId);
    expect(after).toMatchObject({ destinationNextId: null, webhookSecretNextEnvelope: null });
    // Paddle holds only the new destination, for the same connection, with a version marker.
    expect(s.paddle.notificationSettings()).toEqual([
      expect.objectContaining({
        id: after.destinationId,
        active: true,
        destination: expect.stringMatching(
          new RegExp(`^https://sharerepo\\.test/webhooks/paddle/${s.connectionId}\\?v=[^&]+$`),
        ),
      }),
    ]);
    const newSecret = s.paddle.secretOf(after.destinationId as string);
    expect(
      (
        await openSecret({
          keyring: s.deps.credentialKeys,
          envelope: after.webhookSecretEnvelope as string,
          aad: envelopeAad({
            workspaceId: s.workspaceId,
            rowId: s.connectionId,
            purpose: "webhook_secret",
          }),
        })
      ).plaintext,
    ).toBe(newSecret);
    expect(newSecret).not.toBe(oldSecret);
    expect(await auditOf(s.workspaceId, "paddle.webhook_secret_rotated")).toEqual([
      expect.objectContaining({
        actor_id: s.userId,
        target_id: s.connectionId,
        details: {
          stage: "started",
          previousDestinationId: before.destinationId,
          destinationId: after.destinationId,
        },
      }),
      expect.objectContaining({
        details: {
          stage: "completed",
          previousDestinationId: before.destinationId,
          destinationId: after.destinationId,
        },
      }),
    ]);
    // A delivery signed with the old secret is refused now; the new destination's is accepted.
    const [delivery] = await deliveries(s);
    expect((await post(s, delivery as NonNullable<typeof delivery>)).status).toBe("accepted");
    const forged = { ...(delivery as NonNullable<typeof delivery>) };
    const { signPaddleWebhook } = await import("@sharerepo/integrations/testing");
    const stale = await signPaddleWebhook(
      oldSecret,
      forged.rawBody,
      Math.floor(clock.now() / 1000),
    );
    expect((await post(s, { ...forged, signature: stale })).status).toBe("invalid_signature");
    // And again: each rotation uses a new marker.
    expect(await rotate(s)).toMatchObject({ ok: true });
    expect(s.paddle.notificationSettings()).toHaveLength(1);
  });

  it("rotation/old-and-new-secret-both-accepted: both secrets are accepted while the rotation is in progress", async () => {
    const s = await paddleShop();
    const before = await connectionOf(s);
    // The old destination cannot be deleted yet: the rotation stops after its first step.
    s.paddle.failNext("deleteNotificationSetting", "transient");
    expect(await failure(rotate(s))).toBeInstanceOf(PaddleApiError);
    const during = await connectionOf(s);
    expect(during).toMatchObject({
      destinationId: before.destinationId,
      destinationNextId: expect.stringMatching(/^ntfset_/),
    });
    expect((await getBillingView(serviceContext(), s, s.slug)).connection).toMatchObject({
      rotationInProgress: true,
    });
    // Paddle delivers each event to both destinations; both verify, and the second is a
    // duplicate of the first.
    const both = await deliveries(s);
    expect(both.map((d) => d.settingId)).toEqual([before.destinationId, during.destinationNextId]);
    expect(await statusesOf(s, both)).toEqual(["accepted", "duplicate"]);
    const [onlyNew] = await deliveries(s).then((all) => all.slice(1));
    expect((await post(s, onlyNew as NonNullable<typeof onlyNew>)).status).toBe("accepted");
    // Running the action again completes it; then only the new destination's secret is valid.
    expect(await rotate(s)).toEqual({ ok: true, destinationId: during.destinationNextId });
    expect(await statusesOf(s, both.slice(0, 1))).toEqual(["invalid_signature"]);
    expect(await auditOf(s.workspaceId, "paddle.webhook_secret_rotated")).toHaveLength(2);
  });

  it("leaves the old destination working when creating the second one fails, and resumes", async () => {
    const s = await paddleShop();
    const before = await connectionOf(s);
    s.paddle.failNext("createNotificationSetting", "transient");
    expect(await failure(rotate(s))).toBeInstanceOf(PaddleApiError);
    expect(await connectionOf(s)).toEqual(before);
    expect(await auditOf(s.workspaceId, "paddle.webhook_secret_rotated")).toEqual([]);
    expect(await statusesOf(s, await deliveries(s))).toEqual(["accepted"]);
    expect(await rotate(s)).toMatchObject({ ok: true });
  });

  it("stores nothing when the second destination's response is lost, deletes it, and a rerun creates another", async () => {
    const s = await paddleShop();
    const before = await connectionOf(s);
    s.paddle.loseNextResponse("createNotificationSetting");
    expect(await failure(rotate(s))).toBeInstanceOf(PaddleApiError);
    expect(await connectionOf(s)).toEqual(before);
    // The destination Paddle created at that attempt's unique URL is found and deleted at once.
    expect(s.paddle.notificationSettings().map((setting) => setting.id)).toEqual([
      before.destinationId,
    ]);
    expect(await auditOf(s.workspaceId, "paddle.destinations_swept")).toEqual([
      expect.objectContaining({
        details: { reason: "orphaned", destinationIds: [expect.any(String)] },
      }),
    ]);
    expect(await statusesOf(s, await deliveries(s))).toEqual(["accepted"]);
    expect(await rotate(s)).toMatchObject({ ok: true });
  });

  it("deletes the second destination again when a concurrent change wins the store", async () => {
    const s = await paddleShop();
    const before = await connectionOf(s);
    const ctx = beforeFirstBatch(() =>
      env.DB.prepare("UPDATE paddle_connections SET destination_next_id = ? WHERE id = ?")
        .bind("ntfset_01racer000000000000000000", s.connectionId)
        .run(),
    );
    expect(await failure(rotate(s, ctx))).toBeInstanceOf(ConflictError);
    expect(s.paddle.notificationSettings().map((setting) => setting.id)).toEqual([
      before.destinationId,
    ]);
    expect(await auditOf(s.workspaceId, "paddle.webhook_secret_rotated")).toEqual([]);
  });

  it("deletes the second destination again when storing it fails", async () => {
    const s = await paddleShop();
    const before = await connectionOf(s);
    const failing = {
      ...serviceContext(),
      db: new Proxy(db, {
        get: (target, property, receiver) =>
          property === "batch"
            ? () => Promise.reject(new Error("D1 is unavailable"))
            : Reflect.get(target, property, receiver),
      }),
    };
    expect(await failure(rotate(s, failing))).toMatchObject({ message: "D1 is unavailable" });
    expect(s.paddle.notificationSettings().map((setting) => setting.id)).toEqual([
      before.destinationId,
    ]);
    expect(await connectionOf(s)).toEqual(before);
  });

  it("completes when deleting the old destination succeeded but its response was lost", async () => {
    const s = await paddleShop();
    s.paddle.loseNextResponse("deleteNotificationSetting");
    expect(await failure(rotate(s))).toBeInstanceOf(PaddleApiError);
    const during = await connectionOf(s);
    // The old destination is gone; the next one delivers and its secret is accepted.
    expect(s.paddle.notificationSettings().map((setting) => setting.id)).toEqual([
      during.destinationNextId,
    ]);
    expect(await statusesOf(s, await deliveries(s))).toEqual(["accepted"]);
    expect(await rotate(s)).toEqual({ ok: true, destinationId: during.destinationNextId });
  });

  it("keeps both secrets when the promotion loses to a concurrent disconnect", async () => {
    const s = await paddleShop();
    s.paddle.failNext("deleteNotificationSetting", "transient");
    await failure(rotate(s));
    const ctx = beforeFirstBatch(() =>
      env.DB.prepare(
        "UPDATE paddle_connections SET status = 'disconnected', api_key_envelope = NULL, webhook_secret_envelope = NULL, webhook_secret_next_envelope = NULL WHERE id = ?",
      )
        .bind(s.connectionId)
        .run(),
    );
    expect(await failure(rotate(s, ctx))).toBeInstanceOf(ConflictError);
    expect(await auditOf(s.workspaceId, "paddle.webhook_secret_rotated")).toHaveLength(1);
  });

  it.each([
    ["deleted", (s: PaddleShop, id: string) => s.paddle.deleteNotificationSetting(id)],
    ["deactivated", (s: PaddleShop, id: string) => s.paddle.deactivateNotificationSetting(id)],
  ] as const)("replaces a second destination %s in Paddle before completing", async (_, lose) => {
    const s = await paddleShop();
    const before = await connectionOf(s);
    s.paddle.failNext("deleteNotificationSetting", "transient");
    await failure(rotate(s));
    const lost = (await connectionOf(s)).destinationNextId as string;
    await lose(s, lost);
    const result = await rotate(s);
    const after = await connectionOf(s);
    expect(result).toEqual({ ok: true, destinationId: after.destinationId });
    expect([lost, before.destinationId]).not.toContain(after.destinationId);
    // The lost destination is deleted too, so nothing of the rotation is left behind.
    expect(s.paddle.notificationSettings().map((setting) => setting.id)).toEqual([
      after.destinationId,
    ]);
    const rotated = await auditOf(s.workspaceId, "paddle.webhook_secret_rotated");
    expect(rotated.map((event) => [event.details.stage, event.details.destinationId])).toEqual([
      ["started", lost],
      ["started", after.destinationId],
      ["completed", after.destinationId],
    ]);
  });

  it("propagates a failure to read the second destination, changing nothing", async () => {
    const s = await paddleShop();
    s.paddle.failNext("deleteNotificationSetting", "transient");
    await failure(rotate(s));
    const during = await connectionOf(s);
    s.paddle.failNext("getNotificationSetting", "transient");
    expect(await failure(rotate(s))).toBeInstanceOf(PaddleApiError);
    expect(await connectionOf(s)).toEqual(during);
  });

  it("respects Paddle's 10-destination limit, changing nothing", async () => {
    const s = await paddleShop();
    const before = await connectionOf(s);
    s.paddle.addForeignDestinations(9);
    expect(await rotate(s)).toEqual({ ok: false, reason: "destination_limit" });
    expect(await connectionOf(s)).toEqual(before);
    expect(await auditOf(s.workspaceId, "paddle.webhook_secret_rotated")).toEqual([]);
  });

  it("refuses without an active connection, and is for owners only", async () => {
    const s = await paddleShop();
    await expect(
      rotatePaddleWebhookSecret(serviceContext(), await memberOf(s), s.slug, s.deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
    s.paddle.revokeKey();
    await checkPaddleConnection(
      serviceContext(),
      { workspaceId: s.workspaceId, connectionId: s.connectionId },
      s.deps,
    );
    expect(await rotate(s)).toEqual({ ok: false, reason: "not_active" });
    s.paddle.restoreKey();
    await disconnectPaddle(serviceContext(), s, s.slug, s.deps);
    expect(await rotate(s)).toEqual({ ok: false, reason: "not_connected" });
  });

  it("disconnecting mid-rotation deletes both destinations and erases both secrets", async () => {
    const s = await paddleShop();
    s.paddle.failNext("deleteNotificationSetting", "transient");
    await failure(rotate(s));
    const during = await connectionOf(s);
    expect(await disconnectPaddle(serviceContext(), s, s.slug, s.deps)).toMatchObject({
      ok: true,
      destinationDeleted: true,
      orphanedDestinationIds: [],
    });
    expect(s.paddle.notificationSettings()).toEqual([]);
    const row = await env.DB.prepare(
      "SELECT destination_id, destination_next_id, webhook_secret_envelope, webhook_secret_next_envelope FROM paddle_connections WHERE id = ?",
    )
      .bind(s.connectionId)
      .first();
    expect(row).toEqual({
      destination_id: null,
      destination_next_id: null,
      webhook_secret_envelope: null,
      webhook_secret_next_envelope: null,
    });
    expect(during.destinationNextId).not.toBeNull();
  });

  it("disconnecting mid-rotation keeps both destination IDs when Paddle cannot be asked", async () => {
    const s = await paddleShop();
    s.paddle.failNext("deleteNotificationSetting", "transient");
    await failure(rotate(s));
    const during = await connectionOf(s);
    s.paddle.revokeKey();
    expect(await disconnectPaddle(serviceContext(), s, s.slug, s.deps)).toEqual({
      ok: true,
      destinationDeleted: false,
      destinationId: during.destinationId,
      orphanedDestinationIds: [during.destinationId, during.destinationNextId],
    });
    const row = await env.DB.prepare(
      "SELECT destination_next_id, webhook_secret_next_envelope FROM paddle_connections WHERE id = ?",
    )
      .bind(s.connectionId)
      .first();
    expect(row).toEqual({
      destination_next_id: during.destinationNextId,
      webhook_secret_next_envelope: null,
    });
  });

  it("re-wraps the next secret lazily under a rotated master key, audited", async () => {
    const keyring = rotation();
    const s = await paddleShop({ deps: { credentialKeys: keyring.before } });
    s.paddle.failNext("deleteNotificationSetting", "transient");
    await failure(rotate(s));
    const rotated = withDeps(s, { credentialKeys: keyring.during });
    expect(await statusesOf(rotated, await deliveries(rotated))).toEqual(["accepted", "duplicate"]);
    expect(
      (await auditOf(s.workspaceId, "paddle.credentials_rewrapped")).map((e) => e.details.field),
    ).toEqual(["webhook_secret", "webhook_secret_next"]);
  });
});

describe("rewrap_credentials", () => {
  it("encodes and decodes its key", () => {
    expect(encodeRewrapKey(0)).toBe("rewrap:0");
    expect(encodeRewrapKey(12)).toBe("rewrap:12");
    expect(decodeRewrapKey("rewrap:0")).toEqual({ ok: true, value: 0 });
    expect(decodeRewrapKey("rewrap:999999")).toEqual({ ok: true, value: 999_999 });
    for (const key of ["rewrap:01", "rewrap:-1", "rewrap:1234567", "rewrap:", "x", " rewrap:1"]) {
      expect(decodeRewrapKey(key)).toEqual({ ok: false, error: "key_invalid" });
    }
  });

  /**
   * A shop whose envelopes are all under the rotation's old key: the API key, the webhook secret,
   * a rotation's next secret, and a pending claim request's email.
   */
  async function sealedUnderOldKey() {
    const keyring = rotation();
    const s = await paddleShop({ deps: { credentialKeys: keyring.before } });
    s.paddle.failNext("deleteNotificationSetting", "transient");
    await failure(rotate(s));
    const requested = await requestClaim(
      serviceContext(),
      {
        workspaceSlug: s.slug,
        email: `rewrap-${crypto.randomUUID()}@example.com`,
        user: await signedUpUser(),
        ip: buyerIp(),
      },
      s.deps,
    );
    expect(requested).toMatchObject({ outboxId: expect.any(String) });
    return { keyring, s };
  }

  /** Runs queued by earlier tests are done: a run's successor is queued once per key. */
  const settleRewrapRows = () =>
    env.DB.prepare(
      "UPDATE outbox SET sent_at = ? WHERE kind = 'rewrap_credentials' AND sent_at IS NULL",
    )
      .bind(clock.now())
      .run();

  const kidsOf = async (s: PaddleShop) => {
    const connection = await getPaddleConnection(db, { workspaceId: s.workspaceId });
    const request = await env.DB.prepare(
      "SELECT email_envelope FROM claim_requests WHERE workspace_id = ?",
    )
      .bind(s.workspaceId)
      .first<{ email_envelope: string }>();
    return [
      connection?.apiKeyEnvelope,
      connection?.webhookSecretEnvelope,
      connection?.webhookSecretNextEnvelope,
      request?.email_envelope,
    ].map((envelope) => JSON.parse(envelope as string).kid);
  };

  it("re-wraps every envelope under a retired key, so the old key can be removed", async () => {
    const { keyring, s } = await sealedUnderOldKey();
    const deps = { credentialKeys: keyring.during };
    expect(await queueCredentialRewrap(serviceContext(), deps)).toBe(true);
    const ctx = serviceContext();
    expect(await rewrapCredentials(ctx, 0, deps)).toEqual({
      rewrapped: 4,
      failed: 0,
      remaining: 0,
      continued: false,
    });
    expect(await kidsOf(s)).toEqual([keyring.newId, keyring.newId, keyring.newId, keyring.newId]);
    expect(
      (await listAuditEventsByCorrelationId(db, ctx.correlationId)).map((event) => [
        event.action,
        event.workspaceId,
        event.details,
      ]),
    ).toEqual([
      ["paddle.credentials_rewrapped", s.workspaceId, { field: "api_key" }],
      ["paddle.credentials_rewrapped", s.workspaceId, { field: "webhook_secret" }],
      ["paddle.credentials_rewrapped", s.workspaceId, { field: "webhook_secret_next" }],
      ["credentials.rewrapped", null, { rewrapped: 4, failed: 0, remaining: 0 }],
    ]);
    // Nothing is left to queue, and a redelivered run changes nothing.
    expect(await queueCredentialRewrap(serviceContext(), deps)).toBe(false);
    expect(await rewrapCredentials(serviceContext(), 0, deps)).toEqual({
      rewrapped: 0,
      failed: 0,
      remaining: 0,
      continued: false,
    });

    // The old key is removed: everything still opens.
    const after = withDeps(s, { credentialKeys: keyring.after });
    expect(await statusesOf(after, await deliveries(after))).toEqual(["accepted", "duplicate"]);
    expect(await rotate(after)).toMatchObject({ ok: true });
    const request = await env.DB.prepare(
      "SELECT id, email_envelope FROM claim_requests WHERE workspace_id = ?",
    )
      .bind(s.workspaceId)
      .first<{ id: string; email_envelope: string }>();
    const email = await openSecret({
      keyring: keyring.after,
      envelope: request?.email_envelope as string,
      aad: envelopeAad({
        workspaceId: s.workspaceId,
        rowId: request?.id as string,
        purpose: "email",
      }),
    });
    expect(email.plaintext).toMatch(/^rewrap-.+@example\.com$/);
    await drainPaddle(after);
  });

  it("works in bounded runs, queueing the next run while work remains", async () => {
    await settleRewrapRows();
    const { keyring, s } = await sealedUnderOldKey();
    // Enough pending claim requests that one run cannot do them all.
    const extra = REWRAP_BATCH;
    for (let i = 0; i < extra; i += 1) {
      const id = `clr-${crypto.randomUUID()}`;
      const envelope = await sealSecret({
        keyring: keyring.before,
        plaintext: `bulk-${i}@example.com`,
        aad: envelopeAad({ workspaceId: s.workspaceId, rowId: id, purpose: "email" }),
      });
      await env.DB.prepare(
        "INSERT INTO claim_requests (id, workspace_id, user_id, email_hash, email_envelope, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(id, s.workspaceId, s.userId, "a".repeat(64), envelope, clock.now())
        .run();
    }
    const deps = { credentialKeys: keyring.during };
    expect(await rewrapCredentials(serviceContext(), 0, deps)).toEqual({
      rewrapped: REWRAP_BATCH,
      failed: 0,
      remaining: 4,
      continued: true,
    });
    const next = await env.DB.prepare(
      "SELECT workspace_id FROM outbox WHERE kind = 'rewrap_credentials' AND subject_id = 'rewrap:1' AND sent_at IS NULL",
    ).all();
    expect(next.results).toEqual([{ workspace_id: null }]);
    // A redelivery of the same run queues no second successor.
    expect(await rewrapCredentials(serviceContext(), 0, deps)).toEqual({
      rewrapped: 4,
      failed: 0,
      remaining: 0,
      continued: false,
    });
    expect(await rewrapCredentials(serviceContext(), 1, deps)).toMatchObject({ rewrapped: 0 });
    expect(new Set(await kidsOf(s))).toEqual(new Set([keyring.newId]));
  });

  it("counts envelopes that do not open as failed, and ends the pass at the last envelope", async () => {
    await settleRewrapRows();
    const { keyring, s } = await sealedUnderOldKey();
    // An envelope copied to another row does not open there (it is bound to its row).
    const connection = await connectionOf(s);
    await env.DB.prepare("UPDATE claim_requests SET email_envelope = ? WHERE workspace_id = ?")
      .bind(connection.apiKeyEnvelope, s.workspaceId)
      .run();
    const deps = { credentialKeys: keyring.during };
    expect(await rewrapCredentials(serviceContext(), 0, deps)).toEqual({
      rewrapped: 3,
      failed: 1,
      remaining: 1,
      continued: false,
    });
    // The next pass (the daily check queues it while one remains) reports the failure again.
    expect(await queueCredentialRewrap(serviceContext(), deps)).toBe(true);
    expect(await rewrapCredentials(serviceContext(), 0, deps)).toEqual({
      rewrapped: 0,
      failed: 1,
      remaining: 1,
      continued: false,
    });
  });

  it("rotation/rewrap-progresses-past-unopenable-envelopes", async () => {
    await settleRewrapRows();
    const { keyring, s } = await sealedUnderOldKey();
    // A full batch of envelopes that never open, ordered before a good one: each is sealed for
    // another row, so it is bound to the wrong row.
    const insert = async (id: string, envelope: string) =>
      env.DB.prepare(
        "INSERT INTO claim_requests (id, workspace_id, user_id, email_hash, email_envelope, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(id, s.workspaceId, s.userId, "a".repeat(64), envelope, clock.now())
        .run();
    const seal = (rowId: string, plaintext: string) =>
      sealSecret({
        keyring: keyring.before,
        plaintext,
        aad: envelopeAad({ workspaceId: s.workspaceId, rowId, purpose: "email" }),
      });
    for (let i = 0; i < REWRAP_BATCH; i += 1) {
      const id = `aaa-${String(i).padStart(3, "0")}-${crypto.randomUUID()}`;
      await insert(id, await seal(`other-${id}`, `bad-${i}@example.com`));
    }
    const good = `zzz-${crypto.randomUUID()}`;
    await insert(good, await seal(good, "good@example.com"));
    const deps = { credentialKeys: keyring.during };

    // Before the fix every run read the same first 50 and stopped. Now the pass moves on.
    const runs: { rewrapped: number; failed: number; remaining: number; continued: boolean }[] = [];
    for (let generation = 0; generation < 5; generation += 1) {
      const run = await rewrapCredentials(serviceContext(), generation, deps);
      runs.push(run);
      if (!run.continued) break;
    }
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ continued: true });
    // Every envelope that opens moved: three Paddle envelopes, the pending request and `good`.
    expect(runs.reduce((sum, run) => sum + run.rewrapped, 0)).toBe(5);
    // Each bad envelope is reported once per pass, and they are all that remain.
    expect(runs.reduce((sum, run) => sum + run.failed, 0)).toBe(REWRAP_BATCH);
    expect(runs[1]).toMatchObject({ remaining: REWRAP_BATCH, continued: false });
    const moved = await env.DB.prepare("SELECT email_envelope FROM claim_requests WHERE id = ?")
      .bind(good)
      .first<{ email_envelope: string }>();
    expect(JSON.parse(moved?.email_envelope as string).kid).toBe(keyring.newId);
    // The Paddle envelopes moved too; only the bad emails stay under the old key.
    const connection = await connectionOf(s);
    expect(
      [
        connection.apiKeyEnvelope,
        connection.webhookSecretEnvelope,
        connection.webhookSecretNextEnvelope,
      ].map((envelope) => JSON.parse(envelope as string).kid),
    ).toEqual([keyring.newId, keyring.newId, keyring.newId]);
    const old = await env.DB.prepare(
      "SELECT count(*) AS n FROM claim_requests WHERE workspace_id = ? AND json_extract(email_envelope, '$.kid') = ?",
    )
      .bind(s.workspaceId, keyring.oldId)
      .first<{ n: number }>();
    expect(old?.n).toBe(REWRAP_BATCH);
    // The pass ended: its cursor is gone, so the next pass starts at the beginning again.
    const cursor = await env.DB.prepare("SELECT value FROM system_state WHERE key = ?")
      .bind("rewrap.cursor")
      .first();
    expect(cursor).toBeNull();
  });

  it("queues nothing without a retired key", async () => {
    const { keyring } = await sealedUnderOldKey();
    expect(await queueCredentialRewrap(serviceContext(), { credentialKeys: keyring.before })).toBe(
      false,
    );
    expect(
      await rewrapCredentials(serviceContext(), 0, { credentialKeys: keyring.before }),
    ).toEqual({ rewrapped: 0, failed: 0, remaining: 0, continued: false });
  });

  it("loses to a concurrent change of the same envelope", async () => {
    const { keyring, s } = await sealedUnderOldKey();
    const deps = { credentialKeys: keyring.during };
    // The claim request is handled (its email erased) and the API key replaced meanwhile.
    const ctx = beforeFirstBatch(async () => {
      await env.DB.prepare(
        "UPDATE claim_requests SET email_envelope = NULL, processed_at = ? WHERE workspace_id = ?",
      )
        .bind(clock.now(), s.workspaceId)
        .run();
      await env.DB.prepare("UPDATE paddle_connections SET api_key_envelope = ? WHERE id = ?")
        .bind(JSON.stringify({ v: 1, kid: keyring.newId }), s.connectionId)
        .run();
    });
    expect(await rewrapCredentials(ctx, 0, deps)).toEqual({
      rewrapped: 2,
      failed: 0,
      remaining: 0,
      continued: false,
    });
  });
});
