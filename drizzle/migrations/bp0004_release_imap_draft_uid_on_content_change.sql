-- Blue Pine Solutions Mail downstream migration (see UPSTREAM.md, "Downstream migrations" and
-- "IMAP draft UID invariant (bp0004)"). A Drafts UID names the content of one draft version
-- (A3 binds it to the draft fingerprint, src/lib/email/canonical-message-utils.ts). A draft is
-- edited by several separate writes (its columns, its attachment rows), and the fingerprint is
-- computed in application code, so no single statement elsewhere can prove that a UID still
-- names the current content. These triggers make the database release a draft's Drafts UID in
-- the same statement as any change to what the fingerprint covers: the columns below, and
-- adding or removing an attachment (attachment rows are never updated in place). With the UID
-- gone, a \Deleted mark set on the old content, or a STORE or EXPUNGE naming the old UID, can
-- never reach the edited draft; the edited draft gets the next UID, as A3 already intends.
-- The triggers only ever delete `imap_message_uids` rows of the Drafts folder; they never
-- write `messages` or `message_attachments`. The IMAP listener offers \Deleted and permanent
-- EXPUNGE in Drafts only while all three exist (src/lib/imap/state.ts).
CREATE TRIGGER `bp_imap_draft_content_releases_uid` AFTER UPDATE OF `from_addr`, `to_addr`, `cc_addr`, `bcc_addr`, `subject`, `text_body`, `html_body`, `in_reply_to`, `references_header` ON `messages`
WHEN OLD.`from_addr` IS NOT NEW.`from_addr` OR OLD.`to_addr` IS NOT NEW.`to_addr` OR OLD.`cc_addr` IS NOT NEW.`cc_addr` OR OLD.`bcc_addr` IS NOT NEW.`bcc_addr` OR OLD.`subject` IS NOT NEW.`subject` OR OLD.`text_body` IS NOT NEW.`text_body` OR OLD.`html_body` IS NOT NEW.`html_body` OR OLD.`in_reply_to` IS NOT NEW.`in_reply_to` OR OLD.`references_header` IS NOT NEW.`references_header`
BEGIN
	DELETE FROM `imap_message_uids` WHERE `message_id` = NEW.`id` AND `imap_folder_id` IN (SELECT `id` FROM `imap_folders` WHERE `folder_key` = 'drafts' AND `mailbox_id` IN (OLD.`mailbox_id`, NEW.`mailbox_id`));
END;
--> statement-breakpoint
CREATE TRIGGER `bp_imap_draft_attachment_added_releases_uid` AFTER INSERT ON `message_attachments`
WHEN EXISTS (SELECT 1 FROM `messages` WHERE `id` = NEW.`message_id` AND `status` = 'draft')
BEGIN
	DELETE FROM `imap_message_uids` WHERE `message_id` = NEW.`message_id` AND `imap_folder_id` IN (SELECT `id` FROM `imap_folders` WHERE `folder_key` = 'drafts' AND `mailbox_id` = (SELECT `mailbox_id` FROM `messages` WHERE `id` = NEW.`message_id`));
END;
--> statement-breakpoint
CREATE TRIGGER `bp_imap_draft_attachment_removed_releases_uid` AFTER DELETE ON `message_attachments`
WHEN EXISTS (SELECT 1 FROM `messages` WHERE `id` = OLD.`message_id` AND `status` = 'draft')
BEGIN
	DELETE FROM `imap_message_uids` WHERE `message_id` = OLD.`message_id` AND `imap_folder_id` IN (SELECT `id` FROM `imap_folders` WHERE `folder_key` = 'drafts' AND `mailbox_id` = (SELECT `mailbox_id` FROM `messages` WHERE `id` = OLD.`message_id`));
END;
