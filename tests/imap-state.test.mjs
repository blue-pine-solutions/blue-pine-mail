import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";

/**
 * A3: persistent IMAP mailbox state (src/lib/imap/). No listener exists; these tests drive the
 * protocol-neutral service against the real migrations, product routes and canonical layer.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = join(root, "drizzle", "migrations");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-imap-bundle-"));
await build({
	stdin: {
		contents: `
			export * as imap from "./src/lib/imap/service.ts";
			export * as imapUtils from "./src/lib/imap/utils.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { FileBucket } from "./server/runtime/file-bucket.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { sendEmail } from "./src/lib/email/send.ts";
			export { resolveCanonicalMessage } from "./src/lib/email/canonical-message.ts";
			export { exportDatabaseRecords, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
			export { POST as statusRoute } from "./src/app/api/messages/[messageId]/status/route.ts";
			export { POST as starRoute } from "./src/app/api/messages/[messageId]/star/route.ts";
			export { POST as bulkRoute } from "./src/app/api/messages/bulk/route.ts";
			export { PATCH as patchDraft, DELETE as deleteDraft } from "./src/app/api/drafts/[id]/route.ts";
			export { default as PostalMime } from "postal-mime";
		`,
		resolveDir: root,
		sourcefile: "imap-state-test-entry.ts",
		loader: "ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	jsx: "automatic",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
		"next/link": "next/link.js",
		"next/navigation": "next/navigation.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const entryUrl = pathToFileURL(join(bundleDirectory, "entry.mjs")).href;
const app = await import(entryUrl);
const { imap } = app;
test.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAJJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const BASE = "http://mailflare.local";
const bufferOf = (document) => document.buffer.slice(document.byteOffset, document.byteOffset + document.byteLength);

/**
 * A owns personal mailbox `a` (custom folder `Work`) and shared mailbox `sales`, where B is
 * read_only, C send_as and D full_access. X owns an unrelated mailbox with its own folder.
 */
