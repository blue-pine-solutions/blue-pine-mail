import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { users } from "@/db/schema";
import { mailAppPasswords } from "@/db/schema/bluepine";
import { parseStoredScopes } from "@/lib/mail-app-passwords/utils";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { ImapAccess, ImapPrincipal } from "./types";

/**
 * Re-evaluate what a principal may do with its mailbox, from current state: the account
 * must be enabled, the credential (when named) must still exist with the `imap` scope for
 * this user and mailbox, and the mailbox must be readable through getMailboxAccessLevel
 * (ownership, or current shared access while sharing is enabled). Every IMAP state
 * operation calls this, so a revoked grant stops working at the next operation.
 */
export async function authorizeImapAccess(db: AppDatabase, principal: ImapPrincipal): Promise<ImapAccess | null> {
	const [user] = await db.select({ id: users.id, role: users.role, disabled: users.disabled }).from(users).where(eq(users.id, principal.userId)).limit(1);
	if (!user || user.disabled) return null;
	if (principal.appPasswordId !== undefined) {
		const [credential] = await db
			.select({ scopes: mailAppPasswords.scopes })
			.from(mailAppPasswords)
			.where(and(eq(mailAppPasswords.id, principal.appPasswordId), eq(mailAppPasswords.userId, user.id), eq(mailAppPasswords.mailboxId, principal.mailboxId)))
			.limit(1);
		if (!credential || !parseStoredScopes(credential.scopes).includes("imap")) return null;
	}
	const access = await getMailboxAccessLevel(db, { id: user.id, role: user.role }, principal.mailboxId);
	if (!access?.canRead) return null;
	return { userId: user.id, mailboxId: principal.mailboxId, permission: access.permission, isOwner: access.isOwner, canRead: access.canRead, canManage: access.canManage };
}
