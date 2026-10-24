import {
  type AuditEvent,
  type Instant,
  type RateLimitBucket,
  rateLimitWindowStart,
} from "@sharerepo/domain";
import { and, desc, eq, gt, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { type AuditEvents, auditInserts, conditionalAuditInserts } from "./audit-repository.ts";
import { insertWhere, runBatch, type Statement } from "./batch.ts";
import type { Db } from "./client.ts";
import { dedupedOutboxInsert, type NewOutboxRow } from "./outbox-repository.ts";
import { checkoutClaims, claimRequests, claimTokens } from "./schema/index.ts";

// Purchase claims (decision 0012). Every single-use write is one guarded statement, and its
// audit events are inserted in the same batch under the same guard, ahead of the write (once the
// write runs, its guard no longer holds).

export type CheckoutClaim = typeof checkoutClaims.$inferSelect;
export type ClaimRequest = typeof claimRequests.$inferSelect;
export type ClaimToken = typeof claimTokens.$inferSelect;

const exists = (table: SQLiteTable, where: SQL | undefined) =>
  sql`EXISTS (SELECT 1 FROM ${table} WHERE ${where})`;

function guardedAudit(db: Db, audit: readonly AuditEvent[], condition: SQL): Statement[] {
  return audit.length > 0 ? conditionalAuditInserts(db, audit as AuditEvents, condition) : [];
}

// --- Checkout claims (path 1) ---

/** Records a checkout claim (unconsumed, no transaction yet) with its audit events. */
export async function createCheckoutClaim(
  db: Db,
  claim: Omit<
    CheckoutClaim,
    "transactionId" | "checkoutUrl" | "consumedByCustomerId" | "consumedAt"
  >,
  audit: AuditEvents,
): Promise<CheckoutClaim> {
  const row: CheckoutClaim = {
    ...claim,
    transactionId: null,
    checkoutUrl: null,
    consumedByCustomerId: null,
    consumedAt: null,
  };
  await runBatch(db, [db.insert(checkoutClaims).values(row), ...auditInserts(db, audit)]);
  return row;
}

export async function getCheckoutClaim(
  db: Db,
  key: { workspaceId: string; id: string },
): Promise<CheckoutClaim | null> {
  const rows = await db
    .select()
    .from(checkoutClaims)
    .where(and(eq(checkoutClaims.workspaceId, key.workspaceId), eq(checkoutClaims.id, key.id)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Records the Paddle transaction a checkout claim started, and its checkout URL, once (guarded on
 * no transaction being set). `audit` (for example `checkout.started`, once the transaction
 * exists) is written under the same guard; it may be empty.
 */
export async function setCheckoutClaimTransaction(
  db: Db,
  input: { workspaceId: string; id: string; transactionId: string; checkoutUrl?: string },
  audit: readonly AuditEvent[] = [],
): Promise<{ ok: true } | { ok: false; reason: "stale" }> {
  const guard = and(
    eq(checkoutClaims.workspaceId, input.workspaceId),
    eq(checkoutClaims.id, input.id),
    isNull(checkoutClaims.transactionId),
  );
  const changes = await runBatch(db, [
    ...guardedAudit(db, audit, exists(checkoutClaims, guard)),
    db
      .update(checkoutClaims)
      .set({ transactionId: input.transactionId, checkoutUrl: input.checkoutUrl ?? null })
      .where(guard),
  ]);
  return changes.at(-1) === 1 ? { ok: true } : { ok: false, reason: "stale" };
}

/**
 * The newest checkout the user started for this offer and price, in its workspace, after
 * `createdAfter`, that can still be sent to: it has a transaction and checkout URL, is unconsumed, and
 * is unexpired at `now`. Null when there is none.
 */
export async function findReusableCheckoutClaim(
  db: Db,
  key: {
    workspaceId: string;
    userId: string;
    offerId: string;
    priceId: string;
    createdAfter: Instant;
    now: Instant;
  },
): Promise<(CheckoutClaim & { transactionId: string; checkoutUrl: string }) | null> {
  const rows = await db
    .select()
    .from(checkoutClaims)
    .where(
      and(
        eq(checkoutClaims.workspaceId, key.workspaceId),
        eq(checkoutClaims.userId, key.userId),
        eq(checkoutClaims.offerId, key.offerId),
        eq(checkoutClaims.priceId, key.priceId),
        gt(checkoutClaims.createdAt, key.createdAfter),
        gt(checkoutClaims.expiresAt, key.now),
        isNull(checkoutClaims.consumedByCustomerId),
        isNotNull(checkoutClaims.transactionId),
        isNotNull(checkoutClaims.checkoutUrl),
      ),
    )
    .orderBy(desc(checkoutClaims.createdAt), desc(checkoutClaims.id))
    .limit(1);
  return (
    (rows[0] as (CheckoutClaim & { transactionId: string; checkoutUrl: string }) | undefined) ??
    null
  );
}

/** "This checkout claim is unconsumed and unexpired at `now`", in its workspace. */
function checkoutUnconsumed(key: { workspaceId: string; id: string; now: Instant }) {
  return and(
    eq(checkoutClaims.workspaceId, key.workspaceId),
    eq(checkoutClaims.id, key.id),
    isNull(checkoutClaims.consumedByCustomerId),
    sql`${checkoutClaims.expiresAt} > ${key.now}`,
  );
}

export type ConsumeCheckoutClaimResult =
  /** `first` is true when this call consumed it; false for a renewal of the same customer. */
  | { ok: true; first: boolean }
  | { ok: false; reason: "not_found" | "expired" | "consumed_by_other_customer" };

/**
 * Consumes a checkout claim for `customerId`, in its workspace. The first use requires the claim
 * to be unexpired at `now`; later uses by the same customer (renewals) stay valid and write
 * nothing. A claim consumed by another customer is refused. The audit events are written only
 * when this call consumed the claim.
 */
export async function consumeCheckoutClaim(
  db: Db,
  input: { workspaceId: string; id: string; customerId: string; now: Instant },
  audit: readonly AuditEvent[] = [],
): Promise<ConsumeCheckoutClaimResult> {
  const unconsumed = checkoutUnconsumed(input);
  const changes = await runBatch(db, [
    ...guardedAudit(db, audit, exists(checkoutClaims, unconsumed)),
    db
      .update(checkoutClaims)
      .set({ consumedByCustomerId: input.customerId, consumedAt: input.now })
      .where(unconsumed),
  ]);
  if (changes.at(-1) === 1) return { ok: true, first: true };
  const claim = await getCheckoutClaim(db, input);
  if (claim === null) return { ok: false, reason: "not_found" };
  if (claim.consumedByCustomerId === input.customerId) return { ok: true, first: false };
  if (claim.consumedByCustomerId !== null) {
    return { ok: false, reason: "consumed_by_other_customer" };
  }
  return { ok: false, reason: "expired" };
}

// --- Claim requests (path 2) ---

/**
 * Records a claim request (the email only as its envelope) with its audit event and the
 * `send_claim_email` outbox row, in one batch.
 */
export async function createClaimRequest(
  db: Db,
  input: {
    request: Omit<ClaimRequest, "processedAt">;
    outbox: NewOutboxRow;
  },
  audit: AuditEvents,
): Promise<ClaimRequest> {
  const row: ClaimRequest = { ...input.request, processedAt: null };
  await runBatch(db, [
    db.insert(claimRequests).values(row),
    dedupedOutboxInsert(db, input.outbox),
    ...auditInserts(db, audit),
  ]);
  return row;
}

export async function getClaimRequest(
  db: Db,
  key: { workspaceId: string; id: string },
): Promise<ClaimRequest | null> {
  const rows = await db
    .select()
    .from(claimRequests)
    .where(and(eq(claimRequests.workspaceId, key.workspaceId), eq(claimRequests.id, key.id)))
    .limit(1);
  return rows[0] ?? null;
}

/** A claim token to issue; created unconsumed. */
export type NewClaimToken = Omit<ClaimToken, "consumedAt" | "consumedByUserId">;

const freshToken = (token: NewClaimToken): ClaimToken => ({
  ...token,
  consumedAt: null,
  consumedByUserId: null,
});

/**
 * Finishes a claim request, once: erases the email envelope, stamps `processed_at`, and inserts
 * the claim tokens issued for it (all in the request's workspace), with `audit` (a
 * `claim.token_issued` per token), all guarded on the request being unprocessed. A request that
 * matched nothing finishes with no tokens; erasing the email is then the only change.
 */
export async function finishClaimRequest(
  db: Db,
  input: {
    workspaceId: string;
    id: string;
    now: Instant;
    tokens?: readonly NewClaimToken[];
  },
  audit: readonly AuditEvent[] = [],
): Promise<{ ok: true } | { ok: false; reason: "stale" }> {
  const tokens = input.tokens ?? [];
  if (!tokens.every((token) => token.workspaceId === input.workspaceId)) {
    throw new Error("finishClaimRequest: tokens must belong to the request's workspace");
  }
  const guard = and(
    eq(claimRequests.workspaceId, input.workspaceId),
    eq(claimRequests.id, input.id),
    isNull(claimRequests.processedAt),
  );
  const pending = exists(claimRequests, guard);
  const changes = await runBatch(db, [
    ...tokens.map((token) => insertWhere(db, claimTokens, freshToken(token), pending)),
    ...guardedAudit(db, audit, pending),
    db.update(claimRequests).set({ emailEnvelope: null, processedAt: input.now }).where(guard),
  ]);
  return changes.at(-1) === 1 ? { ok: true } : { ok: false, reason: "stale" };
}

// --- Claim tokens (path 2) ---

/** Issues claim tokens with their audit events (`claim.token_issued`), in one batch. */
export async function createClaimTokens(
  db: Db,
  tokens: readonly NewClaimToken[],
  audit: AuditEvents,
): Promise<ClaimToken[]> {
  const rows = tokens.map(freshToken);
  await runBatch(db, [
    ...rows.map((row) => db.insert(claimTokens).values(row)),
    ...auditInserts(db, audit),
  ]);
  return rows;
}

/**
 * System use (`/claim/:token`): the token with this SHA-256, in any workspace. The hash of a
 * 256-bit random token is the capability; the caller checks expiry and use.
 */
export async function findClaimTokenByHash(db: Db, tokenHash: string): Promise<ClaimToken | null> {
  const rows = await db
    .select()
    .from(claimTokens)
    .where(eq(claimTokens.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export type ConsumeClaimTokenResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "expired" | "already_used" };

/** "This token is unused and unexpired at `now`", in its workspace. */
function claimTokenUsable(key: { workspaceId: string; id: string; now: Instant }) {
  return and(
    eq(claimTokens.workspaceId, key.workspaceId),
    eq(claimTokens.id, key.id),
    isNull(claimTokens.consumedAt),
    sql`${claimTokens.expiresAt} > ${key.now}`,
  );
}

/**
 * Consumes a claim token for `userId`, once: only while it is unused and unexpired at `now`. The
 * audit events are written only if this call consumed it.
 */
export async function consumeClaimToken(
  db: Db,
  input: { workspaceId: string; id: string; userId: string; now: Instant },
  audit: readonly AuditEvent[] = [],
): Promise<ConsumeClaimTokenResult> {
  const usable = claimTokenUsable(input);
  const changes = await runBatch(db, [
    ...guardedAudit(db, audit, exists(claimTokens, usable)),
    db
      .update(claimTokens)
      .set({ consumedAt: input.now, consumedByUserId: input.userId })
      .where(usable),
  ]);
  if (changes.at(-1) === 1) return { ok: true };
  const rows = await db
    .select()
    .from(claimTokens)
    .where(and(eq(claimTokens.workspaceId, input.workspaceId), eq(claimTokens.id, input.id)))
    .limit(1);
  const token = rows[0];
  if (token === undefined) return { ok: false, reason: "not_found" };
  return { ok: false, reason: token.consumedAt === null ? "expired" : "already_used" };
}

// --- Rate limits ---

/**
 * Takes one request from every bucket, or from none: true when the request is allowed, and then
 * counted once in each bucket's current window; false when any bucket is at its limit, and then
 * no counter changes, so refused requests never use up a limit (the domain's
 * `rateLimitDecision`, applied atomically). Windows are aligned to the epoch; a counter stored
 * for another window restarts.
 *
 * One statement does it: an UPSERT whose rows are selected only if no bucket is exhausted. SQLite
 * evaluates a SELECT that reads the target table in full before inserting, so the check sees the
 * counters as they were before this request. Counting is bookkeeping: no audit.
 */
export async function takeRateLimits(
  db: Db,
  buckets: readonly RateLimitBucket[],
  now: Instant,
): Promise<boolean> {
  if (buckets.length === 0) return true;
  const requested = sql.join(
    buckets.map(
      ({ bucket, windowMs, limit }) =>
        sql`(${bucket}, ${rateLimitWindowStart(windowMs, now)}, ${limit})`,
    ),
    sql`, `,
  );
  const rows = await db.all<{ bucket: string }>(sql`
    WITH requested (bucket, window_start, request_limit) AS (VALUES ${requested})
    INSERT INTO claim_rate_limits (bucket, window_start, count)
    SELECT bucket, window_start, 1 FROM requested
    WHERE NOT EXISTS (
      SELECT 1 FROM requested AS r JOIN claim_rate_limits AS c ON c.bucket = r.bucket
      WHERE c.window_start = r.window_start AND c.count >= r.request_limit
    )
    ON CONFLICT (bucket) DO UPDATE SET
      count = CASE WHEN claim_rate_limits.window_start = excluded.window_start
        THEN claim_rate_limits.count + 1 ELSE 1 END,
      window_start = excluded.window_start
    RETURNING bucket`);
  return rows.length === buckets.length;
}

/** A single-use claim a link consumes in the same batch (see `applyCustomerLink`). */
export type ClaimConsumption =
  /** Path 1: the first use of a checkout claim, by the customer being linked. */
  | { kind: "checkout_claim"; id: string }
  /** Path 2: an emailed claim token for the customer being linked, used by `userId`. */
  | { kind: "claim_token"; id: string; userId: string };

/**
 * For a link that consumes a claim: `usable`, the SQL that holds while the claim can still be
 * consumed for `customerId` at `now`, and `consume`, the statement that consumes it only if the
 * statement just before it in the batch changed a row (`changes() = 1`). The link write puts the
 * guarded change immediately before `consume`, so the claim is used exactly when the link is
 * made, and a used claim (whoever used it, whenever) never guards a second link.
 */
export function consumeForLink(
  db: Db,
  input: { workspaceId: string; customerId: string; now: Instant; consumption: ClaimConsumption },
): { usable: SQL; consume: Statement } {
  const { workspaceId, customerId, now, consumption } = input;
  if (consumption.kind === "checkout_claim") {
    const unconsumed = checkoutUnconsumed({ workspaceId, id: consumption.id, now });
    return {
      usable: exists(checkoutClaims, unconsumed),
      consume: db
        .update(checkoutClaims)
        .set({ consumedByCustomerId: customerId, consumedAt: now })
        .where(and(unconsumed, sql`changes() = 1`)),
    };
  }
  const usable = and(
    claimTokenUsable({ workspaceId, id: consumption.id, now }),
    eq(claimTokens.customerId, customerId),
  );
  return {
    usable: exists(claimTokens, usable),
    consume: db
      .update(claimTokens)
      .set({ consumedAt: now, consumedByUserId: consumption.userId })
      .where(and(usable, sql`changes() = 1`)),
  };
}
