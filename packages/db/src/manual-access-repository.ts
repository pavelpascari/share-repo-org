import type { Instant, WorkspaceStatus } from "@sharerepo/domain";
import { and, asc, desc, eq, isNotNull, isNull, lte, type SQL, sql } from "drizzle-orm";
import { type AuditEvents, conditionalAuditInserts } from "./audit-repository.ts";
import { insertWhere, runBatch, type Statement } from "./batch.ts";
import type { Db } from "./client.ts";
import { isUniqueViolation } from "./errors.ts";
import { assertReconcileRows, type NewOutboxRow } from "./outbox-repository.ts";
import { reconcileRequest } from "./reconcile-repository.ts";
import {
  entitlements,
  manualAccesses,
  offers,
  subjects,
  workspaceMemberships,
  workspaces,
} from "./schema/index.ts";
import type {
  Entitlement,
  EntitlementPlanWrite,
  OfferVersionRef,
} from "./subscription-repository.ts";

// Manual access (decision 0016): an owner's grant of an offer's repositories to a subject, with
// no subscription. Its entitlements have `source_type` `manual` and name it as `source_id`.

/** Domain manual access, as stored. */
export type ManualAccess = typeof manualAccesses.$inferSelect;

export async function getManualAccess(
  db: Db,
  key: { workspaceId: string; id: string },
): Promise<ManualAccess | null> {
  const rows = await db
    .select()
    .from(manualAccesses)
    .where(and(eq(manualAccesses.workspaceId, key.workspaceId), eq(manualAccesses.id, key.id)))
    .limit(1);
  return rows[0] ?? null;
}

/** A manual access as the owner's page lists it: with its offer and its GitHub account. */
export interface ManualAccessListing {
  access: ManualAccess;
  offerName: string;
  /** The account's login when it was last seen, and its immutable GitHub ID. */
  subjectLogin: string;
  subjectExternalId: string;
  /** How many of its entitlements are live (`active`). */
  liveEntitlements: number;
}

/** The workspace's manual accesses, newest first, revoked ones too. */
export async function listManualAccesses(
  db: Db,
  workspaceId: string,
): Promise<ManualAccessListing[]> {
  const live = sql<number>`(SELECT count(*) FROM ${entitlements} WHERE ${entitlements.workspaceId} = ${manualAccesses.workspaceId} AND ${entitlements.sourceType} = 'manual' AND ${entitlements.sourceId} = ${manualAccesses.id} AND ${entitlements.state} = 'active')`;
  const rows = await db
    .select({
      access: manualAccesses,
      offerName: offers.name,
      subjectLogin: subjects.loginSnapshot,
      subjectExternalId: subjects.externalSubjectId,
      liveEntitlements: live,
    })
    .from(manualAccesses)
    // Both joins are on the workspace too (and composite foreign keys enforce it).
    .innerJoin(
      offers,
      and(
        eq(offers.workspaceId, manualAccesses.workspaceId),
        eq(offers.id, manualAccesses.offerId),
      ),
    )
    .innerJoin(
      subjects,
      and(
        eq(subjects.workspaceId, manualAccesses.workspaceId),
        eq(subjects.id, manualAccesses.subjectId),
      ),
    )
    .where(eq(manualAccesses.workspaceId, workspaceId))
    .orderBy(desc(manualAccesses.createdAt), asc(manualAccesses.id));
  return rows.map((row) => ({ ...row, liveEntitlements: Number(row.liveEntitlements) }));
}

/** The manual access's live entitlements, oldest first. */
export async function listLiveEntitlementsForManualAccess(
  db: Db,
  key: { workspaceId: string; manualAccessId: string },
): Promise<Entitlement[]> {
  return db
    .select()
    .from(entitlements)
    .where(
      and(
        eq(entitlements.workspaceId, key.workspaceId),
        eq(entitlements.sourceType, "manual"),
        eq(entitlements.sourceId, key.manualAccessId),
        eq(entitlements.state, "active"),
      ),
    )
    .orderBy(asc(entitlements.createdAt), asc(entitlements.id));
}

/** One manual access's decision, ready to write. */
export interface ManualAccessWrite {
  workspaceId: string;
  now: Instant;
  /** The access's `version` when the decision read it; 0 to create it. */
  expectedVersion: number;
  /** The complete new row, at `expectedVersion + 1`. */
  access: ManualAccess;
  /** Its offer, at the version the plan was decided from. */
  offer: OfferVersionRef;
  /**
   * When creating: at most this many open (not revoked) manual accesses may exist in the
   * workspace before it, counted in the batch itself.
   */
  openLimit?: number;
  /**
   * The workspace status the decision was made under (it decides whether access is withdrawn).
   * The write is stale unless the workspace still has it, checked in the batch: a deletion
   * requested or cancelled after the read cannot be overwritten by a decision made before it.
   */
  workspaceStatus: WorkspaceStatus;
  /**
   * For an owner's change: the user, who must still own the workspace when the batch runs, so a
   * membership removed after the authorization check authorizes nothing. Absent for system work.
   */
  ownerUserId?: string;
  entitlements: EntitlementPlanWrite;
  /**
   * `reconcile_resource` rows for every repository whose entitlements the plan changes. Each is
   * inserted unless one with its key is pending, and stamps the repository's reconcile request.
   */
  reconcile: readonly NewOutboxRow[];
}

