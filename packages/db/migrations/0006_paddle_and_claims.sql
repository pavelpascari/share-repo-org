CREATE TABLE `checkout_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`price_id` text NOT NULL,
	`transaction_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_by_customer_id` text,
	`consumed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`offer_id`) REFERENCES `offers`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`consumed_by_customer_id`) REFERENCES `customers`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "checkout_claims_price_id_present" CHECK(length(price_id) > 0),
	CONSTRAINT "checkout_claims_expiry_after_creation" CHECK(expires_at > created_at),
	CONSTRAINT "checkout_claims_consumed_pair" CHECK((consumed_by_customer_id IS NULL) = (consumed_at IS NULL)),
	CONSTRAINT "checkout_claims_consumed_after_creation" CHECK(consumed_at IS NULL OR consumed_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_claims_workspace_id_id_unique` ON `checkout_claims` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `claim_rate_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL,
	CONSTRAINT "claim_rate_limits_bucket_present" CHECK(length(bucket) > 0),
	CONSTRAINT "claim_rate_limits_count_non_negative" CHECK(count >= 0)
);
--> statement-breakpoint
CREATE TABLE `claim_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`email_hash` text NOT NULL,
	`email_envelope` text,
	`created_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "claim_requests_email_hash_hex" CHECK(length(email_hash) = 64 AND email_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "claim_requests_email_envelope_json" CHECK(email_envelope IS NULL OR (json_valid(email_envelope) AND json_type(email_envelope) = 'object')),
	CONSTRAINT "claim_requests_processed_erased" CHECK(processed_at IS NULL OR email_envelope IS NULL),
	CONSTRAINT "claim_requests_processed_after_creation" CHECK(processed_at IS NULL OR processed_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_requests_workspace_id_id_unique` ON `claim_requests` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `claim_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`consumed_by_user_id` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`consumed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`customer_id`) REFERENCES `customers`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "claim_tokens_token_hash_hex" CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "claim_tokens_expiry_after_creation" CHECK(expires_at > created_at),
	CONSTRAINT "claim_tokens_consumed_pair" CHECK((consumed_at IS NULL) = (consumed_by_user_id IS NULL)),
	CONSTRAINT "claim_tokens_consumed_after_creation" CHECK(consumed_at IS NULL OR consumed_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_tokens_token_hash_unique` ON `claim_tokens` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `claim_tokens_workspace_id_id_unique` ON `claim_tokens` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `paddle_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`environment` text NOT NULL,
	`seller_id` text NOT NULL,
	`seller_name` text,
	`credential_kind` text NOT NULL,
	`api_key_envelope` text,
	`api_key_expires_on` integer,
	`destination_id` text,
	`webhook_secret_envelope` text,
	`status` text NOT NULL,
	`status_reason` text,
	`last_event_at` integer,
	`last_checked_at` integer,
	`catalog_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "paddle_connections_environment_valid" CHECK(environment IN ('sandbox', 'live')),
	CONSTRAINT "paddle_connections_credential_kind_valid" CHECK(credential_kind IN ('api_key', 'oauth')),
	CONSTRAINT "paddle_connections_status_valid" CHECK(status IN ('active', 'unauthorized', 'disconnected')),
	CONSTRAINT "paddle_connections_seller_id_present" CHECK(length(seller_id) > 0),
	CONSTRAINT "paddle_connections_api_key_envelope_json" CHECK(api_key_envelope IS NULL OR (json_valid(api_key_envelope) AND json_type(api_key_envelope) = 'object')),
	CONSTRAINT "paddle_connections_webhook_secret_envelope_json" CHECK(webhook_secret_envelope IS NULL OR (json_valid(webhook_secret_envelope) AND json_type(webhook_secret_envelope) = 'object')),
	CONSTRAINT "paddle_connections_live_has_credentials" CHECK(status = 'disconnected' OR ((credential_kind <> 'api_key' OR api_key_envelope IS NOT NULL) AND destination_id IS NOT NULL AND webhook_secret_envelope IS NOT NULL)),
	CONSTRAINT "paddle_connections_disconnected_erased" CHECK(status <> 'disconnected' OR (api_key_envelope IS NULL AND webhook_secret_envelope IS NULL)),
	CONSTRAINT "paddle_connections_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paddle_connections_one_live` ON `paddle_connections` (`workspace_id`) WHERE status <> 'disconnected';--> statement-breakpoint
CREATE UNIQUE INDEX `paddle_connections_workspace_id_id_unique` ON `paddle_connections` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `paddle_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`price_id` text NOT NULL,
	`product_id` text NOT NULL,
	`product_name` text NOT NULL,
	`description` text,
	`billing_interval` text,
	`billing_frequency` integer,
	`unit_amount` text NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`connection_id`) REFERENCES `paddle_connections`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "paddle_prices_price_id_present" CHECK(length(price_id) > 0),
	CONSTRAINT "paddle_prices_product_id_present" CHECK(length(product_id) > 0),
	CONSTRAINT "paddle_prices_status_valid" CHECK(status IN ('active', 'archived')),
	CONSTRAINT "paddle_prices_billing_cycle_valid" CHECK((billing_interval IS NULL AND billing_frequency IS NULL) OR (billing_interval IS NOT NULL AND billing_frequency IS NOT NULL AND billing_interval IN ('day', 'week', 'month', 'year') AND billing_frequency >= 1)),
	CONSTRAINT "paddle_prices_unit_amount_digits" CHECK(length(unit_amount) > 0 AND unit_amount NOT GLOB '*[^0-9]*'),
	CONSTRAINT "paddle_prices_currency_code" CHECK(length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paddle_prices_workspace_id_id_unique` ON `paddle_prices` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `paddle_prices_price_unique` ON `paddle_prices` (`workspace_id`,`connection_id`,`price_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_external_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`connection_id` text,
	`external_event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`action` text,
	`installation_id` text,
	`payload_digest` text NOT NULL,
	`occurred_at` integer,
	`received_at` integer NOT NULL,
	`processing_state` text NOT NULL,
	`attempts` integer NOT NULL,
	`last_error_code` text,
	`processed_at` integer,
	FOREIGN KEY (`connection_id`) REFERENCES `paddle_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "external_events_provider_valid" CHECK(provider IN ('github', 'paddle')),
	CONSTRAINT "external_events_connection_iff_paddle" CHECK((provider = 'paddle') = (connection_id IS NOT NULL)),
	CONSTRAINT "external_events_state_valid" CHECK(processing_state IN ('pending', 'processed', 'ignored', 'failed')),
	CONSTRAINT "external_events_attempts_non_negative" CHECK(attempts >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_external_events`("id", "provider", "connection_id", "external_event_id", "event_type", "action", "installation_id", "payload_digest", "occurred_at", "received_at", "processing_state", "attempts", "last_error_code", "processed_at") SELECT "id", "provider", NULL, "external_event_id", "event_type", "action", "installation_id", "payload_digest", NULL, "received_at", "processing_state", "attempts", "last_error_code", "processed_at" FROM `external_events`;--> statement-breakpoint
DROP TABLE `external_events`;--> statement-breakpoint
ALTER TABLE `__new_external_events` RENAME TO `external_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `external_events_state_idx` ON `external_events` (`processing_state`,`received_at`);--> statement-breakpoint
CREATE TABLE `__new_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`available_at` integer NOT NULL,
	`attempts` integer NOT NULL,
	`sent_at` integer,
	`failed_at` integer,
	`last_error_code` text,
	CONSTRAINT "outbox_kind_valid" CHECK(kind IN ('process_external_event', 'resync_connection', 'refresh_subscription', 'recompute_offer', 'reconcile_resource', 'send_claim_email', 'check_paddle_connection', 'sweep_paddle_subscriptions')),
	CONSTRAINT "outbox_attempts_non_negative" CHECK(attempts >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_outbox`("id", "kind", "subject_id", "created_at", "available_at", "attempts", "sent_at", "failed_at", "last_error_code") SELECT "id", "kind", "subject_id", "created_at", "available_at", "attempts", "sent_at", "failed_at", "last_error_code" FROM `outbox`;--> statement-breakpoint
DROP TABLE `outbox`;--> statement-breakpoint
ALTER TABLE `__new_outbox` RENAME TO `outbox`;--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`sent_at`,`available_at`);--> statement-breakpoint
-- Hand-written: drizzle-kit 0.31 cannot express an index on an expression, so this index is not
-- in the Drizzle schema or the snapshots (see packages/db/src/schema/events.ts). It replaces
-- external_events_provider_event_unique, dropped with the old table: Paddle events dedupe per
-- connection, and GitHub's null connections compare equal through coalesce.
CREATE UNIQUE INDEX `external_events_connection_event_unique` ON `external_events` (`provider`, coalesce(`connection_id`, ''), `external_event_id`);
