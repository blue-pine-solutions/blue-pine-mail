import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { imapFolders, imapMessageUids } from "@/db/schema/bluepine";
import { draftFingerprint } from "@/lib/email/canonical-message-utils";
import { newId } from "@/lib/ids";
import type { ImapFolderKey } from "./types";
import { chunk, IN_LIST_CHUNK, nowSeconds, parseFolderKey, UID_ASSIGNMENT_CHUNK } from "./utils";

/**
 * Storage mechanics behind src/lib/imap/service.ts. Every write here is a single SQL
 * statement, so it is atomic on D1 and on the Node SQLite wrapper without relying on
 * batches: UID assignment is one INSERT … SELECT whose UIDNEXT bump happens in the
 * bp_imap_message_uids_advance_uid_next trigger, inside the same statement.
 *
 * Membership is never cached. A mapping row is kept only while its message is still a
 * member of the folder; any read that finds it otherwise deletes it (the message was
 * expunged from that folder), and its UID is never assigned again because UIDNEXT only
 * moves forward.
 */

export type ImapFolderRow = typeof imapFolders.$inferSelect;

function changes(result: unknown): number {
	return Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0);
}

/** "This message is in this IMAP folder", over `messages` columns. Mirrors folderKeyForMessage. */
export function membershipCondition(mailboxId: string, key: ImapFolderKey): SQL {
	const parsed = parseFolderKey(key);
	if (!parsed) throw new Error(`Unknown IMAP folder ${key}`);
	if (parsed.kind === "folder") return and(eq(messages.mailboxId, mailboxId), eq(messages.status, "received"), eq(messages.folderId, parsed.folderId))!;
	if (parsed.role === "inbox") return and(eq(messages.mailboxId, mailboxId), eq(messages.status, "received"), isNull(messages.folderId))!;
	return and(eq(messages.mailboxId, mailboxId), eq(messages.status, parsed.status))!;
}

export async function findFolderRow(db: AppDatabase, mailboxId: string, key: ImapFolderKey): Promise<ImapFolderRow | null> {
	const [row] = await db.select().from(imapFolders).where(and(eq(imapFolders.mailboxId, mailboxId), eq(imapFolders.folderKey, key))).limit(1);
	return row ?? null;
}

/**
 * The folder's state row, created on first use. A new UIDVALIDITY is the current Unix
 * time, raised above every UIDVALIDITY the mailbox has used so a folder recreated under
 * a familiar name never repeats one. Concurrent creators race on the unique index; the
 * loser's INSERT is ignored and both read the winner's row.
 */
export async function ensureFolderRow(db: AppDatabase, mailboxId: string, key: ImapFolderKey): Promise<ImapFolderRow> {
	const existing = await findFolderRow(db, mailboxId, key);
	if (existing) return existing;
	const now = nowSeconds();
	await db.run(sql`
		INSERT OR IGNORE INTO imap_folders (id, mailbox_id, folder_key, uid_validity, uid_next, created_at)
		SELECT ${newId("imf")}, ${mailboxId}, ${key}, MAX(${now}, COALESCE((SELECT MAX(uid_validity) FROM imap_folders WHERE mailbox_id = ${mailboxId}), 0) + 1), 1, ${now}
	`);
	const created = await findFolderRow(db, mailboxId, key);
	if (!created) throw new Error(`IMAP folder state for ${key} could not be created`);
	return created;
}

/** Forget one UID: the message no longer holds it. When `expected` is given, only if the row still binds that fingerprint. */
export async function releaseUid(db: AppDatabase, folderId: string, uid: number, expected?: { draftFingerprint: string | null }): Promise<void> {
	const conditions = [eq(imapMessageUids.imapFolderId, folderId), eq(imapMessageUids.uid, uid)];
	if (expected) conditions.push(expected.draftFingerprint === null ? isNull(imapMessageUids.draftFingerprint) : eq(imapMessageUids.draftFingerprint, expected.draftFingerprint));
	await db.delete(imapMessageUids).where(and(...conditions));
}

