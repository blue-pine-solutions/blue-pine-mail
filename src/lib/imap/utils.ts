import type { ImapFlagName, ImapFlags, ImapFolderKey, ImapSpecialUse, ImapStateErrorCode, ImapSystemRole } from "./types";

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

/** UIDs per relocation batch (expungeImapFolder), leaving room under IN_LIST_CHUNK for the other parameters. */
export const RELOCATION_CHUNK = 80;

/**
 * The bp0003 trigger that clears a message's pending \Deleted marks whenever its folder
 * membership changes. \Deleted and EXPUNGE are only offered while it exists.
 */
export const DELETED_INVARIANT_TRIGGER = "bp_imap_membership_clears_deleted";

/**
 * Folders whose EXPUNGE is recoverable: \Deleted messages move to Trash. Expunging Trash or
 * Drafts would delete permanently, which this server does not do yet, so \Deleted cannot
 * be set there.
 */
export function isRecoverablyExpungeable(key: ImapFolderKey): boolean {
	return key !== "trash" && key !== "drafts";
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

export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
	return chunks;
}
