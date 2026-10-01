import { and, asc, eq, exists, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import type { AppDatabase } from "@/db";
import { folders, jmapMailboxRevisions, messageAttachments, messages } from "@/db/schema";
import { imapMessageUids, imapUnsubscribedFolders } from "@/db/schema/bluepine";
import { sanitizeFilename, validateAttachments } from "@/lib/email/attachments";
import { resolveCanonicalMessage } from "@/lib/email/canonical-message";
import type { CanonicalRow } from "@/lib/email/canonical-message-types";
import { draftFingerprint, fingerprintFromKey, isCanonicalKey } from "@/lib/email/canonical-message-utils";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { resolveThreadId } from "@/lib/email/threading";
import { newId } from "@/lib/ids";
import { isMailboxSharingEnabled } from "@/lib/mailboxes/access-utils";
import { authorizeImapAccess } from "./access";
import { cleanupDeletedMessageObjects } from "./cleanup";
import {
	currentDraftFingerprints,
	deleteImapMessagesPermanently,
	deletedInvariantInstalled,
	draftInvariantInstalled,
	ensureFolderRow,
	findFolderRow,
	hasDeletedInvariant,
	hasDraftInvariant,
	insertImapCopies,
	insertImapDraft,
	recordImapUnsubscription,
	membershipCondition,
	relocateImapMessages,
	releaseStaleDraftUids,
	releaseUid,
	syncFolder,
} from "./state";
import type { ImapDraftAttachmentRow, ImapDraftRow, ImapFolderRow, ImapPlannedCopy } from "./state";
import type {
	ImapAccess,
	ImapAppendResult,
	ImapChangeSignal,
	ImapCopyResult,
	ImapDraftAppend,
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
	ImapMoveResult,
	ImapMoveTarget,
	ImapPrincipal,
} from "./types";
import { recordSpamTraining } from "@/lib/spam/feedback";
import {
	chunk,
	customFolderKey,
	customFolderNames,
	FLAG_STORE_CHUNK,
	flagsFor,
	ImapStateError,
	imapCopyTarget,
	imapMoveTarget,
	IN_LIST_CHUNK,
	MAX_COPY_BYTES,
	MAX_COPY_MESSAGES,
	isPermanentlyExpungeable,
	parseFolderKey,
	PERMANENT_DELETE_CHUNK,
	RELOCATION_CHUNK,
	STORABLE_FLAGS,
	SYSTEM_FOLDERS,
} from "./utils";

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
 *   it, and only while the bp0003 invariant is installed; in Drafts only on the principal's
 *   own drafts and only while the bp0004 invariant is installed too. Expunging moves \Deleted
 *   messages to Trash, except in Trash and Drafts, where it deletes them permanently (A5.2c):
 *   the database rows first, in one guarded batch, and their stored objects only after that
 *   has committed, best effort.
 * - MOVE (moveImapMessages) is the same relocation for any UIDs, under the special-folder
 *   policy of imapMoveTarget; it deletes nothing.
 *
 * Authorization is re-evaluated on every call, and folder keys are resolved within the
 * principal's own mailbox only.
 */

/**
 * `deletable`: management access and the bp0003 invariant, what \Deleted, EXPUNGE and MOVE
 * need anywhere. `draftDeletable`: that, and the bp0004 invariant, what they need in Drafts.
 */
type Deletability = { deletable: boolean; draftDeletable: boolean };
type Opened = { db: AppDatabase; access: ImapAccess; mailbox: ImapMailbox } & Deletability;

async function deletability(db: AppDatabase, access: ImapAccess): Promise<Deletability> {
	const deletable = access.canManage && (await hasDeletedInvariant(db));
	return { deletable, draftDeletable: deletable && (await hasDraftInvariant(db)) };
}

async function open(env: CloudflareEnv, principal: ImapPrincipal, key: string): Promise<Opened> {
	const db = getDb(env);
	const access = await authorizeImapAccess(db, principal);
	if (!access) throw new ImapStateError("forbidden", "Mailbox access denied");
	const allowed = await deletability(db, access);
	const mailbox = await resolveMailbox(db, access, key, allowed);
	if (!mailbox) throw new ImapStateError("nonexistent", "No such folder");
	return { db, access, mailbox, ...allowed };
}

/**
 * The flags a principal may change on messages in a folder. Read and starred state can be
 * changed by anyone who can read the mailbox, as in the web app. \Deleted needs management
 * access (its purpose is a later expunge) and the bp0003 invariant (`deletable`), in Drafts
 * also the bp0004 invariant (`draftDeletable`); in Drafts it further applies only to the
 * principal's own drafts, which storeImapFlags enforces per message.
 */
function permanentFlags(key: ImapFolderKey, allowed: Deletability): ImapFlagName[] {
	const deletable = key === "drafts" ? allowed.draftDeletable : allowed.deletable;
	return deletable ? ["seen", "flagged", "deleted"] : ["seen", "flagged"];
}

async function resolveMailbox(db: AppDatabase, access: ImapAccess, key: string, allowed: Deletability): Promise<ImapMailbox | null> {
	const parsed = parseFolderKey(key);
	if (!parsed) return null;
	if (parsed.kind === "role") return (await listMailboxes(db, access, allowed)).find((mailbox) => mailbox.key === key) ?? null;
	const [folder] = await db.select({ id: folders.id }).from(folders).where(and(eq(folders.id, parsed.folderId), eq(folders.mailboxId, access.mailboxId))).limit(1);
	if (!folder) return null;
	return (await listMailboxes(db, access, allowed)).find((mailbox) => mailbox.key === key) ?? null;
}

async function listMailboxes(db: AppDatabase, access: ImapAccess, allowed: Deletability): Promise<ImapMailbox[]> {
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
			storedName: null,
			role: folder.role,
			specialUse: folder.specialUse,
			folderId: null,
			selectable: true,
			permanentFlags: permanentFlags(folder.role, allowed),
			mayWrite: access.canManage,
			mayRename: false,
			mayDelete: false,
		})),
		...custom.map((folder): ImapMailbox => ({
			key: customFolderKey(folder.id),
			name: names.get(folder.id)!,
			storedName: folder.name,
			role: null,
			specialUse: null,
			folderId: folder.id,
			selectable: true,
			permanentFlags: permanentFlags(customFolderKey(folder.id), allowed),
			mayWrite: access.canManage,
			mayRename: access.canManage,
			mayDelete: access.canManage,
		})),
	];
}

