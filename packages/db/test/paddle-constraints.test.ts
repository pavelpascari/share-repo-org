import { describe, expect, it } from "vitest";
import { schema } from "../src/index.ts";
import { customerRow, subscribedWorkspace } from "./support/commerce.ts";
import { db } from "./support/connections.ts";
import {
  checkoutClaimRow,
  claimRequestRow,
  claimTokenRow,
  hexDigest,
  insertRaw,
  type PaddleConnectionInsert,
  paddleConnectionRow,
  paddlePriceRow,
  seedPaddleConnection,
} from "./support/paddle.ts";
import { insertUserRow, insertWorkspaceRow, T0, uniqueId } from "./support/rows.ts";

const ok = { success: true };
const checkFailed = (name: string) => new RegExp(`CHECK constraint failed: ${name}`);
const FK_FAILED = /FOREIGN KEY constraint failed/;
const UNIQUE_FAILED = /UNIQUE constraint failed/;

async function workspace() {
  const id = uniqueId("ws");
  await insertWorkspaceRow({ id });
  return id;
}

async function user() {
  const id = uniqueId("usr");
  await insertUserRow(id);
  return id;
}

type Ws = Awaited<ReturnType<typeof subscribedWorkspace>>;

describe("paddle_connections constraints", () => {
  it("accepts a live API-key connection", async () => {
    await expect(
      insertRaw(schema.paddleConnections, paddleConnectionRow(await workspace())),
    ).resolves.toMatchObject(ok);
  });

  it.each<[string, Partial<PaddleConnectionInsert>]>([
    ["paddle_connections_environment_valid", { environment: "production" as "live" }],
    ["paddle_connections_credential_kind_valid", { credentialKind: "password" as "oauth" }],
    ["paddle_connections_status_valid", { status: "suspended" as "active" }],
    ["paddle_connections_seller_id_present", { sellerId: "" }],
    ["paddle_connections_api_key_envelope_json", { apiKeyEnvelope: "pdl_sdbx_apikey_plain" }],
    ["paddle_connections_api_key_envelope_json", { apiKeyEnvelope: "[1]" }],
    ["paddle_connections_webhook_secret_envelope_json", { webhookSecretEnvelope: "secret" }],
    ["paddle_connections_webhook_secret_envelope_json", { webhookSecretEnvelope: '"x"' }],
    ["paddle_connections_live_has_credentials", { apiKeyEnvelope: null }],
    ["paddle_connections_live_has_credentials", { status: "unauthorized", destinationId: null }],
    ["paddle_connections_live_has_credentials", { webhookSecretEnvelope: null }],
    ["paddle_connections_disconnected_erased", { status: "disconnected" }],
    ["paddle_connections_disconnected_erased", { status: "disconnected", apiKeyEnvelope: null }],
    [
      "paddle_connections_disconnected_erased",
      { status: "disconnected", webhookSecretEnvelope: null },
    ],
    ["paddle_connections_updated_after_created", { updatedAt: T0 - 1 }],
  ])("CHECK %s rejects %j", async (name, overrides) => {
    const row = paddleConnectionRow(await workspace(), overrides);
    await expect(insertRaw(schema.paddleConnections, row)).rejects.toThrow(checkFailed(name));
  });

  it("accepts a disconnected connection with its credentials erased and destination kept", async () => {
    const row = paddleConnectionRow(await workspace(), {
      status: "disconnected",
      apiKeyEnvelope: null,
      webhookSecretEnvelope: null,
    });
    await expect(insertRaw(schema.paddleConnections, row)).resolves.toMatchObject(ok);
  });

  it("does not require an API key of an OAuth connection", async () => {
    const row = paddleConnectionRow(await workspace(), {
      credentialKind: "oauth",
      apiKeyEnvelope: null,
      apiKeyExpiresOn: null,
    });
    await expect(insertRaw(schema.paddleConnections, row)).resolves.toMatchObject(ok);
  });

  it("allows one connection per workspace that is not disconnected", async () => {
    const workspaceId = await workspace();
    const erased = { status: "disconnected", apiKeyEnvelope: null, webhookSecretEnvelope: null };
    await seedPaddleConnection(workspaceId, erased as Partial<PaddleConnectionInsert>);
    await seedPaddleConnection(workspaceId, erased as Partial<PaddleConnectionInsert>);
    await seedPaddleConnection(workspaceId, { status: "unauthorized" });
    for (const status of ["active", "unauthorized"] as const) {
      await expect(
        insertRaw(schema.paddleConnections, paddleConnectionRow(workspaceId, { status })),
      ).rejects.toThrow(UNIQUE_FAILED);
    }
    // Another workspace is unaffected.
    await expect(
      insertRaw(schema.paddleConnections, paddleConnectionRow(await workspace())),
    ).resolves.toMatchObject(ok);
  });

  it("references an existing workspace", async () => {
    const row = paddleConnectionRow(uniqueId("ws"));
    await expect(insertRaw(schema.paddleConnections, row)).rejects.toThrow(FK_FAILED);
  });
});