/**
 * Bring a folder's mappings up to date with the product state:
 * 1. drop mappings whose message left the folder (moved, deleted, sent, restored away);
 * 2. for Drafts, drop mappings whose draft content changed since the UID was bound;
 * 3. give every member without a UID the next UIDs, oldest message first
 *    (`created_at`, then `id`), in bounded chunks.
 * The folder's first sync assigns UIDs to all existing messages in that order, which is
 * how mail from before A3 enters IMAP: deterministically and only when first needed.
 */
export async function syncFolder(db: AppDatabase, folder: ImapFolderRow, mailboxId: string, key: ImapFolderKey): Promise<void> {
	const member = membershipCondition(mailboxId, key);
	await db.run(sql`
		DELETE FROM imap_message_uids
		WHERE imap_folder_id = ${folder.id}
			AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = imap_message_uids.message_id AND ${member})
	`);
	if (key === "drafts") await bindDraftFingerprints(db, folder.id, member);
	for (;;) {
		const now = nowSeconds();
		const assigned = changes(await db.run(sql`
			INSERT INTO imap_message_uids (imap_folder_id, uid, message_id, created_at)
			SELECT f.id, f.uid_next - 1 + ROW_NUMBER() OVER (ORDER BY pending.created_at, pending.id), pending.id, ${now}
			FROM (
				SELECT messages.id AS id, messages.created_at AS created_at
				FROM messages
				WHERE ${member}
					AND NOT EXISTS (SELECT 1 FROM imap_message_uids x WHERE x.imap_folder_id = ${folder.id} AND x.message_id = messages.id)
				ORDER BY messages.created_at, messages.id
				LIMIT ${UID_ASSIGNMENT_CHUNK}
			) AS pending
			JOIN imap_folders f ON f.id = ${folder.id}
		`));
		if (assigned < UID_ASSIGNMENT_CHUNK) break;
	}
	if (key === "drafts") await bindDraftFingerprints(db, folder.id, member);
}

/** Current canonical draft fingerprints (A1's), keyed by message id. */
export async function currentDraftFingerprints(db: AppDatabase, rows: Array<typeof messages.$inferSelect>): Promise<Map<string, string>> {
	const attachmentsByMessage = new Map<string, Array<typeof messageAttachments.$inferSelect>>();
	for (const ids of chunk(rows.map((row) => row.id), IN_LIST_CHUNK)) {
		for (const attachment of await db.select().from(messageAttachments).where(inArray(messageAttachments.messageId, ids))) {
			const list = attachmentsByMessage.get(attachment.messageId) ?? [];
			list.push(attachment);
			attachmentsByMessage.set(attachment.messageId, list);
		}
	}
	const result = new Map<string, string>();
	for (const row of rows) result.set(row.id, await draftFingerprint(row, attachmentsByMessage.get(row.id) ?? []));
	return result;
}

/**
 * A draft's IMAP content is its canonical representation, which changes when the draft
 * is edited, while an IMAP UID names immutable content. Each Drafts mapping is therefore
 * bound to the fingerprint of the content it was assigned for: an unbound one is bound
 * now, and one whose draft has since changed is dropped so the edited draft gets a new UID.
 */
async function bindDraftFingerprints(db: AppDatabase, folderId: string, member: SQL): Promise<void> {
	const mapped = await db
		.select({ uid: imapMessageUids.uid, bound: imapMessageUids.draftFingerprint, message: messages })
		.from(imapMessageUids)
		.innerJoin(messages, eq(messages.id, imapMessageUids.messageId))
		.where(and(eq(imapMessageUids.imapFolderId, folderId), member));
	if (mapped.length === 0) return;
	const current = await currentDraftFingerprints(db, mapped.map((row) => row.message));
	for (const row of mapped) {
		const fingerprint = current.get(row.message.id)!;
		if (row.bound === fingerprint) continue;
		if (row.bound === null) {
			await db
				.update(imapMessageUids)
				.set({ draftFingerprint: fingerprint })
				.where(and(eq(imapMessageUids.imapFolderId, folderId), eq(imapMessageUids.uid, row.uid), isNull(imapMessageUids.draftFingerprint)));
		} else {
			await releaseUid(db, folderId, row.uid, { draftFingerprint: row.bound });
		}
	}
}
