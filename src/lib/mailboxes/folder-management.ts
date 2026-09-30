import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "@/db";
import { folders, users } from "@/db/schema";
import { mailAppPasswords } from "@/db/schema/bluepine";
import { newId } from "@/lib/ids";
import { parseStoredScopes } from "@/lib/mail-app-passwords/utils";
import { getMailboxAccessLevel } from "./access";
import { isMailboxSharingEnabled } from "./access-utils";
import type { CreateFolderResult, DeleteFolderResult, FolderActor, RenameFolderResult } from "./folder-management-types";
import { normalizeFolderName } from "./folder-management-utils";

/**
 * Custom-folder management (R-1), shared by every protocol: JMAP Mailbox/set today, IMAP
 * CREATE/RENAME/DELETE later (A5.5). Folders belong to one mailbox; system folders (Inbox, Sent,
 * Drafts, Archive, Spam, Trash) are statuses, not folders, so they are never managed here.
 *
 * Authority is the product's existing one: the mailbox owner, or a `full_access` delegate of a
 * shared mailbox while sharing is enabled (getMailboxAccessLevel's `canManage`), for an enabled
 * user and an enabled mailbox; a mail app password, when named, must still exist for that user
 * and mailbox with the `imap` scope. It is checked twice:
 *
 * 1. up front, to answer precisely (`notFound` when the mailbox is not visible, `forbidden` when
 *    it is visible but not manageable), and
 * 2. again inside every mutating statement (managementGuard), each run as one D1 batch (a
 *    transaction on D1 and on the Node SQLite wrapper), so a downgrade, a revocation or a
 *    disabled user or mailbox between the two checks changes nothing.
 *
 * Every statement is scoped to the authoritative mailbox and to a folder verified to belong to
 * it (`folders.id` and `folders.mailbox_id` together): a folder id from another mailbox is
 * `notFound`, whatever mailbox it is presented with, and nothing about it (not even whether it
 * holds messages) is revealed. Deleting a folder requires it to be empty, snoozed messages
 * included, in the deleting statement itself; `removeMessages` moves exactly that mailbox's
 * messages in that folder to Trash in the same batch.
 */

const dialect = new SQLiteAsyncDialect();

type BatchResult = { results: unknown[] };

/** Run raw statements as one D1 batch (a transaction on D1 and on the Node SQLite wrapper). */
async function batchSql(db: AppDatabase, statements: SQL[]): Promise<BatchResult[]> {
	const client = db.$client as D1Database;
	return (await client.batch(
		statements.map((statement) => {
			const query = dialect.sqlToQuery(statement);
			return client.prepare(query.sql).bind(...query.params);
		}),
	)) as BatchResult[];
}

/**
 * The management authority of `actor` over `mailboxId`, re-checked inside a mutating statement
 * (the in-SQL form of authorize() below): the user exists and is enabled; the mail app password,
 * when named, still exists for this user and mailbox with the `imap` scope; the mailbox exists
 * and is enabled; and the user owns it or, while sharing is enabled, holds `full_access` to it
 * as a shared mailbox. Exported so the D1 certification can evaluate it directly.
 */
export function managementGuard(actor: FolderActor, mailboxId: string): SQL {
	const credential =
		actor.appPasswordId === undefined
			? sql``
			: sql`AND EXISTS (SELECT 1 FROM mail_app_passwords WHERE mail_app_passwords.id = ${actor.appPasswordId} AND mail_app_passwords.user_id = ${actor.userId} AND mail_app_passwords.mailbox_id = ${mailboxId} AND EXISTS (SELECT 1 FROM json_each(mail_app_passwords.scopes) WHERE json_each.value = 'imap'))`;
	const delegated = isMailboxSharingEnabled()
		? sql`OR (mailboxes.type = 'shared' AND EXISTS (SELECT 1 FROM mailbox_access WHERE mailbox_access.mailbox_id = mailboxes.id AND mailbox_access.user_id = ${actor.userId} AND mailbox_access.permission = 'full_access'))`
		: sql``;
	return sql`
		EXISTS (SELECT 1 FROM users WHERE users.id = ${actor.userId} AND users.disabled = 0)
		${credential}
		AND EXISTS (SELECT 1 FROM mailboxes WHERE mailboxes.id = ${mailboxId} AND mailboxes.disabled = 0 AND (mailboxes.user_id = ${actor.userId} ${delegated}))
	`;
}

/** `folderId` is a folder of `mailboxId`. */
function folderOfMailbox(folderId: string, mailboxId: string): SQL {
	return sql`EXISTS (SELECT 1 FROM folders WHERE folders.id = ${folderId} AND folders.mailbox_id = ${mailboxId})`;
}

/**
 * The up-front decision: `ok` when the actor may manage folders of the mailbox, `forbidden` when
 * the mailbox is visible to it but not manageable, `notFound` otherwise. Mirrors managementGuard.
 */