describe("paddle_prices constraints", () => {
  const priceFor = async (overrides: Parameters<typeof paddlePriceRow>[2] = {}) => {
    const workspaceId = await workspace();
    const connection = await seedPaddleConnection(workspaceId);
    return paddlePriceRow(workspaceId, connection.id, overrides);
  };

  it.each([
    ["a monthly price", {}],
    ["a one-time price", { billingInterval: null, billingFrequency: null }],
    ["an archived yearly price", { status: "archived", billingInterval: "year" }],
    ["a zero amount", { unitAmount: "0" }],
  ] as const)("accepts %s", async (_, overrides) => {
    await expect(insertRaw(schema.paddlePrices, await priceFor(overrides))).resolves.toMatchObject(
      ok,
    );
  });

  it.each([
    ["paddle_prices_price_id_present", { priceId: "" }],
    ["paddle_prices_product_id_present", { productId: "" }],
    ["paddle_prices_status_valid", { status: "draft" }],
    ["paddle_prices_billing_cycle_valid", { billingFrequency: null }],
    ["paddle_prices_billing_cycle_valid", { billingInterval: null }],
    ["paddle_prices_billing_cycle_valid", { billingFrequency: 0 }],
    ["paddle_prices_billing_cycle_valid", { billingInterval: "fortnight" }],
    ["paddle_prices_unit_amount_digits", { unitAmount: "" }],
    ["paddle_prices_unit_amount_digits", { unitAmount: "10.50" }],
    ["paddle_prices_unit_amount_digits", { unitAmount: "-1" }],
    ["paddle_prices_currency_code", { currency: "usd" }],
    ["paddle_prices_currency_code", { currency: "US" }],
  ] as const)("CHECK %s rejects %j", async (name, overrides) => {
    const row = await priceFor(overrides as Parameters<typeof paddlePriceRow>[2]);
    await expect(insertRaw(schema.paddlePrices, row)).rejects.toThrow(checkFailed(name));
  });

  it("imports a price once per connection", async () => {
    const row = await priceFor();
    await insertRaw(schema.paddlePrices, row);
    await expect(insertRaw(schema.paddlePrices, { ...row, id: uniqueId("ppr") })).rejects.toThrow(
      UNIQUE_FAILED,
    );
  });
});

describe("checkout_claims constraints", () => {
  const claimFor = (ws: Ws, overrides: Parameters<typeof checkoutClaimRow>[3] = {}) =>
    checkoutClaimRow(ws.workspaceId, ws.userId, ws.offer.offer.id, overrides);

  it("accepts an open claim and a consumed one", async () => {
    const ws = await subscribedWorkspace();
    await expect(insertRaw(schema.checkoutClaims, claimFor(ws))).resolves.toMatchObject(ok);
    const consumed = claimFor(ws, {
      transactionId: "txn_01",
      consumedByCustomerId: ws.customer.id,
      consumedAt: T0 + 1,
    });
    await expect(insertRaw(schema.checkoutClaims, consumed)).resolves.toMatchObject(ok);
  });

  it.each<[string, (ws: Ws) => Parameters<typeof checkoutClaimRow>[3]]>([
    ["checkout_claims_price_id_present", () => ({ priceId: "" })],
    ["checkout_claims_expiry_after_creation", () => ({ expiresAt: T0 })],
    ["checkout_claims_consumed_pair", () => ({ consumedAt: T0 + 1 })],
    ["checkout_claims_consumed_pair", (ws) => ({ consumedByCustomerId: ws.customer.id })],
    [
      "checkout_claims_consumed_after_creation",
      (ws) => ({ consumedByCustomerId: ws.customer.id, consumedAt: T0 - 1 }),
    ],
  ])("CHECK %s", async (name, overrides) => {
    const ws = await subscribedWorkspace();
    await expect(insertRaw(schema.checkoutClaims, claimFor(ws, overrides(ws)))).rejects.toThrow(
      checkFailed(name),
    );
  });

  it("references an existing user", async () => {
    const ws = await subscribedWorkspace();
    const row = claimFor(ws, { userId: uniqueId("usr") });
    await expect(insertRaw(schema.checkoutClaims, row)).rejects.toThrow(FK_FAILED);
  });
});

