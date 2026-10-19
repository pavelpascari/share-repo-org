CREATE TABLE `provider_mutations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`operation` text NOT NULL,
	`access_level` text NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`retry_class` text,
	`external_id` text,
	`entitlement_ids` text NOT NULL,
	`correlation_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`connection_id`) REFERENCES `connections`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`grant_id`) REFERENCES `grants`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`subject_id`) REFERENCES `subjects`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`resource_id`) REFERENCES `resources`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "provider_mutations_operation_valid" CHECK(operation IN ('invite', 'remove_collaborator', 'cancel_invitation')),
	CONSTRAINT "provider_mutations_access_level_valid" CHECK(access_level IN ('read', 'write')),
	CONSTRAINT "provider_mutations_status_valid" CHECK(status IN ('started', 'succeeded', 'failed', 'resolved')),
	CONSTRAINT "provider_mutations_retry_class_valid" CHECK(retry_class IS NULL OR retry_class IN ('retryable', 'rate_limited', 'user_action_required', 'terminal')),
	CONSTRAINT "provider_mutations_failure_classified" CHECK((status = 'failed') = (error_code IS NOT NULL AND retry_class IS NOT NULL)),
	CONSTRAINT "provider_mutations_finished" CHECK((status = 'started') = (finished_at IS NULL) AND (finished_at IS NULL OR finished_at >= started_at)),
	CONSTRAINT "provider_mutations_entitlement_ids_json" CHECK(json_valid(entitlement_ids) AND json_type(entitlement_ids) = 'array')
);
--> statement-breakpoint
CREATE INDEX `provider_mutations_budget_idx` ON `provider_mutations` (`workspace_id`,`resource_id`,`operation`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_mutations_workspace_id_id_unique` ON `provider_mutations` (`workspace_id`,`id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	CONSTRAINT "outbox_kind_valid" CHECK(kind IN ('process_external_event', 'resync_connection', 'refresh_subscription', 'recompute_offer', 'reconcile_resource')),
	CONSTRAINT "outbox_attempts_non_negative" CHECK(attempts >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_outbox`("id", "kind", "subject_id", "created_at", "available_at", "attempts", "sent_at", "failed_at", "last_error_code") SELECT "id", "kind", "subject_id", "created_at", "available_at", "attempts", "sent_at", "failed_at", "last_error_code" FROM `outbox`;--> statement-breakpoint
DROP TABLE `outbox`;--> statement-breakpoint
ALTER TABLE `__new_outbox` RENAME TO `outbox`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`sent_at`,`available_at`);--> statement-breakpoint
ALTER TABLE `grants` ADD `indirect` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `grants` ADD `next_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `resources` ADD `next_reconcile_at` integer;--> statement-breakpoint
ALTER TABLE `resources` ADD `last_reconciled_at` integer;--> statement-breakpoint
ALTER TABLE `resources` ADD `reconcile_token` text;--> statement-breakpoint
ALTER TABLE `resources` ADD `reconcile_lease_until` integer;--> statement-breakpoint
ALTER TABLE `resources` ADD `reconcile_requested_at` integer;--> statement-breakpoint
ALTER TABLE `resources` ADD `reconcile_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `resources` ADD `last_reconcile_error` text;--> statement-breakpoint
CREATE INDEX `resources_next_reconcile_idx` ON `resources` (`next_reconcile_at`);--> statement-breakpoint
CREATE TRIGGER `provider_mutations_settle_once` BEFORE UPDATE ON `provider_mutations`
WHEN OLD.status <> 'started'
  OR NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.connection_id IS NOT OLD.connection_id OR NEW.grant_id IS NOT OLD.grant_id
  OR NEW.subject_id IS NOT OLD.subject_id OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.operation IS NOT OLD.operation OR NEW.access_level IS NOT OLD.access_level
  OR NEW.entitlement_ids IS NOT OLD.entitlement_ids OR NEW.correlation_id IS NOT OLD.correlation_id
  OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'provider_mutations settle once, from started'); END;
--> statement-breakpoint
CREATE TRIGGER `provider_mutations_no_delete` BEFORE DELETE ON `provider_mutations`
BEGIN SELECT RAISE(ABORT, 'provider_mutations is append-only'); END;
