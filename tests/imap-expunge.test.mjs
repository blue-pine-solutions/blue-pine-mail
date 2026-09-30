import assert from "node:assert/strict";
import test from "node:test";
import { assertTagged, fetchAttributes, install, loadApp, memoryClient } from "./support/imap-harness.mjs";

/**
 * A5.2a: writable \Deleted and recoverable EXPUNGE / CLOSE, over the real A2 verifier, A3
 * state, bp0003 trigger and product routes (SQLite + file bucket).
 *
 * - \Deleted is imap_message_uids.deleted; only management access may set it, not in Trash
 *   or Drafts, and only while bp0003's trigger exists.
 * - EXPUNGE and CLOSE move \Deleted messages to Trash in one atomic batch per chunk. Nothing
 *   is ever deleted: rows, bytes, attachments, read/starred and dates stay.
 * - bp0003 clears a message's \Deleted marks whenever its folder membership changes.
 */
const { app, cleanup } = await loadApp("imap-expunge");
test.after(cleanup);

const BASE = "http://mailflare.local";
const TRIGGER = "bp_imap_membership_clears_deleted";
const texts = (result) => result.untagged.map((unit) => unit.text);
const SHARED = { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" };

async function connect(context, { userId = "user-a", mailboxId = "mbx-a", address = "a@example.test" } = {}) {
	const { client, session, start } = memoryClient(app, context.env);
	await start();
	const { credential, id } = await context.credential(userId, mailboxId);
	assertTagged(await client.login(address, credential), "OK");
	return { client, session, credentialId: id };
}

async function setup(t, account) {
	const context = await install(app, t);
	return { ...context, ...(await connect(context, account)) };
}

async function web(context, handler, path, { body, userId = "user-a" } = {}) {
	const token = await app.createSession(context.env, userId);
	const request = new Request(`${BASE}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const response = await handler(request);
	assert.equal(response.status, 200, `${path} answered ${response.status}`);
}
const bulk = (context, messageIds, action, extra = {}) => web(context, app.bulkRoute, "/api/messages/bulk", { body: { messageIds, action, ...extra } });

async function deliverMany(context, ids, values) {
	for (const id of ids) await context.deliver(id, `Subject: ${id}\r\n\r\nbody of ${id}\r\n`, values);
}

const sql = (context, query, ...params) => context.database.db.prepare(query).all(...params);
const one = (context, query, ...params) => context.database.db.prepare(query).get(...params);
const mapping = (context, messageId) => sql(context, "SELECT f.folder_key AS folder, u.uid, u.deleted FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE u.message_id = ? ORDER BY f.folder_key", messageId);
const uidNext = (context, key, mailboxId = "mbx-a") => one(context, "SELECT uid_next FROM imap_folders WHERE mailbox_id = ? AND folder_key = ?", mailboxId, key)?.uid_next;
const productState = (context) => JSON.stringify([
	sql(context, "SELECT id, status, read, starred, folder_id, raw_r2_key, created_at FROM messages ORDER BY id"),
	sql(context, "SELECT imap_folder_id, uid, message_id, deleted FROM imap_message_uids ORDER BY imap_folder_id, uid"),
	sql(context, "SELECT id, uid_next, uid_validity FROM imap_folders ORDER BY id"),
]);

/**
 * The A5.2a safety invariants, checked after every scenario: no message was deleted, its
 * bytes are still stored, no message holds two UIDs in the folder it is in, and no Trash
 * UID created by an expunge carries \Deleted.
 */
async function assertInvariants(context, expectedMessages) {
	const rows = sql(context, "SELECT id, raw_r2_key FROM messages ORDER BY id");
	if (expectedMessages !== undefined) assert.equal(rows.length, expectedMessages, "no message row was deleted");
	for (const row of rows) if (row.raw_r2_key) assert.ok(await context.env.BUCKET.get(row.raw_r2_key), `stored bytes of ${row.id} still exist`);
	assert.deepEqual(sql(context, "SELECT imap_folder_id, message_id, COUNT(*) AS n FROM imap_message_uids GROUP BY imap_folder_id, message_id HAVING n > 1"), [], "one UID per message per folder");
	assert.deepEqual(sql(context, "SELECT imap_folder_id, uid, COUNT(*) AS n FROM imap_message_uids GROUP BY imap_folder_id, uid HAVING n > 1"), [], "UIDs are unique per folder");
	assert.deepEqual(sql(context, "SELECT u.uid FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key IN ('trash', 'drafts') AND u.deleted = 1"), [], "nothing in Trash or Drafts is marked \\Deleted");
}

/** Run `hook` right before the next `count`-th D1 batch whose SQL matches `pattern` executes. */
function beforeBatch(context, pattern, hook, count = 1) {
	const database = context.database;
	const original = database.batch;
	let seen = 0;
	database.batch = async function (statements) {
		const text = statements.map((statement) => statement.sql ?? "").join("\n");
		if (pattern.test(text) && ++seen === count) {
			database.batch = original;
			await hook();
		}
		return original.call(this, statements);
	};
	return () => (database.batch = original);
}
/** Run `hook` right after the next D1 batch whose SQL matches `pattern` has committed. */
function afterBatch(context, pattern, hook) {
	const database = context.database;
	const original = database.batch;
	database.batch = async function (statements) {
		const result = await original.call(this, statements);
		if (pattern.test(statements.map((statement) => statement.sql ?? "").join("\n"))) {
			database.batch = original;
			await hook();
		}
		return result;
	};
}
const RELOCATION = /UPDATE messages SET status/;
/** Create the Trash state row first, as any earlier Trash read would, so snapshots compare only what a command changes. */
const openTrash = (context, mailboxId = "mbx-a") => app.imap.openImapFolder(context.env, { userId: "user-a", mailboxId }, "trash");

// ---- bp0003: \Deleted cleared on membership change ------------------------------------------

test("bp0003: status, folder and mailbox changes clear pending \\Deleted marks; read and starred changes do not", async (t) => {
	const context = await install(app, t);
	const { db } = context.database;
	await deliverMany(context, ["m-1"]);
	db.exec("INSERT INTO imap_folders (id, mailbox_id, folder_key, uid_validity, uid_next, created_at) VALUES ('F-in', 'mbx-a', 'inbox', 10, 1, 1), ('F-ar', 'mbx-a', 'archive', 11, 1, 1)");
	const mark = () => db.prepare("INSERT OR REPLACE INTO imap_message_uids (imap_folder_id, uid, message_id, deleted, created_at) VALUES ('F-in', 1, 'm-1', 1, 1)").run();
	const deleted = () => one(context, "SELECT deleted FROM imap_message_uids WHERE imap_folder_id = 'F-in' AND uid = 1").deleted;
	const cases = [
		["read only", "UPDATE messages SET read = 1 WHERE id = 'm-1'", 1],
		["starred only", "UPDATE messages SET starred = 1 WHERE id = 'm-1'", 1],
		["snooze and subject", "UPDATE messages SET snoozed_until = 5, subject = 'x' WHERE id = 'm-1'", 1],
		["status written to the same value", "UPDATE messages SET status = 'received', folder_id = NULL WHERE id = 'm-1'", 1],
		["status change", "UPDATE messages SET status = 'archived' WHERE id = 'm-1'", 0],
		["status change back", "UPDATE messages SET status = 'received' WHERE id = 'm-1'", 0],
		["folder change", "UPDATE messages SET folder_id = 'fld-work' WHERE id = 'm-1'", 0],
		["folder cleared", "UPDATE messages SET folder_id = NULL WHERE id = 'm-1'", 0],
		["mailbox change", "UPDATE messages SET mailbox_id = 'mbx-s' WHERE id = 'm-1'", 0],
		["mailbox change back", "UPDATE messages SET mailbox_id = 'mbx-a' WHERE id = 'm-1'", 0],
	];
	for (const [name, statement, expected] of cases) {
		mark();
		db.exec(statement);
		assert.equal(deleted(), expected, name);
	}
	// Every mapping of the message is cleared, whichever folder it is in.
	db.exec("INSERT INTO imap_message_uids (imap_folder_id, uid, message_id, deleted, created_at) VALUES ('F-ar', 1, 'm-1', 1, 1)");
	mark();
	db.exec("UPDATE messages SET status = 'spam' WHERE id = 'm-1'");
	assert.deepEqual(sql(context, "SELECT deleted FROM imap_message_uids WHERE message_id = 'm-1'"), [{ deleted: 0 }, { deleted: 0 }]);
	// Other messages are untouched.
	await deliverMany(context, ["m-2"]);
	db.exec("INSERT INTO imap_message_uids (imap_folder_id, uid, message_id, deleted, created_at) VALUES ('F-in', 2, 'm-2', 1, 1)");
	db.exec("UPDATE messages SET status = 'trash' WHERE id = 'm-1'");
	assert.equal(one(context, "SELECT deleted FROM imap_message_uids WHERE message_id = 'm-2'").deleted, 1);
});

test("bp0003: deleting a custom folder (folder_id set to NULL by its foreign key) clears the old \\Deleted mark", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["w-1"], { folder_id: "fld-work" });
	await context.client.command("SELECT Work");
	assertTagged(await context.client.command("STORE 1 +FLAGS (\\Deleted)"), "OK");
	assert.deepEqual(mapping(context, "w-1"), [{ folder: "f:fld-work", uid: 1, deleted: 1 }]);
	context.database.db.prepare("DELETE FROM folders WHERE id = 'fld-work'").run();
	assert.equal(context.row("w-1").folder_id, null);
	assert.equal(mapping(context, "w-1")[0].deleted, 0, "the mark is cleared by the folder_id change");
	const other = await connect(context);
	await other.client.command("SELECT INBOX");
	const fetched = await other.client.command("FETCH 1 (FLAGS)");
	assert.deepEqual(fetched.untagged.map((unit) => fetchAttributes(unit.text).FLAGS), [[]], "the message is in INBOX, not \\Deleted");
	assert.equal((await context.client.command("NOOP")).untagged.at(-1).text, "* BYE Selected mailbox no longer exists");
	await assertInvariants(context, 1);
});

test("bp0003: a message that leaves INBOX and comes back before any IMAP sync does not resurrect its old \\Deleted mark", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	assertTagged(await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)"), "OK");
	await context.client.command("LOGOUT");
	// The web app archives it and brings it back; nothing reads INBOX over IMAP meanwhile.
	await bulk(context, ["m-1"], "archive");
	await bulk(context, ["m-1"], "inbox");
	assert.deepEqual(mapping(context, "m-1"), [{ folder: "inbox", uid: 1, deleted: 0 }], "the UID nobody saw leave is kept, without its mark");
	const again = await connect(context);
	await again.client.command("SELECT INBOX");
	assert.deepEqual((await again.client.command("FETCH 1:* (UID FLAGS)")).untagged.map((unit) => fetchAttributes(unit.text).FLAGS), [[], []]);
	assertTagged(await again.client.command("EXPUNGE"), "OK");
	assert.equal(context.row("m-1").status, "received", "EXPUNGE does not act on the stale mark");
	await assertInvariants(context, 2);
});

// ---- Permanent flags and STORE \Deleted -------------------------------------------------------

test("a5.2a/a5.2c: PERMANENTFLAGS include \\Deleted for a manager in every folder, Trash and Drafts included (A5.2c); readers and EXAMINE never get it", async (t) => {
	const context = await setup(t);
	const permanent = (result) => texts(result).find((line) => line.startsWith("* OK [PERMANENTFLAGS"));
	for (const folder of ["INBOX", "Work", "Archive", "Spam", "Sent", "Trash", "Drafts"]) {
		const result = await context.client.command(`SELECT ${folder}`);
		assertTagged(result, "OK", /\[READ-WRITE\]/);
		assert.equal(permanent(result), "* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Deleted)] Flags permitted", folder);
	}
	assert.equal(permanent(await context.client.command("EXAMINE INBOX")), "* OK [PERMANENTFLAGS ()] Read-only mailbox");
	const reader = await connect(context, SHARED);
	assert.equal(permanent(await reader.client.command("SELECT INBOX")), "* OK [PERMANENTFLAGS (\\Seen \\Flagged)] Flags permitted");
	const capability = texts(await context.client.command("CAPABILITY"))[0];
	assert.equal(capability, "* CAPABILITY IMAP4rev1 ID NAMESPACE UNSELECT SPECIAL-USE MOVE UIDPLUS IDLE", "MOVE (A5.2b), UIDPLUS (A5.3), IDLE (A5.4) and nothing else new (A5.2c adds no capability)");
});

test("a5.2a: STORE \\Deleted with +FLAGS, -FLAGS, FLAGS and .SILENT; it persists across reconnects and is seen by a second session", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3"]);
	const watcher = await connect(context);
	await watcher.client.command("SELECT INBOX");
	await context.client.command("SELECT INBOX");
	const before = { read: context.row("m-1").read, starred: context.row("m-1").starred };
	assert.deepEqual(texts(await context.client.command("STORE 1 +FLAGS (\\Deleted)")), ["* 1 FETCH (FLAGS (\\Deleted))"]);
	assert.deepEqual({ read: context.row("m-1").read, starred: context.row("m-1").starred }, before, "\\Deleted does not touch read or starred");
	assert.equal(context.row("m-1").status, "received", "marking moves nothing");
	assert.deepEqual(texts(await context.client.command("UID STORE 2 +FLAGS.SILENT (\\Seen \\Deleted)")), [], ".SILENT reports nothing when the result is as asked");
	assert.deepEqual(mapping(context, "m-2"), [{ folder: "inbox", uid: 2, deleted: 1 }]);
	assert.equal(context.row("m-2").read, 1);
	assert.deepEqual(texts(await context.client.command("STORE 2 -FLAGS (\\Deleted)")), ["* 2 FETCH (FLAGS (\\Seen))"]);
	assert.deepEqual(texts(await context.client.command("STORE 3 FLAGS (\\Flagged \\Deleted)")), ["* 3 FETCH (FLAGS (\\Flagged \\Deleted))"]);
	assert.deepEqual(texts(await context.client.command("STORE 3 FLAGS (\\Flagged)")), ["* 3 FETCH (FLAGS (\\Flagged))"], "a replace clears \\Deleted for a manager");
	assertTagged(await context.client.command("STORE 3 +FLAGS (\\Deleted)"), "OK");
	// Another session sees the change on its next command.
	const noop = await watcher.client.command("NOOP");
	assert.deepEqual(texts(noop).sort(), ["* 1 FETCH (FLAGS (\\Deleted))", "* 2 FETCH (FLAGS (\\Seen))", "* 3 FETCH (FLAGS (\\Flagged \\Deleted))"]);
	// A new connection reads it back from storage.
	const later = await connect(context);
	await later.client.command("SELECT INBOX");
	assert.deepEqual((await later.client.command("FETCH 1:3 (FLAGS)")).untagged.map((unit) => fetchAttributes(unit.text).FLAGS), [["\\Deleted"], ["\\Seen"], ["\\Flagged", "\\Deleted"]]);
	assert.deepEqual((await app.imap.openImapFolder(context.env, { userId: "user-a", mailboxId: "mbx-a" }, "inbox")).messages.map((entry) => entry.flags.deleted), [true, false, true]);
	assert.equal((await app.imap.getImapFolderStatus(context.env, { userId: "user-a", mailboxId: "mbx-a" }, "inbox")).deleted, 2);
	await assertInvariants(context, 3);
});

test("a5.2a: a reader's STORE naming \\Deleted is NO [NOPERM] and writes nothing, not even the \\Seen it also named; its FLAGS replace never touches \\Deleted", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["s-1", "s-2"], { mailbox_id: "mbx-s" });
	const owner = await connect(context, { userId: "user-a", mailboxId: "mbx-s", address: "sales@example.test" });
	await owner.client.command("SELECT INBOX");
	assertTagged(await owner.client.command("STORE 2 +FLAGS (\\Deleted)"), "OK");
	const reader = await connect(context, SHARED);
	await reader.client.command("SELECT INBOX");
	const before = productState(context);
	for (const command of ["STORE 1 +FLAGS (\\Seen \\Deleted)", "STORE 1 FLAGS (\\Seen \\Deleted)", "UID STORE 2 -FLAGS (\\Deleted)", "STORE 1:2 +FLAGS.SILENT (\\Deleted)"]) {
		assertTagged(await reader.client.command(command), "NO", /^\S+ NO \[NOPERM\] /, command);
	}
	assert.equal(productState(context), before, "nothing was written");
	assert.equal(reader.session.isClosed, false);
	assert.deepEqual(texts(await reader.client.command("STORE 2 FLAGS (\\Seen)")), ["* 2 FETCH (FLAGS (\\Seen \\Deleted))"], "a reader's replace changes only \\Seen and \\Flagged");
	assert.equal(mapping(context, "s-2")[0].deleted, 1);
	assertTagged(await reader.client.command("EXPUNGE"), "NO", /\[NOPERM\]/);
	assert.equal(context.row("s-2").status, "received");
	assertTagged(await reader.client.command("CLOSE"), "OK");
	assert.equal(context.row("s-2").status, "received", "a reader's CLOSE expunges nothing");
	assertTagged(await reader.client.command("NOOP"), "OK");
	assert.ok(!reader.client.logs.some((event) => event.event === "access.revoked"));
	await assertInvariants(context, 2);
});

test("a5.2a: a stale or moved UID cannot set \\Deleted on anything", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	await bulk(context, ["m-1"], "archive");
	const result = await context.client.command("STORE 1 +FLAGS (\\Deleted)");
	assertTagged(result, "NO", /no longer exist/);
	assert.deepEqual(texts(result), [], "no EXPUNGE during STORE and no FETCH for the vanished message");
	assert.deepEqual(sql(context, "SELECT message_id FROM imap_message_uids WHERE deleted = 1"), []);
	await app.imap.openImapFolder(context.env, { userId: "user-a", mailboxId: "mbx-a" }, "archive");
	assert.equal(mapping(context, "m-1").find((row) => row.folder === "archive").deleted, 0);
});

// ---- EXPUNGE ----------------------------------------------------------------------------------

test("a5.2a: EXPUNGE moves exactly the \\Deleted messages to Trash, reports them highest first, and keeps everything about them", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3", "m-4", "m-5"]);
	context.database.db.exec("UPDATE messages SET read = 1 WHERE id = 'm-2'; UPDATE messages SET starred = 1 WHERE id = 'm-4'");
	const attachment = "attachments/m-4/att-1/a.txt";
	await context.env.BUCKET.put(attachment, new TextEncoder().encode("attached"));
	context.database.db.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at) VALUES ('att-1', 'm-4', 'a.txt', 'text/plain', 8, ?, 1)").run(attachment);
	await context.client.command("SELECT INBOX");
	const original = {};
	for (const uid of [2, 4]) original[uid] = (await app.imap.fetchImapMessage(context.env, { userId: "user-a", mailboxId: "mbx-a" }, "inbox", uid)).bytes;
	const rowsBefore = Object.fromEntries(["m-2", "m-4"].map((id) => [id, context.row(id)]));
	await context.client.command("STORE 2,4 +FLAGS.SILENT (\\Deleted)");
	const trashNext = uidNext(context, "trash") ?? 1;
	const result = await context.client.command("EXPUNGE");
	assertTagged(result, "OK", /EXPUNGE completed/);
	assert.deepEqual(texts(result), ["* 4 EXPUNGE", "* 2 EXPUNGE"], "highest first, so each number is valid when applied");
	for (const id of ["m-2", "m-4"]) {
		const row = context.row(id);
		assert.equal(row.status, "trash");
		assert.equal(row.folder_id, null);
		for (const column of ["read", "starred", "created_at", "raw_r2_key", "direction", "subject", "mailbox_id", "user_id"]) assert.equal(row[column], rowsBefore[id][column], `${id}.${column}`);
	}
	for (const id of ["m-1", "m-3", "m-5"]) assert.equal(context.row(id).status, "received");
	assert.ok(await context.env.BUCKET.get(attachment), "attachments are kept");
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM message_attachments").n, 1);
	assert.deepEqual(mapping(context, "m-2"), [{ folder: "trash", uid: trashNext, deleted: 0 }]);
	assert.deepEqual(mapping(context, "m-4"), [{ folder: "trash", uid: trashNext + 1, deleted: 0 }], "Trash UIDs in source UID order, without \\Deleted");
	assert.equal(uidNext(context, "trash"), trashNext + 2, "Trash UIDNEXT moved with the assignment");
	// The session's view renumbered; the Trash copies serve the same octets under the same RFC822.SIZE.
	assert.deepEqual((await context.client.command("FETCH 1:* (UID)")).untagged.map((unit) => fetchAttributes(unit.text).UID), [1, 3, 5]);
	const trashSession = await connect(context);
	const select = await trashSession.client.command("SELECT Trash");
	assert.ok(texts(select).includes("* 2 EXISTS"));
	const fetched = await trashSession.client.command("FETCH 1:2 (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])");
	const attributes = fetched.untagged.map((unit) => fetchAttributes(unit.text));
	assert.deepEqual(attributes.map((item) => item.FLAGS), [["\\Seen"], ["\\Flagged"]], "read and starred preserved, \\Deleted not carried");
	assert.deepEqual(fetched.literals.map((literal) => literal.toString("latin1")), [Buffer.from(original[2]).toString("latin1"), Buffer.from(original[4]).toString("latin1")], "canonical bytes unchanged");
	assert.deepEqual(attributes.map((item) => item["RFC822.SIZE"]), [original[2].byteLength, original[4].byteLength]);
	assert.equal((await app.imap.resolveImapUid(context.env, { userId: "user-a", mailboxId: "mbx-a" }, "trash", trashNext)).internalDate.getTime(), rowsBefore["m-2"].created_at * 1000, "INTERNALDATE preserved");
	// A second EXPUNGE, and a retried relocation, change nothing.
	const stateAfter = productState(context);
	assert.deepEqual(texts(await context.client.command("EXPUNGE")), []);
	assert.deepEqual(await app.imap.expungeImapFolder(context.env, { userId: "user-a", mailboxId: "mbx-a" }, "inbox", 100), []);
	assert.equal(productState(context), stateAfter);
	await assertInvariants(context, 5);
});

test("a5.2a: EXPUNGE also reports messages that left meanwhile, with the numbers the client knows", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3", "m-4"]);
	await context.client.command("SELECT INBOX");
	await context.client.command("STORE 3 +FLAGS.SILENT (\\Deleted)");
	await bulk(context, ["m-1"], "archive");
	// A FETCH withholds the EXPUNGE for m-1 (RFC 3501 §7.4.1); sequence 3 still names m-3.
	assertTagged(await context.client.command("FETCH 3 (UID)"), "OK");
	await deliverMany(context, ["m-5"]);
	const result = await context.client.command("EXPUNGE");
	assertTagged(result, "OK");
	assert.deepEqual(texts(result), ["* 5 EXISTS", "* 3 EXPUNGE", "* 1 EXPUNGE"]);
	assert.equal(context.row("m-3").status, "trash");
	assert.equal(context.row("m-1").status, "archived", "the web move is not overwritten");
	assert.deepEqual((await context.client.command("FETCH 1:* (UID)")).untagged.map((unit) => fetchAttributes(unit.text).UID), [2, 4, 5]);
	await assertInvariants(context, 5);
});

test("a5.2a: EXPUNGE in every recoverable folder moves to Trash (Trash and Drafts delete permanently, tests/imap-permanent-expunge.test.mjs)", async (t) => {
	const context = await setup(t);
	await context.deliver("in-1", "Subject: i\r\n\r\ni\r\n");
	await context.deliver("wk-1", "Subject: w\r\n\r\nw\r\n", { folder_id: "fld-work" });
	await context.deliver("ar-1", "Subject: a\r\n\r\na\r\n", { status: "archived" });
	await context.deliver("sp-1", "Subject: s\r\n\r\ns\r\n", { status: "spam" });
	await context.deliver("se-1", "Subject: out\r\n\r\no\r\n", { status: "sent", direction: "outbound", from_addr: "a@example.test", to_addr: "b@elsewhere.test", read: 1 });
	for (const [folder, id] of [["INBOX", "in-1"], ["Work", "wk-1"], ["Archive", "ar-1"], ["Spam", "sp-1"], ["Sent", "se-1"]]) {
		await context.client.command(`SELECT ${folder}`);
		assertTagged(await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)"), "OK", undefined, folder);
		const result = await context.client.command("EXPUNGE");
		assertTagged(result, "OK", undefined, folder);
		assert.deepEqual(texts(result), ["* 1 EXPUNGE"], folder);
		const row = context.row(id);
		assert.deepEqual([row.status, row.folder_id], ["trash", null], folder);
	}
	assert.equal(context.row("se-1").direction, "outbound", "sent mail stays outbound in Trash");
	assert.equal(context.session.isClosed, false);
	await assertInvariants(context, 5);
});

test("a5.2a/a5.3: EXPUNGE and UID EXPUNGE under EXAMINE are refused, outside SELECT they are BAD", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1"]);
	assertTagged(await context.client.command("EXPUNGE"), "BAD", /not valid in this state/);
	assertTagged(await context.client.command("UID EXPUNGE 1"), "BAD", /not valid in this state/);
	await context.client.command("SELECT INBOX");
	await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
	const before = productState(context);
	await context.client.command("EXAMINE INBOX");
	assertTagged(await context.client.command("EXPUNGE"), "NO", /read-only/);
	assertTagged(await context.client.command("UID EXPUNGE 1"), "NO", /read-only/);
	assertTagged(await context.client.command("CLOSE"), "OK");
	assert.equal(productState(context), before, "EXAMINE and its CLOSE never expunge");
	await context.client.command("SELECT INBOX");
	assertTagged(await context.client.command("UNSELECT"), "OK");
	assert.equal(productState(context), before, "UNSELECT never expunges");
	assertTagged(await context.client.command("UID EXPUNGE 1"), "BAD", /not valid in this state/);
	assert.equal(productState(context), before);
});

// ---- CLOSE ------------------------------------------------------------------------------------

test("a5.2a: CLOSE under SELECT expunges silently to Trash and deselects", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	await context.client.command("STORE 2 +FLAGS.SILENT (\\Deleted)");
	const result = await context.client.command("CLOSE");
	assertTagged(result, "OK", /CLOSE completed/);
	assert.deepEqual(texts(result), [], "no untagged EXPUNGE during CLOSE");
	assert.equal(context.row("m-2").status, "trash");
	assert.equal(context.row("m-1").status, "received");
	assertTagged(await context.client.command("FETCH 1 (UID)"), "BAD", /not valid in this state/);
	await assertInvariants(context, 2);
});

test("a5.2a: a CLOSE whose move fails answers NO [UNAVAILABLE], keeps the mailbox selected and every mark; a retry succeeds", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	await context.client.command("STORE 1:2 +FLAGS.SILENT (\\Deleted)");
	await openTrash(context);
	const before = productState(context);
	beforeBatch(context, RELOCATION, () => {
		throw new Error("injected D1 failure");
	});
	assertTagged(await context.client.command("CLOSE"), "NO", /\[UNAVAILABLE\]/);
	assert.equal(productState(context), before);
	assertTagged(await context.client.command("FETCH 1:2 (FLAGS)"), "OK", undefined, "still selected");
	assertTagged(await context.client.command("CLOSE"), "OK");
	assert.deepEqual([context.row("m-1").status, context.row("m-2").status], ["trash", "trash"]);
	await assertInvariants(context, 2);
});

// ---- Concurrency and failures -----------------------------------------------------------------

test("a5.2a: a concurrent -FLAGS \\Deleted or web move/restore before EXPUNGE wins; nothing is overwritten", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3"]);
	const other = await connect(context);
	await context.client.command("SELECT INBOX");
	await other.client.command("SELECT INBOX");
	await context.client.command("STORE 1:3 +FLAGS.SILENT (\\Deleted)");
	await other.client.command("STORE 1 -FLAGS.SILENT (\\Deleted)");
	await bulk(context, ["m-2"], "archive");
	await bulk(context, ["m-3"], "trash");
	await bulk(context, ["m-3"], "inbox");
	const result = await context.client.command("EXPUNGE");
	assertTagged(result, "OK");
	assert.deepEqual(texts(result), ["* 1 FETCH (FLAGS ())", "* 3 FETCH (FLAGS ())", "* 2 EXPUNGE"]);
	assert.deepEqual(["m-1", "m-2", "m-3"].map((id) => context.row(id).status), ["received", "archived", "received"]);
	await assertInvariants(context, 3);
});

test("a5.2a: EXPUNGE is decided at the moment of the write: a mark cleared, or a message moved, just before the batch is left alone", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3"]);
	await context.client.command("SELECT INBOX");
	await context.client.command("STORE 1:3 +FLAGS.SILENT (\\Deleted)");
	beforeBatch(context, RELOCATION, () => {
		context.database.db.exec("UPDATE imap_message_uids SET deleted = 0 WHERE message_id = 'm-1'; UPDATE messages SET status = 'archived' WHERE id = 'm-2'");
	});
	const result = await context.client.command("EXPUNGE");
	assertTagged(result, "OK");
	assert.deepEqual(["m-1", "m-2", "m-3"].map((id) => context.row(id).status), ["received", "archived", "trash"]);
	assert.deepEqual(texts(result), ["* 3 EXPUNGE", "* 2 EXPUNGE", "* 1 FETCH (FLAGS ())"], "EXPUNGEs first, then the flag change of a message that stayed");
	await assertInvariants(context, 3);
});

test("a5.2a: two IMAP sessions expunging at once move each message exactly once", async (t) => {
	const context = await setup(t);
	const ids = Array.from({ length: 30 }, (_, index) => `m-${String(index).padStart(2, "0")}`);
	await deliverMany(context, ids);
	const other = await connect(context);
	await context.client.command("SELECT INBOX");
	await other.client.command("SELECT INBOX");
	await context.client.command("STORE 1:* +FLAGS.SILENT (\\Deleted)");
	await other.client.command("NOOP");
	const [first, second] = await Promise.all([context.client.command("EXPUNGE"), other.client.command("EXPUNGE")]);
	assertTagged(first, "OK");
	assertTagged(second, "OK");
	for (const result of [first, second]) assert.equal(texts(result).filter((line) => / EXPUNGE$/.test(line)).length, 30, "each session learns about all 30");
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages WHERE status = 'trash'").n, 30);
	const trash = sql(context, "SELECT u.uid FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key = 'trash' ORDER BY u.uid").map((row) => row.uid);
	assert.deepEqual(trash, Array.from({ length: 30 }, (_, index) => index + 1), "30 distinct Trash UIDs");
	assert.equal(uidNext(context, "trash"), 31);
	await assertInvariants(context, 30);
});

test("a5.2a: EXPUNGE of more than one chunk moves every chunk; UIDs stay unique and ascending", async (t) => {
	const context = await setup(t);
	const ids = Array.from({ length: 170 }, (_, index) => `m-${String(index).padStart(3, "0")}`);
	await deliverMany(context, ids);
	await context.client.command("SELECT INBOX");
	await context.client.command("STORE 2:* +FLAGS.SILENT (\\Deleted)");
	const result = await context.client.command("EXPUNGE");
	assertTagged(result, "OK");
	const numbers = texts(result).map((line) => Number(/^\* (\d+) EXPUNGE$/.exec(line)[1]));
	assert.deepEqual(numbers, Array.from({ length: 169 }, (_, index) => 170 - index));
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages WHERE status = 'trash'").n, 169);
	assert.equal(uidNext(context, "trash"), 170);
	await assertInvariants(context, 170);
});

test("a5.2a: a permission downgrade before the command, or between chunks, stops the move with NO [NOPERM]; what moved is reported", async (t) => {
	const context = await install(app, t);
	context.database.db.exec("UPDATE mailbox_access SET permission = 'full_access' WHERE id = 'acc-b'");
	const ids = Array.from({ length: 100 }, (_, index) => `s-${String(index).padStart(3, "0")}`);
	await deliverMany(context, ids, { mailbox_id: "mbx-s" });
	const manager = await connect(context, SHARED);
	await manager.client.command("SELECT INBOX");
	assertTagged(await manager.client.command("STORE 1:* +FLAGS.SILENT (\\Deleted)"), "OK");
	// Between chunks: the first 80 move, then the delegate is a reader.
	afterBatch(context, RELOCATION, () => context.database.db.exec("UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-b'"));
	const result = await manager.client.command("EXPUNGE");
	assertTagged(result, "NO", /\[NOPERM\]/);
	assert.equal(texts(result).filter((line) => / EXPUNGE$/.test(line)).length, 80, "the first chunk moved and is reported");
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages WHERE status = 'trash'").n, 80);
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages WHERE status = 'received'").n, 20);
	assert.equal(manager.session.isClosed, false);
	// Before the command: nothing moves, the session goes on; STORE and CLOSE follow suit.
	const before = productState(context);
	assertTagged(await manager.client.command("EXPUNGE"), "NO", /\[NOPERM\]/);
	assertTagged(await manager.client.command("STORE 1 -FLAGS (\\Deleted)"), "NO", /\[NOPERM\]/);
	assertTagged(await manager.client.command("CLOSE"), "OK");
	assert.equal(productState(context), before);
	assertTagged(await manager.client.command("NOOP"), "OK");
	await assertInvariants(context, 100);
});

test("a5.2a: revoked access or a revoked app password ends the session with BYE and moves nothing more", async (t) => {
	const context = await install(app, t);
	context.database.db.exec("UPDATE mailbox_access SET permission = 'full_access' WHERE id = 'acc-b'");
	const ids = Array.from({ length: 100 }, (_, index) => `s-${String(index).padStart(3, "0")}`);
	await deliverMany(context, ids, { mailbox_id: "mbx-s" });
	// Revoked between chunks.
	const first = await connect(context, SHARED);
	await first.client.command("SELECT INBOX");
	await first.client.command("STORE 1:* +FLAGS.SILENT (\\Deleted)");
	afterBatch(context, RELOCATION, () => context.database.db.prepare("DELETE FROM mail_app_passwords WHERE id = ?").run(first.credentialId));
	const cut = await first.client.command("EXPUNGE");
	assert.equal(cut.untagged.at(-1).text, "* BYE Access revoked");
	assert.equal(first.session.isClosed, true);
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages WHERE status = 'trash'").n, 80, "the committed chunk stays; nothing half-moved");
	// Revoked before the command: EXPUNGE and CLOSE end the session and move nothing.
	for (const command of ["EXPUNGE", "CLOSE"]) {
		const session = await connect(context, SHARED);
		await session.client.command("SELECT INBOX");
		const before = productState(context);
		context.database.db.prepare("DELETE FROM mail_app_passwords WHERE id = ?").run(session.credentialId);
		const result = await session.client.command(command);
		assert.equal(result.untagged.at(-1).text, "* BYE Access revoked", command);
		assert.equal(productState(context), before, command);
	}
	const session = await connect(context, SHARED);
	await session.client.command("SELECT INBOX");
	const before = productState(context);
	context.database.db.exec("DELETE FROM mailbox_access WHERE id = 'acc-b'");
	assert.equal((await session.client.command("EXPUNGE")).untagged.at(-1).text, "* BYE Access revoked");
	assert.equal(productState(context), before);
	await assertInvariants(context, 100);
});

test("a5.2a: an exhausted Trash UIDNEXT, or any failed statement, rolls the whole relocation back; a retry after the fault succeeds", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await app.imap.openImapFolder(context.env, { userId: "user-a", mailboxId: "mbx-a" }, "trash");
	await context.client.command("SELECT INBOX");
	await context.client.command("STORE 1:2 +FLAGS.SILENT (\\Deleted)");
	const before = productState(context);
	context.database.db.exec("UPDATE imap_folders SET uid_next = 4294967296 WHERE mailbox_id = 'mbx-a' AND folder_key = 'trash'");
	const exhausted = productState(context);
	assertTagged(await context.client.command("EXPUNGE"), "NO", /\[UNAVAILABLE\]/);
	assert.equal(productState(context), exhausted, "status, marks and mappings untouched");
	assert.deepEqual(mapping(context, "m-1"), [{ folder: "inbox", uid: 1, deleted: 1 }]);
	assert.equal(context.session.isClosed, false);
	// A failure injected into the batch itself.
	const other = await setup(t);
	await deliverMany(other, ["x-1"]);
	await other.client.command("SELECT INBOX");
	await other.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
	await openTrash(other);
	const otherBefore = productState(other);
	beforeBatch(other, RELOCATION, () => {
		throw new Error("injected D1 failure");
	});
	assertTagged(await other.client.command("EXPUNGE"), "NO", /\[UNAVAILABLE\]/);
	assert.equal(productState(other), otherBefore);
	assert.deepEqual(texts(await other.client.command("EXPUNGE")), ["* 1 EXPUNGE"], "the retry moves it");
	assert.equal(other.row("x-1").status, "trash");
	assert.ok(before);
	await assertInvariants(context, 2);
	await assertInvariants(other, 1);
});

// ---- Fail-closed without bp0003 ---------------------------------------------------------------

test("a5.2a: without the bp0003 trigger \\Deleted is not offered, STORE \\Deleted and EXPUNGE are NO [CANNOT], CLOSE moves nothing, and the session goes on", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	await context.client.command("STORE 2 +FLAGS.SILENT (\\Deleted)");
	context.database.db.exec(`DROP TRIGGER ${TRIGGER}`);
	const before = productState(context);
	const select = await context.client.command("SELECT INBOX");
	assert.ok(texts(select).includes("* OK [PERMANENTFLAGS (\\Seen \\Flagged)] Flags permitted"));
	assert.deepEqual((await app.imap.listImapMailboxes(context.env, { userId: "user-a", mailboxId: "mbx-a" })).map((mailbox) => mailbox.permanentFlags.includes("deleted")), Array(7).fill(false));
	assertTagged(await context.client.command("STORE 1 +FLAGS (\\Seen \\Deleted)"), "NO", /^\S+ NO \[CANNOT\] /);
	assertTagged(await context.client.command("STORE 2 -FLAGS (\\Deleted)"), "NO", /\[CANNOT\]/);
	assertTagged(await context.client.command("EXPUNGE"), "NO", /^\S+ NO \[CANNOT\] EXPUNGE is unavailable/);
	assertTagged(await context.client.command("CLOSE"), "OK");
	assert.equal(productState(context), before, "nothing written, nothing moved");
	await context.client.command("SELECT INBOX");
	assertTagged(await context.client.command("STORE 1 +FLAGS (\\Seen)"), "OK", undefined, "\\Seen and \\Flagged keep working");
	assert.equal(context.session.isClosed, false);
	assert.ok(!context.client.logs.some((event) => event.event === "access.revoked"));
	await assert.rejects(app.imap.setImapMessageFlags(context.env, { userId: "user-a", mailboxId: "mbx-a" }, "inbox", 1, { deleted: true }), (error) => error.code === "unsupported");
	await assertInvariants(context, 2);
});

test("a5.2a: a trigger that disappears after the check never lets a \\Deleted write or a relocation through", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	await context.client.command("STORE 2 +FLAGS.SILENT (\\Deleted)");
	await openTrash(context);
	const before = productState(context);
	beforeBatch(context, /imap_message_uids/, () => context.database.db.exec(`DROP TRIGGER ${TRIGGER}`));
	const stored = await context.client.command("STORE 1 +FLAGS (\\Deleted)");
	assert.deepEqual(texts(stored), ["* 1 FETCH (FLAGS ())"], "the write did nothing and the real flags are reported");
	assert.equal(productState(context), before);
	context.database.db.exec(`CREATE TRIGGER ${TRIGGER} AFTER UPDATE OF mailbox_id, status, folder_id ON messages WHEN OLD.mailbox_id IS NOT NEW.mailbox_id OR OLD.status IS NOT NEW.status OR OLD.folder_id IS NOT NEW.folder_id BEGIN UPDATE imap_message_uids SET deleted = 0 WHERE message_id = NEW.id AND deleted = 1; END`);
	beforeBatch(context, RELOCATION, () => context.database.db.exec(`DROP TRIGGER ${TRIGGER}`));
	assertTagged(await context.client.command("EXPUNGE"), "OK");
	assert.equal(productState(context), before, "the relocation's own guard kept m-2 in place");
	await assertInvariants(context, 2);
});
