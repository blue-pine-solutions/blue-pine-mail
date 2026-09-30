import { normalizeFolderName } from "@/lib/mailboxes/folder-management-utils";
import type { ImapFlagName, ImapFlags, ImapFolderKey, ImapMoveTarget, ImapSpecialUse, ImapStateErrorCode, ImapSystemRole } from "./types";

/**
 * The product folders IMAP exposes, in listing order, and the `messages.status` each
 * holds. Queued and failed sends have no folder: their representation is not final.
 */
export const SYSTEM_FOLDERS: ReadonlyArray<{ role: ImapSystemRole; name: string; status: string; specialUse: ImapSpecialUse | null }> = [
	{ role: "inbox", name: "INBOX", status: "received", specialUse: null },
	{ role: "drafts", name: "Drafts", status: "draft", specialUse: "Drafts" },
	{ role: "sent", name: "Sent", status: "sent", specialUse: "Sent" },
	{ role: "archive", name: "Archive", status: "archived", specialUse: "Archive" },
	{ role: "junk", name: "Spam", status: "spam", specialUse: "Junk" },
	{ role: "trash", name: "Trash", status: "trash", specialUse: "Trash" },
];

const CUSTOM_PREFIX = "f:";

/** Size of one UID assignment statement, so first access to a large folder is a series of bounded writes. */
export const UID_ASSIGNMENT_CHUNK = 500;

/** D1 accepts at most 100 bound parameters per statement. */
export const IN_LIST_CHUNK = 90;

/** UIDs per storeImapFlags statement, leaving room under IN_LIST_CHUNK for the membership and value parameters. */
export const FLAG_STORE_CHUNK = 80;

/** Flags a STORE may name and this server keeps. Which of them a principal may change where is ImapMailbox.permanentFlags. */
export const STORABLE_FLAGS: readonly ImapFlagName[] = ["seen", "flagged", "deleted"];

/** UIDs per relocation batch (expungeImapFolder, moveImapMessages), leaving room under IN_LIST_CHUNK for the other parameters. */
export const RELOCATION_CHUNK = 80;

/**
 * UIDs per permanent-deletion batch (A5.2c). Smaller than RELOCATION_CHUNK: each statement
 * also carries the in-SQL authorization and invariant guards (about 20 more bound parameters,
 * D1 allows 100), and deleting a message re-tokenizes its bodies for the full-text index and
 * cascades into several tables inside the same D1 statement, so the work per batch is bounded.
 */
export const PERMANENT_DELETE_CHUNK = 25;

/** D1's limit on bound parameters per statement; the permanent-deletion batch asserts it stays below. */
export const D1_MAX_BOUND_PARAMETERS = 100;

/**
 * The bp0003 trigger that clears a message's pending \Deleted marks whenever its folder
 * membership changes. \Deleted and EXPUNGE are only offered while it exists.
 */
export const DELETED_INVARIANT_TRIGGER = "bp_imap_membership_clears_deleted";

/**
 * The bp0004 triggers that release a draft's Drafts UID whenever what its fingerprint covers
 * changes (its content columns, or an attachment added or removed), with the table each is
 * on. \Deleted and permanent EXPUNGE in Drafts are only offered while all of them exist. The
 * content trigger's columns are exactly those draftFingerprint digests
 * (tests/downstream-migrations.test.mjs keeps them in step).
 */
export const DRAFT_INVARIANT_TRIGGERS: ReadonlyArray<{ name: string; table: string }> = [
	{ name: "bp_imap_draft_content_releases_uid", table: "messages" },
	{ name: "bp_imap_draft_attachment_added_releases_uid", table: "message_attachments" },
	{ name: "bp_imap_draft_attachment_removed_releases_uid", table: "message_attachments" },
];

/**
 * Folders whose EXPUNGE deletes permanently (A5.2c): Trash, and Drafts for their author. Every
 * other folder's EXPUNGE is recoverable (A5.2a): \Deleted messages move to Trash.
 */
export function isPermanentlyExpungeable(key: ImapFolderKey): key is "trash" | "drafts" {
	return key === "trash" || key === "drafts";
}

