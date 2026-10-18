ALTER TABLE `connections` ADD `sync_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `sync_token` text;--> statement-breakpoint
ALTER TABLE `outbox` ADD `failed_at` integer;--> statement-breakpoint
ALTER TABLE `outbox` ADD `last_error_code` text;