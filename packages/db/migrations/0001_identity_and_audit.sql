CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`workspace_id` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text,
	`correlation_id` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`details` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "audit_events_scope_valid" CHECK(scope IN ('workspace', 'account')),
	CONSTRAINT "audit_events_scope_workspace" CHECK((scope = 'workspace') = (workspace_id IS NOT NULL)),
	CONSTRAINT "audit_events_actor_type_valid" CHECK(actor_type IN ('user', 'system', 'operator', 'provider')),
	CONSTRAINT "audit_events_actor_id_present" CHECK(actor_type = 'system' OR actor_id IS NOT NULL),
	CONSTRAINT "audit_events_details_json" CHECK(json_valid(details) AND json_type(details) = 'object')
);
--> statement-breakpoint
CREATE INDEX `audit_events_workspace_occurred_idx` ON `audit_events` (`workspace_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `audit_events_correlation_id_idx` ON `audit_events` (`correlation_id`);--> statement-breakpoint
CREATE INDEX `audit_events_target_idx` ON `audit_events` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `auth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`account_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "auth_accounts_no_credentials" CHECK(access_token IS NULL AND refresh_token IS NULL AND id_token IS NULL AND password IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_provider_account_unique` ON `auth_accounts` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `auth_accounts_user_id_idx` ON `auth_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_rate_limits_key_unique` ON `auth_rate_limits` (`key`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_unique` ON `auth_sessions` (`token`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user_id_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_users_email_unique` ON `auth_users` (`email`);--> statement-breakpoint
CREATE TABLE `auth_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_verifications_identifier_idx` ON `auth_verifications` (`identifier`);--> statement-breakpoint
CREATE TABLE `external_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_user_id` text NOT NULL,
	`username_snapshot` text NOT NULL,
	`display_name_snapshot` text,
	`avatar_url_snapshot` text,
	`verified_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "external_identities_provider_valid" CHECK(provider IN ('github')),
	CONSTRAINT "external_identities_external_user_id_present" CHECK(length(external_user_id) > 0),
	CONSTRAINT "external_identities_username_present" CHECK(length(username_snapshot) > 0),
	CONSTRAINT "external_identities_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_identities_provider_user_unique` ON `external_identities` (`provider`,`external_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `external_identities_user_provider_unique` ON `external_identities` (`user_id`,`provider`);--> statement-breakpoint
-- Hand-written (Drizzle does not model triggers): audit history is append-only (decision 0007).
CREATE TRIGGER `audit_events_no_update` BEFORE UPDATE ON `audit_events`
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `audit_events_no_delete` BEFORE DELETE ON `audit_events`
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
