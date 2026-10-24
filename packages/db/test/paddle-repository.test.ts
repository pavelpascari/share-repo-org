import { env } from "cloudflare:workers";
import { type CredentialKeyring, envelopeAad, openSecret, sealSecret } from "@sharerepo/platform";
import { describe, expect, it } from "vitest";
import {
  createPaddleConnection,
  disconnectPaddleConnection,
  getPaddleConnection,
  getPaddleConnectionForWebhook,
  listActivePaddleConnections,
  listPaddlePrices,
  markPaddleEventReceived,
  type PaddleConnection,
  type PaddlePriceImport,
  recordPaddleConnectionChecked,
  replacePaddleCredentials,
  rewrapPaddleEnvelope,
  updatePaddleConnectionStatus,
  upsertPaddlePrices,
} from "../src/index.ts";
import { auditCount, workspaceEvent } from "./support/audit.ts";
import { count, db, workspaceWithOwner } from "./support/connections.ts";
import { ENVELOPE, paddleConnectionRow } from "./support/paddle.ts";
import { T0, uniqueId } from "./support/rows.ts";

const NOW = T0 + 60_000;

function connectionRow(
  workspaceId: string,
  overrides: Partial<PaddleConnection> = {},
): PaddleConnection {
  return {
    lastEventAt: null,
    lastCheckedAt: null,
    catalogSyncedAt: null,
    ...paddleConnectionRow(workspaceId),
    ...overrides,
  } as PaddleConnection;
}

async function connected(overrides: Partial<PaddleConnection> = {}) {
  const { workspaceId, userId } = await workspaceWithOwner();
  const connection = connectionRow(workspaceId, overrides);
  const event = workspaceEvent(workspaceId);
  expect(await createPaddleConnection(db, connection, [event])).toEqual({ ok: true });
  return { workspaceId, userId, connection, event };
}

const key = (c: { workspaceId: string; id: string }) => ({
  workspaceId: c.workspaceId,
  connectionId: c.id,
});

function priceImport(overrides: Partial<PaddlePriceImport> = {}): PaddlePriceImport {
  return {
    id: uniqueId("ppr"),
    priceId: uniqueId("pri"),
    productId: "pro_01",
    productName: "Pro",
    description: null,
    billingInterval: "month",
    billingFrequency: 1,
    unitAmount: "1000",
    currency: "USD",
    status: "active",
    ...overrides,
  };
}