export type ManualAccessWriteResult =
  | { ok: true }
  /**
   * `stale`: the access or its offer changed since it was read, the workspace left the status it
   * was read in, or the owner no longer owns it, so nothing was written; read (and authorize) again
   * and decide again. `already_open`: creating, but the subject already has an open manual access
   * to the offer. `limit_reached`: creating, but the workspace has `openLimit` open ones.
   */
  | { ok: false; reason: "stale" | "already_open" | "limit_reached" };

const OPEN_KEY = [
  "manual_accesses.workspace_id",
  "manual_accesses.offer_id",
  "manual_accesses.subject_id",
] as const;

/** Rows a write changes must belong to the manual access; anything else is a caller defect. */
function assertWriteScoped(input: ManualAccessWrite): void {
  const { workspaceId, access } = input;
  assertReconcileRows(input.reconcile, workspaceId, "applyManualAccessWrite");
  const scoped =
    access.workspaceId === workspaceId &&
    access.version === input.expectedVersion + 1 &&
    access.offerId === input.offer.offerId &&
    (input.expectedVersion > 0 || input.openLimit !== undefined) &&
    input.entitlements.create.every(
      (row) =>
        row.workspaceId === workspaceId &&
        row.sourceType === "manual" &&
        row.sourceId === access.id &&
        row.subjectId === access.subjectId,
    );
  if (!scoped) {
    throw new Error(
      "applyManualAccessWrite: rows must belong to the manual access at expectedVersion + 1, and a new one needs openLimit",
    );
  }
}

const openCount = (workspaceId: string) =>
  sql`(SELECT count(*) FROM ${manualAccesses} WHERE ${manualAccesses.workspaceId} = ${workspaceId} AND ${manualAccesses.revokedAt} IS NULL)`;

/**
 * Writes one manual access decision in one atomic batch (decision 0003): the access row, its
 * entitlement plan, reconcile requests and audit events. Like `applySubscriptionRefresh`:
 *
 * Every statement is guarded on the decision's facts still holding when the batch runs: the offer
 * at the version read, the workspace in the status read and, for an owner's change, the owner
 * still owning it. A deletion, an offer edit or a lost membership that commits after the read
 * therefore makes the write `stale` rather than racing it.
 *
 * - **Creating** (`expectedVersion` 0): the INSERT runs first, only while those facts hold and the workspace has fewer than `openLimit` open manual accesses; the rest
 *   is guarded on the new row existing. An open access of the same offer and subject fails the
 *   partial unique index and rolls everything back (`already_open`).
 * - **Existing**: every statement is guarded on the access still being at `expectedVersion` and
 *   the offer at its version; the access UPDATE, which bumps the version, runs last.
 *
 * Entitlement ends run before creates, and touch only live entitlements of this access.
 */
