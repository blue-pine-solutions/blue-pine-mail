-- Blue Pine Solutions Mail downstream migration (see UPSTREAM.md, "Downstream migrations").
-- IMAP mailbox state: per-folder UIDVALIDITY/UIDNEXT and per-folder message UIDs, kept beside
-- the upstream tables. Nothing is attached to `messages` or `folders`: membership is derived
-- from them when a folder is read (src/lib/imap/), so an upstream rebuild of either table
-- cannot silently drop Blue Pine state.
CREATE TABLE `imap_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`folder_key` text NOT NULL,
	`uid_validity` integer NOT NULL CHECK (`uid_validity` BETWEEN 1 AND 4294967295),
	`uid_next` integer DEFAULT 1 NOT NULL CHECK (`uid_next` BETWEEN 1 AND 4294967296),
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `imap_folders_mailbox_key_idx` ON `imap_folders` (`mailbox_id`,`folder_key`);
--> statement-breakpoint
CREATE TABLE `imap_message_uids` (
	`imap_folder_id` text NOT NULL,
	`uid` integer NOT NULL CHECK (`uid` BETWEEN 1 AND 4294967295),
	`message_id` text NOT NULL,
	`draft_fingerprint` text,
	`rfc822_key` text,
	`rfc822_size` integer,
	`deleted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`imap_folder_id`, `uid`),
	FOREIGN KEY (`imap_folder_id`) REFERENCES `imap_folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `imap_message_uids_folder_message_idx` ON `imap_message_uids` (`imap_folder_id`,`message_id`);
--> statement-breakpoint
CREATE INDEX `imap_message_uids_message_idx` ON `imap_message_uids` (`message_id`);
--> statement-breakpoint
-- UIDNEXT moves with every assigned UID inside the statement that assigns it, so allocation is one atomic statement on SQLite and D1 alike.
CREATE TRIGGER `bp_imap_message_uids_advance_uid_next` AFTER INSERT ON `imap_message_uids`
BEGIN
	UPDATE `imap_folders` SET `uid_next` = MAX(`uid_next`, NEW.`uid` + 1) WHERE `id` = NEW.`imap_folder_id`;
END;
--> statement-breakpoint
-- An assigned UID names one message for the life of its UIDVALIDITY.
CREATE TRIGGER `bp_imap_message_uids_immutable` BEFORE UPDATE OF `imap_folder_id`, `uid`, `message_id` ON `imap_message_uids`
BEGIN
	SELECT RAISE(ABORT, 'IMAP UIDs cannot be reassigned');
END;
--> statement-breakpoint
-- UIDNEXT never decreases and UIDVALIDITY only ever increases (RFC 9051 §2.3.1.1).
CREATE TRIGGER `bp_imap_folders_monotonic` BEFORE UPDATE OF `uid_next`, `uid_validity` ON `imap_folders`
WHEN NEW.`uid_next` < OLD.`uid_next` OR NEW.`uid_validity` < OLD.`uid_validity`
BEGIN
	SELECT RAISE(ABORT, 'IMAP UIDNEXT and UIDVALIDITY cannot decrease');
END;
