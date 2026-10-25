import {
  CREDENTIAL_KINDS,
  type CredentialKind,
  type Instant,
  PADDLE_BILLING_INTERVALS,
  PADDLE_CONNECTION_STATUSES,
  PADDLE_ENVIRONMENTS,
  PADDLE_PRICE_STATUSES,
  type PaddleBillingInterval,
  type PaddleConnectionStatus,
  type PaddleEnvironment,
  type PaddlePriceStatus,
} from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { literalList } from "./sql.ts";
import { workspaces } from "./workspaces.ts";

/**
 * A workspace's Paddle seller account (decision 0011). At most one row per workspace is not
 * `disconnected`; disconnected rows stay as history, with their credentials erased. The key and
 * webhook secret are encrypted envelopes (JSON), bound to this row by their additional
 * authenticated data, never plaintext.
 */
export const paddleConnections = sqliteTable(
  "paddle_connections",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    environment: text("environment", { enum: PADDLE_ENVIRONMENTS })
      .$type<PaddleEnvironment>()
      .notNull(),
    // `slr_…`; a reconnect must present a key for the same seller.
    sellerId: text("seller_id").notNull(),
    // From `account.read`, which is optional.
    sellerName: text("seller_name"),
    credentialKind: text("credential_kind", { enum: CREDENTIAL_KINDS })
      .$type<CredentialKind>()
      .notNull(),
    apiKeyEnvelope: text("api_key_envelope"),
    // Entered by the creator: Paddle's API does not report a key's expiry. UTC midnight.
    apiKeyExpiresOn: integer("api_key_expires_on").$type<Instant>(),
    // The notification destination (`ntfset_…`). Kept after a disconnect whose delete failed, so
    // the creator can be told which destination to delete in Paddle.
    destinationId: text("destination_id"),
    webhookSecretEnvelope: text("webhook_secret_envelope"),
    // During a webhook secret rotation: the second destination, at the same URL, and its secret.
    // Both secrets are accepted until the old destination is deleted and these are promoted.
    destinationNextId: text("destination_next_id"),
    webhookSecretNextEnvelope: text("webhook_secret_next_envelope"),
    status: text("status", { enum: PADDLE_CONNECTION_STATUSES })
      .$type<PaddleConnectionStatus>()
      .notNull(),
    // A classified code explaining the status (for example a missing permission), never a message.
    statusReason: text("status_reason"),
    lastEventAt: integer("last_event_at").$type<Instant>(),
    lastCheckedAt: integer("last_checked_at").$type<Instant>(),
    catalogSyncedAt: integer("catalog_synced_at").$type<Instant>(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
  },
  (t) => [
    unique("paddle_connections_workspace_id_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("paddle_connections_one_live")
      .on(t.workspaceId)
      .where(sql`status <> 'disconnected'`),
    check(
      "paddle_connections_environment_valid",
      sql`environment IN (${literalList(PADDLE_ENVIRONMENTS)})`,
    ),
    check(
      "paddle_connections_credential_kind_valid",
      sql`credential_kind IN (${literalList(CREDENTIAL_KINDS)})`,
    ),
    check(
      "paddle_connections_status_valid",
      sql`status IN (${literalList(PADDLE_CONNECTION_STATUSES)})`,
    ),
    check("paddle_connections_seller_id_present", sql`length(seller_id) > 0`),
    check(
      "paddle_connections_api_key_envelope_json",
      sql`api_key_envelope IS NULL OR (json_valid(api_key_envelope) AND json_type(api_key_envelope) = 'object')`,
    ),
    check(
      "paddle_connections_webhook_secret_envelope_json",
      sql`webhook_secret_envelope IS NULL OR (json_valid(webhook_secret_envelope) AND json_type(webhook_secret_envelope) = 'object')`,
    ),
    check(
      "paddle_connections_webhook_secret_next_envelope_json",
      sql`webhook_secret_next_envelope IS NULL OR (json_valid(webhook_secret_next_envelope) AND json_type(webhook_secret_next_envelope) = 'object')`,
    ),
    // A rotation's secret belongs to its destination.
    check(
      "paddle_connections_next_secret_has_destination",
      sql`webhook_secret_next_envelope IS NULL OR destination_next_id IS NOT NULL`,
    ),
    // A live API-key connection holds its key; a live connection holds its destination's secret.
    check(
      "paddle_connections_live_has_credentials",
      sql`status = 'disconnected' OR ((credential_kind <> 'api_key' OR api_key_envelope IS NOT NULL) AND destination_id IS NOT NULL AND webhook_secret_envelope IS NOT NULL)`,
    ),
    // Disconnecting erases the stored credentials (decision 0011).
    check(
      "paddle_connections_disconnected_erased",
      sql`status <> 'disconnected' OR (api_key_envelope IS NULL AND webhook_secret_envelope IS NULL AND webhook_secret_next_envelope IS NULL)`,
    ),
    check("paddle_connections_updated_after_created", sql`updated_at >= created_at`),
  ],
);

/**
 * A Paddle price imported from a connection's catalog, with its product's name. Archived prices
 * stay, marked archived. Recurring prices have both an interval and a frequency; one-time prices
 * have neither.
 */
export const paddlePrices = sqliteTable(
  "paddle_prices",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    connectionId: text("connection_id").notNull(),
    // `pri_…`, the commercial item ID that offer items and subscription items carry.
    priceId: text("price_id").notNull(),
    productId: text("product_id").notNull(),
    productName: text("product_name").notNull(),
    description: text("description"),
    billingInterval: text("billing_interval", {
      enum: PADDLE_BILLING_INTERVALS,
    }).$type<PaddleBillingInterval>(),
    billingFrequency: integer("billing_frequency"),
    // Paddle's amount in the currency's lowest denomination, as the decimal string it sends.
    unitAmount: text("unit_amount").notNull(),
    currency: text("currency").notNull(),
    status: text("status", { enum: PADDLE_PRICE_STATUSES }).$type<PaddlePriceStatus>().notNull(),
    syncedAt: integer("synced_at").$type<Instant>().notNull(),
  },
  (t) => [
    unique("paddle_prices_workspace_id_id_unique").on(t.workspaceId, t.id),
    unique("paddle_prices_price_unique").on(t.workspaceId, t.connectionId, t.priceId),
    foreignKey({
      name: "paddle_prices_connection_fk",
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [paddleConnections.workspaceId, paddleConnections.id],
    }).onDelete("restrict"),
    check("paddle_prices_price_id_present", sql`length(price_id) > 0`),
    check("paddle_prices_product_id_present", sql`length(product_id) > 0`),
    check("paddle_prices_status_valid", sql`status IN (${literalList(PADDLE_PRICE_STATUSES)})`),
    check(
      "paddle_prices_billing_cycle_valid",
      // IS NOT NULL is explicit: a NULL comparison would make the CHECK pass.
      sql`(billing_interval IS NULL AND billing_frequency IS NULL) OR (billing_interval IS NOT NULL AND billing_frequency IS NOT NULL AND billing_interval IN (${literalList(PADDLE_BILLING_INTERVALS)}) AND billing_frequency >= 1)`,
    ),
    check(
      "paddle_prices_unit_amount_digits",
      sql`length(unit_amount) > 0 AND unit_amount NOT GLOB '*[^0-9]*'`,
    ),
    check(
      "paddle_prices_currency_code",
      sql`length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'`,
    ),
  ],
);
