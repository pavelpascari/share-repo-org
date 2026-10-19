CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source` text NOT NULL,
	`external_customer_id` text NOT NULL,
	`subject_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`subject_id`) REFERENCES `subjects`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "customers_source_valid" CHECK(source IN ('simulated', 'paddle')),
	CONSTRAINT "customers_external_id_present" CHECK(length(external_customer_id) > 0),
	CONSTRAINT "customers_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_workspace_id_id_unique` ON `customers` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `customers_external_unique` ON `customers` (`workspace_id`,`source`,`external_customer_id`);--> statement-breakpoint
CREATE TABLE `entitlements` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`access_level` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`offer_version` integer NOT NULL,
	`policy_version` integer NOT NULL,
	`state` text NOT NULL,
	`valid_from` integer NOT NULL,
	`valid_until` integer,
	`decision_reason` text NOT NULL,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`subject_id`) REFERENCES `subjects`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`resource_id`) REFERENCES `resources`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`source_id`) REFERENCES `subscriptions`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`offer_id`,`offer_version`) REFERENCES `offer_versions`(`workspace_id`,`offer_id`,`version`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "entitlements_access_level_valid" CHECK(access_level IN ('read', 'write')),
	CONSTRAINT "entitlements_source_type_valid" CHECK(source_type IN ('subscription')),
	CONSTRAINT "entitlements_state_valid" CHECK(state IN ('active', 'expired', 'revoked')),
	CONSTRAINT "entitlements_policy_version_positive" CHECK(policy_version >= 1),
	CONSTRAINT "entitlements_interval_valid" CHECK(valid_until IS NULL OR valid_until > valid_from),
	CONSTRAINT "entitlements_ended_iff_not_active" CHECK((state = 'active') = (ended_at IS NULL)),
	CONSTRAINT "entitlements_reason_present" CHECK(length(decision_reason) > 0),
	CONSTRAINT "entitlements_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entitlements_live_unique` ON `entitlements` (`workspace_id`,`source_id`,`offer_id`,`resource_id`,`subject_id`) WHERE state = 'active';--> statement-breakpoint
CREATE INDEX `entitlements_subject_resource_idx` ON `entitlements` (`workspace_id`,`subject_id`,`resource_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `entitlements_workspace_id_id_unique` ON `entitlements` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`access_level` text NOT NULL,
	`state` text NOT NULL,
	`managed` integer NOT NULL,
	`entitlement_id` text,
	`external_grant_id` text,
	`expires_at` integer,
	`observed_at` integer,
	`last_attempt_at` integer,
	`last_error_code` text,
	`retry_class` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`connection_id`) REFERENCES `connections`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`subject_id`) REFERENCES `subjects`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`resource_id`) REFERENCES `resources`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`entitlement_id`) REFERENCES `entitlements`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "grants_access_level_valid" CHECK(access_level IN ('read', 'write')),
	CONSTRAINT "grants_state_valid" CHECK(state IN ('unknown', 'absent', 'provisioning', 'pending_invitation', 'active', 'revoking', 'error')),
	CONSTRAINT "grants_retry_class_valid" CHECK(retry_class IS NULL OR retry_class IN ('retryable', 'rate_limited', 'user_action_required', 'terminal')),
	CONSTRAINT "grants_error_classified" CHECK((state = 'error') = (last_error_code IS NOT NULL AND retry_class IS NOT NULL)),
	CONSTRAINT "grants_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grants_workspace_id_id_unique` ON `grants` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `grants_identity_unique` ON `grants` (`workspace_id`,`connection_id`,`resource_id`,`subject_id`,`access_level`);--> statement-breakpoint
CREATE TABLE `offer_accesses` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`access_level` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`offer_id`) REFERENCES `offers`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`resource_id`) REFERENCES `resources`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "offer_accesses_access_level_valid" CHECK(access_level IN ('read', 'write'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offer_accesses_workspace_id_id_unique` ON `offer_accesses` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `offer_accesses_offer_resource_unique` ON `offer_accesses` (`workspace_id`,`offer_id`,`resource_id`);--> statement-breakpoint
CREATE TABLE `offer_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`source` text NOT NULL,
	`external_item_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`offer_id`) REFERENCES `offers`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "offer_items_source_valid" CHECK(source IN ('simulated', 'paddle')),
	CONSTRAINT "offer_items_external_item_id_present" CHECK(length(external_item_id) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offer_items_workspace_id_id_unique` ON `offer_items` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `offer_items_item_unique` ON `offer_items` (`workspace_id`,`source`,`external_item_id`);--> statement-breakpoint
CREATE TABLE `offer_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`version` integer NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_user_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`offer_id`) REFERENCES `offers`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "offer_versions_version_positive" CHECK(version >= 1),
	CONSTRAINT "offer_versions_snapshot_json" CHECK(json_valid(snapshot) AND json_type(snapshot) = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offer_versions_workspace_id_id_unique` ON `offer_versions` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `offer_versions_offer_version_unique` ON `offer_versions` (`workspace_id`,`offer_id`,`version`);--> statement-breakpoint
CREATE TABLE `offers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`grace_period_days` integer DEFAULT 7 NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "offers_name_present" CHECK(length(trim(name)) > 0),
	CONSTRAINT "offers_status_valid" CHECK(status IN ('active', 'archived')),
	CONSTRAINT "offers_grace_period_bounds" CHECK(grace_period_days BETWEEN 0 AND 30),
	CONSTRAINT "offers_version_positive" CHECK(version >= 1),
	CONSTRAINT "offers_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offers_workspace_id_id_unique` ON `offers` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `simulated_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`customer_github_id` text NOT NULL,
	`customer_login` text NOT NULL,
	`items` text NOT NULL,
	`state` text NOT NULL,
	`current_period_start` integer NOT NULL,
	`current_period_end` integer NOT NULL,
	`cancel_at` integer,
	`ended_at` integer,
	`past_due_since` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "simulated_subscriptions_state_valid" CHECK(state IN ('trialing', 'active', 'past_due', 'paused', 'canceled', 'expired')),
	CONSTRAINT "simulated_subscriptions_items_json" CHECK(json_valid(items) AND json_type(items) = 'array'),
	CONSTRAINT "simulated_subscriptions_period_valid" CHECK(current_period_end > current_period_start),
	CONSTRAINT "simulated_subscriptions_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `simulated_subscriptions_workspace_id_id_unique` ON `simulated_subscriptions` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`type` text NOT NULL,
	`external_subject_id` text NOT NULL,
	`login_snapshot` text NOT NULL,
	`external_identity_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`external_identity_id`) REFERENCES `external_identities`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "subjects_provider_valid" CHECK(provider IN ('github')),
	CONSTRAINT "subjects_type_valid" CHECK(type IN ('user')),
	CONSTRAINT "subjects_external_id_present" CHECK(length(external_subject_id) > 0),
	CONSTRAINT "subjects_login_present" CHECK(length(login_snapshot) > 0),
	CONSTRAINT "subjects_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subjects_workspace_id_id_unique` ON `subjects` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subjects_external_unique` ON `subjects` (`workspace_id`,`provider`,`external_subject_id`);--> statement-breakpoint
CREATE TABLE `subscription_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`external_item_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`subscription_id`) REFERENCES `subscriptions`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "subscription_items_external_item_id_present" CHECK(length(external_item_id) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_items_item_unique` ON `subscription_items` (`workspace_id`,`subscription_id`,`external_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_items_workspace_id_id_unique` ON `subscription_items` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source` text NOT NULL,
	`external_subscription_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`state` text NOT NULL,
	`provider_state` text NOT NULL,
	`current_period_start` integer,
	`current_period_end` integer,
	`cancel_at` integer,
	`ended_at` integer,
	`past_due_since` integer,
	`source_updated_at` integer NOT NULL,
	`last_observed_at` integer NOT NULL,
	`next_evaluation_at` integer,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`customer_id`) REFERENCES `customers`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "subscriptions_source_valid" CHECK(source IN ('simulated', 'paddle')),
	CONSTRAINT "subscriptions_state_valid" CHECK(state IN ('trialing', 'active', 'past_due', 'paused', 'canceled', 'expired')),
	CONSTRAINT "subscriptions_period_valid" CHECK(current_period_start IS NULL OR current_period_end IS NULL OR current_period_end > current_period_start),
	CONSTRAINT "subscriptions_past_due_since_iff_past_due" CHECK((state = 'past_due') = (past_due_since IS NOT NULL)),
	CONSTRAINT "subscriptions_ended_at_iff_ended" CHECK((state IN ('canceled', 'expired')) = (ended_at IS NOT NULL)),
	CONSTRAINT "subscriptions_version_positive" CHECK(version >= 1),
	CONSTRAINT "subscriptions_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
CREATE INDEX `subscriptions_next_evaluation_idx` ON `subscriptions` (`next_evaluation_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_workspace_id_id_unique` ON `subscriptions` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_external_unique` ON `subscriptions` (`workspace_id`,`source`,`external_subscription_id`);--> statement-breakpoint
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
	CONSTRAINT "outbox_kind_valid" CHECK(kind IN ('process_external_event', 'resync_connection', 'refresh_subscription', 'recompute_offer')),
	CONSTRAINT "outbox_attempts_non_negative" CHECK(attempts >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_outbox`("id", "kind", "subject_id", "created_at", "available_at", "attempts", "sent_at", "failed_at", "last_error_code") SELECT "id", "kind", "subject_id", "created_at", "available_at", "attempts", "sent_at", "failed_at", "last_error_code" FROM `outbox`;--> statement-breakpoint
DROP TABLE `outbox`;--> statement-breakpoint
ALTER TABLE `__new_outbox` RENAME TO `outbox`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`sent_at`,`available_at`);--> statement-breakpoint
CREATE TRIGGER `offer_versions_no_update` BEFORE UPDATE ON `offer_versions`
BEGIN SELECT RAISE(ABORT, 'offer_versions is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `offer_versions_no_delete` BEFORE DELETE ON `offer_versions`
BEGIN SELECT RAISE(ABORT, 'offer_versions is append-only'); END;
