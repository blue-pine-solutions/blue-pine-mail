-- Blue Pine Solutions Mail downstream migration (see UPSTREAM.md, "Downstream migrations").
-- Mail app passwords: per-mailbox credentials for mail protocols, never the web password.
CREATE TABLE `mail_app_passwords` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`label` text NOT NULL,
	`public_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_app_passwords_public_id_idx` ON `mail_app_passwords` (`public_id`);
--> statement-breakpoint
CREATE INDEX `mail_app_passwords_user_idx` ON `mail_app_passwords` (`user_id`);
--> statement-breakpoint
CREATE INDEX `mail_app_passwords_mailbox_idx` ON `mail_app_passwords` (`mailbox_id`);
--> statement-breakpoint
-- A changed web password (settings, reset link, admin reset, API v1) revokes every mail app password of the account.
CREATE TRIGGER `bp_mail_app_passwords_revoke_on_password_change` AFTER UPDATE OF `password_hash` ON `users`
WHEN NEW.`password_hash` IS NOT OLD.`password_hash`
BEGIN
	DELETE FROM `mail_app_passwords` WHERE `user_id` = NEW.`id`;
END;
--> statement-breakpoint
-- Removing a user's shared-mailbox access revokes the credentials bound to that mailbox, so re-granting access later does not revive them.
CREATE TRIGGER `bp_mail_app_passwords_revoke_on_access_removal` AFTER DELETE ON `mailbox_access`
BEGIN
	DELETE FROM `mail_app_passwords` WHERE `user_id` = OLD.`user_id` AND `mailbox_id` = OLD.`mailbox_id`;
END;
