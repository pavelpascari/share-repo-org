import { IDENTITY_PROVIDERS, type IdentityProvider, type Instant } from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { literalList } from "./sql.ts";
import { users } from "./users.ts";

/**
 * Domain `ExternalIdentity`: a provider account linked to a ShareRepo user. Global, not
 * workspace-owned. Keyed by the provider's immutable user ID; the username is only a snapshot.
 */
export const externalIdentities = sqliteTable(
  "external_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    provider: text("provider", { enum: IDENTITY_PROVIDERS }).$type<IdentityProvider>().notNull(),
    externalUserId: text("external_user_id").notNull(),
    usernameSnapshot: text("username_snapshot").notNull(),
    displayNameSnapshot: text("display_name_snapshot"),
    avatarUrlSnapshot: text("avatar_url_snapshot"),
    verifiedAt: integer("verified_at").$type<Instant>().notNull(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
  },
  (t) => [
    // One provider account belongs to at most one user (claim threat model, constraint 2).
    uniqueIndex("external_identities_provider_user_unique").on(t.provider, t.externalUserId),
    // A user has at most one identity per provider, so a GitHub subject resolves unambiguously.
    uniqueIndex("external_identities_user_provider_unique").on(t.userId, t.provider),
    check(
      "external_identities_provider_valid",
      sql`provider IN (${literalList(IDENTITY_PROVIDERS)})`,
    ),
    check("external_identities_external_user_id_present", sql`length(external_user_id) > 0`),
    check("external_identities_username_present", sql`length(username_snapshot) > 0`),
    check("external_identities_updated_after_created", sql`updated_at >= created_at`),
  ],
);