/**
 * The special-folder policy of IMAP MOVE (A5.2b): what moving a message from `source` to
 * `destination` makes of it, or why the move is refused. It follows the web app's moves:
 *
 * - INBOX is `received` without a folder, a custom folder `received` in that folder, Archive
 *   `archived`, Spam `spam` and Trash `trash`, from any folder that may move there.
 * - Sent and Drafts are never destinations: sending and composing are not moves, and a
 *   message in Trash does not remember that it came from Sent, so nothing can be put back
 *   there.
 * - Drafts may only move to Trash (the web app's "discard"; the caller also requires the
 *   principal to own each draft). Sent mail cannot move to Spam.
 * - A move into the folder a message is already in is refused: it would change nothing.
 * - Moving into Spam is the web app's "report spam", and moving from Spam to INBOX its
 *   "not spam": both train the mailbox's filter (inbound mail only). Other moves out of Spam
 *   (to Archive, Trash or a custom folder) do not, as in the web app.
 */
export function imapMoveTarget(source: ImapFolderKey, destination: ImapFolderKey): { target: ImapMoveTarget } | { refusal: string } {
	const to = parseFolderKey(destination);
	if (!to || !parseFolderKey(source)) return { refusal: "Unknown folder" };
	if (source === destination) return { refusal: "Messages are already in that mailbox" };
	if (to.kind === "role" && (to.role === "sent" || to.role === "drafts")) return { refusal: `Messages cannot be moved into ${to.role === "sent" ? "Sent" : "Drafts"}` };
	if (source === "drafts" && destination !== "trash") return { refusal: "Drafts can only be moved to Trash" };
	if (source === "sent" && destination === "junk") return { refusal: "Sent mail cannot be moved to Spam" };
	if (to.kind === "folder") return { target: { status: "received", folderId: to.folderId, training: null } };
	const training = destination === "junk" ? "spam" : source === "junk" && destination === "inbox" ? "ham" : null;
	return { target: { status: to.status, folderId: null, training } };
}

export class ImapStateError extends Error {
	constructor(readonly code: ImapStateErrorCode, message: string) {
		super(message);
		this.name = "ImapStateError";
	}
}

export function customFolderKey(folderId: string): ImapFolderKey {
	return `${CUSTOM_PREFIX}${folderId}`;
}

export function parseFolderKey(key: string): { kind: "role"; role: ImapSystemRole; status: string } | { kind: "folder"; folderId: string } | null {
	if (key.startsWith(CUSTOM_PREFIX)) {
		const folderId = key.slice(CUSTOM_PREFIX.length);
		return folderId ? { kind: "folder", folderId } : null;
	}
	const system = SYSTEM_FOLDERS.find((folder) => folder.role === key);
	return system ? { kind: "role", role: system.role, status: system.status } : null;
}

/**
 * The one IMAP folder a message belongs to, or null when it is not IMAP-visible. This is
 * the web app's partition: a custom folder only holds `received` mail (moving a message
 * to Trash, Spam or Archive wins over a folder it was filed in), and every other status
 * maps to its system folder. Snoozing does not hide mail from IMAP, as in JMAP.
 */
export function folderKeyForMessage(row: { mailboxId: string | null; status: string; folderId: string | null }): ImapFolderKey | null {
	if (!row.mailboxId) return null;
	if (row.status === "received" && row.folderId) return customFolderKey(row.folderId);
	return SYSTEM_FOLDERS.find((folder) => folder.status === row.status)?.role ?? null;
}

/** Product state as IMAP flags. Outbound mail is always seen, as in JMAP's `$seen`. */
export function flagsFor(row: { read: boolean; starred: boolean; status: string; direction: string }, deleted: boolean): ImapFlags {
	return {
		seen: row.read || row.direction === "outbound",
		flagged: row.starred,
		draft: row.status === "draft",
		deleted,
	};
}

/**
 * IMAP names for custom folders, unique within the mailbox. A folder whose name matches
 * a system folder (case-insensitively, since `INBOX` is) or an earlier folder gets the
 * first free ` (n)` suffix; earlier means older, so names are stable while folders exist.
 */
