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
  },
  (t) => [
    index("outbox_pending_idx").on(t.sentAt, t.availableAt),
    check("outbox_kind_valid", sql`kind IN (${literalList(OUTBOX_KINDS)})`),
    check("outbox_attempts_non_negative", sql`attempts >= 0`),
  ],
);
