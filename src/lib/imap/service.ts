import { and, asc, eq, exists, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import type { AppDatabase } from "@/db";
import { folders, messages } from "@/db/schema";
import { imapMessageUids } from "@/db/schema/bluepine";
import { resolveCanonicalMessage } from "@/lib/email/canonical-message";
import { fingerprintFromKey, isCanonicalKey } from "@/lib/email/canonical-message-utils";
import { authorizeImapAccess } from "./access";
import { currentDraftFingerprints, deletedInvariantInstalled, ensureFolderRow, findFolderRow, hasDeletedInvariant, membershipCondition, relocateImapMessages, releaseUid, syncFolder } from "./state";
import type { ImapFolderRow } from "./state";
import type {
	ImapAccess,
	ImapFlagChanges,
	ImapFlagName,
	ImapFlags,
	ImapFlagStore,
	ImapFolderKey,
	ImapFolderSnapshot,
	ImapFolderStatus,
	ImapMailbox,
	ImapMessageContent,
	ImapMessageEntry,
	ImapPrincipal,
} from "./types";
import { chunk, customFolderKey, customFolderNames, FLAG_STORE_CHUNK, flagsFor, ImapStateError, isRecoverablyExpungeable, parseFolderKey, RELOCATION_CHUNK, STORABLE_FLAGS, SYSTEM_FOLDERS } from "./utils";

/**
 * Protocol-neutral IMAP mailbox state for one authenticated principal (a verified mail
 * app password, A2). A listener formats these values; it never touches storage itself.
 *
 * - The IMAP-visible folders are the mailbox's system folders and its custom folders
 *   (listImapMailboxes). Each has a persistent UIDVALIDITY and a monotonic UIDNEXT.
 * - A message holds one UID in the one folder it belongs to. Moving it (a status or folder
 *   change anywhere in the product) expunges it from the old folder and it receives the
 *   next UID of the new one; deleting it expunges it. UIDs are never reused.
 * - Content for a UID is the A1 canonical representation, byte for byte, and never changes
 *   while the UID exists.
 * - \Deleted is IMAP's own mark on a UID. Only principals with management access may set
 *   it, only in folders whose expunge is recoverable (not Trash or Drafts), and only while
 *   the bp0003 invariant is installed. Expunging moves \Deleted messages to Trash; nothing
 *   here deletes a message or a stored object.
 *
 * Authorization is re-evaluated on every call, and folder keys are resolved within the
 * principal's own mailbox only.
 */

type Opened = { db: AppDatabase; access: ImapAccess; mailbox: ImapMailbox; deletable: boolean };

async function open(env: CloudflareEnv, principal: ImapPrincipal, key: string): Promise<Opened> {
	const db = getDb(env);
	const access = await authorizeImapAccess(db, principal);
	if (!access) throw new ImapStateError("forbidden", "Mailbox access denied");
	const deletable = access.canManage && (await hasDeletedInvariant(db));
	const mailbox = await resolveMailbox(db, access, key, deletable);
	if (!mailbox) throw new ImapStateError("nonexistent", "No such folder");
	return { db, access, mailbox, deletable };
}

/**
 * The flags a principal may change on messages in a folder. Read and starred state can be
 * changed by anyone who can read the mailbox, as in the web app. \Deleted needs management
 * access (its purpose is a later expunge), a folder whose expunge is recoverable, and the
 * bp0003 invariant (`deletable`).
 */
function permanentFlags(key: ImapFolderKey, deletable: boolean): ImapFlagName[] {
	return deletable && isRecoverablyExpungeable(key) ? ["seen", "flagged", "deleted"] : ["seen", "flagged"];
}

async function resolveMailbox(db: AppDatabase, access: ImapAccess, key: string, deletable: boolean): Promise<ImapMailbox | null> {
	const parsed = parseFolderKey(key);
	if (!parsed) return null;
	if (parsed.kind === "role") return (await listMailboxes(db, access, deletable)).find((mailbox) => mailbox.key === key) ?? null;
	const [folder] = await db.select({ id: folders.id }).from(folders).where(and(eq(folders.id, parsed.folderId), eq(folders.mailboxId, access.mailboxId))).limit(1);
	if (!folder) return null;
	return (await listMailboxes(db, access, deletable)).find((mailbox) => mailbox.key === key) ?? null;
}

async function listMailboxes(db: AppDatabase, access: ImapAccess, deletable: boolean): Promise<ImapMailbox[]> {
	const custom = await db
		.select({ id: folders.id, name: folders.name })
		.from(folders)
		.where(eq(folders.mailboxId, access.mailboxId))
		.orderBy(asc(folders.createdAt), asc(folders.id));
	const names = customFolderNames(custom);
	return [
		...SYSTEM_FOLDERS.map((folder): ImapMailbox => ({
			key: folder.role,
			name: folder.name,
			role: folder.role,
			specialUse: folder.specialUse,
			folderId: null,
			selectable: true,
			permanentFlags: permanentFlags(folder.role, deletable),
			mayWrite: access.canManage,
			mayRename: false,
			mayDelete: false,
		})),
		...custom.map((folder): ImapMailbox => ({
			key: customFolderKey(folder.id),
			name: names.get(folder.id)!,
			role: null,
			specialUse: null,
			folderId: folder.id,
			selectable: true,
			permanentFlags: permanentFlags(customFolderKey(folder.id), deletable),
			mayWrite: access.canManage,
			mayRename: access.canManage,
			mayDelete: access.canManage,
		})),
	];
}

/** The IMAP-visible folders of the principal's mailbox, system folders first. */
export async function listImapMailboxes(env: CloudflareEnv, principal: ImapPrincipal): Promise<ImapMailbox[]> {
	const db = getDb(env);
	const access = await authorizeImapAccess(db, principal);
	if (!access) throw new ImapStateError("forbidden", "Mailbox access denied");
	// UIDs held in custom folders that no longer exist can never be read again. The folder
	// rows stay: they keep later UIDVALIDITY values in this mailbox increasing.
	await db.run(sql`
		DELETE FROM imap_message_uids WHERE imap_folder_id IN (
			SELECT id FROM imap_folders
			WHERE mailbox_id = ${access.mailboxId} AND folder_key LIKE 'f:%'
				AND substr(folder_key, 3) NOT IN (SELECT id FROM folders WHERE mailbox_id = ${access.mailboxId})
		)
	`);
	return listMailboxes(db, access, access.canManage && (await hasDeletedInvariant(db)));
}

async function synced(opened: Opened): Promise<ImapFolderRow> {
	const folder = await ensureFolderRow(opened.db, opened.access.mailboxId, opened.mailbox.key);
	await syncFolder(opened.db, folder, opened.access.mailboxId, opened.mailbox.key);
	return (await findFolderRow(opened.db, opened.access.mailboxId, opened.mailbox.key))!;
}

async function readEntries(opened: Opened, folderId: string): Promise<ImapMessageEntry[]> {
	const rows = await opened.db
		.select({
			uid: imapMessageUids.uid,
			deleted: imapMessageUids.deleted,
			rfc822Size: imapMessageUids.rfc822Size,
			messageId: messages.id,
			createdAt: messages.createdAt,
			read: messages.read,
			starred: messages.starred,
			status: messages.status,
			direction: messages.direction,
		})
		.from(imapMessageUids)
		.innerJoin(messages, eq(messages.id, imapMessageUids.messageId))
		.where(and(eq(imapMessageUids.imapFolderId, folderId), membershipCondition(opened.access.mailboxId, opened.mailbox.key)))
		.orderBy(asc(imapMessageUids.uid));
	return rows.map((row) => ({ uid: row.uid, messageId: row.messageId, internalDate: row.createdAt, flags: flagsFor(row, row.deleted), rfc822Size: row.rfc822Size }));
}

/**
 * Everything a SELECT needs: the folder's UIDVALIDITY and UIDNEXT and its messages in UID
 * order, after assigning UIDs to messages that arrived or moved in since the last read.
 * UIDNEXT is read after the messages, so it is greater than every UID returned.
 */
export async function openImapFolder(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey): Promise<ImapFolderSnapshot> {
	const opened = await open(env, principal, key);
	const folder = await synced(opened);
	const entries = await readEntries(opened, folder.id);
	const state = (await findFolderRow(opened.db, opened.access.mailboxId, opened.mailbox.key))!;
	return { mailbox: opened.mailbox, uidValidity: state.uidValidity, uidNext: state.uidNext, messages: entries };
}

/** STATUS-style counters for a folder, on the same synchronized state as openImapFolder. */
export async function getImapFolderStatus(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey): Promise<ImapFolderStatus> {
	const snapshot = await openImapFolder(env, principal, key);
	return {
		uidValidity: snapshot.uidValidity,
		uidNext: snapshot.uidNext,
		messages: snapshot.messages.length,
		unseen: snapshot.messages.filter((entry) => !entry.flags.seen).length,
		deleted: snapshot.messages.filter((entry) => entry.flags.deleted).length,
	};
}

/** Assign (or return) the UID of a message in a folder, e.g. right after a move into it. Null when the message is not a member. */
export async function ensureImapUid(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey, messageId: string): Promise<number | null> {
	const opened = await open(env, principal, key);
	const folder = await synced(opened);
	const [row] = await opened.db
		.select({ uid: imapMessageUids.uid })
		.from(imapMessageUids)
		.innerJoin(messages, eq(messages.id, imapMessageUids.messageId))
		.where(and(eq(imapMessageUids.imapFolderId, folder.id), eq(imapMessageUids.messageId, messageId), membershipCondition(opened.access.mailboxId, opened.mailbox.key)))
		.limit(1);
	return row?.uid ?? null;
}

type Hit = { folder: ImapFolderRow; mapping: typeof imapMessageUids.$inferSelect; message: typeof messages.$inferSelect };

/**
 * The message a UID currently names, or null when the UID is not (or no longer) valid.
 * A mapping whose message has left the folder is released here, so a UID is never seen
 * to disappear and later come back.
 */
async function resolveHit(opened: Opened, uid: number): Promise<Hit | null> {
	if (!Number.isInteger(uid) || uid < 1) return null;
	const folder = await findFolderRow(opened.db, opened.access.mailboxId, opened.mailbox.key);
	if (!folder) return null;
	const [row] = await opened.db
		.select({ mapping: imapMessageUids, message: messages })
		.from(imapMessageUids)
		.leftJoin(messages, and(eq(messages.id, imapMessageUids.messageId), membershipCondition(opened.access.mailboxId, opened.mailbox.key)))
		.where(and(eq(imapMessageUids.imapFolderId, folder.id), eq(imapMessageUids.uid, uid)))
		.limit(1);
	if (!row) return null;
	if (!row.message) {
		await releaseUid(opened.db, folder.id, uid);
		return null;
	}
	if (opened.mailbox.key === "drafts") {
		const fingerprint = (await currentDraftFingerprints(opened.db, [row.message])).get(row.message.id)!;
		let bound = row.mapping.draftFingerprint;
		if (bound === null) {
			await opened.db
				.update(imapMessageUids)
				.set({ draftFingerprint: fingerprint })
				.where(and(eq(imapMessageUids.imapFolderId, folder.id), eq(imapMessageUids.uid, uid), isNull(imapMessageUids.draftFingerprint)));
			const [again] = await opened.db.select({ bound: imapMessageUids.draftFingerprint }).from(imapMessageUids).where(and(eq(imapMessageUids.imapFolderId, folder.id), eq(imapMessageUids.uid, uid))).limit(1);
			if (!again) return null;
			bound = again.bound;
		}
		if (bound !== fingerprint) {
			await releaseUid(opened.db, folder.id, uid, { draftFingerprint: bound });
			return null;
		}
		row.mapping.draftFingerprint = bound;
	}
	return { folder, mapping: row.mapping, message: row.message };
}

/** The internal message a UID names, with its flags. Null when the UID is not valid. */
export async function resolveImapUid(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey, uid: number): Promise<ImapMessageEntry | null> {
	const opened = await open(env, principal, key);
	const hit = await resolveHit(opened, uid);
	if (!hit) return null;
	return { uid, messageId: hit.message.id, internalDate: hit.message.createdAt, flags: flagsFor(hit.message, hit.mapping.deleted), rfc822Size: hit.mapping.rfc822Size };
}

async function toBytes(body: ReadableStream | ArrayBuffer): Promise<Uint8Array> {
	return new Uint8Array(body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer());
}

/**
 * The exact RFC 5322 bytes for a UID, from A1's canonical layer (never rebuilt here), and
 * their octet length as RFC822.SIZE. The first read binds the UID to the stored object it
 * served; if the object behind a message ever changes (a draft re-materialized), the UID is
 * released rather than made to serve different bytes. Bytes A1 would only generate for this
 * read (a missing object) are refused as `unavailable`, since they would not be stable.
 */
export async function fetchImapMessage(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey, uid: number): Promise<ImapMessageContent | null> {
	const opened = await open(env, principal, key);
	const hit = await resolveHit(opened, uid);
	if (!hit) return null;
	const { folder, mapping, message } = hit;

	const canonical = await resolveCanonicalMessage(env, message);
	if (canonical.source === "transient" || !canonical.key) {
		if (canonical.body instanceof ReadableStream) await canonical.body.cancel().catch(() => undefined);
		throw new ImapStateError("unavailable", `Message ${message.id} has no stored representation right now`);
	}
	const changedDraft = mapping.draftFingerprint !== null && isCanonicalKey(canonical.key) && fingerprintFromKey(canonical.key) !== mapping.draftFingerprint;
	if (changedDraft || (mapping.rfc822Key !== null && mapping.rfc822Key !== canonical.key)) {
		if (canonical.body instanceof ReadableStream) await canonical.body.cancel().catch(() => undefined);
		await releaseUid(opened.db, folder.id, uid);
		return null;
	}
	const bytes = await toBytes(canonical.body);
	if (mapping.rfc822Key === null) {
		await opened.db
			.update(imapMessageUids)
			.set({ rfc822Key: canonical.key, rfc822Size: bytes.byteLength })
			.where(and(eq(imapMessageUids.imapFolderId, folder.id), eq(imapMessageUids.uid, uid), isNull(imapMessageUids.rfc822Key)));
		const [bound] = await opened.db.select({ rfc822Key: imapMessageUids.rfc822Key }).from(imapMessageUids).where(and(eq(imapMessageUids.imapFolderId, folder.id), eq(imapMessageUids.uid, uid))).limit(1);
		if (!bound) return null;
		if (bound.rfc822Key !== canonical.key) {
			await releaseUid(opened.db, folder.id, uid);
			return null;
		}
	}
	return {
		uid,
		messageId: message.id,
		bytes,
		size: bytes.byteLength,
		flags: flagsFor(message, mapping.deleted),
		source: canonical.source,
	};
}

/** RFC822.SIZE for a UID: the recorded octet length of its bytes, reading them once if needed. */
export async function getImapMessageSize(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey, uid: number): Promise<number | null> {
	const entry = await resolveImapUid(env, principal, key, uid);
	if (!entry) return null;
	if (entry.rfc822Size !== null) return entry.rfc822Size;
	return (await fetchImapMessage(env, principal, key, uid))?.size ?? null;
}

/** Why \Deleted cannot be changed in an opened folder, or null when it can. */
function deletedRefusal(opened: Opened): ImapStateError | null {
	if (!opened.access.canManage) return new ImapStateError("denied", "This access does not allow marking messages deleted");
	if (!opened.deletable) return new ImapStateError("unsupported", "\\Deleted is unavailable on this server right now");
	if (!isRecoverablyExpungeable(opened.mailbox.key)) return new ImapStateError("unsupported", "Messages in Trash and Drafts cannot be marked deleted on this server yet");
	return null;
}

/**
 * Change flags on the message a UID names. `seen` and `flagged` are the product's read and
 * starred state (shared by everyone with access, and changeable by anyone who can read the
 * mailbox, as in the web app); outbound mail stays seen. `deleted` is IMAP's own \Deleted
 * mark, kept on the UID and gone when the message leaves the folder; changing it follows the
 * same rules as storeImapFlags (`denied` without management access, `unsupported` in Trash,
 * in Drafts or without the bp0003 invariant), checked before anything is written. Returns
 * the resulting flags. A single-UID form for callers other than the listener.
 */
export async function setImapMessageFlags(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey, uid: number, changes: ImapFlagChanges) {
	const opened = await open(env, principal, key);
	if (changes.deleted !== undefined) {
		const refusal = deletedRefusal(opened);
		if (refusal) throw refusal;
	}
	const hit = await resolveHit(opened, uid);
	if (!hit) return null;
	const set: Partial<typeof messages.$inferInsert> = {};
	if (changes.seen !== undefined) set.read = changes.seen;
	if (changes.flagged !== undefined) set.starred = changes.flagged;
	if (Object.keys(set).length) await opened.db.update(messages).set(set).where(eq(messages.id, hit.message.id));
	if (changes.deleted !== undefined) {
		await opened.db
			.update(imapMessageUids)
			.set({ deleted: changes.deleted })
			.where(and(eq(imapMessageUids.imapFolderId, hit.folder.id), eq(imapMessageUids.uid, uid), deletedInvariantInstalled));
	}
	const entry = await resolveHit(opened, uid);
	return entry ? flagsFor(entry.message, entry.mapping.deleted) : null;
}

/**
 * Apply one STORE-style change to many UIDs of a folder and return the resulting flags of
 * each UID, or null for a UID that no longer names a member of the folder.
 *
 * - `seen` and `flagged` are the product's `messages.read` and `messages.starred`, the same
 *   state the web app and JMAP change, so a write here bumps the product's revision through
 *   its own triggers. Outbound mail is always \Seen, so clearing \Seen never writes it.
 * - `deleted` is `imap_message_uids.deleted`, the UID's own \Deleted mark. It needs
 *   management access (`denied` otherwise) and a folder where it is permanent: not Trash or
 *   Drafts, and only while the bp0003 invariant is installed (`unsupported` otherwise).
 *   Naming it where it cannot change refuses the whole request before anything is written,
 *   so `+FLAGS (\Seen \Deleted)` never sets \Seen alone. A replace (`FLAGS`) changes only
 *   the flags the principal may change here, so it never touches \Deleted for a reader.
 * - Each chunk of UIDs is authorized afresh (A3's per-call rule), and its writes are one
 *   batch of statements whose predicate is the UID mapping *and* current folder membership:
 *   a UID whose message has moved or been deleted, however recently, changes nothing, and
 *   no UID can reach a message outside this folder. Rows already in the target state are
 *   not written, so a no-op STORE does not bump any revision.
 * - Permission problems are `denied` (the principal keeps its access); lost access is
 *   `forbidden`.
 */
export async function storeImapFlags(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey, uids: number[], store: ImapFlagStore): Promise<Map<number, ImapFlags | null>> {
	const wanted = [...new Set(uids.filter((uid) => Number.isInteger(uid) && uid >= 1))];
	const result = new Map<number, ImapFlags | null>(wanted.map((uid) => [uid, null]));
	const named = STORABLE_FLAGS.filter((flag) => store.flags.includes(flag));
	const targetOf = (flag: ImapFlagName) => (store.mode === "replace" ? store.flags.includes(flag) : store.mode === "add");
	// An empty request still authorizes once, so a revoked principal never gets an answer.
	for (const uidChunk of wanted.length ? chunk(wanted, FLAG_STORE_CHUNK) : [[]]) {
		const opened = await open(env, principal, key);
		if (named.includes("deleted")) {
			const refusal = deletedRefusal(opened);
			if (refusal) throw refusal;
		}
		if (named.some((flag) => !opened.mailbox.permanentFlags.includes(flag))) throw new ImapStateError("denied", "This access does not allow changing these flags");
		const changing = store.mode === "replace" ? opened.mailbox.permanentFlags : named;
		if (!uidChunk.length) continue;
		const folder = await findFolderRow(opened.db, opened.access.mailboxId, opened.mailbox.key);
		if (!folder) continue;
		const member = membershipCondition(opened.access.mailboxId, opened.mailbox.key);
		const mapped = inArray(
			messages.id,
			opened.db.select({ id: imapMessageUids.messageId }).from(imapMessageUids).where(and(eq(imapMessageUids.imapFolderId, folder.id), inArray(imapMessageUids.uid, uidChunk))),
		);
		const writes = changing.map((flag) => {
			const value = targetOf(flag);
			if (flag === "seen") {
				return opened.db
					.update(messages)
					.set({ read: value })
					.where(and(mapped, member, ne(messages.read, value), value ? undefined : ne(messages.direction, "outbound")));
			}
			if (flag === "flagged") return opened.db.update(messages).set({ starred: value }).where(and(mapped, member, ne(messages.starred, value)));
			return opened.db
				.update(imapMessageUids)
				.set({ deleted: value })
				.where(
					and(
						eq(imapMessageUids.imapFolderId, folder.id),
						inArray(imapMessageUids.uid, uidChunk),
						ne(imapMessageUids.deleted, value),
						exists(opened.db.select({ one: sql`1` }).from(messages).where(and(eq(messages.id, imapMessageUids.messageId), member))),
						deletedInvariantInstalled,
					),
				);
		});
		if (writes.length) await opened.db.batch(writes as [(typeof writes)[number], ...(typeof writes)[number][]]);
		const rows = await opened.db
			.select({ uid: imapMessageUids.uid, deleted: imapMessageUids.deleted, read: messages.read, starred: messages.starred, status: messages.status, direction: messages.direction })
			.from(imapMessageUids)
			.innerJoin(messages, eq(messages.id, imapMessageUids.messageId))
			.where(and(eq(imapMessageUids.imapFolderId, folder.id), inArray(imapMessageUids.uid, uidChunk), member));
		for (const row of rows) result.set(row.uid, flagsFor(row, row.deleted));
	}
	return result;
}

/**
 * Why EXPUNGE may not run in an opened folder, or null when it may: `denied` without
 * management access, `unsupported` in Trash and Drafts (their expunge would be a permanent
 * deletion, which this server does not do yet) or without the bp0003 invariant.
 */
function expungeRefusal(opened: Opened): ImapStateError | null {
	if (!opened.access.canManage) return new ImapStateError("denied", "This access does not allow expunging messages");
	if (!isRecoverablyExpungeable(opened.mailbox.key)) return new ImapStateError("unsupported", "Messages in Trash and Drafts cannot be expunged on this server yet");
	if (!opened.deletable) return new ImapStateError("unsupported", "EXPUNGE is unavailable on this server right now");
	return null;
}

/**
 * Recoverable EXPUNGE (A5.2a): move every message of the folder whose UID is at most
 * `maxUid` and is marked \Deleted to Trash (status `trash`, no folder), and return the UIDs
 * that left the folder, ascending. The session passes the highest UID it has announced, so a
 * message it never reported is never expunged under it.
 *
 * Nothing is deleted: the message keeps its row, read and starred state, date, stored bytes
 * and attachments, and gets a new UID in Trash without \Deleted. Each chunk of UIDs is
 * authorized afresh and moved by one atomic relocateImapMessages batch, which re-checks
 * \Deleted, membership and the bp0003 invariant at that moment: a UID whose mark was cleared
 * or whose message moved meanwhile stays where it is. Refusals (expungeRefusal)
 * are raised before anything moves; a later chunk may still be refused (or find access
 * gone) after earlier chunks moved.
 */
export async function expungeImapFolder(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey, maxUid: number): Promise<number[]> {
	const first = await open(env, principal, key);
	const refusal = expungeRefusal(first);
	if (refusal) throw refusal;
	const folder = await findFolderRow(first.db, first.access.mailboxId, first.mailbox.key);
	if (!folder) return [];
	const candidates = (
		await first.db
			.select({ uid: imapMessageUids.uid })
			.from(imapMessageUids)
			.innerJoin(messages, eq(messages.id, imapMessageUids.messageId))
			.where(and(eq(imapMessageUids.imapFolderId, folder.id), eq(imapMessageUids.deleted, true), lte(imapMessageUids.uid, maxUid), membershipCondition(first.access.mailboxId, first.mailbox.key)))
			.orderBy(asc(imapMessageUids.uid))
	).map((row) => row.uid);
	const expunged: number[] = [];
	for (const [index, uidChunk] of chunk(candidates, RELOCATION_CHUNK).entries()) {
		const opened = index === 0 ? first : await open(env, principal, key);
		const again = expungeRefusal(opened);
		if (again) throw again;
		const trash = await ensureFolderRow(opened.db, opened.access.mailboxId, "trash");
		expunged.push(...(await relocateImapMessages(opened.db, opened.access.mailboxId, { folder, key: opened.mailbox.key }, { folder: trash, key: "trash" }, { status: "trash", folderId: null }, uidChunk)));
	}
	return expunged.sort((a, b) => a - b);
}