export async function applyManualAccessWrite(
  db: Db,
  input: ManualAccessWrite,
  audit: AuditEvents,
): Promise<ManualAccessWriteResult> {
  assertWriteScoped(input);
  const { workspaceId, now, expectedVersion, access } = input;
  const creating = expectedVersion === 0;
  // The offer at its version, the workspace at its status, and the owner still an owner: the
  // facts the decision and its authorization were made under, re-checked inside the batch.
  const ownerStill =
    input.ownerUserId === undefined
      ? sql`1`
      : sql`EXISTS (SELECT 1 FROM ${workspaceMemberships} WHERE ${workspaceMemberships.workspaceId} = ${workspaceId} AND ${workspaceMemberships.userId} = ${input.ownerUserId} AND ${workspaceMemberships.role} = 'owner')`;
  const decisionCurrent = sql`EXISTS (SELECT 1 FROM ${offers} WHERE ${offers.workspaceId} = ${workspaceId} AND ${offers.id} = ${input.offer.offerId} AND ${offers.version} = ${input.offer.version}) AND EXISTS (SELECT 1 FROM ${workspaces} WHERE ${workspaces.id} = ${workspaceId} AND ${workspaces.status} = ${input.workspaceStatus}) AND ${ownerStill}`;
  const current = and(
    eq(manualAccesses.workspaceId, workspaceId),
    eq(manualAccesses.id, access.id),
    eq(manualAccesses.version, expectedVersion),
  ) as SQL;
  const guard = creating
    ? sql`EXISTS (SELECT 1 FROM ${manualAccesses} WHERE ${manualAccesses.workspaceId} = ${workspaceId} AND ${manualAccesses.id} = ${access.id})`
    : sql`EXISTS (SELECT 1 FROM ${manualAccesses} WHERE ${current}) AND ${decisionCurrent}`;

  const statements: Statement[] = [];
  if (creating) {
    statements.push(
      insertWhere(
        db,
        manualAccesses,
        access,
        sql`${decisionCurrent} AND ${openCount(workspaceId)} < ${input.openLimit as number}`,
      ),
    );
  }
  const ofAccess = (id: string) =>
    and(
      eq(entitlements.workspaceId, workspaceId),
      eq(entitlements.sourceType, "manual"),
      eq(entitlements.sourceId, access.id),
      eq(entitlements.id, id),
      eq(entitlements.state, "active"),
      guard,
    );
  statements.push(
    ...input.entitlements.end.map(({ id, state, reason }) =>
      db
        .update(entitlements)
        .set({ state, decisionReason: reason, endedAt: now, updatedAt: now })
        .where(ofAccess(id)),
    ),
    ...input.entitlements.update.map(({ id, set }) =>
      db
        .update(entitlements)
        .set({ ...set, updatedAt: now })
        .where(ofAccess(id)),
    ),
    ...input.entitlements.create.map((row) => insertWhere(db, entitlements, row, guard)),
    ...input.reconcile.flatMap((row) => reconcileRequest(db, workspaceId, row, guard)),
    ...conditionalAuditInserts(db, audit, guard),
  );
  if (!creating) {
    const { id: _id, workspaceId: _ws, createdAt: _createdAt, ...fields } = access;
    // Last: once it runs, the guard no longer holds.
    statements.push(db.update(manualAccesses).set(fields).where(and(current, decisionCurrent)));
  }

  let changes: number[];
  try {
    changes = await runBatch(db, statements);
  } catch (error) {
    if (creating && isUniqueViolation(error, OPEN_KEY)) {
      return { ok: false, reason: "already_open" };
    }
    throw error;
  }
  if (changes.at(creating ? 0 : -1) === 1) return { ok: true };
  if (creating) {
    const [row] = await db.all<{ open: number }>(sql`SELECT ${openCount(workspaceId)} AS open`);
    if (Number(row?.open) >= (input.openLimit as number)) {
      return { ok: false, reason: "limit_reached" };
    }
  }
  return { ok: false, reason: "stale" };
}

/** A manual access due for evaluation, by workspace and ID. */
export interface DueManualAccess {
  workspaceId: string;
  id: string;
}

/**
 * Up to `limit` manual accesses, in any workspace, whose `next_evaluation_at` has passed, oldest
 * due first. The sweep evaluates each; the write that follows sets its next boundary or clears it.
 */
export async function listDueManualAccesses(
  db: Db,
  input: { now: Instant; limit: number },
): Promise<DueManualAccess[]> {
  return db
    .select({ workspaceId: manualAccesses.workspaceId, id: manualAccesses.id })
    .from(manualAccesses)
    .where(
      and(
        isNotNull(manualAccesses.nextEvaluationAt),
        lte(manualAccesses.nextEvaluationAt, input.now),
      ),
    )
    .orderBy(asc(manualAccesses.nextEvaluationAt), asc(manualAccesses.id))
    .limit(input.limit);
}

/**
 * The statement that makes a workspace's open manual accesses (of one offer, with `offerId`) due
 * for evaluation now, only if `when` holds. It bumps their version, so a decision read before it
 * cannot overwrite the timer: its write is stale and decides again. Revoked accesses have nothing
 * left to decide.
 */
export function manualAccessesDue(
  db: Db,
  input: { workspaceId: string; offerId?: string; now: Instant; when?: SQL },
): Statement {
  return db
    .update(manualAccesses)
    .set({
      nextEvaluationAt: input.now,
      version: sql`${manualAccesses.version} + 1`,
      updatedAt: sql`max(${manualAccesses.updatedAt}, ${input.now})`,
    })
    .where(
      and(
        eq(manualAccesses.workspaceId, input.workspaceId),
        input.offerId === undefined ? undefined : eq(manualAccesses.offerId, input.offerId),
        isNull(manualAccesses.revokedAt),
        input.when,
      ),
    );
}

/**
 * Makes a workspace's open manual accesses (of one offer, with `offerId`) due for evaluation now,
 * as {@link manualAccessesDue}. Returns how many.
 */
export async function markManualAccessesDue(
  db: Db,
  input: { workspaceId: string; offerId?: string; now: Instant },
): Promise<number> {
  const [changed] = await runBatch(db, [manualAccessesDue(db, input)]);
  return changed as number;
}
