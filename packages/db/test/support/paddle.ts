import { env } from "cloudflare:workers";
import { schema } from "../../src/index.ts";
import { db } from "./connections.ts";
import { T0, uniqueId } from "./rows.ts";

type Insert<T extends { $inferInsert: unknown }> = T["$inferInsert"];
export type PaddleConnectionInsert = Insert<typeof schema.paddleConnections>;
export type PaddlePriceInsert = Insert<typeof schema.paddlePrices>;
export type CheckoutClaimInsert = Insert<typeof schema.checkoutClaims>;
export type ClaimRequestInsert = Insert<typeof schema.claimRequests>;
export type ClaimTokenInsert = Insert<typeof schema.claimTokens>;

const DAY = 24 * 60 * 60_000;

/** The shape of a sealed envelope; its contents do not matter to the schema. */
export const ENVELOPE = JSON.stringify({
  v: 1,
  kid: "k1",
  iv: "aa",
  ct: "bb",
  wiv: "cc",
  wk: "dd",
});

/** 64 random lowercase hex characters, the shape of a stored digest. */
export function hexDigest(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function paddleConnectionRow(
  workspaceId: string,
  overrides: Partial<PaddleConnectionInsert> = {},
): PaddleConnectionInsert {
  return {
    id: uniqueId("pdc"),
    workspaceId,
    environment: "sandbox",
    sellerId: "slr_01",
    sellerName: "Acme",
    credentialKind: "api_key",
    apiKeyEnvelope: ENVELOPE,
    apiKeyExpiresOn: T0 + 365 * DAY,
    destinationId: uniqueId("ntfset"),
    webhookSecretEnvelope: ENVELOPE,
    status: "active",
    statusReason: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** A stored, active Paddle connection for the workspace. */
export async function seedPaddleConnection(
  workspaceId: string,
  overrides: Partial<PaddleConnectionInsert> = {},
) {
  const row = paddleConnectionRow(workspaceId, overrides);
  await db.insert(schema.paddleConnections).values(row);
  return row;
}

export function paddlePriceRow(
  workspaceId: string,
  connectionId: string,
  overrides: Partial<PaddlePriceInsert> = {},
): PaddlePriceInsert {
  return {
    id: uniqueId("ppr"),
    workspaceId,
    connectionId,
    priceId: uniqueId("pri"),
    productId: "pro_01",
    productName: "Pro",
    description: null,
    billingInterval: "month",
    billingFrequency: 1,
    unitAmount: "1000",
    currency: "USD",
    status: "active",
    syncedAt: T0,
    ...overrides,
  };
}

export function checkoutClaimRow(
  workspaceId: string,
  userId: string,
  offerId: string,
  overrides: Partial<CheckoutClaimInsert> = {},
): CheckoutClaimInsert {
  return {
    id: uniqueId("ckc"),
    workspaceId,
    userId,
    offerId,
    priceId: "pri_01",
    transactionId: null,
    createdAt: T0,
    expiresAt: T0 + 7 * DAY,
    consumedByCustomerId: null,
    consumedAt: null,
    ...overrides,
  };
}

export function claimRequestRow(
  workspaceId: string,
  userId: string,
  overrides: Partial<ClaimRequestInsert> = {},
): ClaimRequestInsert {
  return {
    id: uniqueId("clr"),
    workspaceId,
    userId,
    emailHash: hexDigest(),
    emailEnvelope: ENVELOPE,
    createdAt: T0,
    processedAt: null,
    ...overrides,
  };
}

export function claimTokenRow(
  workspaceId: string,
  customerId: string,
  overrides: Partial<ClaimTokenInsert> = {},
): ClaimTokenInsert {
  return {
    id: uniqueId("clt"),
    workspaceId,
    customerId,
    tokenHash: hexDigest(),
    createdAt: T0,
    expiresAt: T0 + DAY,
    consumedAt: null,
    consumedByUserId: null,
    ...overrides,
  };
}

type Table = Parameters<typeof db.insert>[0];

/**
 * Inserts through D1 directly with the SQL Drizzle would run, so a failure surfaces SQLite's own
 * message (Drizzle wraps it in a message that quotes the statement).
 */
export function insertRaw<T extends Table>(table: T, row: T["$inferInsert"]) {
  const query = db.insert(table).values(row).toSQL();
  return env.DB.prepare(query.sql)
    .bind(...query.params)
    .run();
}
