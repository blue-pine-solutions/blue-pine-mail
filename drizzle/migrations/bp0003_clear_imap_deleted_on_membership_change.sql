-- Blue Pine Solutions Mail downstream migration (see UPSTREAM.md, "Downstream migrations" and
-- "IMAP mailbox state"). IMAP \Deleted is kept on a message's UID in one folder
-- (imap_message_uids.deleted), and that UID is released lazily, the next time the folder is
-- read. A message that left a folder and came back before anyone read it would otherwise find
-- its old UID still marked \Deleted, and a later EXPUNGE would act on a mark that no longer
-- expresses anyone's intent. Any change to the columns that decide which IMAP folder a message
-- is in (mailbox_id, status, folder_id; see membershipCondition in src/lib/imap/state.ts)
-- therefore clears the pending \Deleted marks of that message, whichever code path made it.
-- The trigger only ever clears a mark, never sets one or touches UIDs. The IMAP listener
-- offers \Deleted and EXPUNGE only while this trigger exists (src/lib/imap/state.ts).
CREATE TRIGGER `bp_imap_membership_clears_deleted` AFTER UPDATE OF `mailbox_id`, `status`, `folder_id` ON `messages`
WHEN OLD.`mailbox_id` IS NOT NEW.`mailbox_id` OR OLD.`status` IS NOT NEW.`status` OR OLD.`folder_id` IS NOT NEW.`folder_id`
BEGIN
	UPDATE `imap_message_uids` SET `deleted` = 0 WHERE `message_id` = NEW.`id` AND `deleted` = 1;
END;