describe("claim_requests constraints", () => {
  const requestFor = async (overrides: Parameters<typeof claimRequestRow>[2] = {}) =>
    claimRequestRow(await workspace(), await user(), overrides);

  it("accepts a pending request and a processed one with its email erased", async () => {
    await expect(insertRaw(schema.claimRequests, await requestFor())).resolves.toMatchObject(ok);
    const processed = await requestFor({ emailEnvelope: null, processedAt: T0 });
    await expect(insertRaw(schema.claimRequests, processed)).resolves.toMatchObject(ok);
  });

  it.each([
    ["claim_requests_email_hash_hex", { emailHash: hexDigest().toUpperCase() }],
    ["claim_requests_email_hash_hex", { emailHash: hexDigest().slice(1) }],
    ["claim_requests_email_hash_hex", { emailHash: `${hexDigest()}0` }],
    ["claim_requests_email_hash_hex", { emailHash: `${hexDigest().slice(1)}g` }],
    ["claim_requests_email_envelope_json", { emailEnvelope: "someone@example.com" }],
    ["claim_requests_processed_erased", { processedAt: T0 }],
    ["claim_requests_processed_after_creation", { emailEnvelope: null, processedAt: T0 - 1 }],
  ] as const)("CHECK %s rejects %j", async (name, overrides) => {
    await expect(insertRaw(schema.claimRequests, await requestFor(overrides))).rejects.toThrow(
      checkFailed(name),
    );
  });

  it("references an existing user", async () => {
    const row = claimRequestRow(await workspace(), uniqueId("usr"));
    await expect(insertRaw(schema.claimRequests, row)).rejects.toThrow(FK_FAILED);
  });
});

describe("claim_tokens constraints", () => {
  it("accepts an unused token and a used one", async () => {
    const ws = await subscribedWorkspace();
    await expect(
      insertRaw(schema.claimTokens, claimTokenRow(ws.workspaceId, ws.customer.id)),
    ).resolves.toMatchObject(ok);
    const used = claimTokenRow(ws.workspaceId, ws.customer.id, {
      consumedAt: T0 + 1,
      consumedByUserId: ws.userId,
    });
    await expect(insertRaw(schema.claimTokens, used)).resolves.toMatchObject(ok);
  });

  it.each<[string, (ws: Ws) => Parameters<typeof claimTokenRow>[2]]>([
    ["claim_tokens_token_hash_hex", () => ({ tokenHash: hexDigest().toUpperCase() })],
    ["claim_tokens_token_hash_hex", () => ({ tokenHash: hexDigest().slice(2) })],
    ["claim_tokens_token_hash_hex", () => ({ tokenHash: `${hexDigest().slice(1)}z` })],
    ["claim_tokens_expiry_after_creation", () => ({ expiresAt: T0 - 1 })],
    ["claim_tokens_consumed_pair", () => ({ consumedAt: T0 + 1 })],
    ["claim_tokens_consumed_pair", (ws) => ({ consumedByUserId: ws.userId })],
    [
      "claim_tokens_consumed_after_creation",
      (ws) => ({ consumedAt: T0 - 1, consumedByUserId: ws.userId }),
    ],
  ])("CHECK %s", async (name, overrides) => {
    const ws = await subscribedWorkspace();
    const row = claimTokenRow(ws.workspaceId, ws.customer.id, overrides(ws));
    await expect(insertRaw(schema.claimTokens, row)).rejects.toThrow(checkFailed(name));
  });

  it("keeps token hashes unique across workspaces", async () => {
    const a = await subscribedWorkspace();
    const b = await subscribedWorkspace();
    const tokenHash = hexDigest();
    await insertRaw(schema.claimTokens, claimTokenRow(a.workspaceId, a.customer.id, { tokenHash }));
    await expect(
      insertRaw(schema.claimTokens, claimTokenRow(b.workspaceId, b.customer.id, { tokenHash })),
    ).rejects.toThrow(UNIQUE_FAILED);
  });

  it("references an existing consuming user", async () => {
    const ws = await subscribedWorkspace();
    const row = claimTokenRow(ws.workspaceId, ws.customer.id, {
      consumedAt: T0 + 1,
      consumedByUserId: uniqueId("usr"),
    });
    await expect(insertRaw(schema.claimTokens, row)).rejects.toThrow(FK_FAILED);
  });
});

