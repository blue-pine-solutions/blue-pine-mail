import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { imapFolders, imapMessageUids } from "@/db/schema/bluepine";
import { draftFingerprint } from "@/lib/email/canonical-message-utils";
import { newId } from "@/lib/ids";
import type { ImapFolderKey } from "./types";
import { chunk, DELETED_INVARIANT_TRIGGER, IN_LIST_CHUNK, nowSeconds, parseFolderKey, UID_ASSIGNMENT_CHUNK } from "./utils";

/**
 * Storage mechanics behind src/lib/imap/service.ts. Every write here is a single SQL
 * statement, so it is atomic on D1 and on the Node SQLite wrapper without relying on
 * batches: UID assignment is one INSERT … SELECT whose UIDNEXT bump happens in the
 * bp_imap_message_uids_advance_uid_next trigger, inside the same statement. The one
 * exception is relocateImapMessages, one batch (a transaction on both runtimes) whose
 * statements each carry their own guard.
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

/**
 * "The bp0003 invariant is installed": a message's pending \Deleted marks are cleared by
 * the database whenever its folder membership changes. Used inside every write that sets
 * \Deleted or acts on it, so such a write does nothing at all once the trigger is gone,
 * whatever an earlier check found.
 */
export const deletedInvariantInstalled: SQL = sql`EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ${DELETED_INVARIANT_TRIGGER} AND tbl_name = 'messages')`;

/** Whether the bp0003 invariant is installed right now. Never cached: writes re-check it themselves. */
export async function hasDeletedInvariant(db: AppDatabase): Promise<boolean> {
	const row = await db.get<{ installed: number }>(sql`SELECT CASE WHEN ${deletedInvariantInstalled} THEN 1 ELSE 0 END AS installed`);
	return Number(row?.installed) === 1;
}

export type ImapRelocationEnd = { folder: ImapFolderRow; key: ImapFolderKey };

const dialect = new SQLiteAsyncDialect();

/**
 * Run raw statements as one D1 batch: a transaction on D1 and on the Node SQLite wrapper
 * alike. drizzle's own batch cannot carry parameterized raw SQL, so the statements are
 * compiled with its SQLite dialect and sent through the D1 API.
 */
async function batchSql(db: AppDatabase, statements: SQL[]) {
	const client = db.$client as D1Database;
	return client.batch(
		statements.map((statement) => {
			const query = dialect.sqlToQuery(statement);
			return client.prepare(query.sql).bind(...query.params);
		}),
	);
}

/**
 * Move the messages that `uids` name in `source` into `destination` as one atomic batch, and
 * return the source UIDs this released. Only messages whose source UID is still marked
 * \Deleted at that moment move (A5.2a's recoverable EXPUNGE; MOVE will relax this), and
 * only while the bp0003 invariant is installed. Every statement guards itself on current
 * state, so a stale or repeated request, or one racing any other move, changes nothing it
 * should not:
 *
 * 1. The product move: `messages` rows still in the source folder, named by a source UID
 *    still marked \Deleted, get the destination's status and folder. bp0003 clears their
 *    \Deleted marks as part of this statement.
 * 2. Destination UIDs, in source UID order, for every message named by these source UIDs
 *    that is now in the destination and not the source and holds no destination UID yet.
 *    The rows have `deleted` = 0 (the default), carry the source UID's recorded canonical
 *    key and size (the bytes do not change), and advance UIDNEXT in the same statement
 *    (bp0002). A destination UID left from an earlier stay whose loss nobody observed is
 *    kept; step 1 has already cleared its \Deleted mark.
 * 3. Release of every source UID whose message is no longer in the source folder.
 *
 * `messages` columns other than status and folder, and every stored object, are untouched.
 * A failed statement (for example an exhausted UIDNEXT) rolls the whole batch back.
 */
export async function relocateImapMessages(
	db: AppDatabase,
	mailboxId: string,
	source: ImapRelocationEnd,
	destination: ImapRelocationEnd,
	target: { status: string; folderId: string | null },
	uids: number[],
): Promise<number[]> {
	if (!uids.length) return [];
	if (uids.length > IN_LIST_CHUNK) throw new Error("Too many UIDs for one relocation");
	const inSource = membershipCondition(mailboxId, source.key);
	const inDestination = membershipCondition(mailboxId, destination.key);
	const uidList = sql.join(uids.map((uid) => sql`${uid}`), sql`, `);
	const folderGuard = target.folderId === null ? sql`1` : sql`EXISTS (SELECT 1 FROM folders WHERE folders.id = ${target.folderId} AND folders.mailbox_id = ${mailboxId})`;
	const now = nowSeconds();
	const left = sql`
		EXISTS (SELECT 1 FROM messages WHERE messages.id = s.message_id AND ${inDestination})
		AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = s.message_id AND ${inSource})
	`;
	const [, , released] = await batchSql(db, [
		sql`
			UPDATE messages SET status = ${target.status}, folder_id = ${target.folderId}
			WHERE ${inSource}
				AND messages.id IN (SELECT message_id FROM imap_message_uids WHERE imap_folder_id = ${source.folder.id} AND uid IN (${uidList}) AND deleted = 1)
				AND ${folderGuard}
				AND ${deletedInvariantInstalled}
		`,
		sql`
			INSERT INTO imap_message_uids (imap_folder_id, uid, message_id, rfc822_key, rfc822_size, created_at)
			SELECT f.id, f.uid_next - 1 + ROW_NUMBER() OVER (ORDER BY s.uid), s.message_id, s.rfc822_key, s.rfc822_size, ${now}
			FROM imap_message_uids s
			JOIN imap_folders f ON f.id = ${destination.folder.id}
			WHERE s.imap_folder_id = ${source.folder.id} AND s.uid IN (${uidList})
				AND ${left}
				AND NOT EXISTS (SELECT 1 FROM imap_message_uids x WHERE x.imap_folder_id = ${destination.folder.id} AND x.message_id = s.message_id)
		`,
		sql`
			DELETE FROM imap_message_uids
			WHERE imap_folder_id = ${source.folder.id} AND uid IN (${uidList})
				AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = imap_message_uids.message_id AND ${inSource})
			RETURNING uid
		`,
	]);
	return (released.results as Array<{ uid: number }>).map((row) => Number(row.uid)).sort((a, b) => a - b);
}
