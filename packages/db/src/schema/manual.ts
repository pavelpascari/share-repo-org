import {
  type Instant,
  MANUAL_ACCESS_NOTE_MAX_LENGTH,
  MANUAL_ACCESS_REVOKE_CAUSES,
  type ManualAccessRevokeCause,
} from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { offers, subjects } from "./commerce.ts";
import { literalList } from "./sql.ts";
import { workspaces } from "./workspaces.ts";

/**
 * A workspace owner's manual access grant (decision 0016): an offer's repositories for one
 * subject, with no subscription, until `ends_at` (null: open-ended) or until revoked. It is an
 * entitlement source: its entitlements name it as `source_id` with `source_type` `manual`.
 * `version` gives writers optimistic concurrency; `next_evaluation_at` is its database timer,
 * swept every minute like `subscriptions.next_evaluation_at` (decision 0013).
 *
 * At most one open (not revoked) manual access exists per offer and subject. The owner who
 * granted it is recorded only in the audit trail, so an account deletion never has to keep it.
 */
export const manualAccesses = sqliteTable(
  "manual_accesses",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    offerId: text("offer_id").notNull(),
    subjectId: text("subject_id").notNull(),
    // When access ends, or null while open-ended.
    endsAt: integer("ends_at").$type<Instant>(),
    // The owner's optional note, shown with the grant and recorded as the audit reason.
    note: text("note"),
    revokedAt: integer("revoked_at").$type<Instant>(),
    revokeCause: text("revoke_cause", {
      enum: MANUAL_ACCESS_REVOKE_CAUSES,
    }).$type<ManualAccessRevokeCause | null>(),
    // When its entitlements must be planned again (its end date, or a deletion or offer change).
    nextEvaluationAt: integer("next_evaluation_at").$type<Instant>(),
    version: integer("version").notNull(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
  },
  (t) => [
    unique("manual_accesses_workspace_id_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("manual_accesses_open_unique")
      .on(t.workspaceId, t.offerId, t.subjectId)
      .where(sql`revoked_at IS NULL`),
    index("manual_accesses_next_evaluation_idx").on(t.nextEvaluationAt),
    foreignKey({
      name: "manual_accesses_offer_fk",
      columns: [t.workspaceId, t.offerId],
      foreignColumns: [offers.workspaceId, offers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "manual_accesses_subject_fk",
      columns: [t.workspaceId, t.subjectId],
      foreignColumns: [subjects.workspaceId, subjects.id],
    }).onDelete("restrict"),
    check("manual_accesses_ends_after_created", sql`ends_at IS NULL OR ends_at > created_at`),
    check(
      "manual_accesses_note_bounds",
      sql.raw(
        `note IS NULL OR (length(trim(note)) > 0 AND length(note) <= ${MANUAL_ACCESS_NOTE_MAX_LENGTH})`,
      ),
    ),
    check(
      "manual_accesses_revoke_cause_valid",
      sql`revoke_cause IS NULL OR revoke_cause IN (${literalList(MANUAL_ACCESS_REVOKE_CAUSES)})`,
    ),
    check(
      "manual_accesses_revoked_pair",
      sql`(revoked_at IS NULL) = (revoke_cause IS NULL) AND (revoked_at IS NULL OR revoked_at >= created_at)`,
    ),
    check(
      "manual_accesses_revoked_not_scheduled",
      sql`revoked_at IS NULL OR next_evaluation_at IS NULL`,
    ),
    check("manual_accesses_version_positive", sql`version >= 1`),
    check("manual_accesses_updated_after_created", sql`updated_at >= created_at`),
  ],
);
