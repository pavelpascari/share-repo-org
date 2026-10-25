import type { Instant } from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Global (not workspace-owned) and deliberately minimal: login profile data lives in `auth_users`
 * and provider accounts in `external_identities` (decision 0006).
 *
 * `deleted_at` marks the ID-only row an account deletion keeps while a connection or offer
 * version still names the user (decision 0015): nothing may attach to it again. A trigger
 * (migration 0011) refuses linking an identity to it, so a sign-in racing the deletion cannot
 * leave a stray identity behind.
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
    deletedAt: integer("deleted_at").$type<Instant>(),
  },
  () => [check("users_updated_after_created", sql`updated_at >= created_at`)],
);
