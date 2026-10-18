CREATE TABLE `connection_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`write_access_acknowledged_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`user_id`) REFERENCES `workspace_memberships`(`workspace_id`,`user_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "connection_intents_expiry_after_creation" CHECK(expires_at > created_at),
	CONSTRAINT "connection_intents_consumed_in_window" CHECK(consumed_at IS NULL OR consumed_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_intents_token_hash_unique` ON `connection_intents` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `connection_intents_workspace_id_id_unique` ON `connection_intents` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`installation_id` text NOT NULL,
	`account_external_id` text NOT NULL,
	`account_login_snapshot` text NOT NULL,
	`account_type` text NOT NULL,
	`status` text NOT NULL,
	`permissions` text NOT NULL,
	`write_access_acknowledged_at` integer NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_synced_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "connections_provider_valid" CHECK(provider IN ('github')),
	CONSTRAINT "connections_account_type_valid" CHECK(account_type IN ('user')),
	CONSTRAINT "connections_status_valid" CHECK(status IN ('active', 'suspended', 'deleted')),
	CONSTRAINT "connections_permissions_json" CHECK(json_valid(permissions) AND json_type(permissions) = 'object'),
	CONSTRAINT "connections_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_installation_id_unique` ON `connections` (`installation_id`);--> statement-breakpoint
CREATE INDEX `connections_workspace_id_idx` ON `connections` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `connections_workspace_id_id_unique` ON `connections` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `external_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`external_event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`action` text,
	`installation_id` text,
	`payload_digest` text NOT NULL,
	`received_at` integer NOT NULL,
	`processing_state` text NOT NULL,
	`attempts` integer NOT NULL,
	`last_error_code` text,
	`processed_at` integer,
	CONSTRAINT "external_events_provider_valid" CHECK(provider IN ('github')),
	CONSTRAINT "external_events_state_valid" CHECK(processing_state IN ('pending', 'processed', 'ignored', 'failed')),
	CONSTRAINT "external_events_attempts_non_negative" CHECK(attempts >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_events_provider_event_unique` ON `external_events` (`provider`,`external_event_id`);--> statement-breakpoint
CREATE INDEX `external_events_state_idx` ON `external_events` (`processing_state`,`received_at`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`available_at` integer NOT NULL,
	`attempts` integer NOT NULL,
	`sent_at` integer,
	CONSTRAINT "outbox_kind_valid" CHECK(kind IN ('process_external_event', 'resync_connection')),
	CONSTRAINT "outbox_attempts_non_negative" CHECK(attempts >= 0)
);
--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`sent_at`,`available_at`);--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`provider` text NOT NULL,
	`type` text NOT NULL,
	`external_id` text NOT NULL,
	`name_snapshot` text NOT NULL,
	`owner_external_id` text NOT NULL,
	`private` integer NOT NULL,
	`archived` integer NOT NULL,
	`selection` text NOT NULL,
	`capabilities` text NOT NULL,
	`discovered_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`connection_id`) REFERENCES `connections`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "resources_provider_valid" CHECK(provider IN ('github')),
	CONSTRAINT "resources_type_valid" CHECK(type IN ('repository')),
	CONSTRAINT "resources_selection_valid" CHECK(selection IN ('selected', 'removed')),
	CONSTRAINT "resources_capabilities_json" CHECK(json_valid(capabilities) AND json_type(capabilities) = 'object'),
	CONSTRAINT "resources_updated_after_discovered" CHECK(updated_at >= discovered_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resources_workspace_id_id_unique` ON `resources` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `resources_connection_external_unique` ON `resources` (`connection_id`,`external_id`);