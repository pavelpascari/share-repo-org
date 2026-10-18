import type { IdentityProvider } from "@sharerepo/domain";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type AuditEvents, auditInserts } from "./audit-repository.ts";
import { runBatch } from "./batch.ts";
import type { Db } from "./client.ts";
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

/**
 * Inserts a subject with its audit events, in one batch. A subject with the same external ID in
 * the workspace fails the UNIQUE constraint as is (nothing is written); the caller re-reads it
 * with `findSubjectByExternalId`.
 */
export async function insertSubject(db: Db, subject: Subject, audit: AuditEvents): Promise<void> {
  await runBatch(db, [db.insert(subjects).values(subject), ...auditInserts(db, audit)]);
}

/** The workspace's subjects with these IDs, by login; IDs of other workspaces are ignored. */
export async function listSubjects(
  db: Db,
  key: { workspaceId: string; ids: readonly string[] },
): Promise<Subject[]> {
  if (key.ids.length === 0) return [];
  return db
    .select()
    .from(subjects)
    .where(and(eq(subjects.workspaceId, key.workspaceId), inArray(subjects.id, [...key.ids])))
    .orderBy(asc(subjects.loginSnapshot), asc(subjects.id));
}
