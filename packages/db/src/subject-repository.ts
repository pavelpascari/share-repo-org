import type { IdentityProvider, Instant } from "@sharerepo/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type AuditEvents, auditInserts, conditionalAuditInserts } from "./audit-repository.ts";
import { insertWhere, runBatch } from "./batch.ts";
import { ascending, selectInChunks } from "./chunks.ts";
import type { Db } from "./client.ts";
import type { ExternalIdentity } from "./identity-repository.ts";
import { subjects } from "./schema/index.ts";

/** Domain `Subject`: an access-provider principal, keyed by its immutable external ID. */
export type Subject = typeof subjects.$inferSelect;

export async function findSubjectByExternalId(
  db: Db,
  key: { workspaceId: string; provider: IdentityProvider; externalSubjectId: string },
): Promise<Subject | null> {
  const rows = await db
    .select()
    .from(subjects)
    .where(
      and(
        eq(subjects.workspaceId, key.workspaceId),
        eq(subjects.provider, key.provider),
        eq(subjects.externalSubjectId, key.externalSubjectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** The workspace's subject by ID; null for an unknown ID or another workspace's subject. */
export async function getSubject(
  db: Db,
  key: { workspaceId: string; subjectId: string },
): Promise<Subject | null> {
  const rows = await db
    .select()
    .from(subjects)
    .where(and(eq(subjects.workspaceId, key.workspaceId), eq(subjects.id, key.subjectId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Inserts a subject with its audit events, in one batch. A subject with the same external ID in
 * the workspace fails the UNIQUE constraint as is (nothing is written); the caller re-reads it
 * with `findSubjectByExternalId`.
 */
export async function insertSubject(db: Db, subject: Subject, audit: AuditEvents): Promise<void> {
  await runBatch(db, [db.insert(subjects).values(subject), ...auditInserts(db, audit)]);
}

/**
 * The workspace's subjects with these IDs, by login; IDs of other workspaces are ignored. The IDs
 * are bound in chunks (D1's parameter limit).
 */
export async function listSubjects(
  db: Db,
  key: { workspaceId: string; ids: readonly string[] },
): Promise<Subject[]> {
  const rows = await selectInChunks(key.ids, (chunk) =>
    db
      .select()
      .from(subjects)
      .where(and(eq(subjects.workspaceId, key.workspaceId), inArray(subjects.id, chunk))),
  );
  return rows.sort((a, b) => ascending(a.loginSnapshot, b.loginSnapshot) || ascending(a.id, b.id));
}

/**
 * The workspace's subject for a user's GitHub account, created (with `audit`, typically
 * `subject.created`) if the workspace has none. A subject is keyed by the account's immutable ID,
 * so one created earlier from commercial data (without the identity link) is the same principal
 * and is returned as it is. `subjectId` is the ID of the row to create, which `audit` names.
 * One batch: the insert is skipped when the key exists (also when a concurrent caller
 * just created it), and the audit events are written only if this call's row was inserted.
 */
export async function findOrCreateSubjectForIdentity(
  db: Db,
  input: {
    workspaceId: string;
    identity: Pick<ExternalIdentity, "id" | "provider" | "externalUserId" | "usernameSnapshot">;
    subjectId: string;
    now: Instant;
  },
  audit: AuditEvents,
): Promise<{ subject: Subject; created: boolean }> {
  const { workspaceId, identity, now } = input;
  const key = {
    workspaceId,
    provider: identity.provider,
    externalSubjectId: identity.externalUserId,
  };
  const subject: Subject = {
    id: input.subjectId,
    workspaceId,
    provider: identity.provider,
    type: "user",
    externalSubjectId: identity.externalUserId,
    loginSnapshot: identity.usernameSnapshot,
    externalIdentityId: identity.id,
    createdAt: now,
    updatedAt: now,
  };
  const absent = sql`NOT EXISTS (SELECT 1 FROM ${subjects} WHERE ${and(
    eq(subjects.workspaceId, workspaceId),
    eq(subjects.provider, identity.provider),
    eq(subjects.externalSubjectId, identity.externalUserId),
  )})`;
  const created = sql`EXISTS (SELECT 1 FROM ${subjects} WHERE ${and(
    eq(subjects.workspaceId, workspaceId),
    eq(subjects.id, subject.id),
  )})`;
  const [inserted] = await runBatch(db, [
    insertWhere(db, subjects, subject, absent),
    ...conditionalAuditInserts(db, audit, created),
  ]);
  if (inserted === 1) return { subject, created: true };
  // The insert was skipped only because a subject with this key exists.
  return { subject: (await findSubjectByExternalId(db, key)) as Subject, created: false };
}

export type UpdateSubjectLoginResult =
  | { ok: true }
  /** The subject's login is no longer `previousLogin` (or it does not exist): nothing written. */
  | { ok: false; reason: "stale" };

/**
 * Records a subject's new login snapshot (the account was renamed; its immutable ID is the same)
 * with its audit events, in one batch conditional on the login still being `previousLogin`. The
 * audit inserts run first, guarded by that condition, and the update last: once it runs, the
 * condition no longer holds.
 */
export async function updateSubjectLogin(
  db: Db,
  input: {
    workspaceId: string;
    subjectId: string;
    previousLogin: string;
    login: string;
    now: Instant;
  },
  audit: AuditEvents,
): Promise<UpdateSubjectLoginResult> {
  const current = and(
    eq(subjects.workspaceId, input.workspaceId),
    eq(subjects.id, input.subjectId),
    eq(subjects.loginSnapshot, input.previousLogin),
  );
  const changes = await runBatch(db, [
    ...conditionalAuditInserts(db, audit, sql`EXISTS (SELECT 1 FROM ${subjects} WHERE ${current})`),
    db.update(subjects).set({ loginSnapshot: input.login, updatedAt: input.now }).where(current),
  ]);
  return changes.at(-1) === 1 ? { ok: true } : { ok: false, reason: "stale" };
}
