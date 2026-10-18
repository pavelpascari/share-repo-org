import {
  EXTERNAL_EVENT_STATES,
  type ExternalEventState,
  IDENTITY_PROVIDERS,
  type IdentityProvider,
  type Instant,
  OUTBOX_KINDS,
  type OutboxKind,
} from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { literalList } from "./sql.ts";

/**
 * Receipt of a provider webhook (domain `ExternalEvent`). Global: an event can arrive before any
 * workspace is connected. Stores metadata and a payload digest, never the payload, which can
 * contain personal data. Unique per provider delivery ID, so redelivery is a no-op.
 */
export const externalEvents = sqliteTable(
  "external_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider", { enum: IDENTITY_PROVIDERS }).$type<IdentityProvider>().notNull(),
    externalEventId: text("external_event_id").notNull(),
    eventType: text("event_type").notNull(),
    action: text("action"),
    installationId: text("installation_id"),
    payloadDigest: text("payload_digest").notNull(),
    receivedAt: integer("received_at").$type<Instant>().notNull(),
    processingState: text("processing_state", { enum: EXTERNAL_EVENT_STATES })
      .$type<ExternalEventState>()
      .notNull(),
    attempts: integer("attempts").notNull(),
    lastErrorCode: text("last_error_code"),
    processedAt: integer("processed_at").$type<Instant>(),
  },
  (t) => [
    uniqueIndex("external_events_provider_event_unique").on(t.provider, t.externalEventId),
    index("external_events_state_idx").on(t.processingState, t.receivedAt),
    check("external_events_provider_valid", sql`provider IN (${literalList(IDENTITY_PROVIDERS)})`),
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
