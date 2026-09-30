import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { mailboxes, users } from "./index";

/**
 * Blue Pine-owned tables. Created by `bpNNNN` migrations (UPSTREAM.md, "Downstream
 * migrations") and deliberately outside drizzle-kit's schema input, so upstream
 * migration generation never picks them up.
 */

/** Credentials a mail app uses for one mailbox over mail protocols. Only a hash of the credential is stored. */
export const mailAppPasswords = sqliteTable(
	"mail_app_passwords",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		label: text("label").notNull(),
		/** The non-secret identifier embedded in the credential, used for lookup and shown to the user. */
		publicId: text("public_id").notNull(),
		/** SHA-256 of the whole credential, hex. */
		secretHash: text("secret_hash").notNull(),
		/** JSON array of MailAppPasswordScope. */
		scopes: text("scopes").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
	},
	(t) => [uniqueIndex("mail_app_passwords_public_id_idx").on(t.publicId), index("mail_app_passwords_user_idx").on(t.userId), index("mail_app_passwords_mailbox_idx").on(t.mailboxId)],
);

/**
 * IMAP state of one folder of one mailbox (src/lib/imap/). `folderKey` is a system role
 * (`inbox`, `sent`, `drafts`, `archive`, `junk`, `trash`) or `f:<folders.id>`. Rows outlive
 * the custom folder they describe so a later UIDVALIDITY in the mailbox is always greater.
 */
export const imapFolders = sqliteTable(
	"imap_folders",
	{
		id: text("id").primaryKey(),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		folderKey: text("folder_key").notNull(),
		uidValidity: integer("uid_validity").notNull(),
		/** Advanced by the bp_imap_message_uids_advance_uid_next trigger; never decreases. */
		uidNext: integer("uid_next").notNull().default(1),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [uniqueIndex("imap_folders_mailbox_key_idx").on(t.mailboxId, t.folderKey)],
);

/**
 * The UID a message holds in an IMAP folder. A row exists while the message is a member of
 * that folder; when it leaves, the row is deleted and its UID is never assigned again.
 */
export const imapMessageUids = sqliteTable(
	"imap_message_uids",
	{
		imapFolderId: text("imap_folder_id")
			.notNull()
			.references(() => imapFolders.id, { onDelete: "cascade" }),
		uid: integer("uid").notNull(),
		/** `messages.id`. No foreign key, so upstream rebuilds of `messages` cannot cascade into IMAP state. */
		messageId: text("message_id").notNull(),
		/** For drafts: the canonical draft fingerprint this UID's content is bound to. */
		draftFingerprint: text("draft_fingerprint"),
		/** The stored object whose bytes this UID serves, recorded on first read; a different object means different content. */
		rfc822Key: text("rfc822_key"),
		/** Octet length of those bytes. */
		rfc822Size: integer("rfc822_size"),
		/** IMAP \Deleted, which has no product equivalent. */
		deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		primaryKey({ columns: [t.imapFolderId, t.uid] }),
		uniqueIndex("imap_message_uids_folder_message_idx").on(t.imapFolderId, t.messageId),
		index("imap_message_uids_message_idx").on(t.messageId),
	],
);