export function customFolderNames(folders: Array<{ id: string; name: string }>): Map<string, string> {
	const taken = new Set(SYSTEM_FOLDERS.map((folder) => folder.name.toLowerCase()));
	const names = new Map<string, string>();
	for (const folder of folders) {
		let name = folder.name;
		for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${folder.name} (${n})`;
		taken.add(name.toLowerCase());
		names.set(folder.id, name);
	}
	return names;
}

/**
 * A5.5a: the strict naming policy of IMAP mailbox management. The product's own folder names
 * (web, JMAP) may differ only in case or Unicode normalization, or equal a system folder's; IMAP
 * then lists the later ones with a ` (n)` suffix (customFolderNames), and that suffix can move to
 * another folder when a folder of the group is deleted. So IMAP never creates such a name, and
 * never renames or deletes a folder whose listed name could shift.
 */

/** The key two names collide under: Unicode NFC, then lowercase (customFolderNames folds case too). */
export function foldMailboxName(name: string): string {
	return name.normalize("NFC").toLowerCase();
}

/** `<base> (<n>)`, the shape customFolderNames gives a colliding name. */
const DISAMBIGUATED_NAME = /^(.*) \((\d+)\)$/;

/**
 * Folder ids whose listed IMAP name is not stable: a folder whose name collides (case- or
 * NFC-folded) with another folder's or a system folder's, and a folder named like a
 * disambiguated name whose base collides with one of those (it can take over that suffix).
 */
export function ambiguousFolderIds(folders: ReadonlyArray<{ id: string; name: string }>): Set<string> {
	const counts = new Map<string, number>();
	for (const folder of SYSTEM_FOLDERS) counts.set(foldMailboxName(folder.name), 1);
	for (const folder of folders) {
		const key = foldMailboxName(folder.name);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const ambiguous = new Set<string>();
	for (const folder of folders) {
		const suffixed = DISAMBIGUATED_NAME.exec(folder.name);
		if ((counts.get(foldMailboxName(folder.name)) ?? 0) > 1 || (suffixed && counts.has(foldMailboxName(suffixed[1])))) ambiguous.add(folder.id);
	}
	return ambiguous;
}

/**
 * Whether `name` (a decoded mailbox name) may become a folder's name through IMAP CREATE or
 * RENAME, given the mailbox's folders (excluding the folder being renamed):
 *
 * - `invalid`: not a valid folder name as stored (normalizeFolderName would refuse or change
 *   it, e.g. surrounding whitespace), or it contains the LIST wildcards `*` or `%`;
 * - `exists`: it names an existing mailbox: exactly a folder's name, a system folder's canonical
 *   name, or INBOX in any case;
 * - `collides`: it differs from an existing folder's or a system folder's name only in case or
 *   Unicode normalization, or has the `<base> (<n>)` shape with a colliding base;
 * - `ok` otherwise.
 */
export function imapFolderNameVerdict(name: string, folders: ReadonlyArray<{ name: string }>): "ok" | "invalid" | "exists" | "collides" {
	if (name.includes("*") || name.includes("%") || normalizeFolderName(name) !== name) return "invalid";
	if (name.toUpperCase() === "INBOX" || SYSTEM_FOLDERS.some((folder) => folder.name === name) || folders.some((folder) => folder.name === name)) return "exists";
	const taken = new Set([...SYSTEM_FOLDERS.map((folder) => foldMailboxName(folder.name)), ...folders.map((folder) => foldMailboxName(folder.name))]);
	const suffixed = DISAMBIGUATED_NAME.exec(name);
	if (taken.has(foldMailboxName(name)) || (suffixed && taken.has(foldMailboxName(suffixed[1])))) return "collides";
	return "ok";
}

export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
	return chunks;
}

/**
 * Whether a stored object key may be deleted as part of permanently deleting message
 * `messageId` (A5.2c post-commit cleanup), from the key alone. Only the namespaces a message
 * owns qualify, and only in the shape the code that writes them produces:
 *
 * - raw: `inbound/<name>.eml` (received mail, src/lib/email/inbound.ts and intake.ts),
 *   `imports/<messageId>.eml` (src/lib/import/service.ts), `drafts/<messageId>.eml` (JMAP
 *   Email/import) and `canonical/<messageId>/<name>.eml` (A1's canonical layer);
 * - attachment: `attachments/<messageId>/<attachmentId>/<filename>`.
 *
 * Anything else (`backups/`, `jmap-uploads/`, avatars, another message's key, a path with an
 * empty, `.` or `..` segment) is never deletable: a corrupted reference must leak, not reach
 * unrelated bytes.
 */
export function isDeletableMessageObjectKey(kind: "raw" | "attachment", key: unknown, messageId: string): boolean {
	if (typeof key !== "string" || !key || key.includes("\0") || key.includes("\\")) return false;
	const segments = key.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
	if (kind === "attachment") return segments.length === 4 && segments[0] === "attachments" && segments[1] === messageId;
	const [namespace] = segments;
	if (namespace === "inbound") return segments.length === 2 && segments[1].endsWith(".eml") && segments[1].length > 4;
	if (namespace === "imports" || namespace === "drafts") return segments.length === 2 && segments[1] === `${messageId}.eml`;
	if (namespace === "canonical") return segments.length === 3 && segments[1] === messageId && segments[2].endsWith(".eml") && segments[2].length > 4;
	return false;
}
