import type { Instant } from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Small system-wide bookkeeping values by key, such as when the sweep last raised a lag alert
 * (decision 0014). Not tenant data: never a workspace's state, a secret or personal data.
 */
export const systemState = sqliteTable(
  "system_state",
  {
    key: text("key").primaryKey(),
    // JSON validated by the code that owns the key.
    value: text("value").notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
  },
  () => [
    check("system_state_key_present", sql`length(key) > 0`),
    check("system_state_value_json", sql`json_valid(value)`),
  ],
);