describe("Paddle connections", () => {
  it("creates one with its audit event and reads it back", async () => {
    const { workspaceId, connection, event } = await connected();
    expect(await getPaddleConnection(db, { workspaceId })).toEqual(connection);
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
    expect(await getPaddleConnectionForWebhook(db, connection.id)).toEqual({
      id: connection.id,
      workspaceId,
      status: "active",
      webhookSecretEnvelope: connection.webhookSecretEnvelope,
    });
    expect(await getPaddleConnectionForWebhook(db, uniqueId("pdc"))).toBeNull();
  });

  it("refuses a second live connection in the workspace, writing nothing", async () => {
    const { workspaceId } = await connected();
    const event = workspaceEvent(workspaceId);
    const second = connectionRow(workspaceId);
    expect(await createPaddleConnection(db, second, [event])).toEqual({
      ok: false,
      reason: "already_connected",
    });
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
    expect(await count("paddle_connections", "id = ?", second.id)).toBe(0);
  });

  it("propagates other constraint failures", async () => {
    const { workspaceId } = await workspaceWithOwner();
    await expect(
      createPaddleConnection(db, connectionRow(workspaceId, { sellerId: "" }), [
        workspaceEvent(workspaceId),
      ]),
    ).rejects.toThrow();
  });

  it("isolation/cross-workspace-read-denied: reads never cross workspaces", async () => {
    const { connection } = await connected();
    const other = await workspaceWithOwner();
    expect(await getPaddleConnection(db, { workspaceId: other.workspaceId })).toBeNull();
    const event = workspaceEvent(other.workspaceId);
    const wrong = { workspaceId: other.workspaceId, connectionId: connection.id };
    expect(
      await updatePaddleConnectionStatus(
        db,
        {
          ...wrong,
          expectedStatus: "active",
          status: "unauthorized",
          statusReason: "forbidden",
          now: NOW,
        },
        [event],
      ),
    ).toEqual({ ok: false, reason: "stale" });
    expect(
      await disconnectPaddleConnection(db, { ...wrong, destinationId: null, now: NOW }, [event]),
    ).toEqual({ ok: false, reason: "stale" });
    expect(
      await upsertPaddlePrices(db, { ...wrong, prices: [priceImport()], now: NOW }, [event]),
    ).toEqual({ ok: false, reason: "stale" });
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
    expect(await count("paddle_prices", "workspace_id = ?", other.workspaceId)).toBe(0);
  });

  it("moves status only from the expected status, auditing once", async () => {
    const { connection } = await connected();
    const change = {
      ...key(connection),
      expectedStatus: "active" as const,
      status: "unauthorized" as const,
      statusReason: "forbidden",
      now: NOW,
    };
    const first = workspaceEvent(connection.workspaceId);
    const second = workspaceEvent(connection.workspaceId);
    expect(await updatePaddleConnectionStatus(db, change, [first])).toEqual({ ok: true });
    expect(await updatePaddleConnectionStatus(db, change, [second])).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(await auditCount(env.DB, first.correlationId)).toBe(1);
    expect(await auditCount(env.DB, second.correlationId)).toBe(0);
    expect(await getPaddleConnection(db, connection)).toMatchObject({
      status: "unauthorized",
      statusReason: "forbidden",
      lastCheckedAt: NOW,
      updatedAt: NOW,
    });
    expect(await listActivePaddleConnections(db)).not.toContainEqual({
      workspaceId: connection.workspaceId,
      id: connection.id,
    });
  });

  it("lists active connections for the sweep", async () => {
    const { connection } = await connected();
    expect(await listActivePaddleConnections(db)).toContainEqual({
      workspaceId: connection.workspaceId,
      id: connection.id,
    });
  });

  it("records checks and received events as bookkeeping, never backwards", async () => {
    const { connection } = await connected();
    await recordPaddleConnectionChecked(db, { ...key(connection), now: NOW });
    await markPaddleEventReceived(db, { ...key(connection), now: NOW + 10 });
    await markPaddleEventReceived(db, { ...key(connection), now: NOW + 5 });
    expect(await getPaddleConnection(db, connection)).toMatchObject({
      lastCheckedAt: NOW,
      lastEventAt: NOW + 10,
      updatedAt: connection.updatedAt,
    });
  });

  it("reconnects with a new key for the same seller only", async () => {
    const { connection } = await connected();
    await updatePaddleConnectionStatus(
      db,
      {
        ...key(connection),
        expectedStatus: "active",
        status: "unauthorized",
        statusReason: "forbidden",
        now: NOW,
      },
      [workspaceEvent(connection.workspaceId)],
    );
    const input = {
      ...key(connection),
      sellerId: connection.sellerId,
      sellerName: "Acme Ltd",
      apiKeyEnvelope: JSON.stringify({ v: 1, replaced: true }),
      apiKeyExpiresOn: T0 + 1000,
      now: NOW + 1,
    };
    const otherSeller = workspaceEvent(connection.workspaceId);
    expect(
      await replacePaddleCredentials(db, { ...input, sellerId: "slr_other" }, [otherSeller]),
    ).toEqual({ ok: false, reason: "stale" });
    expect(await auditCount(env.DB, otherSeller.correlationId)).toBe(0);

    const event = workspaceEvent(connection.workspaceId);
    expect(await replacePaddleCredentials(db, input, [event])).toEqual({ ok: true });
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
    expect(await getPaddleConnection(db, connection)).toMatchObject({
      status: "active",
      statusReason: null,
      sellerName: "Acme Ltd",
      apiKeyEnvelope: input.apiKeyEnvelope,
      apiKeyExpiresOn: T0 + 1000,
      destinationId: connection.destinationId,
      webhookSecretEnvelope: connection.webhookSecretEnvelope,
    });

    const destination = { id: uniqueId("ntfset"), webhookSecretEnvelope: '{"v":1,"new":1}' };
    expect(
      await replacePaddleCredentials(db, { ...input, destination }, [
        workspaceEvent(connection.workspaceId),
      ]),
    ).toEqual({ ok: true });
    expect(await getPaddleConnection(db, connection)).toMatchObject({
      destinationId: destination.id,
      webhookSecretEnvelope: destination.webhookSecretEnvelope,
    });
  });

  it("disconnects once, erasing the credentials and keeping what the creator must delete", async () => {
    const { connection } = await connected();
    const event = workspaceEvent(connection.workspaceId);
    const input = { ...key(connection), destinationId: connection.destinationId, now: NOW };
    expect(await disconnectPaddleConnection(db, input, [event])).toEqual({ ok: true });
    expect(await disconnectPaddleConnection(db, input, [workspaceEvent("x")])).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
    expect(await getPaddleConnection(db, connection)).toBeNull();
    expect(await getPaddleConnectionForWebhook(db, connection.id)).toEqual({
      id: connection.id,
      workspaceId: connection.workspaceId,
      status: "disconnected",
      webhookSecretEnvelope: null,
    });
    const row = await env.DB.prepare(
      "SELECT api_key_envelope, webhook_secret_envelope, destination_id FROM paddle_connections WHERE id = ?",
    )
      .bind(connection.id)
      .first();
    expect(row).toEqual({
      api_key_envelope: null,
      webhook_secret_envelope: null,
      destination_id: connection.destinationId,
    });
    // Bookkeeping skips a disconnected connection, and a new one can be created.
    await markPaddleEventReceived(db, { ...key(connection), now: NOW + 1 });
    expect(
      await count("paddle_connections", "id = ? AND last_event_at IS NULL", connection.id),
    ).toBe(1);
    const next = connectionRow(connection.workspaceId);
    expect(
      await createPaddleConnection(db, next, [workspaceEvent(connection.workspaceId)]),
    ).toEqual({ ok: true });
  });

  it("forgets the destination once it was deleted in Paddle", async () => {
    const { connection } = await connected();
    await disconnectPaddleConnection(db, { ...key(connection), destinationId: null, now: NOW }, [
      workspaceEvent(connection.workspaceId),
    ]);
    expect(
      await count("paddle_connections", "id = ? AND destination_id IS NULL", connection.id),
    ).toBe(1);
  });
});

