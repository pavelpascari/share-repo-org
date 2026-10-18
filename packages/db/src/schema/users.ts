import type { Instant } from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Global (not workspace-owned) and deliberately minimal: login profile data lives in `auth_users`
 * and provider accounts in `external_identities` (decision 0006).
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
  },
  () => [check("users_updated_after_created", sql`updated_at >= created_at`)],
);
