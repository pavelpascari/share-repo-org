import { type Instant, SUBSCRIPTION_STATES, type SubscriptionState } from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { literalList } from "./sql.ts";
import { workspaces } from "./workspaces.ts";

/**
 * The simulated entitlement source's own data (decision 0009): what "the provider" holds for a
 * subscription. Policy never reads it; processing reads it only through the source port, exactly
 * as it will read Paddle. Never used in production.
 */
export const simulatedSubscriptions = sqliteTable(
  "simulated_subscriptions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    // The subscriber, as the owner named them: a GitHub account's immutable ID and login.
    customerGithubId: text("customer_github_id").notNull(),
    customerLogin: text("customer_login").notNull(),
    // Validated JSON array of commercial item IDs.
    items: text("items").notNull(),
    state: text("state", { enum: SUBSCRIPTION_STATES }).$type<SubscriptionState>().notNull(),
    currentPeriodStart: integer("current_period_start").$type<Instant>().notNull(),
    currentPeriodEnd: integer("current_period_end").$type<Instant>().notNull(),
    cancelAt: integer("cancel_at").$type<Instant>(),
    endedAt: integer("ended_at").$type<Instant>(),
    pastDueSince: integer("past_due_since").$type<Instant>(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
  },
  (t) => [
    unique("simulated_subscriptions_workspace_id_id_unique").on(t.workspaceId, t.id),
    check(
      "simulated_subscriptions_state_valid",
      sql`state IN (${literalList(SUBSCRIPTION_STATES)})`,
    ),
    check(
      "simulated_subscriptions_items_json",
      sql`json_valid(items) AND json_type(items) = 'array'`,
    ),
    check("simulated_subscriptions_period_valid", sql`current_period_end > current_period_start`),
    check("simulated_subscriptions_updated_after_created", sql`updated_at >= created_at`),
  ],
);