/**
 * IMAP subscriptions (A5.5b): the keys of the folders the principal's user has unsubscribed
 * from in this mailbox, sorted. Every other visible folder is subscribed: that is how mailboxes
 * behaved before subscriptions were stored, so an upgrade changes nothing a client sees, and a
 * folder created on any surface (web, JMAP, IMAP) is subscribed. The state is the user's, for
 * this mailbox account: another user of a shared mailbox has their own, and a new app password
 * of the same user sees the same. Rows of custom folders that no longer exist are removed by
 * listImapMailboxes and never returned here.
 */
export async function listImapUnsubscribed(env: CloudflareEnv, principal: ImapPrincipal): Promise<ImapFolderKey[]> {
	const db = getDb(env);
	const access = await authorizeImapAccess(db, principal);
	if (!access) throw new ImapStateError("forbidden", "Mailbox access denied");
	const rows = await db
		.select({ key: imapUnsubscribedFolders.folderKey })
		.from(imapUnsubscribedFolders)
		.where(and(eq(imapUnsubscribedFolders.userId, access.userId), eq(imapUnsubscribedFolders.mailboxId, access.mailboxId)))
		.orderBy(asc(imapUnsubscribedFolders.folderKey));
	return rows.map((row) => row.key as ImapFolderKey);
}

/**
 * SUBSCRIBE (`subscribed`) or UNSUBSCRIBE folder `key` for the principal's user in this mailbox
 * (A5.5b). Reading the mailbox is the authority needed, as for any view preference: it changes
 * nothing anyone else sees. `forbidden` when access is gone (checked first, and again in SQL by
 * readerGuard for the write that records state), `nonexistent` for a folder that is not, or no
 * longer, in this mailbox. Both directions are idempotent.
 */
