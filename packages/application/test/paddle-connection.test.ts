import { env } from "cloudflare:workers";
import { getPaddleConnection, listPaddlePrices } from "@sharerepo/db";
import { ForbiddenError, NotFoundError, openSecret } from "@sharerepo/platform";
import { describe, expect, it } from "vitest";
import {
  checkPaddleConnection,
  connectPaddle,
  disconnectPaddle,
  getBillingView,
  PADDLE_REQUIRED_PERMISSIONS,
  PADDLE_WEBHOOK_EVENTS,
  PaddleUnavailableError,
  reconnectPaddle,
  syncPaddleCatalog,
} from "../src/index.ts";
import { failingBatches, memberOf, shop } from "./support/commerce.ts";
import { clock, db, serviceContext, signedUpUser } from "./support/context.ts";
import {
  apiKey,
  auditOf,
  beforeFirstBatch,
  commerceDeps,
  connectionOf,
  KEYRING,
  PaddleAccounts,
  paddleShop,
  ROTATED,
  sellerId,
} from "./support/paddle.ts";

const DAY = 86_400_000;
const EXPIRES = () => clock.now() + 300 * DAY;

/** A workspace with GitHub connected and a Paddle seller account it has not connected yet. */
async function unconnected(options: Parameters<PaddleAccounts["seller"]>[0] = {}) {
  const s = await shop();
  const accounts = new PaddleAccounts();
  const { fake, key } = accounts.seller(options);
  return { s, accounts, fake, key, deps: commerceDeps(accounts) };
}

