import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { claimRequests } from "./schema/index.ts";

// Tenant credential envelopes across tables, for the `rewrap_credentials` job (Phase 6, secret
// rotation): every envelope records the ID of the master key that sealed it (`kid`), so the
// envelopes still under a retired key can be found and moved to the current one before that key
// is removed from `CREDENTIAL_KEYS`.

/** Where an envelope is stored, and what it seals (its AAD purpose). */
export type StoredEnvelopeField = "api_key" | "webhook_secret" | "webhook_secret_next" | "email";

/** One stored envelope, with the row it is bound to. */
export interface StoredEnvelope {
  readonly table: "paddle_connections" | "claim_requests";
  readonly field: StoredEnvelopeField;
  readonly workspaceId: string;
  readonly rowId: string;
  readonly envelope: string;
}

/** Every envelope column, in the order the job visits them. Identifiers, never input. */
const ENVELOPE_COLUMNS = [
  { table: "paddle_connections", field: "api_key", column: "api_key_envelope" },
  { table: "paddle_connections", field: "webhook_secret", column: "webhook_secret_envelope" },
  {
    table: "paddle_connections",
    field: "webhook_secret_next",
    column: "webhook_secret_next_envelope",
  },
  { table: "claim_requests", field: "email", column: "email_envelope" },
] as const;

/** Every stored envelope sealed under one of `keyIds`, as one query over every envelope column. */
function envelopesUnder(keyIds: readonly string[]) {
  const ids = sql.join(
    keyIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql.join(
    ENVELOPE_COLUMNS.map(({ table, field, column }, order) => {
      const envelope = sql.raw(column);
      return sql`SELECT ${order} AS ord, ${table} AS "table", ${field} AS field, workspace_id AS workspaceId, id AS rowId, ${envelope} AS envelope FROM ${sql.raw(table)} WHERE json_extract(${envelope}, '$.kid') IN (${ids})`;
    }),
    sql` UNION ALL `,
  );
}

/**
 * Up to `limit` envelopes sealed under one of `keyIds` (the keyring's listed keys other than the
 * current one), in a stable order: table, field, then row. Empty when `keyIds` is.
 */
export async function listEnvelopesUnderKeys(
  db: Db,
  input: { keyIds: readonly string[]; limit: number },
): Promise<StoredEnvelope[]> {
  if (input.keyIds.length === 0) return [];
  return db.all<StoredEnvelope>(
    sql`SELECT "table", field, workspaceId, rowId, envelope FROM (${envelopesUnder(input.keyIds)}) ORDER BY ord, rowId LIMIT ${input.limit}`,
  );
}

/** How many envelopes are sealed under one of `keyIds`; 0 when `keyIds` is empty. */
export async function countEnvelopesUnderKeys(db: Db, keyIds: readonly string[]): Promise<number> {
  if (keyIds.length === 0) return 0;
  const [row] = await db.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM (${envelopesUnder(keyIds)})`,
  );
  return (row as { n: number }).n;
}

/**
 * Replaces a pending claim request's email envelope with one re-sealed under the current master
 * key. Guarded on the stored envelope still being `previous` and the request unhandled, so a job
 * that erased the email meanwhile wins. Returns whether it wrote. The rewrap run's audit event
 * (`credentials.rewrapped`) counts it: the email itself is unchanged.
 */
export async function rewrapClaimRequestEmail(
  db: Db,
  input: { workspaceId: string; id: string; previous: string; next: string },
): Promise<boolean> {
  const rows = await db
    .update(claimRequests)
    .set({ emailEnvelope: input.next })
    .where(
      and(
        eq(claimRequests.workspaceId, input.workspaceId),
        eq(claimRequests.id, input.id),
        eq(claimRequests.emailEnvelope, input.previous),
        isNull(claimRequests.processedAt),
      ),
    )
    .returning({ id: claimRequests.id });
  return rows.length === 1;
}