export async function setImapSubscription(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey, subscribed: boolean): Promise<void> {
	const db = getDb(env);
	const access = await authorizeImapAccess(db, principal);
	if (!access) throw new ImapStateError("forbidden", "Mailbox access denied");
	if (!(await resolveMailbox(db, access, key, await deletability(db, access)))) throw new ImapStateError("nonexistent", "No such folder");
	if (subscribed) {
		// Removing the principal's own row can reveal or change nothing for anyone else.
		await db.delete(imapUnsubscribedFolders).where(and(eq(imapUnsubscribedFolders.userId, access.userId), eq(imapUnsubscribedFolders.mailboxId, access.mailboxId), eq(imapUnsubscribedFolders.folderKey, key)));
		return;
	}
	const authority = { userId: access.userId, mailboxId: access.mailboxId, appPasswordId: principal.appPasswordId, sharedAccess: isMailboxSharingEnabled() };
	if (await recordImapUnsubscription(db, authority, key)) return;
	// The guarded write recorded nothing: access or the folder went away after the checks above.
	if (!(await authorizeImapAccess(db, principal))) throw new ImapStateError("forbidden", "Mailbox access denied");
	throw new ImapStateError("nonexistent", "No such folder");
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
	// Likewise every user's subscription state for those folders (A5.5b): a folder id is never
	// reused, so such a row can never apply to another folder, and none is left behind.
	await db.run(sql`
		DELETE FROM imap_unsubscribed_folders
		WHERE mailbox_id = ${access.mailboxId} AND folder_key LIKE 'f:%'
			AND substr(folder_key, 3) NOT IN (SELECT id FROM folders WHERE mailbox_id = ${access.mailboxId})
	`);
	return listMailboxes(db, access, await deletability(db, access));
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

/**
 * IDLE's fast, cross-process change signal (A5.4): the principal's authority re-established
 * from current state, then the mailbox's revision and the folder's UIDVALIDITY, each one indexed
 * lookup. It never scans the folder, assigns a UID or writes anything; the caller refreshes its
 * view (openImapFolder) only when the signal moved, and reconciles periodically regardless,
 * because the revision does not cover IMAP-only state such as \Deleted marks or Drafts UIDs
 * released by an attachment change. UIDVALIDITY, which it does not cover either, is read here.
 *
 * `key` null (IDLE outside a selected mailbox) checks authority and reads the revision only.
 * Throws `forbidden` when access is gone, `nonexistent` when the folder is, and `unconfirmed`
 * when authority could not be evaluated at all (a database failure while authorizing); any
 * other failure is a database failure after authority was confirmed.
 */
export async function getImapChangeSignal(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey | null): Promise<ImapChangeSignal> {
	const db = getDb(env);
	let access: ImapAccess | null;
	try {
		access = await authorizeImapAccess(db, principal);
	} catch (error) {
		throw new ImapStateError("unconfirmed", `Access could not be checked: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!access) throw new ImapStateError("forbidden", "Mailbox access denied");
	const [row] = await db.select({ revision: jmapMailboxRevisions.revision }).from(jmapMailboxRevisions).where(eq(jmapMailboxRevisions.mailboxId, access.mailboxId)).limit(1);
	const revision = Number(row?.revision ?? 0);
	if (key === null) return { revision, uidValidity: null };
	const parsed = parseFolderKey(key);
	if (!parsed) throw new ImapStateError("nonexistent", "No such folder");
	if (parsed.kind === "folder") {
		const [folder] = await db.select({ id: folders.id }).from(folders).where(and(eq(folders.id, parsed.folderId), eq(folders.mailboxId, access.mailboxId))).limit(1);
		if (!folder) throw new ImapStateError("nonexistent", "No such folder");
	}
	const state = await findFolderRow(db, access.mailboxId, key);
	return { revision, uidValidity: state?.uidValidity ?? null };
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
	if (opened.mailbox.key === "drafts" && !opened.draftDeletable) return new ImapStateError("unsupported", "\\Deleted is unavailable in Drafts on this server right now");
	return null;
}

/**
 * In Drafts, \Deleted belongs to a draft's author: refuse (`denied`) when any of `uids` names
 * another user's draft, read from current state. Stale Drafts UIDs (content changed before
 * bp0004 was installed) are released first, so the check and the write only ever see UIDs
 * that name their draft's current content.
 */
async function assertOwnDrafts(opened: Opened, folder: ImapFolderRow, uids: number[]): Promise<void> {
	await releaseStaleDraftUids(opened.db, folder, opened.access.mailboxId);
	const authors = await opened.db
		.select({ userId: messages.userId })
		.from(imapMessageUids)
		.innerJoin(messages, eq(messages.id, imapMessageUids.messageId))
		.where(and(eq(imapMessageUids.imapFolderId, folder.id), inArray(imapMessageUids.uid, uids), membershipCondition(opened.access.mailboxId, "drafts")));
	if (authors.some((row) => row.userId !== opened.access.userId)) throw new ImapStateError("denied", "Only the author of a draft may mark it deleted");
}

/** SQL guards of a \Deleted write in the opened folder: bp0003 always, and in Drafts bp0004 and the principal's authorship. */
function deletedWriteGuards(opened: Opened) {
	if (opened.mailbox.key !== "drafts") return [deletedInvariantInstalled];
	return [
		deletedInvariantInstalled,
		draftInvariantInstalled,
		exists(opened.db.select({ one: sql`1` }).from(messages).where(and(eq(messages.id, imapMessageUids.messageId), eq(messages.userId, opened.access.userId)))),
	];
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
	if (changes.deleted === true && opened.mailbox.key === "drafts") {
		const folder = await findFolderRow(opened.db, opened.access.mailboxId, opened.mailbox.key);
		if (folder) await assertOwnDrafts(opened, folder, [uid]);
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
			.where(and(eq(imapMessageUids.imapFolderId, hit.folder.id), eq(imapMessageUids.uid, uid), ...deletedWriteGuards(opened)));
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
 *   management access (`denied` otherwise) and the bp0003 invariant, in Drafts also the bp0004
 *   invariant (`unsupported` otherwise). In Drafts it applies only to the principal's own
 *   drafts: naming another user's draft is `denied`, and the write itself carries the
 *   authorship guard, so a draft never gets a \Deleted mark from anyone but its author.
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
		// Setting \Deleted on another user's draft is refused; clearing is guarded in the write below.
		if (opened.mailbox.key === "drafts" && changing.includes("deleted") && targetOf("deleted")) await assertOwnDrafts(opened, folder, uidChunk);
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
						...deletedWriteGuards(opened),
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
 * management access, `unsupported` without the bp0003 invariant, and in Drafts without the
 * bp0004 invariant.
 */
function expungeRefusal(opened: Opened): ImapStateError | null {
	if (!opened.access.canManage) return new ImapStateError("denied", "This access does not allow expunging messages");
	if (!opened.deletable) return new ImapStateError("unsupported", "EXPUNGE is unavailable on this server right now");
	if (opened.mailbox.key === "drafts" && !opened.draftDeletable) return new ImapStateError("unsupported", "EXPUNGE is unavailable in Drafts on this server right now");
	return null;
}

/**
 * EXPUNGE: remove every message of the folder whose UID is at most `maxUid` and is marked
 * \Deleted, and return the UIDs that left the folder, ascending. The session passes the highest
 * UID it has announced, so a message it never reported is never expunged under it. Refusals
 * (expungeRefusal) are raised before anything changes; each chunk is authorized afresh, and a
 * later chunk may still be refused (or find access gone) after earlier chunks committed, which
 * stay committed.
 *
 * - Everywhere but Trash and Drafts it is recoverable (A5.2a): the messages move to Trash
 *   (status `trash`, no folder) by one atomic relocateImapMessages batch per chunk of 80, which
 *   re-checks \Deleted, membership and bp0003. Nothing is deleted: row, read and starred state,
 *   date, stored bytes and attachments stay, and the message gets a new Trash UID without
 *   \Deleted.
 * - In Trash and Drafts it is permanent (A5.2c, permanentlyExpunge).
 *
 * `only` (UID EXPUNGE, RFC 4315, A5.3) narrows the candidates to the UIDs it lists: a message
 * marked \Deleted but not listed, and a listed message not marked \Deleted, are untouched.
 * It only ever removes candidates; every guard above, and the ones the batches repeat in their
 * own SQL (the \Deleted mark on the exact UID, `maxUid`, membership, authority), still applies.
 */
export async function expungeImapFolder(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey, maxUid: number, only?: readonly number[]): Promise<number[]> {
	const first = await open(env, principal, key);
	const refusal = expungeRefusal(first);
	if (refusal) throw refusal;
	const folder = await findFolderRow(first.db, first.access.mailboxId, first.mailbox.key);
	if (!folder) return [];
	const requested = only ? new Set(only) : null;
	const listed = (uids: number[]) => (requested ? uids.filter((uid) => requested.has(uid)) : uids);
	if (isPermanentlyExpungeable(first.mailbox.key)) return permanentlyExpunge(env, principal, first, folder, maxUid, listed);
	const candidates = listed(
		(
			await first.db
				.select({ uid: imapMessageUids.uid })
				.from(imapMessageUids)
				.innerJoin(messages, eq(messages.id, imapMessageUids.messageId))
				.where(and(eq(imapMessageUids.imapFolderId, folder.id), eq(imapMessageUids.deleted, true), lte(imapMessageUids.uid, maxUid), membershipCondition(first.access.mailboxId, first.mailbox.key)))
				.orderBy(asc(imapMessageUids.uid))
		).map((row) => row.uid),
	);
	const expunged: number[] = [];
	for (const [index, uidChunk] of chunk(candidates, RELOCATION_CHUNK).entries()) {
		const opened = index === 0 ? first : await open(env, principal, key);
		const again = expungeRefusal(opened);
		if (again) throw again;
		const trash = await ensureFolderRow(opened.db, opened.access.mailboxId, "trash");
		const { released } = await relocateImapMessages(opened.db, opened.access.mailboxId, { folder, key: opened.mailbox.key }, { folder: trash, key: "trash" }, { status: "trash", folderId: null }, uidChunk, { markedDeleted: true });
		expunged.push(...released);
	}
	return expunged.sort((a, b) => a - b);
}

/**
 * Permanent EXPUNGE in Trash, and in Drafts for the principal's own drafts (A5.2c). Database
 * truth disappears before any stored byte does:
 *
 * 1. In Drafts, UIDs that no longer name their draft's current content are released first
 *    (releaseStaleDraftUids); any edit after that releases its UID itself (bp0004).
 * 2. Candidates are the folder's \Deleted UIDs up to `maxUid` (in Drafts, the principal's
 *    drafts only; another user's marked draft is simply left), in chunks of 25.
 * 3. Each chunk is authorized afresh (authorizeImapAccess, expungeRefusal) and deleted by one
 *    atomic deleteImapMessagesPermanently batch, which re-checks the \Deleted mark on the
 *    exact UID, membership, the folder, authorship in Drafts, bp0003 (and bp0004) and the
 *    principal's authority inside its own SQL. What it returns is exactly what it deleted.
 * 4. Only after that batch has committed, cleanupDeletedMessageObjects removes the deleted
 *    messages' raw bytes and attachment objects, best effort: a failure leaves an orphaned
 *    object and a log line, never a restored row or a failed EXPUNGE.
 */
async function permanentlyExpunge(env: CloudflareEnv, principal: ImapPrincipal, first: Opened, folder: ImapFolderRow, maxUid: number, listed: (uids: number[]) => number[]): Promise<number[]> {
	const key = first.mailbox.key as "trash" | "drafts";
	if (key === "drafts") await releaseStaleDraftUids(first.db, folder, first.access.mailboxId);
	const ownership = key === "drafts" ? eq(messages.userId, first.access.userId) : undefined;
	const candidates = listed(
		(
			await first.db
				.select({ uid: imapMessageUids.uid })
				.from(imapMessageUids)
				.innerJoin(messages, eq(messages.id, imapMessageUids.messageId))
				.where(and(eq(imapMessageUids.imapFolderId, folder.id), eq(imapMessageUids.deleted, true), lte(imapMessageUids.uid, maxUid), membershipCondition(first.access.mailboxId, key), ownership))
				.orderBy(asc(imapMessageUids.uid))
		).map((row) => row.uid),
	);
	const expunged: number[] = [];
	for (const [index, uidChunk] of chunk(candidates, PERMANENT_DELETE_CHUNK).entries()) {
		const opened = index === 0 ? first : await open(env, principal, key);
		const again = expungeRefusal(opened);
		if (again) throw again;
		const { released, deleted } = await deleteImapMessagesPermanently(opened.db, { folder, key }, uidChunk, maxUid, {
			userId: opened.access.userId,
			mailboxId: opened.access.mailboxId,
			appPasswordId: principal.appPasswordId,
			sharedAccess: isMailboxSharingEnabled(),
		});
		expunged.push(...released);
		try {
			await cleanupDeletedMessageObjects(env, opened.db, deleted);
		} catch (error) {
			// The deletion has committed; cleanup is best effort and logs its own failures.
			console.error(JSON.stringify({ event: "expunge.cleanup-failed", messageIds: deleted.map((message) => message.messageId), stage: "cleanup", error: error instanceof Error ? error.message : String(error) }));
		}
	}
	return expunged.sort((a, b) => a - b);
}

/**
 * Why a MOVE may not run from an opened folder, or null when it may. Moving takes messages
 * out of the source, so it needs what EXPUNGE needs: management access (`denied`) and the
 * bp0003 invariant (`unsupported`), without which a destination UID could inherit a stale
 * \Deleted mark.
 */
function moveRefusal(opened: Opened): ImapStateError | null {
	if (!opened.access.canManage) return new ImapStateError("denied", "This access does not allow moving messages");
	if (!opened.deletable) return new ImapStateError("unsupported", "MOVE is unavailable on this server right now");
	return null;
}

type MoveChunk = { opened: Opened; destination: ImapMailbox; target: ImapMoveTarget };

/** Authorize a MOVE chunk afresh: source access, destination, special-folder policy. */
async function openMove(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey, destinationKey: ImapFolderKey): Promise<MoveChunk> {
	const opened = await open(env, principal, key);
	const refusal = moveRefusal(opened);
	if (refusal) throw refusal;
	const destination = await resolveMailbox(opened.db, opened.access, destinationKey, opened);
	if (!destination) throw new ImapStateError("nonexistent-destination", "No such destination mailbox");
	const rule = imapMoveTarget(opened.mailbox.key, destination.key);
	if ("refusal" in rule) throw new ImapStateError("unsupported", rule.refusal);
	return { opened, destination, target: rule.target };
}

/**
 * MOVE (RFC 6851, A5.2b): move the messages that `uids` name in folder `key` into the folder
 * `destinationKey` of the same mailbox, and return the source UIDs that moved, ascending.
 *
 * - Refusals come first and move nothing: `denied` without management access, `unsupported`
 *   without the bp0003 invariant or where imapMoveTarget refuses (Sent and Drafts as
 *   destinations, Drafts anywhere but Trash, Sent to Spam, the same folder),
 *   `nonexistent-destination` when the destination does not exist. A MOVE into Spam of
 *   sent mail anywhere is `unsupported`, and a MOVE out of Drafts of a draft another user
 *   owns is `denied` (only a draft's owner may discard it, as in the web app's Drafts).
 * - Each chunk of UIDs is authorized and checked afresh and moved by one atomic
 *   relocateImapMessages batch, so a message either moves entirely (its product state, a
 *   fresh destination UID without \Deleted, the release of its source UID) or not at all.
 *   A UID whose message moved or changed meanwhile, or a custom destination deleted
 *   meanwhile, moves nothing. A later chunk may still be refused (or find access gone)
 *   after earlier chunks moved; those stay moved.
 * - Nothing else about a message changes: its row, bytes, size, date, read and starred
 *   state and attachments stay. Spam training is not part of the move; the caller runs
 *   trainImapSpamFeedback for `moved` afterwards when `training` says so.
 * - Each moved entry carries the destination UID and UIDVALIDITY its batch read back from the
 *   database (relocateImapMessages), for COPYUID (A5.3). Nothing is returned for a chunk that
 *   did not commit.
 */
export async function moveImapMessages(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey, uids: number[], destinationKey: ImapFolderKey): Promise<ImapMoveResult> {
	const wanted = [...new Set(uids.filter((uid) => Number.isInteger(uid) && uid >= 1))].sort((a, b) => a - b);
	const first = await openMove(env, principal, key, destinationKey);
	const result: ImapMoveResult = { moved: [], training: first.target.training };
	const folder = await findFolderRow(first.opened.db, first.opened.access.mailboxId, first.opened.mailbox.key);
	if (!folder || !wanted.length) return result;
	for (const [index, uidChunk] of chunk(wanted, RELOCATION_CHUNK).entries()) {
		const { opened, destination, target } = index === 0 ? first : await openMove(env, principal, key, destinationKey);
		const members = await opened.db
			.select({ direction: messages.direction, userId: messages.userId })
			.from(imapMessageUids)
			.innerJoin(messages, eq(messages.id, imapMessageUids.messageId))
			.where(and(eq(imapMessageUids.imapFolderId, folder.id), inArray(imapMessageUids.uid, uidChunk), membershipCondition(opened.access.mailboxId, opened.mailbox.key)));
		if (destination.key === "junk" && members.some((member) => member.direction !== "inbound")) throw new ImapStateError("unsupported", "Sent mail cannot be moved to Spam");
		if (opened.mailbox.key === "drafts" && members.some((member) => member.userId !== opened.access.userId)) throw new ImapStateError("denied", "Only the author of a draft may discard it");
		const destinationFolder = await ensureFolderRow(opened.db, opened.access.mailboxId, destination.key);
		const { moved } = await relocateImapMessages(opened.db, opened.access.mailboxId, { folder, key: opened.mailbox.key }, { folder: destinationFolder, key: destination.key }, target, uidChunk, {
			inboundOnly: destination.key === "junk",
			ownedBy: opened.mailbox.key === "drafts" ? opened.access.userId : undefined,
		});
		result.moved.push(...moved);
	}
	result.moved.sort((a, b) => a.uid - b.uid);
	return result;
}

/**
 * The spam training a committed MOVE stands for (moveImapMessages' `training`), for the
 * messages it moved: `spam` for a move into Spam, `ham` for a move from Spam to INBOX, the
 * web app's "report spam" and "not spam". Runs after the move, never inside it, so a failure
 * or a crash here leaves the messages moved and at worst untrained.
 *
 * Authorization is re-evaluated (management access, as in the web app). A message is
 * trained only while it is still inbound and still where the move put it, and only once:
 * training already recorded for it with this classification is not repeated, so a retry,
 * a repeated MOVE or a concurrent one counts once. Returns the messages that failed to
 * train, with the error, so the caller can log them; the others are trained.
 */
export async function trainImapSpamFeedback(env: CloudflareEnv, principal: ImapPrincipal, messageIds: string[], classification: "spam" | "ham"): Promise<Array<{ messageId: string; error: unknown }>> {
	const db = getDb(env);
	const access = await authorizeImapAccess(db, principal);
	if (!access) throw new ImapStateError("forbidden", "Mailbox access denied");
	if (!access.canManage) return [];
	const failed: Array<{ messageId: string; error: unknown }> = [];
	for (const messageId of messageIds) {
		try {
			await recordSpamTraining(env, { messageId, mailboxId: access.mailboxId, actorUserId: access.userId, classification, status: classification === "spam" ? "spam" : "received" });
		} catch (error) {
			failed.push({ messageId, error });
		}
	}
	return failed;
}

/**
 * Create a draft from the octets of an IMAP APPEND (A5.7). Drafts only, for principals with
 * management access (the owner, or a full_access delegate while sharing is enabled): the
 * principals who can also mark and expunge their earlier versions, which is how clients
 * replace a draft.
 *
 * The octets are kept exactly as received, under `drafts/<messageId>.eml` like JMAP
 * Email/import's, so FETCH serves them byte for byte and RFC822.SIZE is their length. The
 * columns the web app and JMAP read are parsed from them the way Email/import parses its
 * upload, with the same rules: a From header the principal may send from (the existing sender
 * check) and the existing attachment limits. Attachments are stored like every draft's, under
 * server-generated ids.
 *
 * Order: every object first (raw, then attachments), then one guarded batch for the relational
 * state (insertImapDraft), so the draft never exists without its bytes or without its UID. If
 * a write or the batch fails, or authority is gone by then, nothing is committed and every
 * object written is deleted, best effort (an object left by a crash is unreferenced and never
 * served). A retry after a lost tagged answer creates another draft, as in any IMAP server.
 */
export async function appendImapDraft(env: CloudflareEnv, principal: ImapPrincipal, input: ImapDraftAppend): Promise<ImapAppendResult> {
	const db = getDb(env);
	const access = await authorizeImapAccess(db, principal);
	if (!access) throw new ImapStateError("forbidden", "Mailbox access denied");
	if (!access.canManage) throw new ImapStateError("denied", "This access does not allow creating drafts");
	const { bytes } = input;

	let parsed: Awaited<ReturnType<typeof parseRawMime>>;
	try {
		// The receive buffer is exactly the message, so the parser reads it without a copy.
		const raw = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
		parsed = await parseRawMime(raw);
	} catch {
		throw new ImapStateError("unsupported", "The message could not be parsed");
	}
	if (!parsed.fromAddr) throw new ImapStateError("unsupported", "The message has no From header");
	let sender: { fromAddr: string; mailboxId: string };
	try {
		sender = await getAuthorizedSenderAddress(env, { userId: access.userId, from: parsed.fromAddr, mailboxId: access.mailboxId });
	} catch {
		// Lost access is reported as such; anything else is about the From address.
		if (!(await authorizeImapAccess(db, principal))) throw new ImapStateError("forbidden", "Mailbox access denied");
		throw new ImapStateError("unsupported", "The From address cannot be used from this mailbox");
	}
	try {
		validateAttachments(parsed.attachments);
	} catch (error) {
		throw new ImapStateError("limit", error instanceof Error ? error.message : "Attachments exceed the limits");
	}

	const id = newId("msg");
	const rawR2Key = `drafts/${id}.eml`;
	const attachments = parsed.attachments.map((attachment) => {
		const attachmentId = newId("att");
		const filename = sanitizeFilename(attachment.filename);
		const row: ImapDraftAttachmentRow = {
			id: attachmentId,
			filename,
			contentType: attachment.type,
			size: attachment.content.byteLength,
			disposition: attachment.disposition ?? "attachment",
			contentId: attachment.contentId ?? null,
			r2Key: `attachments/${id}/${attachmentId}/${filename}`,
		};
		return { row, content: attachment.content };
	});
	const draft: ImapDraftRow = {
		id,
		userId: access.userId,
		mailboxId: access.mailboxId,
		fromAddr: sender.fromAddr,
		toAddr: parsed.toAddr ?? "",
		ccAddr: parsed.ccAddr,
		bccAddr: parsed.bccAddr,
		subject: parsed.subject,
		snippet: buildSnippet(parsed.text, parsed.html),
		textBody: parsed.text,
		htmlBody: parsed.html,
		inReplyTo: parsed.inReplyTo,
		references: parsed.references.length ? parsed.references.join(" ") : null,
		threadId: await resolveThreadId(db, { mailboxId: access.mailboxId, messageId: parsed.messageId, inReplyTo: parsed.inReplyTo, references: parsed.references }),
		// Angle brackets are kept, as inbound rows and Email/import store them.
		providerMessageId: parsed.messageId,
		rawR2Key,
		starred: input.flagged,
		createdAt: Math.floor((input.internalDate ?? new Date()).getTime() / 1000),
	};
	// The fingerprint A3 binds a Drafts UID to, over exactly what the batch stores.
	const fingerprint = await draftFingerprint(draft as unknown as CanonicalRow, attachments.map((attachment) => attachment.row));

	const written: string[] = [];
	const removeWritten = async () => {
		for (const key of written) {
			try {
				await env.BUCKET.delete(key);
			} catch (error) {
				console.warn(`IMAP APPEND could not remove ${key} of uncommitted draft ${id}`, error instanceof Error ? error.message : error);
			}
		}
	};
	try {
		// Named before writing, so a write that fails halfway is removed too.
		written.push(rawR2Key);
		await env.BUCKET.put(rawR2Key, bytes, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { userId: access.userId, messageId: id } });
		for (const attachment of attachments) {
			written.push(attachment.row.r2Key);
			await env.BUCKET.put(attachment.row.r2Key, attachment.content, { httpMetadata: { contentType: attachment.row.contentType }, customMetadata: { filename: attachment.row.filename, messageId: id } });
		}
	} catch (error) {
		await removeWritten();
		throw new ImapStateError("unavailable", `Draft objects could not be stored: ${error instanceof Error ? error.message : String(error)}`);
	}

	let committed: { uid: number; uidValidity: number } | null;
	try {
		committed = await insertImapDraft(
			db,
			{ userId: access.userId, mailboxId: access.mailboxId, appPasswordId: principal.appPasswordId, sharedAccess: isMailboxSharingEnabled() },
			draft,
			attachments.map((attachment) => attachment.row),
			{ size: bytes.byteLength, fingerprint },
		);
	} catch (error) {
		await removeWritten();
		throw error;
	}
	if (!committed) {
		await removeWritten();
		if (!(await authorizeImapAccess(db, principal))) throw new ImapStateError("forbidden", "Mailbox access denied");
		throw new ImapStateError("denied", "This access does not allow creating drafts");
	}
	return { messageId: id, ...committed };
}

/** What a COPY's caller provides: the content-read permit to hold while a message is duplicated, and whether the client is still there. */
export type ImapCopyOptions = {
	acquireRead?: () => Promise<() => void>;
	cancelled?: () => boolean;
};

/**
 * COPY and UID COPY (A5.8): copy the messages that `uids` name in folder `key` into folder
 * `destinationKey` of the same mailbox. A copy is an independent message: a new `messages`
 * row, a new raw object (`copies/<id>.eml`) holding exactly the octets the source UID serves,
 * new attachment objects and rows, and a new UID in the destination. The source is only read.
 * Objects are never shared, because deleting a message (web, JMAP, A1 or IMAP) removes the
 * objects its row names.
 *
 * - Refusals come first and copy nothing: `denied` without management access, `unsupported`
 *   where imapCopyTarget refuses (Sent or Drafts as destination, Drafts as source, outbound
 *   mail into Spam), `nonexistent-destination`, `limit` above MAX_COPY_MESSAGES, and
 *   `vanished` when a named message is no longer in the folder.
 * - Then each message is duplicated in turn, holding a content-read permit (`acquireRead`) while
 *   its octets are read and written, so at most one message is in memory. The octets are the
 *   ones FETCH serves for the source UID (its bound canonical object); a source without stored
 *   octets fails the whole COPY as `unavailable` rather than storing generated MIME. The bytes
 *   duplicated (raw plus attachments) count against MAX_COPY_BYTES (`limit`).
 * - Then authority is re-checked and one guarded batch commits every copy or none
 *   (insertImapCopies). Read, starred, INTERNALDATE and thread are the source's at commit; the
 *   copy is not snoozed and carries no \Deleted mark. Nothing trains the spam filter.
 * - On any failure, or when the client went away (`cancelled`) before the commit, every object
 *   written is removed (best effort) and nothing is committed. The error says why: `forbidden`
 *   (access gone), `denied`, `vanished` (a source moved or expunged meanwhile),
 *   `nonexistent-destination` (the destination deleted meanwhile) or `unavailable`.
 *
 * Returns the copies in ascending source UID order with the destination UIDs and UIDVALIDITY
 * read back inside the commit (COPYUID); empty when `uids` names nothing.
 */
export async function copyImapMessages(env: CloudflareEnv, principal: ImapPrincipal, key: ImapFolderKey, uids: number[], destinationKey: ImapFolderKey, options: ImapCopyOptions = {}): Promise<ImapCopyResult> {
	const wanted = [...new Set(uids.filter((uid) => Number.isInteger(uid) && uid >= 1))].sort((a, b) => a - b);
	const opened = await open(env, principal, key);
	const { db, access } = opened;
	if (!access.canManage) throw new ImapStateError("denied", "This access does not allow copying messages");
	const destination = await resolveMailbox(db, access, destinationKey, opened);
	if (!destination) throw new ImapStateError("nonexistent-destination", "No such destination mailbox");
	const rule = imapCopyTarget(opened.mailbox.key, destination.key);
	if ("refusal" in rule) throw new ImapStateError("unsupported", rule.refusal);
	if (!wanted.length) return { copied: [] };
	if (wanted.length > MAX_COPY_MESSAGES) throw new ImapStateError("limit", `At most ${MAX_COPY_MESSAGES} messages can be copied at once`);
	const folder = await findFolderRow(db, access.mailboxId, opened.mailbox.key);
	if (!folder) throw new ImapStateError("vanished", "Some of the requested messages no longer exist");

	const sources: Array<{ uid: number; messageId: string; direction: string }> = [];
	for (const uidChunk of chunk(wanted, IN_LIST_CHUNK - 10)) {
		sources.push(
			...(await db
				.select({ uid: imapMessageUids.uid, messageId: messages.id, direction: messages.direction })
				.from(imapMessageUids)
				.innerJoin(messages, eq(messages.id, imapMessageUids.messageId))
				.where(and(eq(imapMessageUids.imapFolderId, folder.id), inArray(imapMessageUids.uid, uidChunk), membershipCondition(access.mailboxId, opened.mailbox.key)))),
		);
	}
	if (sources.length !== wanted.length) throw new ImapStateError("vanished", "Some of the requested messages no longer exist");
	if (destination.key === "junk" && sources.some((source) => source.direction !== "inbound")) throw new ImapStateError("unsupported", "Sent mail cannot be copied to Spam");
	sources.sort((a, b) => a.uid - b.uid);

	const written: string[] = [];
	const removeWritten = async () => {
		for (const objectKey of written) {
			try {
				await env.BUCKET.delete(objectKey);
			} catch (error) {
				console.warn(`IMAP COPY could not remove ${objectKey} of an uncommitted copy`, error instanceof Error ? error.message : error);
			}
		}
	};
	const planned: ImapPlannedCopy[] = [];
	let total = 0;
	const count = (size: number) => {
		total += size;
		if (total > MAX_COPY_BYTES) throw new ImapStateError("limit", `At most ${MAX_COPY_BYTES} octets can be copied at once`);
	};
	try {
		for (const source of sources) {
			if (options.cancelled?.()) throw new ImapStateError("unavailable", "The client went away");
			const release = (await options.acquireRead?.()) ?? (() => {});
			try {
				// Exactly the octets FETCH serves for the source UID; a transient (generated) representation is refused.
				const content = await fetchImapMessage(env, principal, opened.mailbox.key, source.uid);
				if (!content || content.messageId !== source.messageId) throw new ImapStateError("vanished", "Some of the requested messages no longer exist");
				count(content.size);
				const id = newId("msg");
				const rawR2Key = `copies/${id}.eml`;
				written.push(rawR2Key);
				await env.BUCKET.put(rawR2Key, content.bytes, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { userId: access.userId, messageId: id } });
				const attachments: ImapPlannedCopy["attachments"] = [];
				const rows = await db.select().from(messageAttachments).where(eq(messageAttachments.messageId, source.messageId));
				for (const row of rows) {
					const object = await env.BUCKET.get(row.r2Key);
					if (!object) throw new ImapStateError("unavailable", `Attachment ${row.id} of message ${source.messageId} is missing from storage`);
					const bytes = await object.arrayBuffer();
					count(bytes.byteLength);
					const attachmentId = newId("att");
					const r2Key = `attachments/${id}/${attachmentId}/${sanitizeFilename(row.filename)}`;
					written.push(r2Key);
					await env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: row.contentType }, customMetadata: { filename: row.filename, messageId: id } });
					attachments.push({ sourceId: row.id, id: attachmentId, r2Key });
				}
				planned.push({ sourceUid: source.uid, sourceMessageId: source.messageId, id, rawR2Key, size: content.size, attachments });
			} finally {
				release();
			}
		}
		if (options.cancelled?.()) throw new ImapStateError("unavailable", "The client went away");
	} catch (error) {
		await removeWritten();
		if (error instanceof ImapStateError) throw error;
		throw new ImapStateError("unavailable", `Copies could not be stored: ${error instanceof Error ? error.message : String(error)}`);
	}

	// Authority again after the (possibly long) duplication, then inside the commit itself.
	const recheck = await authorizeImapAccess(db, principal);
	if (!recheck || !recheck.canManage) {
		await removeWritten();
		throw recheck ? new ImapStateError("denied", "This access does not allow copying messages") : new ImapStateError("forbidden", "Mailbox access denied");
	}
	let committed: Map<string, { uid: number; uidValidity: number }>;
	try {
		committed = await insertImapCopies(
			db,
			{ userId: access.userId, mailboxId: access.mailboxId, appPasswordId: principal.appPasswordId, sharedAccess: isMailboxSharingEnabled() },
			{ folderId: folder.id, key: opened.mailbox.key },
			{ key: destination.key, ...rule.target },
			planned,
		);
	} catch (error) {
		await removeWritten();
		// The batch committed nothing; say why if the reason is visible now.
		const after = await authorizeImapAccess(db, principal).catch(() => undefined);
		if (after === null) throw new ImapStateError("forbidden", "Mailbox access denied");
		if (after && !after.canManage) throw new ImapStateError("denied", "This access does not allow copying messages");
		if (after && !(await resolveMailbox(db, after, destination.key, opened).catch(() => null))) throw new ImapStateError("nonexistent-destination", "No such destination mailbox");
		const remaining = after ? await countSources(db, folder.id, access.mailboxId, opened.mailbox.key, planned).catch(() => planned.length) : planned.length;
		if (remaining !== planned.length) throw new ImapStateError("vanished", "Some of the requested messages no longer exist");
		throw new ImapStateError("unavailable", `The copy could not be committed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		copied: planned.map((copy) => {
			const placed = committed.get(copy.id);
			return { uid: copy.sourceUid, messageId: copy.sourceMessageId, destinationUid: placed?.uid ?? null, destinationUidValidity: placed?.uidValidity ?? null };
		}),
	};
}

/** How many planned sources still are where the copy found them (the UID still names the message, which is still in the folder). */
async function countSources(db: AppDatabase, folderId: string, mailboxId: string, key: ImapFolderKey, planned: ImapPlannedCopy[]): Promise<number> {
	let found = 0;
	for (const plannedChunk of chunk(planned, IN_LIST_CHUNK - 10)) {
		const rows = await db
			.select({ uid: imapMessageUids.uid, messageId: imapMessageUids.messageId })
			.from(imapMessageUids)
			.innerJoin(messages, eq(messages.id, imapMessageUids.messageId))
			.where(and(eq(imapMessageUids.imapFolderId, folderId), inArray(imapMessageUids.uid, plannedChunk.map((copy) => copy.sourceUid)), membershipCondition(mailboxId, key)));
		const expected = new Map(plannedChunk.map((copy) => [copy.sourceUid, copy.sourceMessageId]));
		found += rows.filter((row) => expected.get(row.uid) === row.messageId).length;
	}
	return found;
}
