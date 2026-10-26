CREATE TABLE `system_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "system_state_key_present" CHECK(length(key) > 0),
	CONSTRAINT "system_state_value_json" CHECK(json_valid(value))
);
--> statement-breakpoint
-- Hand-edited: drizzle-kit 0.31 emits `PRAGMA foreign_keys=OFF/ON` around table rebuilds, which is a
-- no-op inside the transaction D1 runs a migration in. Rebuilding a referenced table (workspaces,
-- paddle_connections) then fails on the DROP's implicit delete. D1's documented alternative defers
-- foreign key checks to the end of the migration, when the rebuilt tables are back in place.
PRAGMA defer_foreign_keys=on;--> statement-breakpoint
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
	`workspace_id` text,
	`dismissed_at` integer,
	`dismissed_by` text,
	`dismiss_reason` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "outbox_kind_valid" CHECK(kind IN ('process_external_event', 'resync_connection', 'refresh_subscription', 'recompute_offer', 'reconcile_resource', 'send_claim_email', 'check_paddle_connection', 'sweep_paddle_subscriptions', 'prune_data', 'purge_workspace', 'rewrap_credentials')),
	CONSTRAINT "outbox_attempts_non_negative" CHECK(attempts >= 0),
	CONSTRAINT "outbox_dismissed_only_failed" CHECK(dismissed_at IS NULL OR failed_at IS NOT NULL),
	CONSTRAINT "outbox_dismissal_complete" CHECK((dismissed_at IS NULL) = (dismissed_by IS NULL) AND (dismissed_at IS NULL) = (dismiss_reason IS NULL) AND (dismiss_reason IS NULL OR length(dismiss_reason) > 0))
);
--> statement-breakpoint
INSERT INTO `__new_outbox`("id", "kind", "subject_id", "created_at", "available_at", "attempts", "sent_at", "failed_at", "last_error_code", "workspace_id", "dismissed_at", "dismissed_by", "dismiss_reason") SELECT "id", "kind", "subject_id", "created_at", "available_at", "attempts", "sent_at", "failed_at", "last_error_code", NULL, NULL, NULL, NULL FROM `outbox`;--> statement-breakpoint
DROP TABLE `outbox`;--> statement-breakpoint
ALTER TABLE `__new_outbox` RENAME TO `outbox`;--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`sent_at`,`available_at`);--> statement-breakpoint
CREATE INDEX `outbox_pending_subject_idx` ON `outbox` (`kind`,`subject_id`) WHERE sent_at IS NULL AND failed_at IS NULL;--> statement-breakpoint
CREATE INDEX `outbox_open_failures_idx` ON `outbox` (`workspace_id`,`failed_at`) WHERE failed_at IS NOT NULL AND dismissed_at IS NULL;--> statement-breakpoint
CREATE TABLE `__new_paddle_connections` (
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
	`destination_next_id` text,
	`webhook_secret_next_envelope` text,
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
	CONSTRAINT "paddle_connections_webhook_secret_next_envelope_json" CHECK(webhook_secret_next_envelope IS NULL OR (json_valid(webhook_secret_next_envelope) AND json_type(webhook_secret_next_envelope) = 'object')),
	CONSTRAINT "paddle_connections_next_secret_has_destination" CHECK(webhook_secret_next_envelope IS NULL OR destination_next_id IS NOT NULL),
	CONSTRAINT "paddle_connections_live_has_credentials" CHECK(status = 'disconnected' OR ((credential_kind <> 'api_key' OR api_key_envelope IS NOT NULL) AND destination_id IS NOT NULL AND webhook_secret_envelope IS NOT NULL)),
	CONSTRAINT "paddle_connections_disconnected_erased" CHECK(status <> 'disconnected' OR (api_key_envelope IS NULL AND webhook_secret_envelope IS NULL AND webhook_secret_next_envelope IS NULL)),
	CONSTRAINT "paddle_connections_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
INSERT INTO `__new_paddle_connections`("id", "workspace_id", "environment", "seller_id", "seller_name", "credential_kind", "api_key_envelope", "api_key_expires_on", "destination_id", "webhook_secret_envelope", "destination_next_id", "webhook_secret_next_envelope", "status", "status_reason", "last_event_at", "last_checked_at", "catalog_synced_at", "created_at", "updated_at") SELECT "id", "workspace_id", "environment", "seller_id", "seller_name", "credential_kind", "api_key_envelope", "api_key_expires_on", "destination_id", "webhook_secret_envelope", NULL, NULL, "status", "status_reason", "last_event_at", "last_checked_at", "catalog_synced_at", "created_at", "updated_at" FROM `paddle_connections`;--> statement-breakpoint
DROP TABLE `paddle_connections`;--> statement-breakpoint
ALTER TABLE `__new_paddle_connections` RENAME TO `paddle_connections`;--> statement-breakpoint
CREATE UNIQUE INDEX `paddle_connections_one_live` ON `paddle_connections` (`workspace_id`) WHERE status <> 'disconnected';--> statement-breakpoint
CREATE UNIQUE INDEX `paddle_connections_workspace_id_id_unique` ON `paddle_connections` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `__new_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`delete_after` integer,
	`deletion_requested_by` text,
	CONSTRAINT "workspaces_slug_format" CHECK(length(slug) BETWEEN 3 AND 48 AND slug NOT GLOB '*[^a-z0-9-]*' AND slug NOT GLOB '-*' AND slug NOT GLOB '*-' AND slug NOT GLOB '*--*'),
	CONSTRAINT "workspaces_name_format" CHECK(length(name) BETWEEN 1 AND 100 AND name = trim(name, ' ' || char(9, 10, 11, 12, 13))),
	CONSTRAINT "workspaces_status_valid" CHECK(status IN ('active', 'suspended', 'deleting', 'purging')),
	CONSTRAINT "workspaces_updated_after_created" CHECK(updated_at >= created_at),
	CONSTRAINT "workspaces_deletion_scheduled" CHECK((status IN ('deleting', 'purging')) = (delete_after IS NOT NULL)),
	CONSTRAINT "workspaces_deletion_requester" CHECK((delete_after IS NULL) = (deletion_requested_by IS NULL) AND (deletion_requested_by IS NULL OR length(deletion_requested_by) > 0))
);
--> statement-breakpoint
INSERT INTO `__new_workspaces`("id", "slug", "name", "status", "created_at", "updated_at", "delete_after", "deletion_requested_by") SELECT "id", "slug", "name", "status", "created_at", "updated_at", NULL, NULL FROM `workspaces`;--> statement-breakpoint
DROP TABLE `workspaces`;--> statement-breakpoint
ALTER TABLE `__new_workspaces` RENAME TO `workspaces`;--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);--> statement-breakpoint
PRAGMA defer_foreign_keys=off;--> statement-breakpoint
ALTER TABLE `connections` ADD `rate_limited_until` integer;--> statement-breakpoint
CREATE INDEX `checkout_claims_expires_idx` ON `checkout_claims` (`expires_at`);--> statement-breakpoint
CREATE INDEX `claim_requests_created_idx` ON `claim_requests` (`created_at`);--> statement-breakpoint
CREATE INDEX `claim_tokens_expires_idx` ON `claim_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `entitlements_state_valid_until_idx` ON `entitlements` (`state`,`valid_until`);--> statement-breakpoint
CREATE INDEX `external_events_received_idx` ON `external_events` (`received_at`);--> statement-breakpoint
CREATE INDEX `provider_mutations_finished_idx` ON `provider_mutations` (`finished_at`);--> statement-breakpoint
-- Hand-written (Drizzle does not model triggers). Decision 0015: a workspace's append-only history
-- may be deleted only by its purge, which sets the workspace to `purging` in the same batch as
-- its first delete. Account-scoped audit rows (no workspace) can never be deleted. UPDATE stays
-- rejected everywhere (audit_events_no_update, offer_versions_no_update, and
-- provider_mutations_settle_once are unchanged).
DROP TRIGGER `audit_events_no_delete`;--> statement-breakpoint
CREATE TRIGGER `audit_events_no_delete` BEFORE DELETE ON `audit_events`
WHEN (SELECT status FROM workspaces WHERE id = OLD.workspace_id) IS NOT 'purging'
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
--> statement-breakpoint
DROP TRIGGER `offer_versions_no_delete`;--> statement-breakpoint
CREATE TRIGGER `offer_versions_no_delete` BEFORE DELETE ON `offer_versions`
WHEN (SELECT status FROM workspaces WHERE id = OLD.workspace_id) IS NOT 'purging'
BEGIN SELECT RAISE(ABORT, 'offer_versions is append-only'); END;
--> statement-breakpoint
-- A settled mutation may also be pruned (decision 0015 keeps them 90 days), but one still `started`
-- records a request whose outcome is unknown and stays until its workspace is purged.
DROP TRIGGER `provider_mutations_no_delete`;--> statement-breakpoint
CREATE TRIGGER `provider_mutations_no_delete` BEFORE DELETE ON `provider_mutations`
WHEN OLD.status = 'started'
  AND (SELECT status FROM workspaces WHERE id = OLD.workspace_id) IS NOT 'purging'
BEGIN SELECT RAISE(ABORT, 'provider_mutations is append-only'); END;
--> statement-breakpoint
-- The purging exception above is only as strong as the way into `purging`: a workspace reaches it
-- only from `deleting`, and never leaves it (the purge ends by deleting the row). A workspace is
-- never created already being deleted.
CREATE TRIGGER `workspaces_purging_one_way` BEFORE UPDATE OF `status` ON `workspaces`
WHEN (NEW.status = 'purging' AND OLD.status NOT IN ('deleting', 'purging'))
  OR (OLD.status = 'purging' AND NEW.status <> 'purging')
BEGIN SELECT RAISE(ABORT, 'workspaces: purging follows deleting and is final'); END;
--> statement-breakpoint
CREATE TRIGGER `workspaces_created_live` BEFORE INSERT ON `workspaces`
WHEN NEW.status IN ('deleting', 'purging')
BEGIN SELECT RAISE(ABORT, 'workspaces: a new workspace is not being deleted'); END;