describe("claim_rate_limits constraints", () => {
  const bucket = () => `user:${uniqueId("usr")}`;

  it("holds one counter per bucket", async () => {
    const row = { bucket: bucket(), windowStart: T0, count: 1 };
    await expect(insertRaw(schema.claimRateLimits, row)).resolves.toMatchObject(ok);
    await expect(insertRaw(schema.claimRateLimits, row)).rejects.toThrow(UNIQUE_FAILED);
  });

  it.each([
    ["claim_rate_limits_bucket_present", { bucket: "" }],
    ["claim_rate_limits_count_non_negative", { count: -1 }],
  ])("CHECK %s rejects %j", async (name, overrides) => {
    const row = { bucket: bucket(), windowStart: T0, count: 0, ...overrides };
    await expect(insertRaw(schema.claimRateLimits, row)).rejects.toThrow(checkFailed(name));
  });
});

describe("external_events connection constraints", () => {
  const eventRow = (provider: "github" | "paddle", connectionId: string | null) => ({
    id: uniqueId("evt"),
    provider,
    connectionId,
    externalEventId: uniqueId("ext"),
    eventType: "subscription.updated",
    payloadDigest: "sha256:abc",
    occurredAt: T0 - 1,
    receivedAt: T0,
    processingState: "pending" as const,
    attempts: 0,
  });

  it("CHECK external_events_connection_iff_paddle", async () => {
    const connection = await seedPaddleConnection(await workspace());
    const failed = checkFailed("external_events_connection_iff_paddle");
    await expect(insertRaw(schema.externalEvents, eventRow("paddle", null))).rejects.toThrow(
      failed,
    );
    await expect(
      insertRaw(schema.externalEvents, eventRow("github", connection.id)),
    ).rejects.toThrow(failed);
    await expect(
      insertRaw(schema.externalEvents, eventRow("paddle", connection.id)),
    ).resolves.toMatchObject(ok);
  });

  it("references an existing Paddle connection", async () => {
    await expect(
      insertRaw(schema.externalEvents, eventRow("paddle", uniqueId("pdc"))),
    ).rejects.toThrow(FK_FAILED);
  });

  it("CHECK external_events_provider_valid rejects an unknown provider", async () => {
    await expect(
      insertRaw(schema.externalEvents, eventRow("gitlab" as "github", null)),
    ).rejects.toThrow(checkFailed("external_events_provider_valid"));
  });
});

describe("isolation/composite-fk-rejects-cross-tenant-link: paddle and claims", () => {
  const cases: [string, (a: Ws, b: Ws) => Promise<unknown>][] = [
    [
      "paddle_prices -> paddle_connections",
      async (a, b) => {
        const connection = await seedPaddleConnection(b.workspaceId);
        return insertRaw(schema.paddlePrices, paddlePriceRow(a.workspaceId, connection.id));
      },
    ],
    [
      "checkout_claims -> offers",
      (a, b) =>
        insertRaw(
          schema.checkoutClaims,
          checkoutClaimRow(a.workspaceId, a.userId, b.offer.offer.id),
        ),
    ],
    [
      "checkout_claims -> customers",
      (a, b) =>
        insertRaw(
          schema.checkoutClaims,
          checkoutClaimRow(a.workspaceId, a.userId, a.offer.offer.id, {
            consumedByCustomerId: b.customer.id,
            consumedAt: T0 + 1,
          }),
        ),
    ],
    [
      "claim_tokens -> customers",
      (a, b) => insertRaw(schema.claimTokens, claimTokenRow(a.workspaceId, b.customer.id)),
    ],
  ];

  it.each(cases)("%s", async (_, link) => {
    const a = await subscribedWorkspace();
    const b = await subscribedWorkspace();
    await expect(link(a, b)).rejects.toThrow(FK_FAILED);
  });

  it("accepts the same links within one workspace", async () => {
    const a = await subscribedWorkspace();
    const connection = await seedPaddleConnection(a.workspaceId);
    await expect(
      insertRaw(schema.paddlePrices, paddlePriceRow(a.workspaceId, connection.id)),
    ).resolves.toMatchObject(ok);
    const customer = customerRow(a.workspaceId, { source: "paddle" });
    await db.insert(schema.customers).values(customer);
    await expect(
      insertRaw(schema.claimTokens, claimTokenRow(a.workspaceId, customer.id)),
    ).resolves.toMatchObject(ok);
  });
});