describe("credential/envelope-bound-to-row (database)", () => {
  const k = (fill: number) => new Uint8Array(32).fill(fill);
  const OLD: CredentialKeyring = { current: "k1", keys: { k1: k(1) } };
  const ROTATED: CredentialKeyring = { current: "k2", keys: { k1: k(1), k2: k(2) } };
  const API_KEY = `pdl_sdbx_apikey_${crypto.randomUUID().replaceAll("-", "")}`;
  const WEBHOOK_SECRET = `pdl_ntfset_${crypto.randomUUID().replaceAll("-", "")}`;

  async function sealedConnection() {
    const { workspaceId } = await workspaceWithOwner();
    const id = uniqueId("pdc");
    const aad = (purpose: "api_key" | "webhook_secret") =>
      envelopeAad({ workspaceId, rowId: id, purpose });
    const connection = connectionRow(workspaceId, {
      id,
      apiKeyEnvelope: await sealSecret({ keyring: OLD, plaintext: API_KEY, aad: aad("api_key") }),
      webhookSecretEnvelope: await sealSecret({
        keyring: OLD,
        plaintext: WEBHOOK_SECRET,
        aad: aad("webhook_secret"),
      }),
    });
    await createPaddleConnection(db, connection, [workspaceEvent(workspaceId)]);
    return { connection, aad };
  }

  it("credential/envelope-bound-to-row: stored envelopes round-trip with their row's AAD", async () => {
    const { connection, aad } = await sealedConnection();
    const stored = (await getPaddleConnection(db, connection)) as PaddleConnection;
    expect(stored.apiKeyEnvelope).not.toContain(API_KEY);
    expect(
      await openSecret({
        keyring: OLD,
        envelope: stored.apiKeyEnvelope as string,
        aad: aad("api_key"),
      }),
    ).toEqual({ plaintext: API_KEY, needsRewrap: false });
    const webhook = await getPaddleConnectionForWebhook(db, connection.id);
    expect(
      (
        await openSecret({
          keyring: OLD,
          envelope: webhook?.webhookSecretEnvelope as string,
          aad: aad("webhook_secret"),
        })
      ).plaintext,
    ).toBe(WEBHOOK_SECRET);
  });

  it("credential/envelope-bound-to-row: an envelope copied to another tenant's row does not open", async () => {
    const victim = await sealedConnection();
    const attacker = await sealedConnection();
    // Copy the victim's stored key envelope onto the attacker's row, as a defect or an insider
    // with database access could.
    await env.DB.prepare("UPDATE paddle_connections SET api_key_envelope = ? WHERE id = ?")
      .bind(victim.connection.apiKeyEnvelope, attacker.connection.id)
      .run();
    const stored = (await getPaddleConnection(db, attacker.connection)) as PaddleConnection;
    await expect(
      openSecret({
        keyring: OLD,
        envelope: stored.apiKeyEnvelope as string,
        aad: attacker.aad("api_key"),
      }),
    ).rejects.toMatchObject({ reason: "decrypt_failed" });
    // Nor does the key envelope open as the row's webhook secret.
    await expect(
      openSecret({
        keyring: OLD,
        envelope: victim.connection.apiKeyEnvelope as string,
        aad: victim.aad("webhook_secret"),
      }),
    ).rejects.toMatchObject({ reason: "decrypt_failed" });
  });

  it("credential/envelope-bound-to-row: rotation re-wraps once, guarded on the old envelope", async () => {
    const { connection, aad } = await sealedConnection();
    const previous = connection.apiKeyEnvelope as string;
    const opened = await openSecret({ keyring: ROTATED, envelope: previous, aad: aad("api_key") });
    expect(opened.needsRewrap).toBe(true);
    const next = await sealSecret({
      keyring: ROTATED,
      plaintext: opened.plaintext,
      aad: aad("api_key"),
    });
    const rewrap = { ...key(connection), field: "api_key" as const, previous, next };
    expect(await rewrapPaddleEnvelope(db, rewrap)).toEqual({ ok: true });
    expect(await rewrapPaddleEnvelope(db, rewrap)).toEqual({ ok: false, reason: "stale" });
    const stored = (await getPaddleConnection(db, connection)) as PaddleConnection;
    expect(stored.apiKeyEnvelope).toBe(next);
    expect(await openSecret({ keyring: ROTATED, envelope: next, aad: aad("api_key") })).toEqual({
      plaintext: API_KEY,
      needsRewrap: false,
    });

    const webhookPrevious = connection.webhookSecretEnvelope as string;
    const webhookNext = await sealSecret({
      keyring: ROTATED,
      plaintext: WEBHOOK_SECRET,
      aad: aad("webhook_secret"),
    });
    expect(
      await rewrapPaddleEnvelope(db, {
        ...key(connection),
        field: "webhook_secret",
        previous: webhookPrevious,
        next: webhookNext,
      }),
    ).toEqual({ ok: true });
    expect((await getPaddleConnection(db, connection))?.webhookSecretEnvelope).toBe(webhookNext);
  });
});

