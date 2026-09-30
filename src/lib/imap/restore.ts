import { nowSeconds } from "./utils";

/**
 * Keeps IMAP identity sound across a database restore (src/lib/backups/export.ts).
 *
 * A backup carries `imap_folders` and `imap_message_uids` with the messages they describe,
 * so restoring into a database that never served that state (disaster recovery, a new
 * installation) keeps every UIDVALIDITY, UIDNEXT and UID. Restoring over a database whose
 * IMAP state moved on since the backup would hand clients UIDs they have already seen
 * expunged or assigned to other messages, so for each folder that changed, and for each
 * folder the backup does not have, UIDVALIDITY is raised above the value clients last saw
 * and they resynchronize that folder.
 *
 * A folder is unchanged when UIDVALIDITY, UIDNEXT and the number of UIDs held all match:
 * with UIDNEXT equal no UID was assigned since the backup, so the live UIDs are a subset
 * of the backup's, and equal counts make them the same set.
 */

export type ImapRestoreSnapshot = Array<{ id: string; mailbox_id: string; folder_key: string; uid_validity: number; uid_next: number; mapped: number }>;

const SNAPSHOT_SQL = "SELECT f.id, f.mailbox_id, f.folder_key, f.uid_validity, f.uid_next, (SELECT COUNT(*) FROM imap_message_uids u WHERE u.imap_folder_id = f.id) AS mapped FROM imap_folders f";

async function hasImapState(db: D1Database): Promise<boolean> {
	return !!(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'imap_folders'").first<{ name: string }>());
}

/** The live IMAP state, read before a restore replaces it. Null before bp0002 is applied. */
export async function captureImapStateForRestore(db: D1Database): Promise<ImapRestoreSnapshot | null> {
	if (!(await hasImapState(db))) return null;
	return (await db.prepare(SNAPSHOT_SQL).all<ImapRestoreSnapshot[number]>()).results;
}

/** Invalidate, by raising UIDVALIDITY, every folder whose restored state differs from what clients may have seen. */
export async function reconcileImapStateAfterRestore(db: D1Database, before: ImapRestoreSnapshot | null): Promise<void> {
	if (!before?.length) return;
	const restored = new Map((await db.prepare(SNAPSHOT_SQL).all<ImapRestoreSnapshot[number]>()).results.map((row) => [`${row.mailbox_id}\u0000${row.folder_key}`, row]));
	const now = nowSeconds();
	for (const live of before) {
		const row = restored.get(`${live.mailbox_id}\u0000${live.folder_key}`);
		if (row) {
			if (Number(row.uid_validity) === Number(live.uid_validity) && Number(row.uid_next) === Number(live.uid_next) && Number(row.mapped) === Number(live.mapped)) continue;
			const next = Math.max(now, Number(live.uid_validity) + 1, Number(row.uid_validity) + 1);
			await db.prepare("UPDATE imap_folders SET uid_validity = ? WHERE id = ?").bind(next, row.id).run();
		} else {
			// Kept without UIDs so the folder's next UIDVALIDITY still exceeds the one clients know.
			await db
				.prepare(
					"INSERT INTO imap_folders (id, mailbox_id, folder_key, uid_validity, uid_next, created_at) SELECT ?, ?, ?, ?, 1, ? WHERE EXISTS (SELECT 1 FROM mailboxes WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM imap_folders WHERE id = ?)",
				)
				.bind(live.id, live.mailbox_id, live.folder_key, Math.max(now, Number(live.uid_validity) + 1), now, live.mailbox_id, live.id)
				.run();
		}
	}
}
