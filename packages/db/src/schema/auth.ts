import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./users.ts";

// Better Auth's tables (decision 0006). Better Auth reads and writes them through its Drizzle
// adapter, which finds each table by its *export name* (configured as `modelName`) and each column
// by its JS key (Better Auth's field name). Dates are `timestamp_ms` because Better Auth passes
// `Date` objects, which D1 cannot bind; storage is the same epoch-millisecond integer as `Instant`.

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

/** Login profile, 1:1 with `users` (same id). Holds the fields Better Auth requires. */
export const authUsers = sqliteTable("auth_users", {
  id: text("id")
    .primaryKey()
    .references(() => users.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  // Synthetic (`github-<id>@users.sharerepo.invalid`), never a real address: see decision 0006.
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    index("auth_sessions_user_id_idx").on(t.userId),
    // Pruning expired sessions (decision 0015).
    index("auth_sessions_expires_idx").on(t.expiresAt),
  ],
);

export const authAccounts = sqliteTable(
  "auth_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    // The provider's immutable user ID (GitHub's numeric ID, as a string).
    accountId: text("account_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("auth_accounts_provider_account_unique").on(t.providerId, t.accountId),
    index("auth_accounts_user_id_idx").on(t.userId),
    // ShareRepo never keeps a user's OAuth tokens or a password (decision 0006).
    check(
      "auth_accounts_no_credentials",
      sql`access_token IS NULL AND refresh_token IS NULL AND id_token IS NULL AND password IS NULL`,
    ),
  ],
);

export const authVerifications = sqliteTable(
  "auth_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    index("auth_verifications_identifier_idx").on(t.identifier),
    // Pruning expired verifications (decision 0015).
    index("auth_verifications_expires_idx").on(t.expiresAt),
  ],
);

/** Better Auth's rate-limit counters (`storage: "database"`); isolate memory is not shared. */
export const authRateLimits = sqliteTable("auth_rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});
