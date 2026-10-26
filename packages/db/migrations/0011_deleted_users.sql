-- Phase 6 risk fixes: an account deletion that keeps the ID-only `users` row (a connection or
-- offer version still names it, decision 0015) marks it deleted in its final batch. Nothing may
-- link to it again: a sign-in racing the deletion could otherwise re-insert an identity onto it,
-- and every later sign-in with that GitHub account would be refused as a conflict. Adding a
-- nullable column is safe on a running service; existing rows read as not deleted.
ALTER TABLE `users` ADD `deleted_at` integer;--> statement-breakpoint
CREATE TRIGGER `external_identities_user_not_deleted` BEFORE INSERT ON `external_identities`
WHEN (SELECT deleted_at FROM users WHERE id = NEW.user_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'external_identities: the user was deleted'); END;
