import type { CanonicalSource } from "@/lib/email/canonical-message-types";
import type { MailAppPrincipal } from "@/lib/mail-app-passwords/types";
import type { MailboxPermission } from "@/lib/mailboxes/types";

/** Product folders with an IMAP special-use role. Values follow JMAP's role names. */
export type ImapSystemRole = "inbox" | "drafts" | "sent" | "archive" | "junk" | "trash";

/** Stable identity of an IMAP folder within a mailbox: a system role or `f:<folders.id>`. */
export type ImapFolderKey = ImapSystemRole | `f:${string}`;

/** RFC 6154 special-use attribute names, without the protocol's leading backslash. */
export type ImapSpecialUse = "Drafts" | "Sent" | "Archive" | "Junk" | "Trash";

/**
 * Who is asking. A verified mail app password principal (A2) fits as is; `appPasswordId`,
 * when given, must still name a live credential with the `imap` scope.
 */
export type ImapPrincipal = Pick<MailAppPrincipal, "userId" | "mailboxId"> & { appPasswordId?: string };

/** Authorization as evaluated for one operation, never cached across operations. */
export type ImapAccess = {
	userId: string;
	mailboxId: string;
	permission: MailboxPermission;
	isOwner: boolean;
	canRead: boolean;
	canManage: boolean;
};

export type ImapFlagName = "seen" | "flagged" | "deleted";

/** IMAP system flags the product can represent. `\Answered` and `\Recent` are not kept. */
export type ImapFlags = {
	seen: boolean;
	flagged: boolean;
	/** Derived from the Drafts folder (status `draft`); not settable. */
	draft: boolean;
	deleted: boolean;
};

export type ImapMailbox = {
	key: ImapFolderKey;
	/** Unique within the mailbox; `INBOX` for the inbox. Hierarchy and encoding are the listener's concern. */
	name: string;
	role: ImapSystemRole | null;
	specialUse: ImapSpecialUse | null;
	folderId: string | null;
	selectable: true;
	/** Flags a client with this access may change on messages here. */
	permanentFlags: ImapFlagName[];
	/** Future write operations (append, move, copy, expunge) need management access, as in the web app. */
	mayWrite: boolean;
	mayRename: boolean;
	mayDelete: boolean;
};

export type ImapMessageEntry = {
	uid: number;
	messageId: string;
	internalDate: Date;
	flags: ImapFlags;
	/** Known once the message has been read over IMAP; null until then. */
	rfc822Size: number | null;
};

export type ImapFolderSnapshot = {
	mailbox: ImapMailbox;
	uidValidity: number;
	uidNext: number;
	/** In ascending UID order, which is the IMAP message sequence order. */
	messages: ImapMessageEntry[];
};

export type ImapFolderStatus = {
	uidValidity: number;
	uidNext: number;
	messages: number;
	unseen: number;
	deleted: number;
};

export type ImapMessageContent = {
	uid: number;
	messageId: string;
	/** The exact RFC 5322 octets for this UID. */
	bytes: Uint8Array;
	/** `bytes.byteLength`: the RFC822.SIZE for this UID. */
	size: number;
	flags: ImapFlags;
	source: Exclude<CanonicalSource, "transient">;
};

export type ImapFlagChanges = Partial<Record<ImapFlagName, boolean>>;

/**
 * A STORE-style flag change for many UIDs (storeImapFlags). `replace` sets every flag it can
 * change to whether it is listed, `add` sets the listed flags and `remove` clears them.
 * Only \Seen and \Flagged can change; naming `deleted` is refused (`denied` without
 * management access, `unsupported` with it).
 */
export type ImapFlagStore = { mode: "replace" | "add" | "remove"; flags: ImapFlagName[] };

/**
 * `forbidden`: the principal no longer has access at all (the session must end).
 * `denied`: access is intact but does not include this change (answer NO, keep the session).
 * `unsupported`: the change is not available on this server.
 */
export type ImapStateErrorCode = "forbidden" | "denied" | "unsupported" | "nonexistent" | "unavailable";