async function authorize(db: AppDatabase, actor: FolderActor, mailboxId: string): Promise<"ok" | "forbidden" | "notFound"> {
	const [user] = await db.select({ id: users.id, role: users.role, disabled: users.disabled }).from(users).where(eq(users.id, actor.userId)).limit(1);
	if (!user || user.disabled) return "notFound";
	if (actor.appPasswordId !== undefined) {
		const [credential] = await db
			.select({ scopes: mailAppPasswords.scopes })
			.from(mailAppPasswords)
			.where(and(eq(mailAppPasswords.id, actor.appPasswordId), eq(mailAppPasswords.userId, user.id), eq(mailAppPasswords.mailboxId, mailboxId)))
			.limit(1);
		if (!credential || !parseStoredScopes(credential.scopes).includes("imap")) return "notFound";
	}
	const access = await getMailboxAccessLevel(db, { id: user.id, role: user.role }, mailboxId);
	if (!access?.canRead) return "notFound";
	return access.canManage ? "ok" : "forbidden";
}

/** The custom folder `folderId` of `mailboxId` (id and name), or null when it is not a folder of that mailbox. Reads only. */
export async function findFolder(db: AppDatabase, mailboxId: string, folderId: string) {
	const [folder] = await db.select({ id: folders.id, name: folders.name }).from(folders).where(and(eq(folders.id, folderId), eq(folders.mailboxId, mailboxId))).limit(1);
	return folder ?? null;
}

/**
 * Whether another folder of the mailbox already has `name`: exactly, or with `strict` also up to
 * ASCII case (SQLite's lower()), the check the strict guard below makes in SQL.
 */
async function nameTaken(db: AppDatabase, mailboxId: string, name: string, exceptFolderId?: string, strict = false): Promise<boolean> {
	const same = strict ? sql`lower(${folders.name}) = lower(${name})` : eq(folders.name, name);
	const rows = await db.select({ id: folders.id }).from(folders).where(and(eq(folders.mailboxId, mailboxId), same)).limit(2);
	return rows.some((row) => row.id !== exceptFolderId);
}

/**
 * Strict naming (IMAP, A5.5a): the name must also be free up to ASCII case, checked inside the
 * write so two sessions cannot both take `Foo` and `foo`. Case differences outside ASCII and
 * Unicode normalization are the caller's policy (imapFolderNameVerdict); a race between such
 * variants stays possible without a schema constraint, and IMAP's listing disambiguates it.
 */
export type FolderNameOptions = { strictNames?: boolean };

function nameFree(alias: string, mailboxId: string, name: string, strict: boolean, exceptFolderId?: string): SQL {
	const other = sql.raw(alias);
	const same = strict ? sql`(${other}.name = ${name} OR lower(${other}.name) = lower(${name}))` : sql`${other}.name = ${name}`;
	const except = exceptFolderId === undefined ? sql`` : sql`AND ${other}.id <> ${exceptFolderId}`;
	return sql`NOT EXISTS (SELECT 1 FROM folders AS ${other} WHERE ${other}.mailbox_id = ${mailboxId} AND ${same} ${except})`;
}

function isUniqueViolation(error: unknown): boolean {
	const text = `${error instanceof Error ? error.message : String(error)} ${(error as { cause?: unknown })?.cause ?? ""}`;
	return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(text);
}

/**
 * Create a custom folder named `name` in `mailboxId`. Exact duplicates are refused
 * (`alreadyExists`); names differing only in case or Unicode normalization, or equal to a system
 * folder's, are accepted (JMAP, web). With `strictNames` (IMAP) a name equal up to ASCII case is
 * `alreadyExists` too, decided inside the insert.
 */
export async function createFolder(db: AppDatabase, actor: FolderActor, mailboxId: string, name: unknown, options: FolderNameOptions = {}): Promise<CreateFolderResult> {
	const strict = options.strictNames === true;
	const authorized = await authorize(db, actor, mailboxId);
	if (authorized !== "ok") return { outcome: authorized };
	const normalized = normalizeFolderName(name);
	if (normalized === null) return { outcome: "invalidName" };
	if (await nameTaken(db, mailboxId, normalized, undefined, strict)) return { outcome: "alreadyExists" };
	const id = newId("fld");
	let inserted: BatchResult[];
	try {
		inserted = await batchSql(db, [
			sql`
				INSERT INTO folders (id, user_id, mailbox_id, name, created_at)
				SELECT ${id}, mailboxes.user_id, mailboxes.id, ${normalized}, ${Math.floor(Date.now() / 1000)}
				FROM mailboxes
				WHERE mailboxes.id = ${mailboxId}
					AND ${managementGuard(actor, mailboxId)}
					AND ${nameFree("existing", mailboxId, normalized, strict)}
				RETURNING id
			`,
		]);
	} catch (error) {
		if (isUniqueViolation(error)) return { outcome: "alreadyExists" };
		throw error;
	}
	if (inserted[0].results.length) return { outcome: "ok", folderId: id, name: normalized };
	// Nothing written: a folder of that name appeared, or authority went away meanwhile.
	if (await nameTaken(db, mailboxId, normalized, undefined, strict)) return { outcome: "alreadyExists" };
	return { outcome: settledRefusal(await authorize(db, actor, mailboxId)) };
}

