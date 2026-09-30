import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