describe("connectPaddle", () => {
  it("identifies the seller, registers the destination, seals the secrets and imports the catalog", async () => {
    const { s, fake, key, deps } = await unconnected();
    const monthly = fake.addPrice();
    fake.addPrice({ billingCycle: null, description: "Lifetime" });
    const expiresOn = EXPIRES();
    const result = await connectPaddle(
      serviceContext(),
      s,
      s.slug,
      { apiKey: ` ${key} `, apiKeyExpiresOn: expiresOn },
      deps,
    );
    expect(result).toEqual({
      ok: true,
      connectionId: expect.any(String),
      catalog: { added: 2, updated: 0, archived: 0 },
    });
    if (!result.ok) return;
    const [setting] = fake.notificationSettings();
    expect(setting).toMatchObject({
      destination: `https://sharerepo.test/webhooks/paddle/${result.connectionId}`,
      events: [...PADDLE_WEBHOOK_EVENTS],
      active: true,
    });
    const row = await getPaddleConnection(db, { workspaceId: s.workspaceId });
    expect(row).toMatchObject({
      id: result.connectionId,
      environment: "sandbox",
      sellerName: "Acme Seller",
      credentialKind: "api_key",
      apiKeyExpiresOn: expiresOn,
      destinationId: setting?.id,
      status: "active",
      catalogSyncedAt: clock.now(),
    });
    // Envelopes, bound to the row: the plaintext is nowhere in the row.
    expect(JSON.stringify(row)).not.toContain(key);
    expect(JSON.stringify(row)).not.toContain(fake.secretOf(setting?.id as string));
    const opened = await openSecret({
      keyring: KEYRING,
      envelope: row?.apiKeyEnvelope as string,
      aad: `${s.workspaceId}:${result.connectionId}:api_key`,
    });
    expect(opened.plaintext).toBe(key);
    const prices = await listPaddlePrices(db, { workspaceId: s.workspaceId });
    expect(prices.map((p) => [p.priceId, p.billingInterval])).toEqual(
      expect.arrayContaining([
        [monthly.id, "month"],
        [expect.any(String), null],
      ]),
    );
    expect(await auditOf(s.workspaceId, "paddle.connected")).toEqual([
      expect.objectContaining({
        actor_type: "user",
        actor_id: s.userId,
        target_id: result.connectionId,
        details: { environment: "sandbox", sellerId: row?.sellerId },
      }),
    ]);
    expect(await auditOf(s.workspaceId, "paddle.catalog_synced")).toHaveLength(1);
  });

  it("accepts only live keys in production", async () => {
    const { s, accounts, fake } = await unconnected({ environment: "live" });
    const live = accounts.issue(fake, "live");
    const deps = commerceDeps(accounts, { deployment: "production" });
    const sandbox = await connectPaddle(
      serviceContext(),
      s,
      s.slug,
      { apiKey: accounts.issue(fake), apiKeyExpiresOn: null },
      deps,
    );
    expect(sandbox).toEqual({ ok: false, error: { reason: "environment_mismatch" } });
    const result = await connectPaddle(
      serviceContext(),
      s,
      s.slug,
      { apiKey: live, apiKeyExpiresOn: null },
      deps,
    );
    expect(result.ok).toBe(true);
    expect((await getPaddleConnection(db, { workspaceId: s.workspaceId }))?.environment).toBe(
      "live",
    );
  });

  it.each([
    ["not a key", "api_key_invalid"],
    ["a".repeat(50), "api_key_legacy"],
  ] as const)("refuses %j before calling Paddle", async (value, reason) => {
    const { s, fake, deps } = await unconnected();
    const result = await connectPaddle(
      serviceContext(),
      s,
      s.slug,
      { apiKey: value, apiKeyExpiresOn: null },
      deps,
    );
    expect(result).toEqual({ ok: false, error: { reason } });
    expect(fake.calls).toEqual([]);
  });

  it("refuses a key Paddle refuses, a seller in the other environment, and missing permissions", async () => {
    const revoked = await unconnected();
    revoked.fake.revokeKey();
    const live = await unconnected({ environment: "live" });
    const scoped = await unconnected({ permissions: ["price.read", "customer.read"] });
    const liveKeyInDevelopment = await connectPaddle(
      serviceContext(),
      live.s,
      live.s.slug,
      { apiKey: live.accounts.issue(live.fake, "live"), apiKeyExpiresOn: null },
      live.deps,
    );
    expect(liveKeyInDevelopment).toEqual({ ok: false, error: { reason: "environment_mismatch" } });
    for (const [world, error] of [
      [revoked, { reason: "key_refused" }],
      [live, { reason: "environment_mismatch" }],
      [
        scoped,
        {
          reason: "missing_permissions",
          missing: PADDLE_REQUIRED_PERMISSIONS.filter(
            (p) => p !== "price.read" && p !== "customer.read",
          ),
        },
      ],
    ] as const) {
      const result = await connectPaddle(
        serviceContext(),
        world.s,
        world.s.slug,
        { apiKey: world.key, apiKeyExpiresOn: null },
        world.deps,
      );
      expect(result).toEqual({ ok: false, error });
      expect(await getPaddleConnection(db, { workspaceId: world.s.workspaceId })).toBeNull();
      expect(world.fake.notificationSettings()).toEqual([]);
    }
  });

  it("propagates a transient failure of GET /, storing nothing", async () => {
    const { s, fake, key, deps } = await unconnected();
    fake.failNext("getApiRoot", "transient");
    await expect(
      connectPaddle(serviceContext(), s, s.slug, { apiKey: key, apiKeyExpiresOn: null }, deps),
    ).rejects.toMatchObject({ kind: "transient" });
    expect(await getPaddleConnection(db, { workspaceId: s.workspaceId })).toBeNull();
  });

  it("refuses a seller at the destination limit, storing nothing", async () => {
    const { s, fake, key, deps } = await unconnected();
    fake.addForeignDestinations(10);
    const result = await connectPaddle(
      serviceContext(),
      s,
      s.slug,
      { apiKey: key, apiKeyExpiresOn: null },
      deps,
    );
    expect(result).toEqual({ ok: false, error: { reason: "destination_limit" } });
    expect(await getPaddleConnection(db, { workspaceId: s.workspaceId })).toBeNull();
    expect(await auditOf(s.workspaceId, "paddle.connected")).toEqual([]);
  });

  it("propagates other destination failures", async () => {
    const { s, fake, key, deps } = await unconnected();
    fake.failNext("createNotificationSetting", "transient");
    await expect(
      connectPaddle(serviceContext(), s, s.slug, { apiKey: key, apiKeyExpiresOn: null }, deps),
    ).rejects.toMatchObject({ kind: "transient" });
  });

  it("deletes the new destination when storing the connection fails", async () => {
    const { s, fake, key, deps } = await unconnected();
    await expect(
      connectPaddle(failingBatches(), s, s.slug, { apiKey: key, apiKeyExpiresOn: null }, deps),
    ).rejects.toThrow("d1 down");
    expect(fake.notificationSettings()).toEqual([]);
    expect(await getPaddleConnection(db, { workspaceId: s.workspaceId })).toBeNull();
  });

  it("refuses a workspace that is already connected, also when a concurrent connect wins", async () => {
    const { s, fake, key, deps } = await unconnected();
    const first = await connectPaddle(
      serviceContext(),
      s,
      s.slug,
      { apiKey: key, apiKeyExpiresOn: null },
      deps,
    );
    expect(first.ok).toBe(true);
    const again = await connectPaddle(
      serviceContext(),
      s,
      s.slug,
      { apiKey: key, apiKeyExpiresOn: null },
      deps,
    );
    expect(again).toEqual({ ok: false, error: { reason: "already_connected" } });

    const racing = await unconnected();
    const ctx = beforeFirstBatch(() =>
      connectPaddle(
        serviceContext(),
        racing.s,
        racing.s.slug,
        { apiKey: racing.key, apiKeyExpiresOn: null },
        racing.deps,
      ),
    );
    const lost = await connectPaddle(
      ctx,
      racing.s,
      racing.s.slug,
      { apiKey: racing.key, apiKeyExpiresOn: null },
      racing.deps,
    );
    expect(lost).toEqual({ ok: false, error: { reason: "already_connected" } });
    // Only the winner's destination remains.
    expect(racing.fake.notificationSettings()).toHaveLength(1);
    expect(fake.notificationSettings()).toHaveLength(1);
  });

  it("keeps the connection when the catalog import fails", async () => {
    const { s, fake, key, deps } = await unconnected();
    fake.failNext("listPrices", "transient");
    const result = await connectPaddle(
      serviceContext(),
      s,
      s.slug,
      { apiKey: key, apiKeyExpiresOn: null },
      deps,
    );
    expect(result).toEqual({ ok: true, connectionId: expect.any(String), catalog: null });
    expect((await getPaddleConnection(db, { workspaceId: s.workspaceId }))?.catalogSyncedAt).toBe(
      null,
    );
  });

  it("is for owners only", async () => {
    const { s, key, deps } = await unconnected();
    const member = await memberOf(s);
    await expect(
      connectPaddle(serviceContext(), member, s.slug, { apiKey: key, apiKeyExpiresOn: null }, deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("reconnectPaddle", () => {
  it("replaces the key for the same seller and makes the connection active again", async () => {
    const s = await paddleShop();
    s.paddle.revokeKey();
    expect(await checkPaddleConnection(serviceContext(), ref(s), s.deps)).toBe("unauthorized");
    s.paddle.restoreKey();
    const fresh = s.accounts.issue(s.paddle);
    const before = await connectionOf(s);
    const result = await reconnectPaddle(
      serviceContext(),
      s,
      s.slug,
      { apiKey: fresh, apiKeyExpiresOn: null },
      s.deps,
    );
    expect(result).toEqual({ ok: true, destinationRecreated: false });
    const after = await connectionOf(s);
    expect(after).toMatchObject({
      status: "active",
      statusReason: null,
      destinationId: before.destinationId,
      webhookSecretEnvelope: before.webhookSecretEnvelope,
      apiKeyExpiresOn: null,
    });
    expect(after.apiKeyEnvelope).not.toBe(before.apiKeyEnvelope);
    expect(await auditOf(s.workspaceId, "paddle.reconnected")).toEqual([
      expect.objectContaining({
        actor_id: s.userId,
        details: {
          sellerId: before.sellerId,
          previousStatus: "unauthorized",
          destinationRecreated: false,
        },
      }),
    ]);
  });

  it("creates the destination again when it was deleted outside ShareRepo", async () => {
    const s = await paddleShop();
    const before = await connectionOf(s);
    await s.paddle.deleteNotificationSetting(before.destinationId as string);
    const result = await reconnectPaddle(
      serviceContext(),
      s,
      s.slug,
      { apiKey: s.accounts.issue(s.paddle), apiKeyExpiresOn: null },
      s.deps,
    );
    expect(result).toEqual({ ok: true, destinationRecreated: true });
    const after = await connectionOf(s);
    expect(after.destinationId).not.toBe(before.destinationId);
    expect(after.webhookSecretEnvelope).not.toBe(before.webhookSecretEnvelope);
    expect(s.paddle.notificationSettings().map((n) => n.id)).toEqual([after.destinationId]);
  });

  it("refuses another seller, a bad key, a missing connection and the destination limit", async () => {
    const s = await paddleShop();
    const other = s.accounts.seller();
    const call = (value: string, owner = s, slug = s.slug) =>
      reconnectPaddle(
        serviceContext(),
        owner,
        slug,
        { apiKey: value, apiKeyExpiresOn: null },
        s.deps,
      );
    expect(await call(other.key)).toEqual({ ok: false, error: { reason: "seller_mismatch" } });
    expect(await call("nope")).toEqual({ ok: false, error: { reason: "api_key_invalid" } });
    const bare = await shop();
    expect(await call(other.key, bare as never, bare.slug)).toEqual({
      ok: false,
      error: { reason: "not_connected" },
    });

    await s.paddle.deleteNotificationSetting((await connectionOf(s)).destinationId as string);
    s.paddle.addForeignDestinations(10);
    expect(await call(s.accounts.issue(s.paddle))).toEqual({
      ok: false,
      error: { reason: "destination_limit" },
    });
    expect(await auditOf(s.workspaceId, "paddle.reconnected")).toEqual([]);
  });

  it("propagates a failure to read the destination", async () => {
    const s = await paddleShop();
    s.paddle.failNext("getNotificationSetting", "transient");
    await expect(
      reconnectPaddle(
        serviceContext(),
        s,
        s.slug,
        { apiKey: s.accounts.issue(s.paddle), apiKeyExpiresOn: null },
        s.deps,
      ),
    ).rejects.toMatchObject({ kind: "transient" });
  });

  it("deletes a recreated destination when the connection was disconnected meanwhile", async () => {
    const s = await paddleShop();
    await s.paddle.deleteNotificationSetting((await connectionOf(s)).destinationId as string);
    const ctx = beforeFirstBatch(() => disconnectPaddle(serviceContext(), s, s.slug, s.deps));
    const result = await reconnectPaddle(
      ctx,
      s,
      s.slug,
      { apiKey: s.accounts.issue(s.paddle), apiKeyExpiresOn: null },
      s.deps,
    );
    expect(result).toEqual({ ok: false, error: { reason: "not_connected" } });
    expect(s.paddle.notificationSettings()).toEqual([]);
  });

  it("reports a concurrent disconnect when the destination stood", async () => {
    const s = await paddleShop();
    const ctx = beforeFirstBatch(() => disconnectPaddle(serviceContext(), s, s.slug, s.deps));
    const result = await reconnectPaddle(
      ctx,
      s,
      s.slug,
      { apiKey: s.accounts.issue(s.paddle), apiKeyExpiresOn: null },
      s.deps,
    );
    expect(result).toEqual({ ok: false, error: { reason: "not_connected" } });
  });
});

const ref = (s: { workspaceId: string; connectionId: string }) => ({
  workspaceId: s.workspaceId,
  connectionId: s.connectionId,
});

describe("disconnectPaddle", () => {
  it("deletes the destination, erases the credentials and keeps the row as history", async () => {
    const s = await paddleShop();
    const before = await connectionOf(s);
    const result = await disconnectPaddle(serviceContext(), s, s.slug, s.deps);
    expect(result).toEqual({
      ok: true,
      destinationDeleted: true,
      destinationId: before.destinationId,
    });
    expect(s.paddle.notificationSettings()).toEqual([]);
    expect(await getPaddleConnection(db, { workspaceId: s.workspaceId })).toBeNull();
    const row = await env.DB.prepare(
      "SELECT status, api_key_envelope, webhook_secret_envelope, destination_id FROM paddle_connections WHERE id = ?",
    )
      .bind(s.connectionId)
      .first();
    expect(row).toEqual({
      status: "disconnected",
      api_key_envelope: null,
      webhook_secret_envelope: null,
      destination_id: null,
    });
    expect(await auditOf(s.workspaceId, "paddle.disconnected")).toEqual([
      expect.objectContaining({
        details: { previousStatus: "active", destinationDeleted: true },
      }),
    ]);
    expect(await disconnectPaddle(serviceContext(), s, s.slug, s.deps)).toEqual({
      ok: false,
      reason: "not_connected",
    });
  });

  it("keeps the destination ID for the creator when Paddle cannot be asked", async () => {
    const s = await paddleShop();
    s.paddle.revokeKey();
    const { destinationId } = await connectionOf(s);
    expect(await disconnectPaddle(serviceContext(), s, s.slug, s.deps)).toEqual({
      ok: true,
      destinationDeleted: false,
      destinationId,
    });
    const row = await env.DB.prepare("SELECT destination_id FROM paddle_connections WHERE id = ?")
      .bind(s.connectionId)
      .first();
    expect(row).toEqual({ destination_id: destinationId });

    // An unreadable key (a lost master key) is the same: Paddle cannot be asked.
    const t = await paddleShop();
    const lost = { ...t.deps, credentialKeys: { current: "k9", keys: { k9: new Uint8Array(32) } } };
    expect(await disconnectPaddle(serviceContext(), t, t.slug, lost)).toMatchObject({
      ok: true,
      destinationDeleted: false,
    });
  });

  it("reports a concurrent disconnect", async () => {
    const s = await paddleShop();
    const ctx = beforeFirstBatch(() =>
      env.DB.prepare(
        "UPDATE paddle_connections SET status = 'disconnected', api_key_envelope = NULL, webhook_secret_envelope = NULL WHERE id = ?",
      )
        .bind(s.connectionId)
        .run(),
    );
    expect(await disconnectPaddle(ctx, s, s.slug, s.deps)).toEqual({
      ok: false,
      reason: "not_connected",
    });
  });
});

describe("checkPaddleConnection", () => {
  it("records a successful probe without an audit event", async () => {
    const s = await paddleShop();
    clock.advance(60_000);
    expect(await checkPaddleConnection(serviceContext(), ref(s), s.deps)).toBe("active");
    expect((await connectionOf(s)).lastCheckedAt).toBe(clock.now());
    expect(await auditOf(s.workspaceId, "paddle.status_changed")).toEqual([]);
  });

  it("marks a refused key unauthorized and a restored one active, audited", async () => {
    const s = await paddleShop();
    s.paddle.revokeKey();
    expect(await checkPaddleConnection(serviceContext(), ref(s), s.deps)).toBe("unauthorized");
    expect(await connectionOf(s)).toMatchObject({
      status: "unauthorized",
      statusReason: "key_refused",
    });
    expect(await checkPaddleConnection(serviceContext(), ref(s), s.deps)).toBe("unauthorized");
    s.paddle.restoreKey();
    expect(await checkPaddleConnection(serviceContext(), ref(s), s.deps)).toBe("active");
    expect(await auditOf(s.workspaceId, "paddle.status_changed")).toEqual([
      expect.objectContaining({
        actor_type: "system",
        reason: "key_refused",
        details: { previousStatus: "active", status: "unauthorized" },
      }),
      expect.objectContaining({
        reason: null,
        details: { previousStatus: "unauthorized", status: "active" },
      }),
    ]);
  });

  it("marks a key of another seller, or without a permission, unauthorized", async () => {
    const s = await paddleShop();
    s.paddle.setPermissions(["price.read"]);
    await checkPaddleConnection(serviceContext(), ref(s), s.deps);
    expect((await connectionOf(s)).statusReason).toBe("permissions_missing");

    const t = await paddleShop();
    await env.DB.prepare("UPDATE paddle_connections SET seller_id = ? WHERE id = ?")
      .bind(sellerId(), t.connectionId)
      .run();
    await checkPaddleConnection(serviceContext(), ref(t), t.deps);
    expect((await connectionOf(t)).statusReason).toBe("seller_changed");
  });

  it("changes nothing on a transient failure, and ignores another connection", async () => {
    const s = await paddleShop();
    s.paddle.failNext("getApiRoot", "transient");
    await expect(checkPaddleConnection(serviceContext(), ref(s), s.deps)).rejects.toMatchObject({
      kind: "transient",
    });
    expect((await connectionOf(s)).status).toBe("active");
    expect(
      await checkPaddleConnection(
        serviceContext(),
        { workspaceId: s.workspaceId, connectionId: "other" },
        s.deps,
      ),
    ).toBe("not_connected");
  });

  it("credential/envelope-bound-to-row: re-wraps envelopes under a rotated master key once, audited", async () => {
    const s = await paddleShop();
    const rotated = { ...s.deps, credentialKeys: ROTATED };
    const before = await connectionOf(s);
    await checkPaddleConnection(serviceContext(), ref(s), rotated);
    const after = await connectionOf(s);
    expect(JSON.parse(after.apiKeyEnvelope as string).kid).toBe("k2");
    expect(after.webhookSecretEnvelope).toBe(before.webhookSecretEnvelope);
    await checkPaddleConnection(serviceContext(), ref(s), rotated);
    expect((await connectionOf(s)).apiKeyEnvelope).toBe(after.apiKeyEnvelope);
    expect(await auditOf(s.workspaceId, "paddle.credentials_rewrapped")).toEqual([
      expect.objectContaining({ actor_type: "system", details: { field: "api_key" } }),
    ]);
  });
});

describe("syncPaddleCatalog", () => {
  it("adds, updates and archives prices, keeping the ones Paddle no longer lists", async () => {
    const s = await paddleShop();
    const added = s.paddle.addPrice();
    s.paddle.addPrice({ ...s.price, unitAmount: "2500" });
    const result = await syncPaddleCatalog(serviceContext(), s, s.slug, s.deps);
    expect(result).toEqual({ ok: true, summary: { added: 1, updated: 1, archived: 0 } });
    s.paddle.archivePrice(added.id);
    expect(await syncPaddleCatalog(serviceContext(), s, s.slug, s.deps)).toEqual({
      ok: true,
      summary: { added: 0, updated: 0, archived: 1 },
    });
    expect(await syncPaddleCatalog(serviceContext(), s, s.slug, s.deps)).toEqual({
      ok: true,
      summary: { added: 0, updated: 0, archived: 0 },
    });
    const prices = await listPaddlePrices(db, { workspaceId: s.workspaceId });
    expect(prices.find((p) => p.priceId === s.price.id)?.unitAmount).toBe("2500");
    expect(prices.find((p) => p.priceId === added.id)?.status).toBe("archived");
    expect(
      (await auditOf(s.workspaceId, "paddle.catalog_synced")).map((event) => event.details),
    ).toEqual([
      { added: 1, updated: 0, archived: 0 },
      { added: 1, updated: 1, archived: 0 },
      { added: 0, updated: 0, archived: 1 },
      { added: 0, updated: 0, archived: 0 },
    ]);
  });

  it("refuses without a connection and when the connection goes meanwhile", async () => {
    const bare = await shop();
    const accounts = new PaddleAccounts();
    expect(
      await syncPaddleCatalog(serviceContext(), bare, bare.slug, commerceDeps(accounts)),
    ).toEqual({ ok: false, reason: "not_connected" });
    const s = await paddleShop();
    const ctx = beforeFirstBatch(() => disconnectPaddle(serviceContext(), s, s.slug, s.deps));
    expect(await syncPaddleCatalog(ctx, s, s.slug, s.deps)).toEqual({
      ok: false,
      reason: "not_connected",
    });
  });

  it("marks the connection unauthorized when Paddle refuses the key", async () => {
    const s = await paddleShop();
    s.paddle.revokeKey();
    await expect(syncPaddleCatalog(serviceContext(), s, s.slug, s.deps)).rejects.toBeInstanceOf(
      PaddleUnavailableError,
    );
    expect((await connectionOf(s)).status).toBe("unauthorized");
    // Already unauthorized: a second refusal changes and audits nothing more.
    await expect(syncPaddleCatalog(serviceContext(), s, s.slug, s.deps)).rejects.toMatchObject({
      code: "source_unavailable",
    });
    expect(await auditOf(s.workspaceId, "paddle.status_changed")).toHaveLength(1);
  });
});

describe("getBillingView", () => {
  it("shows the connection, a key expiry warning from 14 days before, and the catalog", async () => {
    const s = await paddleShop();
    const row = await connectionOf(s);
    const view = await getBillingView(serviceContext(), s, s.slug);
    expect(view).toEqual({
      connection: {
        id: s.connectionId,
        status: "active",
        statusReason: null,
        environment: "sandbox",
        sellerId: row.sellerId,
        sellerName: "Acme Seller",
        apiKeyExpiresOn: row.apiKeyExpiresOn,
        keyExpiresSoon: false,
        destinationId: row.destinationId,
        lastEventAt: null,
        lastCheckedAt: row.lastCheckedAt,
        catalogSyncedAt: row.catalogSyncedAt,
        connectedAt: row.createdAt,
      },
      prices: [expect.objectContaining({ priceId: s.price.id, billingInterval: "month" })],
    });
    clock.set((row.apiKeyExpiresOn as number) - 14 * DAY);
    expect((await getBillingView(serviceContext(), s, s.slug)).connection?.keyExpiresSoon).toBe(
      true,
    );
    await reconnectPaddle(
      serviceContext(),
      s,
      s.slug,
      { apiKey: s.accounts.issue(s.paddle), apiKeyExpiresOn: null },
      s.deps,
    );
    expect((await getBillingView(serviceContext(), s, s.slug)).connection?.keyExpiresSoon).toBe(
      false,
    );
  });

  it("shows no connection, and is for owners only", async () => {
    const bare = await shop();
    expect(await getBillingView(serviceContext(), bare, bare.slug)).toEqual({
      connection: null,
      prices: [],
    });
    const member = await memberOf(bare);
    await expect(getBillingView(serviceContext(), member, bare.slug)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("isolation/cross-workspace-mutation-denied (Paddle connections)", () => {
  it("another tenant's owner cannot connect, reconnect, sync, view or disconnect", async () => {
    const s = await paddleShop();
    const bob = await signedUpUser();
    const deps = s.deps;
    const attempts = [
      () =>
        connectPaddle(
          serviceContext(),
          bob,
          s.slug,
          { apiKey: apiKey(), apiKeyExpiresOn: null },
          deps,
        ),
      () =>
        reconnectPaddle(
          serviceContext(),
          bob,
          s.slug,
          { apiKey: s.key, apiKeyExpiresOn: null },
          deps,
        ),
      () => syncPaddleCatalog(serviceContext(), bob, s.slug, deps),
      () => getBillingView(serviceContext(), bob, s.slug),
      () => disconnectPaddle(serviceContext(), bob, s.slug, deps),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
    }
    expect((await connectionOf(s)).status).toBe("active");
    // A probe or sweep scoped to another workspace never reaches this connection.
    expect(
      await checkPaddleConnection(
        serviceContext(),
        { workspaceId: (await shop()).workspaceId, connectionId: s.connectionId },
        deps,
      ),
    ).toBe("not_connected");
  });
});
