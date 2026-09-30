import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { mailAppPasswords } from "@/db/schema/bluepine";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { MailAppAuthResult, MailAppPasswordScope } from "./types";
import { digestsEqual, hashMailAppCredential, LAST_USED_RESOLUTION_MS, mailboxAddress, parseMailAppCredential, parseStoredScopes } from "./utils";

/** Compared against when no row matches, so a miss costs the same as a wrong secret. */
const ABSENT_DIGEST = "0".repeat(64);

/**
 * Authenticate a mail protocol login: the mailbox address as username and a mail app
 * password. Protocol-neutral and side-effect free apart from `last_used_at`; it never
 * creates a session, and web passwords and API keys never match the credential format.
 *
 * Authorization is evaluated now, not at creation: the account must be enabled, the
 * mailbox reachable by it through getMailboxAccessLevel (ownership, or current
 * shared-mailbox access while sharing is enabled), and the requested scope granted.
 * Rate limiting belongs to the listener that calls this.
 */
export async function verifyMailAppPassword(env: CloudflareEnv, input: { username: string; password: string; scope: MailAppPasswordScope }): Promise<MailAppAuthResult> {
	const parsed = typeof input.password === "string" ? parseMailAppCredential(input.password) : null;
	const digest = await hashMailAppCredential(typeof input.password === "string" ? input.password : "");
	if (!parsed) return { ok: false, reason: "invalid_credentials" };

	const db = getDb(env);
	const [row] = await db
		.select({
			id: mailAppPasswords.id,
			secretHash: mailAppPasswords.secretHash,
			scopes: mailAppPasswords.scopes,
			mailboxId: mailAppPasswords.mailboxId,
			userId: users.id,
			userEmail: users.email,
			role: users.role,
			userDisabled: users.disabled,
			localPart: mailboxes.localPart,
			hostname: domains.hostname,
		})
		.from(mailAppPasswords)
		.innerJoin(users, eq(users.id, mailAppPasswords.userId))
		.innerJoin(mailboxes, eq(mailboxes.id, mailAppPasswords.mailboxId))
		.innerJoin(domains, eq(domains.id, mailboxes.domainId))
		.where(eq(mailAppPasswords.publicId, parsed.publicId))
		.limit(1);
	const secretMatches = digestsEqual(row?.secretHash ?? ABSENT_DIGEST, digest);
	const username = typeof input.username === "string" ? input.username.trim().toLowerCase() : "";
	// A credential only ever authenticates the mailbox it was issued for.
	if (!row || !secretMatches || username !== mailboxAddress(row.localPart, row.hostname)) return { ok: false, reason: "invalid_credentials" };

	if (row.userDisabled) return { ok: false, reason: "account_disabled" };
	const access = await getMailboxAccessLevel(db, { id: row.userId, role: row.role }, row.mailboxId);
	if (!access) return { ok: false, reason: "mailbox_unavailable" };
	const scopes = parseStoredScopes(row.scopes);
	if (!scopes.includes(input.scope)) return { ok: false, reason: "scope_not_granted" };

	const now = new Date();
	await db
		.update(mailAppPasswords)
		.set({ lastUsedAt: now })
		.where(and(eq(mailAppPasswords.id, row.id), or(isNull(mailAppPasswords.lastUsedAt), lt(mailAppPasswords.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS)))));

	return {
		ok: true,
		principal: {
			appPasswordId: row.id,
			userId: row.userId,
			userEmail: row.userEmail,
			mailboxId: row.mailboxId,
			address: username,
			mailboxType: access.mailbox.type,
			isOwner: access.isOwner,
			permission: access.permission,
			canRead: access.canRead,
			canSendOnBehalf: access.canSendOnBehalf,
			canSendAs: access.canSendAs,
			canManage: access.canManage,
			scopes,
		},
	};
}