function seed(database) {
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
			('user-a', 'a@example.test', 'h', 'A', 'admin', 1),
			('user-b', 'b@example.test', 'h', 'B', 'user', 1),
			('user-c', 'c@example.test', 'h', 'C', 'user', 1),
			('user-d', 'd@example.test', 'h', 'D', 'user', 1),
			('user-x', 'x@example.test', 'h', 'X', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-a', 'example.test', 'manual', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, type, created_at) VALUES
			('mbx-a', 'user-a', 'domain-1', 'a', 'Ann Example', 'personal', 1),
			('mbx-s', 'user-a', 'domain-1', 'sales', 'Sales', 'shared', 1),
			('mbx-x', 'user-x', 'domain-1', 'x', NULL, 'personal', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES
			('acc-b', 'mbx-s', 'user-b', 'read_only', 1),
			('acc-c', 'mbx-s', 'user-c', 'send_as', 1),
			('acc-d', 'mbx-s', 'user-d', 'full_access', 1);
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES
			('fld-work', 'user-a', 'mbx-a', 'Work', 1),
			('fld-x', 'user-x', 'mbx-x', 'Private', 1);
	`);
}

async function install(t, { migrations = migrationsDirectory, directory = mkdtempSync(join(tmpdir(), "mailflare-imap-")), seeded = true } = {}) {
	const database = new app.SqliteDatabase(join(directory, "mailflare.sqlite"));
	await app.applyMigrations(database, migrations);
	if (seeded) seed(database);
	const sent = [];
	const env = {
		DB: database,
		BUCKET: new app.FileBucket(join(directory, "blobs")),
		EMAIL: { async send(message) { sent.push(message); return { messageId: `<provider-${sent.length}@mail.example.test>` }; } },
		OUTBOUND_QUEUE: { async send() {} },
	};
	globalThis.__mailflareNodeEnv = env;
	let closed = false;
	const close = () => { if (!closed) { closed = true; database.db.close(); } };
	t.after(() => {
		delete globalThis.__mailflareNodeEnv;
		close();
		rmSync(directory, { recursive: true, force: true });
	});
	return { database, env, sent, directory, close, row: (id) => database.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) };
}

const insertMessage = (database, values) => {
	const row = { user_id: "user-a", mailbox_id: "mbx-a", direction: "inbound", from_addr: "sender@elsewhere.test", to_addr: "a@example.test", status: "received", created_at: 1790000000, ...values };
	const columns = Object.keys(row);
	database.db.prepare(`INSERT INTO messages (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => row[column]));
};

const owner = { userId: "user-a", mailboxId: "mbx-a" };
const salesAs = (userId) => ({ userId, mailboxId: "mbx-s" });
const listing = (snapshot) => snapshot.messages.map((entry) => [entry.uid, entry.messageId]);
const ids = (snapshot) => snapshot.messages.map((entry) => entry.messageId);

function call(handler, token, path, { method = "POST", body, params } = {}) {
	const request = new Request(`${BASE}${path}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	return params ? handler(request, { params: Promise.resolve(params) }) : handler(request);
}

async function rejectsWith(promise, code) {
	await assert.rejects(promise, (error) => error?.name === "ImapStateError" && error.code === code);
}

test("each message belongs to exactly one IMAP folder, following the web app's partition", () => {
	const key = (status, folderId = null, mailboxId = "mbx") => app.imapUtils.folderKeyForMessage({ mailboxId, status, folderId });
	assert.equal(key("received"), "inbox");
	assert.equal(key("received", "fld-1"), "f:fld-1");
	assert.equal(key("sent"), "sent");
	assert.equal(key("draft"), "drafts");
	assert.equal(key("archived"), "archive");
	assert.equal(key("spam"), "junk");
	assert.equal(key("trash"), "trash");
	assert.equal(key("trash", "fld-1"), "trash", "trashing a filed message puts it in Trash, as the web app shows it");
	assert.equal(key("spam", "fld-1"), "junk");
	assert.equal(key("sent", "fld-1"), "sent");
	for (const hidden of ["queued", "failed", "pending_approval", "anything-else"]) assert.equal(key(hidden), null, hidden);
	assert.equal(key("received", null, null), null, "mail whose mailbox was deleted is not visible");

	assert.deepEqual(app.imapUtils.flagsFor({ read: false, starred: true, status: "received", direction: "inbound" }, false), { seen: false, flagged: true, draft: false, deleted: false });
	assert.deepEqual(app.imapUtils.flagsFor({ read: false, starred: false, status: "draft", direction: "outbound" }, true), { seen: true, flagged: false, draft: true, deleted: true });

	const names = app.imapUtils.customFolderNames([{ id: "1", name: "Sent" }, { id: "2", name: "inbox" }, { id: "3", name: "Sent (2)" }, { id: "4", name: "Projects" }, { id: "5", name: "projects" }]);
	assert.deepEqual([...names.values()], ["Sent (2)", "inbox (2)", "Sent (2) (2)", "Projects", "projects (2)"]);
	assert.equal(new Set([...names.values()].map((name) => name.toLowerCase())).size, 5);
	assert.deepEqual(app.imapUtils.parseFolderKey("junk"), { kind: "role", role: "junk", status: "spam" });
	assert.deepEqual(app.imapUtils.parseFolderKey("f:abc"), { kind: "folder", folderId: "abc" });
	for (const bad of ["f:", "spam", "INBOX", "Sent", ""]) assert.equal(app.imapUtils.parseFolderKey(bad), null, bad);
});

test("the mailbox listing maps the product's folders to special-use roles and scopes rights to the principal", async (t) => {
	const { env } = await install(t);
	const list = await imap.listImapMailboxes(env, owner);
	assert.deepEqual(list.map((mailbox) => [mailbox.key, mailbox.name, mailbox.specialUse]), [
		["inbox", "INBOX", null],
		["drafts", "Drafts", "Drafts"],
		["sent", "Sent", "Sent"],
		["archive", "Archive", "Archive"],
		["junk", "Spam", "Junk"],
		["trash", "Trash", "Trash"],
		["f:fld-work", "Work", null],
	]);
	assert.ok(list.every((mailbox) => mailbox.selectable && mailbox.mayWrite));
	assert.deepEqual(list.filter((mailbox) => mailbox.mayRename).map((mailbox) => mailbox.key), ["f:fld-work"]);
	assert.deepEqual(list[0].permanentFlags, ["seen", "flagged", "deleted"]);

	const readOnly = await imap.listImapMailboxes(env, salesAs("user-b"));
	assert.deepEqual(readOnly.map((mailbox) => mailbox.key), ["inbox", "drafts", "sent", "archive", "junk", "trash"]);
	assert.ok(readOnly.every((mailbox) => !mailbox.mayWrite && mailbox.permanentFlags.join() === "seen,flagged"));
	assert.ok((await imap.listImapMailboxes(env, salesAs("user-d"))).every((mailbox) => mailbox.mayWrite));

	// A folder key only resolves inside the principal's own mailbox.
	await rejectsWith(imap.openImapFolder(env, owner, "f:fld-x"), "nonexistent");
	await rejectsWith(imap.openImapFolder(env, owner, "f:missing"), "nonexistent");
	await rejectsWith(imap.openImapFolder(env, owner, "Sent"), "nonexistent");
	await rejectsWith(imap.openImapFolder(env, { userId: "user-a", mailboxId: "mbx-x" }, "inbox"), "forbidden");
});

test("an upgraded A2 mailbox gets deterministic UIDs on first read, and restarts and re-runs of the migrations keep them", async (t) => {
	// The database as A2 left it: every migration up to bp0001, mail already present.
	const a2Migrations = mkdtempSync(join(tmpdir(), "mailflare-a2-migrations-"));
	t.after(() => rmSync(a2Migrations, { recursive: true, force: true }));
	cpSync(migrationsDirectory, a2Migrations, { recursive: true });
	rmSync(join(a2Migrations, "bp0002_add_imap_mailbox_state.sql"));
	rmSync(join(a2Migrations, "bp0003_clear_imap_deleted_on_membership_change.sql"));
	const directory = mkdtempSync(join(tmpdir(), "mailflare-imap-upgrade-"));
	const first = await install(t, { migrations: a2Migrations, directory });
	for (const [id, createdAt] of [["m-c", 300], ["m-a", 100], ["m-b2", 200], ["m-b1", 200], ["m-d", 400]]) insertMessage(first.database, { id, created_at: createdAt });
	insertMessage(first.database, { id: "s-1", direction: "outbound", status: "sent", created_at: 150 });
	assert.deepEqual(await app.applyMigrations(first.database, migrationsDirectory), ["bp0002_add_imap_mailbox_state.sql", "bp0003_clear_imap_deleted_on_membership_change.sql"], "the upgrade applies only bp0002 and bp0003");
	assert.equal(first.database.db.prepare("SELECT COUNT(*) AS n FROM imap_message_uids").get().n, 0, "the migration itself assigns nothing");

	const inbox = await imap.openImapFolder(first.env, owner, "inbox");
	assert.deepEqual(listing(inbox), [[1, "m-a"], [2, "m-b1"], [3, "m-b2"], [4, "m-c"], [5, "m-d"]], "oldest first, ties by id");
	assert.equal(inbox.uidNext, 6);
	assert.ok(Number.isInteger(inbox.uidValidity) && inbox.uidValidity > 0 && inbox.uidValidity <= 0xffffffff);
	const sent = await imap.openImapFolder(first.env, owner, "sent");
	assert.deepEqual(listing(sent), [[1, "s-1"]], "UIDs are per folder");
	assert.notEqual(sent.uidValidity, inbox.uidValidity, "folders of one mailbox get distinct UIDVALIDITY values");
	assert.deepEqual(listing(await imap.openImapFolder(first.env, owner, "inbox")), listing(inbox), "a second read changes nothing");

	first.close();
	const reopened = new app.SqliteDatabase(join(directory, "mailflare.sqlite"));
	t.after(() => reopened.db.close());
	assert.deepEqual(await app.applyMigrations(reopened, migrationsDirectory), [], "a restart applies nothing");
	const env = { ...first.env, DB: reopened };
	const again = await imap.openImapFolder(env, owner, "inbox");
	assert.deepEqual([again.uidValidity, again.uidNext, listing(again)], [inbox.uidValidity, inbox.uidNext, listing(inbox)], "same state after a restart");
});

test("UIDs are never reused: deletion leaves holes, UIDNEXT only grows, and folders allocate independently", async (t) => {
	const { database, env } = await install(t);
	for (let index = 1; index <= 4; index += 1) insertMessage(database, { id: `m-${index}`, created_at: index });
	const before = await imap.openImapFolder(env, owner, "inbox");
	assert.deepEqual(listing(before), [[1, "m-1"], [2, "m-2"], [3, "m-3"], [4, "m-4"]]);

	database.db.prepare("DELETE FROM messages WHERE id IN ('m-2', 'm-4')").run();
	const afterDelete = await imap.openImapFolder(env, owner, "inbox");
	assert.deepEqual(listing(afterDelete), [[1, "m-1"], [3, "m-3"]]);
	assert.equal(afterDelete.uidNext, 5, "deleting messages does not lower UIDNEXT");
	assert.equal(await imap.resolveImapUid(env, owner, "inbox", 4), null);

	insertMessage(database, { id: "m-5", created_at: 1 });
	const afterArrival = await imap.openImapFolder(env, owner, "inbox");
	assert.deepEqual(listing(afterArrival), [[1, "m-1"], [3, "m-3"], [5, "m-5"]], "a new message takes UIDNEXT even when older than existing ones; holes stay holes");
	assert.equal(afterArrival.uidNext, 6);
	assert.equal(afterArrival.uidValidity, before.uidValidity);

	insertMessage(database, { id: "t-1", status: "trash" });
	assert.deepEqual(listing(await imap.openImapFolder(env, owner, "trash")), [[1, "t-1"]]);
	assert.equal(await imap.ensureImapUid(env, owner, "inbox", "m-5"), 5);
	assert.equal(await imap.ensureImapUid(env, owner, "inbox", "t-1"), null);
	const resolved = await imap.resolveImapUid(env, owner, "inbox", 3);
	assert.equal(resolved.messageId, "m-3");
	for (const bad of [0, -1, 1.5, 99]) assert.equal(await imap.resolveImapUid(env, owner, "inbox", bad), null);
});

test("moves anywhere in the product expunge the old UID and assign the destination's next UID", async (t) => {
	const { database, env } = await install(t);
	for (let index = 1; index <= 3; index += 1) insertMessage(database, { id: `m-${index}`, created_at: index });
	await imap.openImapFolder(env, owner, "inbox");
	await imap.openImapFolder(env, owner, "trash");
	await imap.openImapFolder(env, owner, "f:fld-work");
	const token = await app.createSession(env, "user-a");

	// Web bulk action: file m-1 in Work.
	assert.equal((await call(app.bulkRoute, token, "/api/messages/bulk", { body: { action: "folder", folderId: "fld-work", messageIds: ["m-1"] } })).status, 200);
	assert.deepEqual(listing(await imap.openImapFolder(env, owner, "inbox")), [[2, "m-2"], [3, "m-3"]]);
	assert.deepEqual(listing(await imap.openImapFolder(env, owner, "f:fld-work")), [[1, "m-1"]]);

	// Single-message delete from the folder keeps folder_id; the message is in Trash, not Work.
	assert.equal((await call(app.statusRoute, token, "/api/messages/m-1/status", { body: { status: "trash" }, params: { messageId: "m-1" } })).status, 200);
	assert.equal(database.db.prepare("SELECT folder_id FROM messages WHERE id = 'm-1'").get().folder_id, "fld-work");
	assert.deepEqual(listing(await imap.openImapFolder(env, owner, "f:fld-work")), []);
	assert.deepEqual(listing(await imap.openImapFolder(env, owner, "trash")), [[1, "m-1"]]);

	// Restoring it returns it to Work with a new Work UID, never the old one.
	assert.equal((await call(app.statusRoute, token, "/api/messages/m-1/status", { body: { status: "received" }, params: { messageId: "m-1" } })).status, 200);
	const work = await imap.openImapFolder(env, owner, "f:fld-work");
	assert.deepEqual(listing(work), [[2, "m-1"]]);
	assert.equal(work.uidNext, 3);
	assert.deepEqual(listing(await imap.openImapFolder(env, owner, "trash")), []);

	// A move and a move back between two reads of the folder: whoever observes either state sees consistent UIDs.
	database.db.prepare("UPDATE messages SET status = 'archived' WHERE id = 'm-2'").run();
	assert.equal(await imap.resolveImapUid(env, owner, "inbox", 2), null, "observing the move releases the UID");
	database.db.prepare("UPDATE messages SET status = 'received' WHERE id = 'm-2'").run();
	assert.deepEqual(listing(await imap.openImapFolder(env, owner, "inbox")), [[3, "m-3"], [4, "m-2"]], "and the message comes back under a new UID");

	// A JMAP-style move (status + folder cleared) and the web bulk archive behave the same way.
	assert.equal((await call(app.bulkRoute, token, "/api/messages/bulk", { body: { action: "archive", messageIds: ["m-3"] } })).status, 200);
	assert.deepEqual(listing(await imap.openImapFolder(env, owner, "archive")), [[1, "m-3"]]);
	assert.deepEqual(listing(await imap.openImapFolder(env, owner, "inbox")), [[4, "m-2"]]);
});

test("visibility: received, imported, sent, drafts and snoozed mail are visible; queued, failed and deleted mail is not", async (t) => {
	const { database, env, row } = await install(t);
	insertMessage(database, { id: "in-1", created_at: 1 });
	insertMessage(database, { id: "in-snoozed", created_at: 2, snoozed_until: 4102444800 });
	insertMessage(database, { id: "imported-1", created_at: 3, raw_r2_key: "imports/x.eml" });
	insertMessage(database, { id: "draft-1", direction: "outbound", status: "draft", from_addr: "a@example.test", to_addr: "bob@elsewhere.test" });
	insertMessage(database, { id: "queued-1", direction: "outbound", status: "queued" });
	insertMessage(database, { id: "failed-1", direction: "outbound", status: "failed" });
	insertMessage(database, { id: "odd-1", status: "pending_approval" });

	assert.deepEqual(ids(await imap.openImapFolder(env, owner, "inbox")), ["in-1", "in-snoozed", "imported-1"], "snoozing does not hide mail from IMAP (as in JMAP)");
	assert.deepEqual(ids(await imap.openImapFolder(env, owner, "drafts")), ["draft-1"]);
	assert.deepEqual(ids(await imap.openImapFolder(env, owner, "sent")), [], "queued and failed sends are in no folder");
	const everywhere = [];
	for (const mailbox of await imap.listImapMailboxes(env, owner)) everywhere.push(...ids(await imap.openImapFolder(env, owner, mailbox.key)));
	for (const hidden of ["queued-1", "failed-1", "odd-1"]) assert.ok(!everywhere.includes(hidden), hidden);

	// A real send: queued (invisible) until the transport accepts it, then in Sent.
	const { messageId } = await app.sendEmail(env, { userId: "user-a", mailboxId: "mbx-a", from: "a@example.test", to: "bob@elsewhere.test", subject: "Out", text: "x" });
	assert.equal(row(messageId).status, "sent");
	assert.deepEqual(ids(await imap.openImapFolder(env, owner, "sent")), [messageId]);
	env.EMAIL = { async send() { throw new Error("provider down"); } };
	await assert.rejects(app.sendEmail(env, { userId: "user-a", mailboxId: "mbx-a", from: "a@example.test", to: "bob@elsewhere.test", subject: "Fails", text: "x" }));
	assert.deepEqual(ids(await imap.openImapFolder(env, owner, "sent")), [messageId], "a failed send never appears");

	// A queued message that later fails, then succeeds on retry: it only ever appears once sent.
	database.db.prepare("UPDATE messages SET status = 'sent', raw_r2_key = NULL WHERE id = 'failed-1'").run();
	assert.deepEqual(ids(await imap.openImapFolder(env, owner, "sent")), [messageId, "failed-1"]);

	database.db.prepare("DELETE FROM messages WHERE id = 'in-1'").run();
	assert.deepEqual(ids(await imap.openImapFolder(env, owner, "inbox")), ["in-snoozed", "imported-1"], "permanently deleted mail is gone");
});

test("flags come from product state; changes through IMAP state and through the web are the same state", async (t) => {
	const { database, env, directory, close } = await install(t);
	insertMessage(database, { id: "in-1", created_at: 1 });
	insertMessage(database, { id: "out-1", direction: "outbound", status: "sent", read: 0 });
	insertMessage(database, { id: "draft-1", direction: "outbound", status: "draft" });
	const flagsOf = async (key, uid) => (await imap.resolveImapUid(env, owner, key, uid)).flags;

	await imap.openImapFolder(env, owner, "inbox");
	assert.deepEqual(await flagsOf("inbox", 1), { seen: false, flagged: false, draft: false, deleted: false });
	assert.deepEqual(await imap.setImapMessageFlags(env, owner, "inbox", 1, { seen: true, flagged: true }), { seen: true, flagged: true, draft: false, deleted: false });
	assert.deepEqual(database.db.prepare("SELECT read, starred FROM messages WHERE id = 'in-1'").get(), { read: 1, starred: 1 }, "the product's own read and starred columns");

	const token = await app.createSession(env, "user-a");
	assert.equal((await call(app.starRoute, token, "/api/messages/in-1/star", { params: { messageId: "in-1" } })).status, 200);
	assert.equal((await call(app.bulkRoute, token, "/api/messages/bulk", { body: { action: "unread", messageIds: ["in-1"] } })).status, 200);
	assert.deepEqual(await flagsOf("inbox", 1), { seen: false, flagged: false, draft: false, deleted: false }, "web changes are visible immediately");

	await imap.openImapFolder(env, owner, "sent");
	assert.equal((await flagsOf("sent", 1)).seen, true, "outbound mail is always seen, as in JMAP");
	assert.equal((await imap.setImapMessageFlags(env, owner, "sent", 1, { seen: false })).seen, true);
	await imap.openImapFolder(env, owner, "drafts");
	assert.equal((await flagsOf("drafts", 1)).draft, true);

	assert.equal((await imap.setImapMessageFlags(env, owner, "inbox", 1, { deleted: true })).deleted, true);
	assert.equal(database.db.prepare("SELECT deleted FROM imap_message_uids WHERE message_id = 'in-1'").get().deleted, 1, "\\Deleted lives on the UID");
	assert.equal(database.db.prepare("SELECT status FROM messages WHERE id = 'in-1'").get().status, "received", "marking \\Deleted does not delete or move anything");
	assert.equal(await imap.setImapMessageFlags(env, owner, "inbox", 99, { seen: true }), null);

	close();
	const reopened = new app.SqliteDatabase(join(directory, "mailflare.sqlite"));
	t.after(() => reopened.db.close());
	const env2 = { ...env, DB: reopened };
	assert.deepEqual((await imap.resolveImapUid(env2, owner, "inbox", 1)).flags, { seen: false, flagged: false, draft: false, deleted: true }, "flags survive a restart");
	reopened.db.prepare("UPDATE messages SET status = 'archived' WHERE id = 'in-1'").run();
	const archived = await imap.openImapFolder(env2, owner, "archive");
	assert.equal(archived.messages[0].flags.deleted, false, "\\Deleted belongs to the old folder's UID and does not follow the message");
});

test("RFC822 bytes are A1's canonical representation, byte for byte, and RFC822.SIZE is their exact length", async (t) => {
	const { database, env, row } = await install(t);
	const original = "Received: from mx\r\nFrom: =?UTF-8?B?w5xtbMOkdXQ=?= <sender@elsewhere.test>\r\nTo: a@example.test\r\nSubject: =?UTF-8?Q?caf=C3=A9_=E2=9C=93?=\r\nMessage-ID: <orig@elsewhere.test>\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nexact  bytes\tünïcode ✓\r\n";
	const originalBytes = new TextEncoder().encode(original);
	await env.BUCKET.put("inbound/1.eml", originalBytes);
	insertMessage(database, { id: "in-1", raw_r2_key: "inbound/1.eml", provider_message_id: "<orig@elsewhere.test>" });
	const inbox = await imap.openImapFolder(env, owner, "inbox");
	assert.equal(inbox.messages[0].rfc822Size, null, "size is unknown until first read");
	const fetched = await imap.fetchImapMessage(env, owner, "inbox", 1);
	assert.deepEqual(fetched.bytes, originalBytes, "inbound mail is served as received");
	assert.equal(fetched.size, originalBytes.byteLength);
	assert.notEqual(fetched.size, original.length, "octets, not UTF-16 code units");
	assert.equal(fetched.source, "original");
	assert.equal(await imap.getImapMessageSize(env, owner, "inbox", 1), originalBytes.byteLength);
	assert.equal((await imap.openImapFolder(env, owner, "inbox")).messages[0].rfc822Size, originalBytes.byteLength);

	// Sent mail with an inline CID image, an attachment, Unicode and Bcc.
	const { messageId } = await app.sendEmail(env, {
		userId: "user-a", mailboxId: "mbx-a", from: "a@example.test", to: "Bob <bob@elsewhere.test>", bcc: "hidden@elsewhere.test",
		subject: "Rapport ✓ ünïcode", text: "Grüße", html: '<p>Grüße <img src="cid:logo"></p>',
		attachments: [
			{ filename: "logo.png", type: "image/png", content: PNG.buffer.slice(0), disposition: "inline", contentId: "logo" },
			{ filename: "résumé.txt", type: "text/plain", content: new TextEncoder().encode("attached ✓").buffer, disposition: "attachment" },
		],
	});
	await imap.openImapFolder(env, owner, "sent");
	const first = await imap.fetchImapMessage(env, owner, "sent", 1);
	const second = await imap.fetchImapMessage(env, owner, "sent", 1);
	assert.equal(first.messageId, messageId);
	assert.deepEqual(second.bytes, first.bytes, "identical bytes on every read");
	const stored = new Uint8Array(await (await env.BUCKET.get(row(messageId).raw_r2_key)).arrayBuffer());
	assert.deepEqual(first.bytes, stored, "exactly the stored canonical object");
	assert.equal(first.size, first.bytes.byteLength);
	assert.equal(await imap.getImapMessageSize(env, owner, "sent", 1), first.bytes.byteLength);
	const parsed = await app.PostalMime.parse(first.bytes);
	assert.equal(parsed.subject, "Rapport ✓ ünïcode");
	assert.deepEqual(parsed.bcc.map((entry) => entry.address), ["hidden@elsewhere.test"], "the sender's Sent copy keeps Bcc");
	assert.deepEqual(parsed.attachments.map((attachment) => [attachment.filename, attachment.disposition, attachment.contentId ?? null]), [["logo.png", "inline", "<logo>"], ["résumé.txt", "attachment", null]]);

	// Legacy sent mail without a copy is materialized once by A1, then stable.
	insertMessage(database, { id: "legacy-1", direction: "outbound", status: "sent", provider_message_id: "<legacy-1@mail.example.test>", subject: "Old", text_body: "old", created_at: 1790000001 });
	await imap.openImapFolder(env, owner, "sent");
	const legacy = await imap.fetchImapMessage(env, owner, "sent", 2);
	assert.equal(legacy.source, "materialized");
	const legacyAgain = await imap.fetchImapMessage(env, owner, "sent", 2);
	assert.equal(legacyAgain.source, "stored");
	assert.deepEqual(legacyAgain.bytes, legacy.bytes);

	// A stored object that is missing is refused rather than regenerated under the same UID.
	insertMessage(database, { id: "in-missing", raw_r2_key: "inbound/gone.eml", created_at: 1790000002 });
	await imap.openImapFolder(env, owner, "inbox");
	await rejectsWith(imap.fetchImapMessage(env, owner, "inbox", 2), "unavailable");
	assert.equal(await imap.fetchImapMessage(env, owner, "inbox", 9), null);
});

test("a draft's UID is bound to its content: an edit gives it a new UID, and a UID never serves different bytes", async (t) => {
	const { database, env } = await install(t);
	const token = await app.createSession(env, "user-a");
	insertMessage(database, { id: "draft-1", direction: "outbound", status: "draft", from_addr: "a@example.test", to_addr: "bob@elsewhere.test", subject: "v1", text_body: "one" });
	const drafts = await imap.openImapFolder(env, owner, "drafts");
	assert.deepEqual(listing(drafts), [[1, "draft-1"]]);
	assert.match(database.db.prepare("SELECT draft_fingerprint FROM imap_message_uids").get().draft_fingerprint, /^[0-9a-f]{32}$/);
	const v1 = await imap.fetchImapMessage(env, owner, "drafts", 1);
	assert.equal((await app.PostalMime.parse(v1.bytes)).subject, "v1");
	assert.deepEqual((await imap.fetchImapMessage(env, owner, "drafts", 1)).bytes, v1.bytes, "an unchanged draft is stable");

	const patch = await call(app.patchDraft, token, "/api/drafts/draft-1", { method: "PATCH", params: { id: "draft-1" }, body: { mailboxId: "mbx-a", from: "a@example.test", to: "bob@elsewhere.test", subject: "v2", text: "two" } });
	assert.equal(patch.status, 200);
	assert.equal(await imap.fetchImapMessage(env, owner, "drafts", 1), null, "the old UID no longer names anything");
	const after = await imap.openImapFolder(env, owner, "drafts");
	assert.deepEqual(listing(after), [[2, "draft-1"]]);
	assert.equal((await app.PostalMime.parse((await imap.fetchImapMessage(env, owner, "drafts", 2)).bytes)).subject, "v2");

	// An edit that bypasses the web hooks (an attachment added directly) is still noticed.
	await env.BUCKET.put("attachments/draft-1/a1", new TextEncoder().encode("new"));
	database.db.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES ('att-1', 'draft-1', 'added.txt', 'text/plain', 3, 'attachment', 'attachments/draft-1/a1', 1)").run();
	assert.equal(await imap.resolveImapUid(env, owner, "drafts", 2), null);
	assert.deepEqual(listing(await imap.openImapFolder(env, owner, "drafts")), [[3, "draft-1"]]);

	// A draft's stored object replaced behind the UID (same content, new object) is also a new UID.
	await imap.fetchImapMessage(env, owner, "drafts", 3);
	database.db.prepare("UPDATE messages SET raw_r2_key = NULL WHERE id = 'draft-1'").run();
	assert.equal(await imap.fetchImapMessage(env, owner, "drafts", 3), null, "re-materialized bytes are never served under the old UID");
	assert.deepEqual(listing(await imap.openImapFolder(env, owner, "drafts")), [[4, "draft-1"]], "the next sync gives it a new UID");
	assert.ok((await imap.fetchImapMessage(env, owner, "drafts", 4)).size > 0);

	// Deleting the draft (web DELETE) expunges it for good.
	insertMessage(database, { id: "draft-2", direction: "outbound", status: "draft" });
	const listed = await imap.openImapFolder(env, owner, "drafts");
	assert.deepEqual(ids(listed), ["draft-1", "draft-2"]);
	assert.equal((await call(app.deleteDraft, token, "/api/drafts/draft-2", { method: "DELETE", params: { id: "draft-2" } })).status, 200);
	assert.deepEqual(ids(await imap.openImapFolder(env, owner, "drafts")), ["draft-1"]);
});

test("shared mailboxes: every authorized user sees the same state, rights follow the permission, revocation is immediate", async (t) => {
	const { database, env } = await install(t);
	insertMessage(database, { id: "s-in", mailbox_id: "mbx-s", created_at: 1 });
	const { messageId } = await app.sendEmail(env, { userId: "user-a", mailboxId: "mbx-s", from: "sales@example.test", to: "client@elsewhere.test", bcc: "boss@elsewhere.test", subject: "Quote", text: "q" });

	const views = {};
	for (const user of ["user-a", "user-b", "user-c", "user-d"]) views[user] = await imap.openImapFolder(env, salesAs(user), "inbox");
	for (const user of ["user-b", "user-c", "user-d"]) assert.deepEqual([views[user].uidValidity, listing(views[user])], [views["user-a"].uidValidity, listing(views["user-a"])], user);

	// Read-only: may read and change seen/flagged (as in the web app), not \Deleted. Lacking a
	// permission is `denied` (the session goes on), never `forbidden` (access revoked).
	assert.equal((await imap.setImapMessageFlags(env, salesAs("user-b"), "inbox", 1, { seen: true })).seen, true);
	await rejectsWith(imap.setImapMessageFlags(env, salesAs("user-b"), "inbox", 1, { deleted: true }), "denied");
	assert.equal((await imap.setImapMessageFlags(env, salesAs("user-d"), "inbox", 1, { deleted: true })).deleted, true);

	// Bcc policy: read access to a mailbox includes its complete Sent copies, as in /original, the message API and JMAP.
	await imap.openImapFolder(env, salesAs("user-a"), "sent");
	const ownerCopy = await imap.fetchImapMessage(env, salesAs("user-a"), "sent", 1);
	const readerCopy = await imap.fetchImapMessage(env, salesAs("user-b"), "sent", 1);
	assert.equal(readerCopy.messageId, messageId);
	assert.deepEqual(readerCopy.bytes, ownerCopy.bytes, "one canonical representation for every reader");
	assert.deepEqual((await app.PostalMime.parse(readerCopy.bytes)).bcc.map((entry) => entry.address), ["boss@elsewhere.test"]);

	// Revocation, account disablement and the sharing feature switch take effect on the next call.
	database.db.prepare("DELETE FROM mailbox_access WHERE id = 'acc-b'").run();
	await rejectsWith(imap.openImapFolder(env, salesAs("user-b"), "inbox"), "forbidden");
	await rejectsWith(imap.fetchImapMessage(env, salesAs("user-b"), "sent", 1), "forbidden");
	database.db.prepare("UPDATE users SET disabled = 1 WHERE id = 'user-c'").run();
	await rejectsWith(imap.resolveImapUid(env, salesAs("user-c"), "inbox", 1), "forbidden");
	process.env.BLUEPINE_DISABLED_FEATURES = "sharedMailboxes";
	try {
		await rejectsWith(imap.listImapMailboxes(env, salesAs("user-d")), "forbidden");
		assert.ok(await imap.openImapFolder(env, salesAs("user-a"), "inbox"), "the owner keeps access");
	} finally {
		delete process.env.BLUEPINE_DISABLED_FEATURES;
	}
	database.db.prepare("UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-s'").run();
	await rejectsWith(imap.openImapFolder(env, salesAs("user-a"), "inbox"), "forbidden");

	// A named app password must still exist, belong to this user and mailbox, and carry the imap scope.
	database.db.exec(`
		INSERT INTO mail_app_passwords (id, user_id, mailbox_id, label, public_id, secret_hash, scopes, created_at) VALUES
			('map-imap', 'user-a', 'mbx-a', 'phone', 'pub1', 'h1', '["imap"]', 1),
			('map-smtp', 'user-a', 'mbx-a', 'relay', 'pub2', 'h2', '["smtp"]', 1);
	`);
	assert.ok(await imap.listImapMailboxes(env, { ...owner, appPasswordId: "map-imap" }));
	await rejectsWith(imap.listImapMailboxes(env, { ...owner, appPasswordId: "map-smtp" }), "forbidden");
	await rejectsWith(imap.listImapMailboxes(env, { userId: "user-a", mailboxId: "mbx-s", appPasswordId: "map-imap" }), "forbidden");
	database.db.prepare("DELETE FROM mail_app_passwords WHERE id = 'map-imap'").run();
	await rejectsWith(imap.openImapFolder(env, { ...owner, appPasswordId: "map-imap" }, "inbox"), "forbidden");

	// No access at all, and no reach into another mailbox's state.
	await rejectsWith(imap.openImapFolder(env, { userId: "user-x", mailboxId: "mbx-a" }, "inbox"), "forbidden");
	await rejectsWith(imap.openImapFolder(env, { userId: "user-b", mailboxId: "mbx-a" }, "inbox"), "forbidden");
});

test("concurrent first reads and deliveries in one process never duplicate or reuse a UID", async (t) => {
	const { database, env } = await install(t);
	for (let index = 0; index < 1200; index += 1) insertMessage(database, { id: `m-${String(index).padStart(4, "0")}`, created_at: 1000 + (index % 97) });
	const expected = database.db.prepare("SELECT id FROM messages ORDER BY created_at, id").all().map((row) => row.id);
	const snapshots = await Promise.all(Array.from({ length: 6 }, () => imap.openImapFolder(env, owner, "inbox")));
	for (const snapshot of snapshots) {
		assert.deepEqual(ids(snapshot), expected, "the whole folder, in created_at/id order");
		assert.deepEqual(snapshot.messages.map((entry) => entry.uid), expected.map((_, index) => index + 1));
		assert.equal(snapshot.uidNext, 1201);
	}

	const work = [];
	for (let index = 0; index < 60; index += 1) {
		work.push((async () => {
			insertMessage(database, { id: `n-${index}`, created_at: 5000 });
			return imap.ensureImapUid(env, owner, "inbox", `n-${index}`);
		})());
		if (index % 5 === 0) work.push(imap.openImapFolder(env, owner, "inbox").then(() => null));
		if (index % 7 === 0) work.push((async () => { database.db.prepare("DELETE FROM messages WHERE id = ?").run(expected[index]); return null; })());
	}
	const assigned = (await Promise.all(work)).filter((uid) => uid !== null);
	assert.equal(assigned.length, 60);
	assert.equal(new Set(assigned).size, 60);
	assert.ok(assigned.every((uid) => uid > 1200));
	const final = await imap.openImapFolder(env, owner, "inbox");
	const uids = final.messages.map((entry) => entry.uid);
	assert.deepEqual(uids, [...uids].sort((a, b) => a - b));
	assert.equal(new Set(uids).size, uids.length);
	assert.equal(final.uidNext, 1261);
	assert.equal(final.messages.length, 1200 + 60 - 9);
});

test("separate connections allocating and deleting in parallel threads keep UIDs unique, stable and monotonic", async (t) => {
	const { database, env, directory } = await install(t);
	for (let index = 0; index < 50; index += 1) insertMessage(database, { id: `seed-${index}`, created_at: index });
	await imap.openImapFolder(env, owner, "inbox");
	const workerFile = join(bundleDirectory, "imap-worker.mjs");
	writeFileSync(workerFile, `
		import { workerData, parentPort } from "node:worker_threads";
		const app = await import(workerData.entryUrl);
		const database = new app.SqliteDatabase(workerData.file);
		const env = { DB: database };
		const principal = { userId: "user-a", mailboxId: "mbx-a" };
		const observations = [];
		for (let round = 0; round < workerData.rounds; round += 1) {
			const id = "w" + workerData.worker + "-" + round;
			database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES (?, 'user-a', 'mbx-a', 'inbound', 's@x', 'a@example.test', 'received', ?)").run(id, 100 + round);
			if (round % 4 === 3) database.db.prepare("UPDATE messages SET status = 'trash' WHERE id = ?").run("seed-" + (workerData.worker * 10 + round % 10));
			const uid = await app.imap.ensureImapUid(env, principal, "inbox", id);
			const snapshot = await app.imap.openImapFolder(env, principal, "inbox");
			observations.push({ id, uid, uidNext: snapshot.uidNext, entries: snapshot.messages.map((entry) => [entry.uid, entry.messageId]) });
			await app.imap.openImapFolder(env, principal, "trash");
		}
		database.db.close();
		parentPort.postMessage(observations);
	`);
	const file = join(directory, "mailflare.sqlite");
	const results = await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise((resolve, reject) => {
		const thread = new Worker(workerFile, { workerData: { entryUrl, file, worker, rounds: 30 } });
		thread.once("message", resolve);
		thread.once("error", reject);
	})));

	const uidOwner = new Map();
	const messageUid = new Map();
	for (const observations of results) {
		let lastUidNext = 0;
		for (const observation of observations) {
			assert.ok(observation.uid > 50, "new mail gets UIDs above the initial ones");
			assert.ok(observation.uidNext >= lastUidNext, "UIDNEXT never goes backwards");
			lastUidNext = observation.uidNext;
			const uids = observation.entries.map(([uid]) => uid);
			assert.deepEqual(uids, [...uids].sort((a, b) => a - b));
			assert.ok(uids.every((uid) => uid < observation.uidNext));
			for (const [uid, messageId] of observation.entries) {
				assert.equal(uidOwner.get(uid) ?? messageId, messageId, `UID ${uid} named two messages`);
				uidOwner.set(uid, messageId);
				assert.equal(messageUid.get(messageId) ?? uid, uid, `${messageId} held two UIDs`);
				messageUid.set(messageId, uid);
			}
		}
	}
	const final = await imap.openImapFolder(env, owner, "inbox");
	assert.equal(final.messages.length, database.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = 'mbx-a' AND status = 'received' AND folder_id IS NULL").get().n);
	assert.equal(new Set(final.messages.map((entry) => entry.uid)).size, final.messages.length);
	const trash = await imap.openImapFolder(env, owner, "trash");
	assert.equal(new Set(trash.messages.map((entry) => entry.uid)).size, trash.messages.length);
	assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM imap_message_uids GROUP BY imap_folder_id, message_id HAVING n > 1").all().length, 0);
});

test("allocation is all-or-nothing, and the database itself forbids lowering UIDNEXT or UIDVALIDITY and reassigning a UID", async (t) => {
	const { database, env } = await install(t);
	insertMessage(database, { id: "m-1", created_at: 1 });
	const first = await imap.openImapFolder(env, owner, "inbox");
	const folderId = database.db.prepare("SELECT id FROM imap_folders WHERE folder_key = 'inbox'").get().id;

	database.db.prepare("UPDATE imap_folders SET uid_next = 4294967295 WHERE id = ?").run(folderId);
	insertMessage(database, { id: "m-2", created_at: 2 });
	insertMessage(database, { id: "m-3", created_at: 3 });
	await assert.rejects(imap.openImapFolder(env, owner, "inbox"), (error) => /CHECK constraint failed/.test(String(error.cause?.message ?? error.message)), "the second UID would exceed 2^32-1, so the statement fails");
	assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM imap_message_uids WHERE imap_folder_id = ?").get(folderId).n, 1, "and assigns neither");
	assert.equal(database.db.prepare("SELECT uid_next FROM imap_folders WHERE id = ?").get(folderId).uid_next, 4294967295, "UIDNEXT is untouched by the rolled-back statement");

	assert.throws(() => database.db.prepare("UPDATE imap_folders SET uid_next = 2 WHERE id = ?").run(folderId), /cannot decrease/);
	assert.throws(() => database.db.prepare("UPDATE imap_folders SET uid_validity = uid_validity - 1 WHERE id = ?").run(folderId), /cannot decrease/);
	assert.throws(() => database.db.prepare("UPDATE imap_message_uids SET uid = 7").run(), /cannot be reassigned/);
	assert.throws(() => database.db.prepare("UPDATE imap_message_uids SET message_id = 'm-2'").run(), /cannot be reassigned/);
	assert.throws(() => database.db.prepare("INSERT INTO imap_message_uids (imap_folder_id, uid, message_id, created_at) VALUES (?, 1, 'm-2', 1)").run(folderId), /UNIQUE|PRIMARY/);
	assert.throws(() => database.db.prepare("INSERT INTO imap_message_uids (imap_folder_id, uid, message_id, created_at) VALUES (?, 5, 'm-1', 1)").run(folderId), /UNIQUE/);
	assert.equal(first.uidNext, 2);
});

test("backups: same-state restores keep UID state; restores over diverged or pre-A3 state raise UIDVALIDITY; nothing is reused", async (t) => {
	const { database, env } = await install(t);
	for (let index = 1; index <= 3; index += 1) insertMessage(database, { id: `m-${index}`, created_at: index });
	insertMessage(database, { id: "s-1", direction: "outbound", status: "sent" });
	const inbox = await imap.openImapFolder(env, owner, "inbox");
	const sent = await imap.openImapFolder(env, owner, "sent");
	await imap.setImapMessageFlags(env, owner, "inbox", 2, { deleted: true });
	const document = await app.exportDatabaseRecords(env.DB);
	const parsed = JSON.parse(new TextDecoder().decode(document));
	assert.equal(parsed.tables.imap_folders.length, 2);
	assert.equal(parsed.tables.imap_message_uids.length, 4);
	assert.ok(!parsed.includedTables.includes("imap_folders") && !parsed.includedTables.includes("imap_message_uids"), "downstream tables stay out of includedTables, so upstream and A2 builds accept the backup");

	// Disaster recovery into a new installation: everything preserved, allocation continues after it.
	const fresh = await install(t, { seeded: false });
	await app.restoreDatabaseRecords(fresh.env.DB, bufferOf(document));
	const restored = await imap.openImapFolder(fresh.env, owner, "inbox");
	assert.deepEqual([restored.uidValidity, restored.uidNext, listing(restored)], [inbox.uidValidity, inbox.uidNext, listing(inbox)]);
	assert.equal(restored.messages[1].flags.deleted, true);
	insertMessage(fresh.database, { id: "m-new", created_at: 0 });
	assert.deepEqual(listing(await imap.openImapFolder(fresh.env, owner, "inbox")).at(-1), [4, "m-new"], "no UID reuse after restore");

	// Restoring over the same, unchanged installation: preserved.
	await app.restoreDatabaseRecords(env.DB, bufferOf(document));
	const same = await imap.openImapFolder(env, owner, "inbox");
	assert.deepEqual([same.uidValidity, same.uidNext, listing(same)], [inbox.uidValidity, inbox.uidNext, listing(inbox)]);

	// State moved on after the backup (a UID was assigned and one expunged); restoring it back invalidates that folder only.
	insertMessage(database, { id: "m-4", created_at: 4 });
	database.db.prepare("DELETE FROM messages WHERE id = 'm-1'").run();
	const moved = await imap.openImapFolder(env, owner, "inbox");
	assert.deepEqual(listing(moved), [[2, "m-2"], [3, "m-3"], [4, "m-4"]]);
	await app.restoreDatabaseRecords(env.DB, bufferOf(document));
	const rolledBack = await imap.openImapFolder(env, owner, "inbox");
	assert.ok(rolledBack.uidValidity > moved.uidValidity, "UIDVALIDITY rises, so clients that saw UID 4 or the expunge of UID 1 resynchronize");
	assert.deepEqual(listing(rolledBack), listing(inbox));
	assert.equal((await imap.openImapFolder(env, owner, "sent")).uidValidity, sent.uidValidity, "an unchanged folder keeps its UIDVALIDITY");

	// An A2 (pre-bp0002) backup carries no IMAP state: folders clients knew are re-initialized under a higher UIDVALIDITY.
	const a2Document = { ...parsed, tables: { ...parsed.tables } };
	delete a2Document.tables.imap_folders;
	delete a2Document.tables.imap_message_uids;
	const beforeA2 = await imap.openImapFolder(env, owner, "inbox");
	await app.restoreDatabaseRecords(env.DB, new TextEncoder().encode(JSON.stringify(a2Document)).buffer);
	assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM imap_message_uids").get().n, 0);
	const reinitialized = await imap.openImapFolder(env, owner, "inbox");
	assert.ok(reinitialized.uidValidity > beforeA2.uidValidity);
	assert.deepEqual(listing(reinitialized), [[1, "m-1"], [2, "m-2"], [3, "m-3"]]);
	assert.ok((await imap.openImapFolder(env, owner, "sent")).uidValidity > sent.uidValidity);

	// An A2 backup into a new A3 installation simply initializes on first read.
	const freshA2 = await install(t, { seeded: false });
	await app.restoreDatabaseRecords(freshA2.env.DB, new TextEncoder().encode(JSON.stringify(a2Document)).buffer);
	assert.equal(freshA2.database.db.prepare("SELECT COUNT(*) AS n FROM imap_folders").get().n, 0);
	assert.deepEqual(listing(await imap.openImapFolder(freshA2.env, owner, "inbox")), [[1, "m-1"], [2, "m-2"], [3, "m-3"]]);

	// Canonical references survive, so restored UIDs serve the same bytes.
	await env.BUCKET.put("inbound/r.eml", new TextEncoder().encode("From: a@b\r\n\r\nx\r\n"));
	database.db.prepare("UPDATE messages SET raw_r2_key = 'inbound/r.eml' WHERE id = 'm-3'").run();
	const beforeBytes = await imap.fetchImapMessage(env, owner, "inbox", 3);
	const withRef = await app.exportDatabaseRecords(env.DB);
	await app.restoreDatabaseRecords(env.DB, bufferOf(withRef));
	assert.deepEqual((await imap.fetchImapMessage(env, owner, "inbox", 3)).bytes, beforeBytes.bytes);
	assert.equal((await imap.resolveImapUid(env, owner, "inbox", 3)).rfc822Size, beforeBytes.size);
});

test("custom folders: rename keeps identity, deletion releases its UIDs, and a recreated folder gets a higher UIDVALIDITY", async (t) => {
	const { database, env } = await install(t);
	insertMessage(database, { id: "m-1", folder_id: "fld-work" });
	const work = await imap.openImapFolder(env, owner, "f:fld-work");
	database.db.prepare("UPDATE folders SET name = 'Clients' WHERE id = 'fld-work'").run();
	const renamed = await imap.openImapFolder(env, owner, "f:fld-work");
	assert.equal(renamed.mailbox.name, "Clients");
	assert.deepEqual([renamed.uidValidity, listing(renamed)], [work.uidValidity, listing(work)]);

	database.db.prepare("DELETE FROM folders WHERE id = 'fld-work'").run();
	assert.equal(database.db.prepare("SELECT folder_id FROM messages WHERE id = 'm-1'").get().folder_id, null, "the product returns its mail to the inbox");
	const list = await imap.listImapMailboxes(env, owner);
	assert.ok(!list.some((mailbox) => mailbox.key === "f:fld-work"));
	assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key = 'f:fld-work'").get().n, 0);
	await rejectsWith(imap.openImapFolder(env, owner, "f:fld-work"), "nonexistent");
	assert.deepEqual(ids(await imap.openImapFolder(env, owner, "inbox")), ["m-1"]);

	database.db.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-work-2', 'user-a', 'mbx-a', 'Clients', 2)").run();
	const recreated = await imap.openImapFolder(env, owner, "f:fld-work-2");
	assert.equal(recreated.mailbox.name, "Clients");
	assert.ok(recreated.uidValidity > work.uidValidity, "the same name never comes back with a UIDVALIDITY a client may have cached");
});
