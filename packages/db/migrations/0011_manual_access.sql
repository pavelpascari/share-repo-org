CREATE TABLE `manual_accesses` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`ends_at` integer,
	`note` text,
	`revoked_at` integer,
	`revoke_cause` text,
	`next_evaluation_at` integer,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`offer_id`) REFERENCES `offers`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`subject_id`) REFERENCES `subjects`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "manual_accesses_ends_after_created" CHECK(ends_at IS NULL OR ends_at > created_at),
	CONSTRAINT "manual_accesses_note_bounds" CHECK(note IS NULL OR (length(trim(note)) > 0 AND length(note) <= 500)),
	CONSTRAINT "manual_accesses_revoke_cause_valid" CHECK(revoke_cause IS NULL OR revoke_cause IN ('owner', 'account_deleted')),
	CONSTRAINT "manual_accesses_revoked_pair" CHECK((revoked_at IS NULL) = (revoke_cause IS NULL) AND (revoked_at IS NULL OR revoked_at >= created_at)),
	CONSTRAINT "manual_accesses_revoked_not_scheduled" CHECK(revoked_at IS NULL OR next_evaluation_at IS NULL),
	CONSTRAINT "manual_accesses_version_positive" CHECK(version >= 1),
	CONSTRAINT "manual_accesses_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manual_accesses_open_unique` ON `manual_accesses` (`workspace_id`,`offer_id`,`subject_id`) WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX `manual_accesses_next_evaluation_idx` ON `manual_accesses` (`next_evaluation_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `manual_accesses_workspace_id_id_unique` ON `manual_accesses` (`workspace_id`,`id`);--> statement-breakpoint
-- Hand-edited, as in 0009: drizzle-kit 0.31 emits `PRAGMA foreign_keys=OFF/ON` around a table
-- rebuild, which is a no-op inside the transaction D1 runs a migration in, and `grants` references
-- `entitlements`. D1's documented alternative defers foreign key checks to the end of the
-- migration, when the rebuilt table is back in place. The copy also lists only stored columns:
-- `subscription_id` and `manual_access_id` are generated from `source_type` and `source_id`.
PRAGMA defer_foreign_keys=on;--> statement-breakpoint
CREATE TABLE `__new_entitlements` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`access_level` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`subscription_id` text GENERATED ALWAYS AS (CASE WHEN source_type = 'subscription' THEN source_id END) VIRTUAL,
	`manual_access_id` text GENERATED ALWAYS AS (CASE WHEN source_type = 'manual' THEN source_id END) VIRTUAL,
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
	FOREIGN KEY (`workspace_id`,`subscription_id`) REFERENCES `subscriptions`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`manual_access_id`) REFERENCES `manual_accesses`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`,`offer_id`,`offer_version`) REFERENCES `offer_versions`(`workspace_id`,`offer_id`,`version`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "entitlements_access_level_valid" CHECK(access_level IN ('read', 'write')),
	CONSTRAINT "entitlements_source_type_valid" CHECK(source_type IN ('subscription', 'manual')),
	CONSTRAINT "entitlements_state_valid" CHECK(state IN ('active', 'expired', 'revoked')),
	CONSTRAINT "entitlements_policy_version_positive" CHECK(policy_version >= 1),
	CONSTRAINT "entitlements_interval_valid" CHECK(valid_until IS NULL OR valid_until > valid_from),
	CONSTRAINT "entitlements_ended_iff_not_active" CHECK((state = 'active') = (ended_at IS NULL)),
	CONSTRAINT "entitlements_reason_present" CHECK(length(decision_reason) > 0),
	CONSTRAINT "entitlements_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
INSERT INTO `__new_entitlements`("id", "workspace_id", "subject_id", "resource_id", "access_level", "source_type", "source_id", "offer_id", "offer_version", "policy_version", "state", "valid_from", "valid_until", "decision_reason", "ended_at", "created_at", "updated_at") SELECT "id", "workspace_id", "subject_id", "resource_id", "access_level", "source_type", "source_id", "offer_id", "offer_version", "policy_version", "state", "valid_from", "valid_until", "decision_reason", "ended_at", "created_at", "updated_at" FROM `entitlements`;--> statement-breakpoint
DROP TABLE `entitlements`;--> statement-breakpoint
ALTER TABLE `__new_entitlements` RENAME TO `entitlements`;--> statement-breakpoint
CREATE UNIQUE INDEX `entitlements_live_unique` ON `entitlements` (`workspace_id`,`source_id`,`offer_id`,`resource_id`,`subject_id`) WHERE state = 'active';--> statement-breakpoint
CREATE INDEX `entitlements_subject_resource_idx` ON `entitlements` (`workspace_id`,`subject_id`,`resource_id`);--> statement-breakpoint
CREATE INDEX `entitlements_state_valid_until_idx` ON `entitlements` (`state`,`valid_until`);--> statement-breakpoint
CREATE UNIQUE INDEX `entitlements_workspace_id_id_unique` ON `entitlements` (`workspace_id`,`id`);--> statement-breakpoint
-- As in 0009: switching the pragma off clears the count of deferred violations the DROP's implicit
-- delete recorded for `grants` rows, which the rebuilt table satisfies again. The upgrade test
-- checks `PRAGMA foreign_key_check` afterwards.
PRAGMA defer_foreign_keys=off;
