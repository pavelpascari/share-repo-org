CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "users_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
CREATE TABLE `workspace_memberships` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workspace_memberships_role_valid" CHECK(role IN ('owner', 'member'))
);
--> statement-breakpoint
CREATE INDEX `workspace_memberships_user_id_idx` ON `workspace_memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "workspaces_slug_format" CHECK(length(slug) BETWEEN 3 AND 48 AND slug NOT GLOB '*[^a-z0-9-]*' AND slug NOT GLOB '-*' AND slug NOT GLOB '*-' AND slug NOT GLOB '*--*'),
	CONSTRAINT "workspaces_name_format" CHECK(length(name) BETWEEN 1 AND 100 AND name = trim(name, ' ' || char(9, 10, 11, 12, 13))),
	CONSTRAINT "workspaces_status_valid" CHECK(status IN ('active', 'suspended')),
	CONSTRAINT "workspaces_updated_after_created" CHECK(updated_at >= created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);