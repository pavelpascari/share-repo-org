import type { Instant, PaddleConnectionStatus } from "@sharerepo/domain";
import { and, asc, eq, isNotNull, isNull, ne, type SQL, sql } from "drizzle-orm";
import { type AuditEvents, auditInserts, conditionalAuditInserts } from "./audit-repository.ts";
import { insertWhere, runBatch, type Statement } from "./batch.ts";
import type { Db } from "./client.ts";
import { isUniqueViolation } from "./errors.ts";
import { refreshAllInsert } from "./lifecycle-repository.ts";
import { paddleConnections, paddlePrices } from "./schema/index.ts";

/**
 * A workspace's Paddle seller account (decision 0011). Its envelopes are ciphertext bound to the
 * row; only `@sharerepo/platform`'s `openSecret` with the row's AAD reads them.
 */
export type PaddleConnection = typeof paddleConnections.$inferSelect;
export type PaddlePrice = typeof paddlePrices.$inferSelect;

/**
 * What a webhook needs before it trusts a body: the workspace, the status and the secrets (the
 * next one only while a webhook secret rotation is in progress).
 */
export type PaddleWebhookConnection = Pick<
  PaddleConnection,
  "id" | "workspaceId" | "status" | "webhookSecretEnvelope" | "webhookSecretNextEnvelope"
>;

/** A guarded write found the row in another state than expected (or absent): nothing written. */
export type GuardedWriteResult = { ok: true } | { ok: false; reason: "stale" };

export type CreatePaddleConnectionResult =
  | { ok: true }
  /** The workspace already has a connection that is not disconnected. Nothing was written. */
  | { ok: false; reason: "already_connected" };

const LIVE_KEY = ["paddle_connections.workspace_id"] as const;

const exists = (where: SQL | undefined) =>
  sql`EXISTS (SELECT 1 FROM ${paddleConnections} WHERE ${where})`;

const scoped = (workspaceId: string, connectionId: string) =>
  and(eq(paddleConnections.workspaceId, workspaceId), eq(paddleConnections.id, connectionId));

const notDisconnected = ne(paddleConnections.status, "disconnected");

/**
 * Records a new connection with its audit events, in one batch. The partial unique index allows
 * one live connection per workspace; a second is reported, not thrown.
 */
