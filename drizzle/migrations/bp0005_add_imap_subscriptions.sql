-- Blue Pine Solutions Mail downstream migration (see UPSTREAM.md, "Downstream migrations").
-- IMAP subscriptions (A5.5b): the mailboxes a user has unsubscribed from, per mailbox account
-- (user and mailbox). Every mailbox is subscribed unless a row here says otherwise, so a
-- database upgraded from before A5.5b, and a folder created on any surface, starts subscribed.
-- Folders are named by A3's stable folder key (a system role, or `f:<folder id>`), never by
-- their display name, so a rename keeps the state and a deleted folder's id is never reused.
CREATE TABLE `imap_unsubscribed_folders` (
	`user_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`folder_key` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `mailbox_id`, `folder_key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `imap_unsubscribed_folders_mailbox_idx` ON `imap_unsubscribed_folders` (`mailbox_id`,`folder_key`);
