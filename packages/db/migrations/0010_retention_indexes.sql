CREATE INDEX `auth_sessions_expires_idx` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `auth_verifications_expires_idx` ON `auth_verifications` (`expires_at`);