describe("Paddle prices", () => {
  it("imports, updates by price ID, keeps absent prices, and audits the sync", async () => {
    const { connection } = await connected();
    const monthly = priceImport({ productName: "Pro", priceId: "pri_b" });
    const once = priceImport({
      productName: "Pro",
      priceId: "pri_a",
      billingInterval: null,
      billingFrequency: null,
    });
    const archived = priceImport({ productName: "Basic", status: "archived" });
    const event = workspaceEvent(connection.workspaceId);
    expect(
      await upsertPaddlePrices(
        db,
        { ...key(connection), prices: [monthly, once, archived], now: NOW },
        [event],
      ),
    ).toEqual({ ok: true });
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);

    const all = await listPaddlePrices(db, { workspaceId: connection.workspaceId });
    expect(all.map((p) => p.priceId)).toEqual([archived.priceId, "pri_a", "pri_b"]);
    expect(all[0]).toMatchObject({ connectionId: connection.id, syncedAt: NOW });
    expect(
      (
        await listPaddlePrices(db, {
          workspaceId: connection.workspaceId,
          activeRecurringOnly: true,
        })
      ).map((p) => p.priceId),
    ).toEqual(["pri_b"]);

    // A later sync updates a known price in place and leaves the others as they were.
    const renamed = { ...monthly, id: uniqueId("ppr"), productName: "Pro+", unitAmount: "1200" };
    await upsertPaddlePrices(db, { ...key(connection), prices: [renamed], now: NOW + 1 }, [
      workspaceEvent(connection.workspaceId),
    ]);
    const after = await listPaddlePrices(db, { workspaceId: connection.workspaceId });
    expect(after).toHaveLength(3);
    expect(after.find((p) => p.priceId === "pri_b")).toMatchObject({
      id: monthly.id,
      productName: "Pro+",
      unitAmount: "1200",
      syncedAt: NOW + 1,
    });
    expect(after.find((p) => p.priceId === "pri_a")?.syncedAt).toBe(NOW);
    expect((await getPaddleConnection(db, connection))?.catalogSyncedAt).toBe(NOW + 1);
  });

  it("imports nothing into a disconnected connection, and lists only the live connection's", async () => {
    const { connection } = await connected();
    await upsertPaddlePrices(db, { ...key(connection), prices: [priceImport()], now: NOW }, [
      workspaceEvent(connection.workspaceId),
    ]);
    await disconnectPaddleConnection(db, { ...key(connection), destinationId: null, now: NOW }, [
      workspaceEvent(connection.workspaceId),
    ]);
    const event = workspaceEvent(connection.workspaceId);
    expect(
      await upsertPaddlePrices(db, { ...key(connection), prices: [priceImport()], now: NOW }, [
        event,
      ]),
    ).toEqual({ ok: false, reason: "stale" });
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
    expect(await count("paddle_prices", "connection_id = ?", connection.id)).toBe(1);
    expect(await listPaddlePrices(db, { workspaceId: connection.workspaceId })).toEqual([]);
  });

  it("isolation/cross-workspace-read-denied: lists only the workspace's prices", async () => {
    const { connection } = await connected();
    await upsertPaddlePrices(db, { ...key(connection), prices: [priceImport()], now: NOW }, [
      workspaceEvent(connection.workspaceId),
    ]);
    const other = await connected();
    expect(await listPaddlePrices(db, { workspaceId: other.workspaceId })).toEqual([]);
  });

  it("records a sync with no prices", async () => {
    const { connection } = await connected();
    expect(
      await upsertPaddlePrices(db, { ...key(connection), prices: [], now: NOW }, [
        workspaceEvent(connection.workspaceId),
      ]),
    ).toEqual({ ok: true });
  });
});

it("uses the schema's envelope shape in fixtures", () => {
  expect(JSON.parse(ENVELOPE)).toMatchObject({ v: 1 });
});
