import type { IdentityProvider, Instant } from "@sharerepo/domain";
import { and, eq, sql } from "drizzle-orm";
import { type AuditEvents, auditInserts, conditionalAuditInserts } from "./audit-repository.ts";
import type { Db } from "./client.ts";
import { isUniqueViolation } from "./errors.ts";
import { externalIdentities } from "./schema/index.ts";

/** Domain `ExternalIdentity`. Keyed by the provider's immutable user ID; usernames are snapshots. */
export type ExternalIdentity = typeof externalIdentities.$inferSelect;

export type InsertExternalIdentityResult =
  | { ok: true; identity: ExternalIdentity }
  /** The provider account is already linked to a ShareRepo user (this one or another). */
  | { ok: false; reason: "identity_taken" }
  /** The user already has an identity for this provider. */
  | { ok: false; reason: "user_already_linked" };

export type UpdateExternalIdentitySnapshotResult =
  | { ok: true }
  /** No identity with this id belongs to this user. Nothing, including audit, was written. */
  | { ok: false; reason: "identity_not_owned" };

export interface ExternalIdentitySnapshot {
  id: string;
  userId: string;
  usernameSnapshot: string;
  displayNameSnapshot: string | null;
  avatarUrlSnapshot: string | null;
  verifiedAt: Instant;
  now: Instant;
}

export async function findExternalIdentity(
  db: Db,
  key: { provider: IdentityProvider; externalUserId: string },
): Promise<ExternalIdentity | null> {
  const rows = await db
    .select()
    .from(externalIdentities)
    .where(
      and(
        eq(externalIdentities.provider, key.provider),
        eq(externalIdentities.externalUserId, key.externalUserId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findExternalIdentityForUser(
  db: Db,
  key: { userId: string; provider: IdentityProvider },
): Promise<ExternalIdentity | null> {
  const rows = await db
    .select()
    .from(externalIdentities)
    .where(
      and(eq(externalIdentities.userId, key.userId), eq(externalIdentities.provider, key.provider)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Links a provider account to a user, with its audit events, in one atomic batch. Uniqueness
 * conflicts come back as typed results; other constraint errors (an unknown user) propagate.
 */
export async function insertExternalIdentity(
  db: Db,
  identity: ExternalIdentity,
  audit: AuditEvents,
): Promise<InsertExternalIdentityResult> {
  try {
    await db.batch([db.insert(externalIdentities).values(identity), ...auditInserts(db, audit)]);
  } catch (error) {
    if (
      isUniqueViolation(error, [
        "external_identities.provider",
        "external_identities.external_user_id",
      ])
    ) {
      return { ok: false, reason: "identity_taken" };
    }
    if (isUniqueViolation(error, ["external_identities.user_id", "external_identities.provider"])) {
      return { ok: false, reason: "user_already_linked" };
    }
    throw error;
  }
  return { ok: true, identity };
}

/**
 * Refreshes the profile snapshot (for example after a username change) of an identity the user
 * owns. The UPDATE and the audit inserts share one predicate in one batch, so either both happen
 * or neither does: there is no window in which an audit row describes a change that did not occur.
 */
export async function updateExternalIdentitySnapshot(
  db: Db,
  snapshot: ExternalIdentitySnapshot,
  audit: AuditEvents,
): Promise<UpdateExternalIdentitySnapshotResult> {
  const owned = and(
    eq(externalIdentities.id, snapshot.id),
    eq(externalIdentities.userId, snapshot.userId),
  );
  const [update] = await db.batch([
    db
      .update(externalIdentities)
      .set({
        usernameSnapshot: snapshot.usernameSnapshot,
        displayNameSnapshot: snapshot.displayNameSnapshot,
        avatarUrlSnapshot: snapshot.avatarUrlSnapshot,
        verifiedAt: snapshot.verifiedAt,
        updatedAt: snapshot.now,
      })
      .where(owned),
    ...conditionalAuditInserts(
      db,
      audit,
      sql`EXISTS (SELECT 1 FROM ${externalIdentities} WHERE ${owned})`,
    ),
  ]);
  return update.meta.changes > 0 ? { ok: true } : { ok: false, reason: "identity_not_owned" };
}