export async function createPaddleConnection(
  db: Db,
  connection: PaddleConnection,
  audit: AuditEvents,
): Promise<CreatePaddleConnectionResult> {
  try {
    await runBatch(db, [
      db.insert(paddleConnections).values(connection),
      ...auditInserts(db, audit),
      // Subscriptions stored from an earlier connection are read again, in the same batch, so a
      // crash cannot leave the connection without them: after a cancelled workspace deletion
      // (decision 0015) their entitlements were withdrawn until Paddle could be read.
      refreshAllInsert(db, {
        workspaceId: connection.workspaceId,
        sources: ["paddle"],
        now: connection.createdAt,
        when: sql`1`,
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, LIVE_KEY)) return { ok: false, reason: "already_connected" };
    throw error;
  }
  return { ok: true };
}

/** The workspace's live (not disconnected) connection, or null. */
export async function getPaddleConnection(
  db: Db,
  key: { workspaceId: string },
): Promise<PaddleConnection | null> {
  const rows = await db
    .select()
    .from(paddleConnections)
    .where(and(eq(paddleConnections.workspaceId, key.workspaceId), notDisconnected))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * System use (`POST /webhooks/paddle/:connectionId`): the connection named by the URL, in any
 * workspace and any status. The handler refuses a disconnected one.
 */
export async function getPaddleConnectionForWebhook(
  db: Db,
  connectionId: string,
): Promise<PaddleWebhookConnection | null> {
  const rows = await db
    .select({
      id: paddleConnections.id,
      workspaceId: paddleConnections.workspaceId,
      status: paddleConnections.status,
      webhookSecretEnvelope: paddleConnections.webhookSecretEnvelope,
      webhookSecretNextEnvelope: paddleConnections.webhookSecretNextEnvelope,
    })
    .from(paddleConnections)
    .where(eq(paddleConnections.id, connectionId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The IDs of every connection the workspace ever had, disconnected ones included: a destination
 * ShareRepo created before destinations were tagged names one of them in its URL.
 */
export async function listPaddleConnectionIds(
  db: Db,
  key: { workspaceId: string },
): Promise<string[]> {
  const rows = await db
    .select({ id: paddleConnections.id })
    .from(paddleConnections)
    .where(eq(paddleConnections.workspaceId, key.workspaceId))
    .orderBy(asc(paddleConnections.id));
  return rows.map((row) => row.id);
}

/** Connections the daily sweep visits: every `active` one. */
export async function listActivePaddleConnections(
  db: Db,
): Promise<{ workspaceId: string; id: string }[]> {
  return db
    .select({ workspaceId: paddleConnections.workspaceId, id: paddleConnections.id })
    .from(paddleConnections)
    .where(eq(paddleConnections.status, "active"))
    .orderBy(asc(paddleConnections.id));
}

/**
 * One batch that writes only while `guard` holds: `dependents` (already guarded by the caller),
 * then the audit inserts guarded by it, then `update`, which must be last because once it runs
 * the guard may no longer hold. The result is the update's.
 */
async function guardedUpdate(
  db: Db,
  guard: SQL | undefined,
  update: Statement,
  audit: AuditEvents,
  dependents: readonly Statement[] = [],
): Promise<GuardedWriteResult> {
  const audits = conditionalAuditInserts(db, audit, exists(guard));
  const changes = await runBatch(db, [...dependents, ...audits, update]);
  return changes.at(-1) === 1 ? { ok: true } : { ok: false, reason: "stale" };
}

/**
 * Moves a connection from `expectedStatus` to `status` (a probe or a 401/403), with its audit
 * event (`paddle.status_changed`). Guarded on the expected status, so two workers that observed
 * the same transition record it once. Not for disconnecting: use `disconnectPaddleConnection`.
 */
export async function updatePaddleConnectionStatus(
  db: Db,
  input: {
    workspaceId: string;
    connectionId: string;
    expectedStatus: Exclude<PaddleConnectionStatus, "disconnected">;
    status: Exclude<PaddleConnectionStatus, "disconnected">;
    statusReason: string | null;
    now: Instant;
  },
  audit: AuditEvents,
): Promise<GuardedWriteResult> {
  const guard = and(
    scoped(input.workspaceId, input.connectionId),
    eq(paddleConnections.status, input.expectedStatus),
  );
  return guardedUpdate(
    db,
    guard,
    db
      .update(paddleConnections)
      .set({
        status: input.status,
        statusReason: input.statusReason,
        lastCheckedAt: input.now,
        updatedAt: input.now,
      })
      .where(guard),
    audit,
  );
}

/**
 * Records that a probe found a live connection as it was (`last_checked_at`). Bookkeeping, like
 * `last_event_at`: no audit event, and never a status change.
 */
export async function recordPaddleConnectionChecked(
  db: Db,
  input: { workspaceId: string; connectionId: string; now: Instant },
): Promise<void> {
  await db
    .update(paddleConnections)
    .set({ lastCheckedAt: input.now })
    .where(and(scoped(input.workspaceId, input.connectionId), notDisconnected));
}

/**
 * Reconnect (decision 0011): stores a new key, and optionally a new destination and secret, and
 * makes the connection `active` again, with its audit event (`paddle.reconnected`). Guarded on the
 * connection being live and belonging to the same seller, so a key for another seller never
 * re-homes the workspace's subscriptions. The envelopes must be sealed with this row's AAD.
 */
export async function replacePaddleCredentials(
  db: Db,
  input: {
    workspaceId: string;
    connectionId: string;
    sellerId: string;
    sellerName: string | null;
    apiKeyEnvelope: string;
    apiKeyExpiresOn: Instant | null;
    /** A new destination and its secret, when the old one was deleted outside ShareRepo. */
    destination?: { id: string; webhookSecretEnvelope: string };
    now: Instant;
  },
  audit: AuditEvents,
): Promise<GuardedWriteResult> {
  const guard = and(
    scoped(input.workspaceId, input.connectionId),
    notDisconnected,
    eq(paddleConnections.sellerId, input.sellerId),
  );
  return guardedUpdate(
    db,
    guard,
    db
      .update(paddleConnections)
      .set({
        sellerName: input.sellerName,
        apiKeyEnvelope: input.apiKeyEnvelope,
        apiKeyExpiresOn: input.apiKeyExpiresOn,
        ...(input.destination === undefined
          ? {}
          : {
              destinationId: input.destination.id,
              webhookSecretEnvelope: input.destination.webhookSecretEnvelope,
            }),
        status: "active",
        statusReason: null,
        lastCheckedAt: input.now,
        updatedAt: input.now,
      })
      .where(guard),
    audit,
  );
}

/**
 * Stamps `last_event_at` on a live connection when a signed webhook was accepted. Bookkeeping:
 * no audit event (the event itself is recorded in `external_events`). Never moves backwards.
 */
export async function markPaddleEventReceived(
  db: Db,
  input: { workspaceId: string; connectionId: string; now: Instant },
): Promise<void> {
  await db
    .update(paddleConnections)
    .set({ lastEventAt: sql`max(coalesce(${paddleConnections.lastEventAt}, 0), ${input.now})` })
    .where(and(scoped(input.workspaceId, input.connectionId), notDisconnected));
}

/**
 * Disconnects a live connection, with its audit event (`paddle.disconnected`): erases every
 * envelope (a rotation's next secret too) and marks it `disconnected`. `destinationId` and
 * `destinationNextId` are what to keep: null once the destination was deleted in Paddle (or there
 * was none), or its ID when the creator must delete it by hand. Guarded on the destinations the
 * caller read (`expected`): a rotation that stored a second destination meanwhile makes it stale,
 * so the caller deletes that one too before trying again.
 */
export async function disconnectPaddleConnection(
  db: Db,
  input: {
    workspaceId: string;
    connectionId: string;
    expected: { destinationId: string | null; destinationNextId: string | null };
    destinationId: string | null;
    destinationNextId: string | null;
    now: Instant;
  },
  audit: AuditEvents,
): Promise<GuardedWriteResult> {
  const guard = and(
    scoped(input.workspaceId, input.connectionId),
    notDisconnected,
    sql`${paddleConnections.destinationId} IS ${input.expected.destinationId}`,
    sql`${paddleConnections.destinationNextId} IS ${input.expected.destinationNextId}`,
  );
  return guardedUpdate(
    db,
    guard,
    db
      .update(paddleConnections)
      .set({
        status: "disconnected",
        statusReason: null,
        apiKeyEnvelope: null,
        webhookSecretEnvelope: null,
        webhookSecretNextEnvelope: null,
        destinationId: input.destinationId,
        destinationNextId: input.destinationNextId,
        updatedAt: input.now,
      })
      .where(guard),
    audit,
  );
}

/**
 * Which envelope of a connection a re-wrap replaces. `webhook_secret_next` is the secret of a
 * webhook rotation in progress; it is sealed for that purpose (its own AAD).
 */
export type PaddleEnvelopeField = "api_key" | "webhook_secret" | "webhook_secret_next";

const ENVELOPE_COLUMNS = {
  api_key: { column: paddleConnections.apiKeyEnvelope, key: "apiKeyEnvelope" },
  webhook_secret: { column: paddleConnections.webhookSecretEnvelope, key: "webhookSecretEnvelope" },
  webhook_secret_next: {
    column: paddleConnections.webhookSecretNextEnvelope,
    key: "webhookSecretNextEnvelope",
  },
} as const;

/**
 * Replaces an envelope sealed under a retired master key with one re-sealed under the current
 * key (decision 0011, rotation), with its audit event (`paddle.credentials_rewrapped`). Guarded on
 * the stored envelope still being `previous`, so a concurrent reconnect or re-wrap wins and this
 * one writes nothing, its audit event included.
 */
export async function rewrapPaddleEnvelope(
  db: Db,
  input: {
    workspaceId: string;
    connectionId: string;
    field: PaddleEnvelopeField;
    previous: string;
    next: string;
  },
  audit: AuditEvents,
): Promise<GuardedWriteResult> {
  const { column, key } = ENVELOPE_COLUMNS[input.field];
  const guard = and(
    scoped(input.workspaceId, input.connectionId),
    notDisconnected,
    eq(column, input.previous),
  );
  return guardedUpdate(
    db,
    guard,
    db
      .update(paddleConnections)
      .set({ [key]: input.next })
      .where(guard),
    audit,
  );
}

/**
 * Webhook secret rotation, first step (Phase 6): stores the second destination and its secret
 * (sealed for `webhook_secret_next`), with its audit event (`paddle.webhook_secret_rotated`,
 * `started`). From then on both secrets are accepted. Guarded on the connection being live with
 * `destinationId` as its destination and `expectedNextId` as its second destination: null when no
 * rotation is in progress, or the ID of a second destination being replaced because it no longer
 * delivers. Two rotations never overlap.
 */
export async function startPaddleWebhookRotation(
  db: Db,
  input: {
    workspaceId: string;
    connectionId: string;
    destinationId: string;
    expectedNextId: string | null;
    destinationNextId: string;
    webhookSecretNextEnvelope: string;
    now: Instant;
  },
  audit: AuditEvents,
): Promise<GuardedWriteResult> {
  const guard = and(
    scoped(input.workspaceId, input.connectionId),
    notDisconnected,
    eq(paddleConnections.destinationId, input.destinationId),
    input.expectedNextId === null
      ? isNull(paddleConnections.destinationNextId)
      : eq(paddleConnections.destinationNextId, input.expectedNextId),
  );
  return guardedUpdate(
    db,
    guard,
    db
      .update(paddleConnections)
      .set({
        destinationNextId: input.destinationNextId,
        webhookSecretNextEnvelope: input.webhookSecretNextEnvelope,
        updatedAt: input.now,
      })
      .where(guard),
    audit,
  );
}

/**
 * Webhook secret rotation, last step: once the old destination is deleted in Paddle, the next
 * destination becomes the connection's destination and its secret (re-sealed for
 * `webhook_secret`) the connection's secret, with its audit event (`paddle.webhook_secret_rotated`,
 * `completed`). Guarded on the rotation still being the one read.
 */
export async function completePaddleWebhookRotation(
  db: Db,
  input: {
    workspaceId: string;
    connectionId: string;
    previousDestinationId: string;
    destinationId: string;
    webhookSecretEnvelope: string;
    now: Instant;
  },
  audit: AuditEvents,
): Promise<GuardedWriteResult> {
  const guard = and(
    scoped(input.workspaceId, input.connectionId),
    notDisconnected,
    eq(paddleConnections.destinationId, input.previousDestinationId),
    eq(paddleConnections.destinationNextId, input.destinationId),
  );
  return guardedUpdate(
    db,
    guard,
    db
      .update(paddleConnections)
      .set({
        destinationId: input.destinationId,
        webhookSecretEnvelope: input.webhookSecretEnvelope,
        destinationNextId: null,
        webhookSecretNextEnvelope: null,
        updatedAt: input.now,
      })
      .where(guard),
    audit,
  );
}

/** A price as imported from Paddle's catalog; `id` is ShareRepo's row ID for a new price. */
export type PaddlePriceImport = Omit<PaddlePrice, "workspaceId" | "connectionId" | "syncedAt">;

/**
 * Imports a catalog page set: inserts new prices, updates known ones (matched by `price_id`
 * within the connection; the row ID stays), stamps `catalog_synced_at`, and writes the audit
 * event (`paddle.catalog_synced`), in one batch guarded on the connection being live in the
 * workspace. Prices absent from the import are kept as they are: archived prices stay.
 */
export async function upsertPaddlePrices(
  db: Db,
  input: {
    workspaceId: string;
    connectionId: string;
    prices: readonly PaddlePriceImport[];
    now: Instant;
  },
  audit: AuditEvents,
): Promise<GuardedWriteResult> {
  const { workspaceId, connectionId, now } = input;
  const guard = and(scoped(workspaceId, connectionId), notDisconnected);
  const live = exists(guard);
  // INSERT … SELECT … WHERE <live> ON CONFLICT DO UPDATE. SQLite requires a WHERE on the SELECT
  // of an upsert (to parse ON CONFLICT unambiguously); the guard is that WHERE. A known price
  // keeps its row ID and takes every imported field.
  const updated = Object.fromEntries(
    (
      [
        "productId",
        "productName",
        "description",
        "billingInterval",
        "billingFrequency",
        "unitAmount",
        "currency",
        "status",
        "syncedAt",
      ] as const
    ).map((field) => [field, sql.raw(`excluded.${paddlePrices[field].name}`)]),
  );
  const upserts = input.prices.map((price) =>
    insertWhere(
      db,
      paddlePrices,
      { ...price, workspaceId, connectionId, syncedAt: now },
      live,
    ).onConflictDoUpdate({
      target: [paddlePrices.workspaceId, paddlePrices.connectionId, paddlePrices.priceId],
      set: updated,
    }),
  );
  // The upserts and the audit run before the stamp, all guarded on the connection being live.
  return guardedUpdate(
    db,
    guard,
    db.update(paddleConnections).set({ catalogSyncedAt: now }).where(guard),
    audit,
    upserts,
  );
}

/**
 * The prices of the workspace's live connection, by product then price. With
 * `activeRecurringOnly`, only active prices with a billing cycle: what an offer can sell.
 */
export async function listPaddlePrices(
  db: Db,
  key: { workspaceId: string; activeRecurringOnly?: boolean },
): Promise<PaddlePrice[]> {
  const sellable =
    key.activeRecurringOnly === true
      ? and(eq(paddlePrices.status, "active"), isNotNull(paddlePrices.billingInterval))
      : undefined;
  const rows = await db
    .select({ price: paddlePrices })
    .from(paddlePrices)
    .innerJoin(
      paddleConnections,
      and(
        eq(paddleConnections.workspaceId, paddlePrices.workspaceId),
        eq(paddleConnections.id, paddlePrices.connectionId),
      ),
    )
    .where(and(eq(paddlePrices.workspaceId, key.workspaceId), notDisconnected, sellable))
    .orderBy(asc(paddlePrices.productName), asc(paddlePrices.productId), asc(paddlePrices.priceId));
  return rows.map((row) => row.price);
}
