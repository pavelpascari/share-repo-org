import type { Instant } from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import { check, foreignKey, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { customers, offers } from "./commerce.ts";
import { users } from "./users.ts";
import { workspaces } from "./workspaces.ts";

// Purchase claims (decision 0012). Buyers are users, not workspace members, so user references
// are plain foreign keys to the global `users` table.

/** A SHA-256 or HMAC-SHA256 digest as 64 lowercase hex characters. */
const isHexDigest = (column: string) =>
  sql.raw(`length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`);

/**
 * Path 1: a signed-in buyer started checkout for an offer's price. Only its signed reference
 * travels through Paddle. The first customer whose subscription presents it consumes it;
 * renewals of that customer stay valid, any other customer is refused.
 */
export const checkoutClaims = sqliteTable(
  "checkout_claims",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    offerId: text("offer_id").notNull(),
    // The Paddle price (`pri_…`) the checkout is for.
    priceId: text("price_id").notNull(),
    // The Paddle transaction (`txn_…`), once created.
    transactionId: text("transaction_id"),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    expiresAt: integer("expires_at").$type<Instant>().notNull(),
    consumedByCustomerId: text("consumed_by_customer_id"),
    consumedAt: integer("consumed_at").$type<Instant>(),
  },
  (t) => [
    unique("checkout_claims_workspace_id_id_unique").on(t.workspaceId, t.id),
    foreignKey({
      name: "checkout_claims_offer_fk",
      columns: [t.workspaceId, t.offerId],
      foreignColumns: [offers.workspaceId, offers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "checkout_claims_customer_fk",
      columns: [t.workspaceId, t.consumedByCustomerId],
      foreignColumns: [customers.workspaceId, customers.id],
    }).onDelete("restrict"),
    check("checkout_claims_price_id_present", sql`length(price_id) > 0`),
    check("checkout_claims_expiry_after_creation", sql`expires_at > created_at`),
    check(
      "checkout_claims_consumed_pair",
      sql`(consumed_by_customer_id IS NULL) = (consumed_at IS NULL)`,
    ),
    check(
      "checkout_claims_consumed_after_creation",
      sql`consumed_at IS NULL OR consumed_at >= created_at`,
    ),
  ],
);

/**
 * Path 2: a signed-in buyer asked for claim links for the email they paid with. The email is
 * kept only as an encrypted envelope until the `send_claim_email` job has handled the request;
 * the HMAC of the email feeds rate limits and is never shown.
 */
export const claimRequests = sqliteTable(
  "claim_requests",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    emailHash: text("email_hash").notNull(),
    emailEnvelope: text("email_envelope"),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    processedAt: integer("processed_at").$type<Instant>(),
  },
  (t) => [
    unique("claim_requests_workspace_id_id_unique").on(t.workspaceId, t.id),
    check("claim_requests_email_hash_hex", isHexDigest("email_hash")),
    check(
      "claim_requests_email_envelope_json",
      sql`email_envelope IS NULL OR (json_valid(email_envelope) AND json_type(email_envelope) = 'object')`,
    ),
    // Processing erases the email, whether or not a purchase matched.
    check("claim_requests_processed_erased", sql`processed_at IS NULL OR email_envelope IS NULL`),
    check(
      "claim_requests_processed_after_creation",
      sql`processed_at IS NULL OR processed_at >= created_at`,
    ),
  ],
);

/**
 * Path 2: a single-use emailed claim link for one customer. Only the SHA-256 of the 256-bit
 * token is stored.
 */
export const claimTokens = sqliteTable(
  "claim_tokens",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    customerId: text("customer_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    expiresAt: integer("expires_at").$type<Instant>().notNull(),
    consumedAt: integer("consumed_at").$type<Instant>(),
    consumedByUserId: text("consumed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    unique("claim_tokens_workspace_id_id_unique").on(t.workspaceId, t.id),
    foreignKey({
      name: "claim_tokens_customer_fk",
      columns: [t.workspaceId, t.customerId],
      foreignColumns: [customers.workspaceId, customers.id],
    }).onDelete("restrict"),
    check("claim_tokens_token_hash_hex", isHexDigest("token_hash")),
    check("claim_tokens_expiry_after_creation", sql`expires_at > created_at`),
    check("claim_tokens_consumed_pair", sql`(consumed_at IS NULL) = (consumed_by_user_id IS NULL)`),
    check(
      "claim_tokens_consumed_after_creation",
      sql`consumed_at IS NULL OR consumed_at >= created_at`,
    ),
  ],
);

/**
 * Fixed-window counters for claim requests, like `auth_rate_limits`. Global: a bucket is
 * `email:<hash>`, `user:<id>` or `ip:<hash>`, so limits hold across workspaces.
 */
export const claimRateLimits = sqliteTable(
  "claim_rate_limits",
  {
    bucket: text("bucket").primaryKey(),
    windowStart: integer("window_start").$type<Instant>().notNull(),
    count: integer("count").notNull(),
  },
  () => [
    check("claim_rate_limits_bucket_present", sql`length(bucket) > 0`),
    check("claim_rate_limits_count_non_negative", sql`count >= 0`),
  ],
);