/** Rename custom folder `folderId` of `mailboxId` to `name`. Validation, duplicates and `strictNames` as in createFolder. */
export async function renameFolder(db: AppDatabase, actor: FolderActor, mailboxId: string, folderId: string, name: unknown, options: FolderNameOptions = {}): Promise<RenameFolderResult> {
	const strict = options.strictNames === true;
	const authorized = await authorize(db, actor, mailboxId);
	if (authorized !== "ok") return { outcome: authorized };
	const folder = await findFolder(db, mailboxId, folderId);
	if (!folder) return { outcome: "notFound" };
	const normalized = normalizeFolderName(name);
	if (normalized === null) return { outcome: "invalidName" };
	if (normalized === folder.name) return { outcome: "unchanged", name: normalized };
	if (await nameTaken(db, mailboxId, normalized, folderId, strict)) return { outcome: "alreadyExists" };
	let renamed: BatchResult[];
	try {
		renamed = await batchSql(db, [
			sql`
				UPDATE folders SET name = ${normalized}
				WHERE folders.id = ${folderId} AND folders.mailbox_id = ${mailboxId}
					AND ${managementGuard(actor, mailboxId)}
					AND ${nameFree("other", mailboxId, normalized, strict, folderId)}
				RETURNING id
			`,
		]);
	} catch (error) {
		if (isUniqueViolation(error)) return { outcome: "alreadyExists" };
		throw error;
	}
	if (renamed[0].results.length) return { outcome: "ok", name: normalized };
	if (!(await findFolder(db, mailboxId, folderId))) return { outcome: "notFound" };
	if (await nameTaken(db, mailboxId, normalized, folderId, strict)) return { outcome: "alreadyExists" };
	return { outcome: settledRefusal(await authorize(db, actor, mailboxId)) };
}

/**
 * Delete custom folder `folderId` of `mailboxId`.
 *
 * - Without `removeMessages` the folder must be empty: the deleting statement itself requires
 *   that no message references it (snoozed ones included), so a message filed into it at the
 *   last moment keeps it alive (`hasMessages`) instead of being reclassified to Inbox by the
 *   foreign key's ON DELETE SET NULL.
 * - With `removeMessages`, one batch moves the mailbox's messages in that folder to Trash
 *   (status `trash`, no folder, as the web app's Trash action does) and deletes the folder.
 *   Both statements carry the same guards (authority, the folder belonging to the mailbox, and
 *   no message of any other mailbox referencing it), so either both apply or neither does.
 */
export async function deleteFolder(db: AppDatabase, actor: FolderActor, mailboxId: string, folderId: string, options: { removeMessages?: boolean } = {}): Promise<DeleteFolderResult> {
	const authorized = await authorize(db, actor, mailboxId);
	if (authorized !== "ok") return { outcome: authorized };
	if (!(await findFolder(db, mailboxId, folderId))) return { outcome: "notFound" };
	const guard = sql`${managementGuard(actor, mailboxId)} AND ${folderOfMailbox(folderId, mailboxId)}`;
	// A message of another mailbox still filed in this folder (possible only through data drift)
	// must neither be moved by this mailbox's delete nor lose its folder through ON DELETE SET NULL.
	const noForeignMessages = sql`NOT EXISTS (SELECT 1 FROM messages WHERE messages.folder_id = ${folderId} AND messages.mailbox_id IS NOT ${mailboxId})`;
	const statements: SQL[] = [];
	if (options.removeMessages) {
		statements.push(sql`
			UPDATE messages SET status = 'trash', folder_id = NULL
			WHERE messages.mailbox_id = ${mailboxId} AND messages.folder_id = ${folderId}
				AND ${guard}
				AND ${noForeignMessages}
			RETURNING id
		`);
	}
	statements.push(sql`
		DELETE FROM folders
		WHERE folders.id = ${folderId} AND folders.mailbox_id = ${mailboxId}
			AND ${guard}
			AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.folder_id = ${folderId})
		RETURNING id
	`);
	const results = await batchSql(db, statements);
	const deleted = results[results.length - 1].results.length > 0;
	if (deleted) return { outcome: "ok", movedToTrash: options.removeMessages ? results[0].results.length : 0 };
	// Nothing deleted (and, with removeMessages, nothing moved unless the folder went too).
	if (!(await findFolder(db, mailboxId, folderId))) return { outcome: "notFound" };
	const settled = await authorize(db, actor, mailboxId);
	if (settled !== "ok") return { outcome: settled };
	return { outcome: "hasMessages" };
}

/** The refusal to report when a guarded write changed nothing although it was authorized up front. */
function settledRefusal(authorized: "ok" | "forbidden" | "notFound"): "forbidden" | "notFound" {
	return authorized === "ok" ? "notFound" : authorized;
}
