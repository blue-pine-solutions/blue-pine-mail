import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes } from "@/db/schema";
import { mailAppPasswords } from "@/db/schema/bluepine";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { CreateMailAppPasswordInput, MailAppPasswordSummary } from "./types";
import {
	credentialHint,
	generateMailAppCredential,
	hashMailAppCredential,
	mailboxAddress,
	MAX_MAIL_APP_PASSWORDS_PER_USER,
	normalizeLabel,
	normalizeScopes,
	parseStoredScopes,
} from "./utils";

type Env = CloudflareEnv;
type Owner = { id: string; role: "admin" | "user" };

export class MailAppPasswordError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

/** The caller's own mail app passwords. Never includes the hash. */
export async function listMailAppPasswords(env: Env, user: Owner): Promise<MailAppPasswordSummary[]> {
	const db = getDb(env);
	const rows = await db
		.select({
			id: mailAppPasswords.id,
			label: mailAppPasswords.label,
			mailboxId: mailAppPasswords.mailboxId,
			publicId: mailAppPasswords.publicId,
			scopes: mailAppPasswords.scopes,
			createdAt: mailAppPasswords.createdAt,
			lastUsedAt: mailAppPasswords.lastUsedAt,
			localPart: mailboxes.localPart,
			hostname: domains.hostname,
		})
		.from(mailAppPasswords)
		.innerJoin(mailboxes, eq(mailboxes.id, mailAppPasswords.mailboxId))
		.innerJoin(domains, eq(domains.id, mailboxes.domainId))
		.where(eq(mailAppPasswords.userId, user.id))
		.orderBy(desc(mailAppPasswords.createdAt));
	return Promise.all(
		rows.map(async (row) => ({
			id: row.id,
			label: row.label,
			mailboxId: row.mailboxId,
			address: mailboxAddress(row.localPart, row.hostname),
			scopes: parseStoredScopes(row.scopes),
			hint: credentialHint(row.publicId),
			createdAt: row.createdAt.toISOString(),
			lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
			usable: !!(await getMailboxAccessLevel(db, user, row.mailboxId)),
		})),
	);
}

/**
 * Create a credential for a mailbox the user can currently reach (their own, or a
 * shared one at any permission level). Returns the plaintext exactly once; only its
 * hash is stored. The per-user limit is enforced by the insert itself.
 */
export async function createMailAppPassword(env: Env, user: Owner, input: CreateMailAppPasswordInput): Promise<{ credential: string; password: MailAppPasswordSummary }> {
	const label = normalizeLabel(input.label);
	if (!label) throw new MailAppPasswordError("Enter a name of up to 64 characters", 400);
	const scopes = normalizeScopes(input.scopes);
	if (!scopes) throw new MailAppPasswordError("Choose IMAP, SMTP or both", 400);
	if (typeof input.mailboxId !== "string" || !input.mailboxId) throw new MailAppPasswordError("Choose a mailbox", 400);
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, input.mailboxId);
	if (!access) throw new MailAppPasswordError("Mailbox not found", 404);
	const [domain] = await db.select({ hostname: domains.hostname }).from(domains).where(eq(domains.id, access.mailbox.domainId)).limit(1);
	if (!domain) throw new MailAppPasswordError("Mailbox not found", 404);

	const { credential, publicId } = generateMailAppCredential();
	const id = newId("map");
	const createdAt = new Date();
	const result = await db.run(sql`
		INSERT INTO mail_app_passwords (id, user_id, mailbox_id, label, public_id, secret_hash, scopes, created_at)
		SELECT ${id}, ${user.id}, ${access.mailbox.id}, ${label}, ${publicId}, ${await hashMailAppCredential(credential)}, ${JSON.stringify(scopes)}, ${Math.floor(createdAt.getTime() / 1000)}
		WHERE (SELECT COUNT(*) FROM mail_app_passwords WHERE user_id = ${user.id}) < ${MAX_MAIL_APP_PASSWORDS_PER_USER}
	`);
	if (!result.meta.changes) throw new MailAppPasswordError(`You can have up to ${MAX_MAIL_APP_PASSWORDS_PER_USER} mail app passwords. Revoke one first.`, 409);

	await createAuditLog(env, { actorUserId: user.id, targetUserId: user.id, mailboxId: access.mailbox.id, action: "mail_app_password.create", metadata: { label, credential: credentialHint(publicId), scopes } });
	return {
		credential,
		password: {
			id,
			label,
			mailboxId: access.mailbox.id,
			address: mailboxAddress(access.mailbox.localPart, domain.hostname),
			scopes,
			hint: credentialHint(publicId),
			createdAt: new Date(Math.floor(createdAt.getTime() / 1000) * 1000).toISOString(),
			lastUsedAt: null,
			usable: true,
		},
	};
}

/** Delete one of the user's own credentials. Revocation is immediate and permanent. */
export async function revokeMailAppPassword(env: Env, user: Owner, id: string): Promise<boolean> {
	const db = getDb(env);
	const [row] = await db
		.select({ id: mailAppPasswords.id, mailboxId: mailAppPasswords.mailboxId, label: mailAppPasswords.label, publicId: mailAppPasswords.publicId })
		.from(mailAppPasswords)
		.where(and(eq(mailAppPasswords.id, id), eq(mailAppPasswords.userId, user.id)))
		.limit(1);
	if (!row) return false;
	await db.delete(mailAppPasswords).where(and(eq(mailAppPasswords.id, row.id), eq(mailAppPasswords.userId, user.id)));
	await createAuditLog(env, { actorUserId: user.id, targetUserId: user.id, mailboxId: row.mailboxId, action: "mail_app_password.revoke", metadata: { label: row.label, credential: credentialHint(row.publicId) } });
	return true;
}
