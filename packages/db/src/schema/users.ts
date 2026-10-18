import type { Instant } from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Global (not workspace-owned). Deliberately minimal until Better Auth table ownership is decided in Phase 1. */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
  },
  () => [check("users_updated_after_created", sql`updated_at >= created_at`)],
);
