import {
  EVENT_PROVIDERS,
  type EventProvider,
  EXTERNAL_EVENT_STATES,
  type ExternalEventState,
  type Instant,
  OUTBOX_KINDS,
  type OutboxKind,
} from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { paddleConnections } from "./paddle.ts";
import { literalList } from "./sql.ts";
import { workspaces } from "./workspaces.ts";

/**
 * Receipt of a provider webhook (domain `ExternalEvent`). Global: an event can arrive before any
 * workspace is connected. Stores metadata and a payload digest, never the payload, which can
 * contain personal data. Unique per provider, connection and event ID, so redelivery is a no-op.
 *
 * Paddle events arrive per connection (`/webhooks/paddle/:connectionId`) and are deduplicated
 * within it, so a creator who signs a colliding `evt_` ID cannot suppress another workspace's
 * events. GitHub events have no connection (one App, one webhook) and dedupe per provider.
 */
export const externalEvents = sqliteTable(
  "external_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider", { enum: EVENT_PROVIDERS }).$type<EventProvider>().notNull(),
    // The Paddle connection whose destination received the event; null for GitHub.
    connectionId: text("connection_id").references(() => paddleConnections.id, {
      onDelete: "restrict",
    }),
    externalEventId: text("external_event_id").notNull(),
    eventType: text("event_type").notNull(),
    action: text("action"),
    installationId: text("installation_id"),
    // Paddle: the subscription the event concerns (`data.id` of a `subscription.*` event,
    // `data.subscription_id` of a `transaction.*` event), which processing refreshes. Null for
    // other events and for GitHub. An ID only: the payload itself is never stored.
    externalSubscriptionId: text("external_subscription_id"),
    payloadDigest: text("payload_digest").notNull(),
    // When the provider says the event happened, if it says (Paddle's `occurred_at`).
    occurredAt: integer("occurred_at").$type<Instant>(),
    receivedAt: integer("received_at").$type<Instant>().notNull(),
    processingState: text("processing_state", { enum: EXTERNAL_EVENT_STATES })
      .$type<ExternalEventState>()
      .notNull(),
    attempts: integer("attempts").notNull(),
    lastErrorCode: text("last_error_code"),
    processedAt: integer("processed_at").$type<Instant>(),
  },
  (t) => [
    // Deduplication is the unique expression index `external_events_connection_event_unique` on
    // (provider, coalesce(connection_id, ''), external_event_id): `coalesce` makes GitHub's null
    // connections compare equal. drizzle-kit 0.31 cannot generate an expression index (it quotes
    // the expression as a column), so it is hand-written at the end of migration 0006 and is
    // absent from the snapshots; `pnpm db:check` compares snapshots only. Writers use
    // ON CONFLICT DO NOTHING without a target, which covers this index.
    index("external_events_state_idx").on(t.processingState, t.receivedAt),
    // Pruning by age (decision 0015).
    index("external_events_received_idx").on(t.receivedAt),
    check("external_events_provider_valid", sql`provider IN (${literalList(EVENT_PROVIDERS)})`),
    // Paddle events always name their connection; GitHub events never do.
    check(
      "external_events_connection_iff_paddle",
      sql`(provider = 'paddle') = (connection_id IS NOT NULL)`,
    ),
    check(
      "external_events_state_valid",
      sql`processing_state IN (${literalList(EXTERNAL_EVENT_STATES)})`,
    ),
    check("external_events_attempts_non_negative", sql`attempts >= 0`),
  ],
);

/**
 * Transactional outbox (decision 0003): work intents written in the same batch as the change
 * that causes them, delivered to the jobs Worker at least once. Carries IDs only.
 *
 * A row that failed for good is a failure record (decision 0014): `workspace_id` scopes it (null
 * for system-wide jobs such as the sweeps), and an operator may dismiss it with a reason.
 * `dismissed_by` is a user ID without a foreign key, like an audit actor's, so an operator can
 * still delete their account.
 */
export const outbox = sqliteTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: OUTBOX_KINDS }).$type<OutboxKind>().notNull(),
    subjectId: text("subject_id").notNull(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    availableAt: integer("available_at").$type<Instant>().notNull(),
    attempts: integer("attempts").notNull(),
    sentAt: integer("sent_at").$type<Instant>(),
    // Set when the work failed permanently or ran out of attempts; such rows are never claimed.
    failedAt: integer("failed_at").$type<Instant>(),
    lastErrorCode: text("last_error_code"),
    // The workspace the work is about; null for system-wide work.
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "restrict" }),
    dismissedAt: integer("dismissed_at").$type<Instant>(),
    dismissedBy: text("dismissed_by"),
    dismissReason: text("dismiss_reason"),
  },
  (t) => [
    // Also serves pruning sent rows by `sent_at` (decision 0015).
    index("outbox_pending_idx").on(t.sentAt, t.availableAt),
    // "Is this work already queued?" for the sweeps' repair queries and deduplicated inserts.
    index("outbox_pending_subject_idx")
      .on(t.kind, t.subjectId)
      .where(sql`sent_at IS NULL AND failed_at IS NULL`),
    // Open failures per workspace, oldest first (decision 0014).
    index("outbox_open_failures_idx")
      .on(t.workspaceId, t.failedAt)
      .where(sql`failed_at IS NOT NULL AND dismissed_at IS NULL`),
    check("outbox_kind_valid", sql`kind IN (${literalList(OUTBOX_KINDS)})`),
    check("outbox_attempts_non_negative", sql`attempts >= 0`),
    // Only a failure can be dismissed; a dismissal names who and why.
    check("outbox_dismissed_only_failed", sql`dismissed_at IS NULL OR failed_at IS NOT NULL`),
    check(
      "outbox_dismissal_complete",
      sql`(dismissed_at IS NULL) = (dismissed_by IS NULL) AND (dismissed_at IS NULL) = (dismiss_reason IS NULL) AND (dismiss_reason IS NULL OR length(dismiss_reason) > 0)`,
    ),
  ],
);
