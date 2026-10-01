import assert from "node:assert/strict";
import test from "node:test";
import { assertTagged, install, loadApp, memoryClient } from "./support/imap-harness.mjs";

/**
 * A5.3: UIDPLUS core (RFC 4315), over the real A2 verifier, A3 state, the bp0003 and bp0004
 * triggers, the product routes and the file bucket (SQLite, no Workers).
 *
 * - UID EXPUNGE is EXPUNGE narrowed to the UIDs the client names: of those, only messages still
 *   marked \Deleted leave, by A5.2a's recoverable move to Trash everywhere but Trash and Drafts
 *   and by A5.2c's permanent, database-first deletion there, with every guard of those paths.
 * - MOVE and UID MOVE report `* OK [COPYUID …]` before their EXPUNGEs, from the destination UIDs
 *   and UIDVALIDITY the committing relocation batch read back; never for a move that did not
 *   commit.
 * - UIDPLUS is advertised after authentication; COPY stays refused. APPEND (A5.7, Drafts only)
 *   reports APPENDUID only for a committed draft; it is certified in imap-append.test.mjs.
 */
const { app, cleanup } = await loadApp("imap-uidplus");
test.after(cleanup);

const BASE = "http://mailflare.local";
const AUTH = "IMAP4rev1 ID NAMESPACE UNSELECT SPECIAL-USE MOVE UIDPLUS IDLE";
const SHARED = { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" };
const texts = (result) => result.untagged.map((unit) => unit.text);
const sql = (context, query, ...params) => context.database.db.prepare(query).all(...params);
const one = (context, query, ...params) => context.database.db.prepare(query).get(...params);
const exec = (context, query) => context.database.db.exec(query);
const exists = (context, id) => !!context.row(id);
const stored = async (context, key) => !!(await context.env.BUCKET.get(key));
const uidOf = (context, messageId, key) => one(context, "SELECT u.uid FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE u.message_id = ? AND f.folder_key = ?", messageId, key)?.uid ?? null;
const marked = (context, key) => sql(context, "SELECT u.uid FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key = ? AND u.deleted = 1 ORDER BY u.uid", key).map((row) => row.uid);
const uidValidity = (context, key, mailboxId = "mbx-a") => one(context, "SELECT uid_validity FROM imap_folders WHERE mailbox_id = ? AND folder_key = ?", mailboxId, key)?.uid_validity;
const copyUids = (result) => texts(result).filter((line) => line.includes("COPYUID"));
/** Everything a mutation could touch: rows, attachments and IMAP state. */
const state = (context) =>
	JSON.stringify([
		sql(context, "SELECT id, status, folder_id, read, starred, raw_r2_key FROM messages ORDER BY id"),
		sql(context, "SELECT id, message_id, r2_key FROM message_attachments ORDER BY id"),
		sql(context, "SELECT id, folder_key, uid_validity, uid_next FROM imap_folders ORDER BY id"),
		sql(context, "SELECT imap_folder_id, uid, message_id, deleted FROM imap_message_uids ORDER BY imap_folder_id, uid"),
	]);

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

/** A context where user-b has full access to the shared mailbox and is connected to it. */
async function sharedManager(t) {
	const context = await install(app, t);
	exec(context, "UPDATE mailbox_access SET permission = 'full_access' WHERE id = 'acc-b'");
	return { ...context, ...(await connect(context, SHARED)) };
}

async function deliverMany(context, ids, values = {}) {
	for (const id of ids) await context.deliver(id, `Subject: ${id}\r\n\r\nbody of ${id}\r\n`, values);
}

let draftCounter = 0;
function draft(context, id, { userId = "user-a", mailboxId = "mbx-a" } = {}) {
	context.database.db
		.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, read, created_at) VALUES (?, ?, ?, 'outbound', 'a@example.test', 'b@elsewhere.test', ?, 'draft body', 'draft', 1, ?)")
		.run(id, userId, mailboxId, id, 1790200000 + ++draftCounter);
}

async function attach(context, messageId, attachmentId, content = "attached bytes") {
	const key = `attachments/${messageId}/${attachmentId}/file.txt`;
	await context.env.BUCKET.put(key, content);
	context.database.db
		.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES (?, ?, 'file.txt', 'text/plain', ?, 'attachment', ?, 1)")
		.run(attachmentId, messageId, content.length, key);
	return key;
}

async function webDraftPatch(context, id, body) {
	const token = await app.createSession(context.env, "user-a");
	const request = new Request(`${BASE}/api/drafts/${id}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	return app.draftPatchRoute(request, { params: Promise.resolve({ id }) });
}

const RELOCATION = /UPDATE messages SET status/;
const PERMANENT = /DELETE FROM messages WHERE/;

/** Run `hook` right before the `count`-th D1 batch whose SQL matches `pattern`. */
function beforeBatch(context, pattern, hook, count = 1) {
	const database = context.database;
	const original = database.batch;
	let seen = 0;
	database.batch = async function (statements) {
		if (pattern.test(statements.map((statement) => statement.sql ?? "").join("\n")) && ++seen === count) {
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

function countBatches(context, pattern) {
	const database = context.database;
	const original = database.batch;
	const counter = { n: 0, stop: () => (database.batch = original) };
	database.batch = async function (statements) {
		if (pattern.test(statements.map((statement) => statement.sql ?? "").join("\n"))) counter.n += 1;
		return original.call(this, statements);
	};
	return counter;
}

function watchDeletes(context, fail = () => false) {
	const bucket = context.env.BUCKET;
	const original = bucket.delete.bind(bucket);
	const calls = [];
	bucket.delete = async (key) => {
		calls.push(key);
		if (fail(key)) throw new Error(`injected storage failure for ${key}`);
		return original(key);
	};
	return calls;
}

function captureLogs(t) {
	const lines = [];
	for (const level of ["warn", "error"]) {
		t.mock.method(console, level, (line) => {
			try {
				lines.push(JSON.parse(line));
			} catch {
				lines.push({ raw: line });
			}
		});
	}
	return lines;
}

/** Every live row keeps its bytes; UIDs stay unique; nothing in Trash or Drafts is left half-deleted. */
async function assertInvariants(context) {
	for (const row of sql(context, "SELECT id, raw_r2_key FROM messages WHERE raw_r2_key IS NOT NULL")) assert.ok(await stored(context, row.raw_r2_key), `live message ${row.id} still has its bytes`);
	for (const row of sql(context, "SELECT message_id, r2_key FROM message_attachments")) assert.ok(await stored(context, row.r2_key), `live attachment of ${row.message_id} still has its object`);
	assert.deepEqual(sql(context, "SELECT imap_folder_id, uid, COUNT(*) AS n FROM imap_message_uids GROUP BY imap_folder_id, uid HAVING n > 1"), []);
	assert.deepEqual(sql(context, "SELECT imap_folder_id, message_id, COUNT(*) AS n FROM imap_message_uids GROUP BY imap_folder_id, message_id HAVING n > 1"), []);
	assert.deepEqual(sql(context, "SELECT uid_next FROM imap_folders f WHERE uid_next <= (SELECT COALESCE(MAX(uid), 0) FROM imap_message_uids u WHERE u.imap_folder_id = f.id)"), []);
}

// ---- Capability and command surface ---------------------------------------------------------------

test("a5.3: UIDPLUS is advertised after authentication only; UID EXPUNGE needs a selected mailbox; every other unsupported command stays refused", async (t) => {
	const context = await install(app, t);
	const { client, start } = memoryClient(app, context.env);
	const greeting = await start();
	assert.ok(!greeting.text.includes("UIDPLUS"), "not before authentication");
	assert.deepEqual(texts(await client.command("CAPABILITY")), ["* CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN ID"]);
	assertTagged(await client.command("UID EXPUNGE 1"), "BAD", /not valid in this state/);
	const { credential } = await context.credential("user-a", "mbx-a");
	assertTagged(await client.login("a@example.test", credential), "OK", new RegExp(`\\[CAPABILITY ${AUTH}\\] Logged in`));
	assert.equal(app.AUTH_CAPABILITIES, AUTH);
	assert.deepEqual(texts(await client.command("CAPABILITY")), [`* CAPABILITY ${AUTH}`]);
	assertTagged(await client.command("UID EXPUNGE 1"), "BAD", /not valid in this state/, "authenticated, nothing selected");
	await deliverMany(context, ["m-1"]);
	await client.command("SELECT INBOX");
	assert.deepEqual(texts(await client.command("CAPABILITY")), [`* CAPABILITY ${AUTH}`], "the same in the selected state");
	const before = state(context);
	for (const command of ["COPY 1 Trash", "UID COPY 1 Trash"]) {
		assertTagged(await client.command(command), "NO", /\[CANNOT\] .* not available on this server/, command);
	}
	// An APPEND that commits nothing (here a message without From) carries no APPENDUID.
	client.write("ap APPEND Drafts (\\Seen) {12}\r\n");
	assert.match((await client.unit()).text, /^\+ /);
	client.write("Subject: x\r\n\r\n");
	const append = await client.collect("ap");
	assertTagged(append, "NO", /\[CANNOT\] The message has no From header/);
	assert.ok(!append.tagged.includes("APPENDUID"));
	for (const command of ["ENABLE CONDSTORE", "ENABLE QRESYNC"]) assertTagged(await client.command(command), "BAD", /Unknown command/, command);
	assertTagged(await client.command("FETCH 1 (MODSEQ)"), "BAD");
	assertTagged(await client.command("UID FETCH 1 (FLAGS) (CHANGEDSINCE 1)"), "BAD");
	assertTagged(await client.command("STATUS INBOX (HIGHESTMODSEQ)"), "BAD");
	assert.equal(state(context), before, "nothing refused touched any state");
});

// ---- UID EXPUNGE outside Trash and Drafts: A5.2a's recoverable relocation --------------------------

test("a5.3: UID EXPUNGE in INBOX moves exactly the requested \\Deleted UIDs to Trash; unrequested marks and unmarked requests are untouched", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3", "m-4", "m-5"]);
	await context.client.command("SELECT INBOX");
	assertTagged(await context.client.command("UID STORE 1,2,4,5 +FLAGS.SILENT (\\Deleted)"), "OK");
	const trashNext = one(context, "SELECT uid_next FROM imap_folders WHERE folder_key = 'trash'")?.uid_next ?? 1;
	const result = await context.client.command("UID EXPUNGE 2:4");
	assertTagged(result, "OK", /^\S+ OK UID EXPUNGE completed$/);
	assert.deepEqual(texts(result), ["* 4 EXPUNGE", "* 2 EXPUNGE"], "sequence numbers, highest first; UID 3 was requested but not \\Deleted");
	assert.deepEqual(["m-2", "m-4"].map((id) => context.row(id).status), ["trash", "trash"]);
	assert.deepEqual(["m-1", "m-3", "m-5"].map((id) => context.row(id).status), ["received", "received", "received"]);
	assert.deepEqual(marked(context, "inbox"), [1, 5], "unrequested \\Deleted marks stay");
	assert.deepEqual(["m-2", "m-4"].map((id) => uidOf(context, id, "trash")), [trashNext, trashNext + 1], "fresh Trash UIDs in source order");
	assert.deepEqual(marked(context, "trash"), [], "never \\Deleted in Trash");
	assert.equal(await stored(context, "inbound/m-2.eml"), true, "recoverable: bytes kept");
	// The remaining view is 1, 3, 5; plain EXPUNGE takes the rest of the marks.
	assert.deepEqual((await context.client.command("UID FETCH 1:* (UID)")).untagged.map((unit) => unit.text), ["* 1 FETCH (UID 1)", "* 2 FETCH (UID 3)", "* 3 FETCH (UID 5)"]);
	assert.deepEqual(texts(await context.client.command("EXPUNGE")), ["* 3 EXPUNGE", "* 1 EXPUNGE"]);
	await assertInvariants(context);
});

test("a5.3: UID EXPUNGE is recoverable in every folder but Trash and Drafts: Archive, Spam, Sent and custom folders", async (t) => {
	const context = await setup(t);
	const places = [["Archive", { status: "archived" }], ["Spam", { status: "spam" }], ["Sent", { status: "sent", direction: "outbound", from_addr: "a@example.test" }], ["Work", { status: "received", folder_id: "fld-work" }]];
	for (const [folder, values] of places) {
		const ids = [`${folder}-1`, `${folder}-2`];
		await deliverMany(context, ids, values);
		await context.client.command(`SELECT ${folder}`);
		assertTagged(await context.client.command("STORE 1:2 +FLAGS.SILENT (\\Deleted)"), "OK", undefined, folder);
		const result = await context.client.command(`UID EXPUNGE ${uidOf(context, ids[1], context.row(ids[1]).folder_id ? "f:fld-work" : { Archive: "archive", Spam: "junk", Sent: "sent" }[folder])}`);
		assertTagged(result, "OK", undefined, folder);
		assert.deepEqual(texts(result), ["* 2 EXPUNGE"], folder);
		assert.equal(context.row(ids[1]).status, "trash", folder);
		assert.equal(context.row(ids[0]).status, values.status, `${folder}: the unrequested marked message stays`);
	}
	await assertInvariants(context);
});

// ---- UID EXPUNGE in Trash: A5.2c's permanent deletion ------------------------------------------------

test("a5.3: UID EXPUNGE in Trash permanently deletes only requested \\Deleted UIDs, database first, then their raw and attachment objects", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["t-1", "t-2", "t-3", "t-4"], { status: "trash" });
	const attachments = { "t-1": await attach(context, "t-1", "a-1"), "t-2": await attach(context, "t-2", "a-2"), "t-3": await attach(context, "t-3", "a-3") };
	await context.client.command("SELECT Trash");
	assertTagged(await context.client.command("STORE 1:3 +FLAGS.SILENT (\\Deleted)"), "OK");
	const order = [];
	afterBatch(context, PERMANENT, () => order.push("commit"));
	const deletes = watchDeletes(context);
	const bucketDelete = context.env.BUCKET.delete;
	context.env.BUCKET.delete = async (key) => {
		order.push(`delete ${key}`);
		return bucketDelete(key);
	};
	const result = await context.client.command("UID EXPUNGE 1,3,4");
	assertTagged(result, "OK", /UID EXPUNGE completed/);
	assert.deepEqual(texts(result), ["* 3 EXPUNGE", "* 1 EXPUNGE"], "UID 4 was requested but not marked");
	assert.equal(order[0], "commit", "no object is deleted before the database batch committed");
	assert.deepEqual([exists(context, "t-1"), exists(context, "t-2"), exists(context, "t-3"), exists(context, "t-4")], [false, true, false, true]);
	assert.deepEqual(deletes.sort(), [attachments["t-1"], attachments["t-3"], "inbound/t-1.eml", "inbound/t-3.eml"].sort());
	assert.ok(await stored(context, "inbound/t-2.eml") && (await stored(context, attachments["t-2"])), "the unrequested marked message keeps everything");
	assert.deepEqual(marked(context, "trash"), [2]);
	assert.deepEqual(sql(context, "SELECT message_id FROM imap_message_uids WHERE message_id IN ('t-1', 't-3')"), [], "no mapping names a deleted message");
	const again = await context.client.command("UID EXPUNGE 1,3,4");
	assertTagged(again, "OK");
	assert.deepEqual(texts(again), [], "a retry deletes and reports nothing");
	await assertInvariants(context);
});

// ---- UID EXPUNGE in Drafts: A5.2c with authorship and bp0004 -------------------------------------------

test("a5.3: UID EXPUNGE in Drafts deletes only the principal's own requested \\Deleted drafts; another user's marked draft survives", async (t) => {
	const context = await sharedManager(t);
	draft(context, "d-b1", { userId: "user-b", mailboxId: "mbx-s" });
	draft(context, "d-a", { userId: "user-a", mailboxId: "mbx-s" });
	draft(context, "d-b2", { userId: "user-b", mailboxId: "mbx-s" });
	draft(context, "d-b3", { userId: "user-b", mailboxId: "mbx-s" });
	await context.client.command("SELECT Drafts");
	assertTagged(await context.client.command("UID STORE 1,3,4 +FLAGS.SILENT (\\Deleted)"), "OK");
	// Another user's draft marked behind the listener's back.
	exec(context, "UPDATE imap_message_uids SET deleted = 1 WHERE message_id = 'd-a'");
	const result = await context.client.command("UID EXPUNGE 1:3");
	assertTagged(result, "OK");
	assert.deepEqual(texts(result), ["* 2 FETCH (FLAGS (\\Seen \\Deleted \\Draft))", "* 3 EXPUNGE", "* 1 EXPUNGE"], "the mark set elsewhere is reported; only own requested drafts leave");
	assert.deepEqual(["d-b1", "d-a", "d-b2", "d-b3"].map((id) => exists(context, id)), [false, true, false, true], "d-a is not ours; d-b3 was not requested");
	await assertInvariants(context);
});

test("a5.3: a draft edited, or its attachments changed, after STORE \\Deleted: UID EXPUNGE of the old UID never deletes the replacement", async (t) => {
	const context = await setup(t);
	draft(context, "d-edit");
	draft(context, "d-add");
	draft(context, "d-remove");
	const removed = await attach(context, "d-remove", "att-r");
	await context.client.command("SELECT Drafts");
	assertTagged(await context.client.command("UID STORE 1:3 +FLAGS.SILENT (\\Deleted)"), "OK");
	assert.equal((await webDraftPatch(context, "d-edit", { mailboxId: "mbx-a", from: "a@example.test", to: "b@elsewhere.test", subject: "edited", text: "new body", html: "" })).status, 200);
	await app.storeMessageAttachments(context.env, "d-add", [{ filename: "late.txt", type: "text/plain", content: new TextEncoder().encode("late").buffer }]);
	await app.deleteMessageAttachment(context.env, "d-remove", "att-r");
	const deletes = watchDeletes(context);
	const result = await context.client.command("UID EXPUNGE 1:3");
	assertTagged(result, "OK");
	assert.ok(exists(context, "d-edit") && exists(context, "d-add") && exists(context, "d-remove"), "every edited draft survives");
	assert.deepEqual(deletes, [], "no object is touched");
	assert.deepEqual(texts(result), ["* 6 EXISTS", "* 3 EXPUNGE", "* 2 EXPUNGE", "* 1 EXPUNGE"], "the old UIDs are gone and the edited drafts reappear under new ones");
	assert.deepEqual(marked(context, "drafts"), [], "no mark reaches an edited draft");
	assert.equal(await stored(context, removed), false, "removed by its own route helper, not by IMAP");
	await assertInvariants(context);
});

test("a5.3: a draft edited between the listener's checks and the delete batch survives (bp0004 inside the batch)", async (t) => {
	for (const [name, change] of [
		["content", (context) => exec(context, "UPDATE messages SET subject = 'changed at the last moment' WHERE id = 'd-1'")],
		["attachment added", (context) => app.storeMessageAttachments(context.env, "d-1", [{ filename: "x.txt", type: "text/plain", content: new TextEncoder().encode("x").buffer }])],
	]) {
		const context = await setup(t);
		draft(context, "d-1");
		draft(context, "d-2");
		await context.client.command("SELECT Drafts");
		assertTagged(await context.client.command("STORE 1:2 +FLAGS.SILENT (\\Deleted)"), "OK");
		beforeBatch(context, PERMANENT, () => change(context));
		assertTagged(await context.client.command("UID EXPUNGE 1:2"), "OK", undefined, name);
		assert.ok(exists(context, "d-1"), `${name}: the changed draft survives`);
		assert.equal(exists(context, "d-2"), false, `${name}: the unchanged requested draft is deleted`);
		await assertInvariants(context);
	}
});

// ---- UID sets ------------------------------------------------------------------------------------------

test("a5.3: malformed UID sets are BAD and change nothing; the sequence-set bounds still apply", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	await context.client.command("STORE 1:2 +FLAGS.SILENT (\\Deleted)");
	const before = state(context);
	for (const command of ["UID EXPUNGE", "UID EXPUNGE ", "UID EXPUNGE 0", "UID EXPUNGE 0:2", "UID EXPUNGE 1:0", "UID EXPUNGE x", "UID EXPUNGE -1", "UID EXPUNGE 1,,2", "UID EXPUNGE ,1", "UID EXPUNGE 1:2:3", "UID EXPUNGE 1 2", "UID EXPUNGE 4294967296", "UID EXPUNGE 99999999999", "UID EXPUNGE (1)", "UID EXPUNGE  1", "UID EXPUNGE 1 "]) {
		assertTagged(await context.client.command(command), "BAD", undefined, command);
	}
	// 20,001 ranges within one 64 KiB line: over MAX_SEQUENCE_RANGES, refused before any work.
	const tooMany = Array.from({ length: 20_001 }, () => "1").join(",");
	assertTagged(await context.client.command(`UID EXPUNGE ${tooMany}`), "BAD", /Sequence set too long/);
	assert.equal(state(context), before);
	assert.equal(context.session.isClosed, false);
});

test("a5.3: UID set forms: nonexistent, duplicate, reversed, mixed, `*` and a full-range set, resolved only against announced UIDs", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "m-7", "m-8"]);
	await context.client.command("SELECT INBOX");
	assertTagged(await context.client.command("STORE 1:* +FLAGS.SILENT (\\Deleted)"), "OK");
	const step = async (command, expected, remaining) => {
		const result = await context.client.command(command);
		assertTagged(result, "OK", undefined, command);
		assert.deepEqual(texts(result), expected, command);
		assert.deepEqual((await context.client.command("UID SEARCH ALL")).untagged[0].text, `* SEARCH${remaining.map((uid) => ` ${uid}`).join("")}`, command);
	};
	await step("UID EXPUNGE 99", [], [1, 2, 3, 4, 5, 6, 7, 8]);
	await step("UID EXPUNGE 2,2,2", ["* 2 EXPUNGE"], [1, 3, 4, 5, 6, 7, 8]);
	await step("UID EXPUNGE 4:3", ["* 3 EXPUNGE", "* 2 EXPUNGE"], [1, 5, 6, 7, 8]);
	await step("UID EXPUNGE 1,6,50:4000000000", ["* 3 EXPUNGE", "* 1 EXPUNGE"], [5, 7, 8]);
	await step("UID EXPUNGE *", ["* 3 EXPUNGE"], [5, 7]);
	const started = Date.now();
	await step("UID EXPUNGE 1:4294967295", ["* 2 EXPUNGE", "* 1 EXPUNGE"], []);
	assert.ok(Date.now() - started < 5_000, "a full-range set costs one pass over the mailbox, not over the range");
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages WHERE status = 'trash'").n, 8);
	await step("UID EXPUNGE 1:*", [], []);
	await assertInvariants(context);
});

// ---- EXPUNGE responses ---------------------------------------------------------------------------------

test("a5.3: UID EXPUNGE reports every message that left, in the client's sequence numbers, highest first, and nothing that stayed", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3", "m-4", "m-5", "m-6"]);
	await context.client.command("SELECT INBOX");
	assertTagged(await context.client.command("UID STORE 2,5 +FLAGS.SILENT (\\Deleted)"), "OK");
	const other = await connect(context);
	await other.client.command("SELECT INBOX");
	assertTagged(await other.client.command("UID MOVE 3 Archive"), "OK");
	const result = await context.client.command("UID EXPUNGE 5");
	assertTagged(result, "OK");
	assert.deepEqual(texts(result), ["* 5 EXPUNGE", "* 3 EXPUNGE"], "UID 3 left through another session; UID 2 is marked but was not requested");
	assert.deepEqual(marked(context, "inbox"), [2]);
	assert.deepEqual(texts(await context.client.command("NOOP")), []);
	assert.deepEqual((await context.client.command("UID SEARCH ALL")).untagged[0].text, "* SEARCH 1 2 4 6");
	await assertInvariants(context);
});

test("a5.3: a message that arrives while UID EXPUNGE runs is never expunged, even when `*` or a range would name it", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["t-1"], { status: "trash" });
	const other = await connect(context);
	await other.client.command("SELECT Trash");
	await context.client.command("SELECT Trash");
	assertTagged(await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)"), "OK");
	beforeBatch(context, PERMANENT, async () => {
		await context.deliver("t-late", "Subject: late\r\n\r\nlate\r\n", { status: "trash" });
		await other.client.command("NOOP");
		await other.client.command("STORE 2 +FLAGS.SILENT (\\Deleted)");
	});
	const result = await context.client.command("UID EXPUNGE 1:*");
	assertTagged(result, "OK");
	assert.equal(exists(context, "t-1"), false);
	assert.ok(exists(context, "t-late"), "never announced to this session, so never a candidate");
	assert.equal(uidOf(context, "t-late", "trash"), 2);
	assert.deepEqual(marked(context, "trash"), [2], "the other session did mark it");
	assert.ok(texts(result).includes("* 1 EXPUNGE"));
	assert.deepEqual(marked(context, "trash"), [uidOf(context, "t-late", "trash")]);
	await assertInvariants(context);
});

// ---- Read-only and permissions ---------------------------------------------------------------------------

test("a5.3: UID EXPUNGE under EXAMINE is NO in every folder and changes nothing at all; a read-only delegate gets NOPERM", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1"]);
	await deliverMany(context, ["t-1"], { status: "trash" });
	await attach(context, "t-1", "a-1");
	draft(context, "d-1");
	for (const folder of ["INBOX", "Trash", "Drafts"]) {
		await context.client.command(`SELECT ${folder}`);
		assertTagged(await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)"), "OK", undefined, folder);
	}
	const before = state(context);
	const deletes = watchDeletes(context);
	for (const folder of ["INBOX", "Trash", "Drafts"]) {
		await context.client.command(`EXAMINE ${folder}`);
		assertTagged(await context.client.command("UID EXPUNGE 1:*"), "NO", /read-only/, folder);
	}
	assert.equal(state(context), before, "no flag change, relocation, deletion or UID allocation");
	assert.deepEqual(deletes, [], "no object cleanup");

	await context.deliver("s-1", "Subject: s\r\n\r\ns\r\n", { mailbox_id: "mbx-s", status: "trash" });
	exec(context, "INSERT INTO imap_folders (id, mailbox_id, folder_key, uid_validity, uid_next, created_at) VALUES ('imf-s-trash', 'mbx-s', 'trash', 7, 2, 1)");
	exec(context, "INSERT INTO imap_message_uids (imap_folder_id, uid, message_id, deleted, created_at) VALUES ('imf-s-trash', 1, 's-1', 1, 1)");
	const reader = await connect(context, SHARED);
	await reader.client.command("SELECT Trash");
	const sharedBefore = state(context);
	assertTagged(await reader.client.command("UID EXPUNGE 1"), "NO", /\[NOPERM\]/);
	assert.equal(state(context), sharedBefore);
	assert.equal(reader.session.isClosed, false, "a permission denial keeps the session");
});

// ---- Concurrency ---------------------------------------------------------------------------------------

test("a5.3 race: \\Deleted cleared, the message moved away, or another UID EXPUNGE first: nothing is moved or deleted twice", async (t) => {
	const cases = [
		["\\Deleted cleared by another session", async (context, other) => assertTagged(await other.client.command("UID STORE 1 -FLAGS.SILENT (\\Deleted)"), "OK"), { gone: false, report: ["* 1 FETCH (FLAGS ())"] }],
		["moved away by the web app", (context) => exec(context, "UPDATE messages SET status = 'archived', folder_id = NULL WHERE id = 'x-1'"), { gone: false, status: "archived", report: ["* 1 EXPUNGE"] }],
		["expunged first by another session", async (context, other) => assertTagged(await other.client.command("UID EXPUNGE 1"), "OK"), { gone: true, report: ["* 1 EXPUNGE"] }],
	];
	for (const folder of ["INBOX", "Trash"]) {
		for (const [name, race, outcome] of cases) {
			const label = `${folder}: ${name}`;
			const context = await setup(t);
			await deliverMany(context, ["x-1", "x-2"], folder === "Trash" ? { status: "trash" } : {});
			const other = await connect(context);
			await other.client.command(`SELECT ${folder}`);
			await context.client.command(`SELECT ${folder}`);
			assertTagged(await context.client.command("STORE 1:2 +FLAGS.SILENT (\\Deleted)"), "OK");
			await other.client.command("NOOP");
			const deletes = watchDeletes(context);
			beforeBatch(context, folder === "Trash" ? PERMANENT : RELOCATION, () => race(context, other));
			const result = await context.client.command("UID EXPUNGE 1");
			assertTagged(result, "OK", undefined, label);
			assert.ok(exists(context, "x-2") && context.row("x-2").status === (folder === "Trash" ? "trash" : "received"), `${label}: unrequested x-2 untouched`);
			if (folder === "Trash") {
				assert.equal(exists(context, "x-1"), !outcome.gone, label);
				if (!outcome.gone) assert.equal(context.row("x-1").status, outcome.status ?? "trash", label);
				assert.equal(deletes.filter((key) => key === "inbound/x-1.eml").length, outcome.gone ? 1 : 0, `${label}: its bytes are removed at most once`);
			} else {
				assert.equal(context.row("x-1").status, outcome.status ?? (outcome.gone ? "trash" : "received"), label);
				assert.equal(sql(context, "SELECT 1 FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key = 'trash' AND u.message_id = 'x-1'").length, outcome.gone ? 1 : 0, `${label}: at most one Trash UID`);
			}
			assert.deepEqual(texts(result), outcome.report, `${label}: EXPUNGE reported only if it left (a cleared mark is reported as a flag change)`);
			const retry = await context.client.command("UID EXPUNGE 1");
			assertTagged(retry, "OK", undefined, label);
			assert.deepEqual(texts(retry), [], `${label}: a retry changes nothing`);
			await assertInvariants(context);
		}
	}
});

test("a5.3: authority is re-checked inside the permanent delete: a credential revoked, access downgraded or removed, account or mailbox disabled deletes nothing", async (t) => {
	const cases = [
		["app password revoked", (context) => exec(context, `DELETE FROM mail_app_passwords WHERE id = '${context.credentialId}'`)],
		["mailbox access removed", (context) => exec(context, "DELETE FROM mailbox_access WHERE id = 'acc-b'")],
		["downgraded to read_only", (context) => exec(context, "UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-b'")],
		["user disabled", (context) => exec(context, "UPDATE users SET disabled = 1 WHERE id = 'user-b'")],
		["mailbox disabled", (context) => exec(context, "UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-s'")],
	];
	for (const folder of ["Trash", "Drafts"]) {
		for (const [name, revoke] of cases) {
			const label = `${folder}: ${name}`;
			const context = await sharedManager(t);
			if (folder === "Trash") await context.deliver("s-1", "Subject: s\r\n\r\ns\r\n", { mailbox_id: "mbx-s", status: "trash", user_id: "user-b" });
			else draft(context, "s-1", { userId: "user-b", mailboxId: "mbx-s" });
			await context.client.command(`SELECT ${folder}`);
			assertTagged(await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)"), "OK", undefined, label);
			const deletes = watchDeletes(context);
			beforeBatch(context, PERMANENT, () => revoke(context));
			await context.client.command("UID EXPUNGE 1");
			assert.ok(exists(context, "s-1"), label);
			assert.deepEqual(deletes, [], `${label}: storage untouched`);
		}
	}
});

test("a5.3: revoked access before UID EXPUNGE ends the session with BYE and moves nothing; a downgrade is NOPERM and the session goes on", async (t) => {
	for (const [name, revoke, expectBye] of [
		["app password revoked", (context) => exec(context, `DELETE FROM mail_app_passwords WHERE id = '${context.credentialId}'`), true],
		["access removed", (context) => exec(context, "DELETE FROM mailbox_access WHERE id = 'acc-b'"), true],
		["user disabled", (context) => exec(context, "UPDATE users SET disabled = 1 WHERE id = 'user-b'"), true],
		["mailbox disabled", (context) => exec(context, "UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-s'"), true],
		["downgraded to read_only", (context) => exec(context, "UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-b'"), false],
	]) {
		const context = await sharedManager(t);
		await context.deliver("s-1", "Subject: s\r\n\r\ns\r\n", { mailbox_id: "mbx-s" });
		await context.client.command("SELECT INBOX");
		assertTagged(await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)"), "OK");
		revoke(context);
		const result = await context.client.command("UID EXPUNGE 1");
		assert.equal(context.row("s-1").status, "received", name);
		if (expectBye) {
			assert.equal(result.tagged, null, name);
			assert.ok(result.untagged.some((unit) => /^\* BYE /.test(unit.text)), name);
		} else {
			assertTagged(result, "NO", /\[NOPERM\]/, name);
			assert.equal(context.session.isClosed, false, name);
		}
	}
});

// ---- Chunks, failures and storage ---------------------------------------------------------------------

test("a5.3: UID EXPUNGE spans chunks: 27 of 30 Trash UIDs in two delete batches, 90 of 100 INBOX UIDs in two relocation batches", async (t) => {
	const context = await setup(t);
	const trashIds = Array.from({ length: 30 }, (_, index) => `t-${String(index + 1).padStart(2, "0")}`);
	await deliverMany(context, trashIds, { status: "trash" });
	await context.client.command("SELECT Trash");
	assertTagged(await context.client.command("STORE 1:* +FLAGS.SILENT (\\Deleted)"), "OK");
	let batches = countBatches(context, PERMANENT);
	let result = await context.client.command("UID EXPUNGE 1:10,12:20,22:29");
	batches.stop();
	assertTagged(result, "OK");
	assert.equal(batches.n, 2, "25 + 2");
	assert.equal(texts(result).length, 27);
	assert.deepEqual(trashIds.filter((id) => exists(context, id)), ["t-11", "t-21", "t-30"]);

	const inboxIds = Array.from({ length: 100 }, (_, index) => `m-${String(index + 1).padStart(3, "0")}`);
	await deliverMany(context, inboxIds);
	await context.client.command("SELECT INBOX");
	assertTagged(await context.client.command("STORE 1:* +FLAGS.SILENT (\\Deleted)"), "OK");
	batches = countBatches(context, RELOCATION);
	result = await context.client.command("UID EXPUNGE 1:90");
	batches.stop();
	assertTagged(result, "OK");
	assert.equal(batches.n, 2, "80 + 10");
	assert.deepEqual(texts(result), Array.from({ length: 90 }, (_, index) => `* ${90 - index} EXPUNGE`));
	assert.equal(marked(context, "inbox").length, 10, "the ten unrequested marks stay");
	await assertInvariants(context);
});

test("a5.3 storage: a failing delete batch reaches no storage and answers NO [UNAVAILABLE]; a retry deletes; cleanup failures are logged and never undo it", async (t) => {
	const context = await setup(t);
	const logs = captureLogs(t);
	await deliverMany(context, ["t-1", "t-2", "t-3", "t-4", "t-5"], { status: "trash" });
	const kept = await attach(context, "t-2", "a-2");
	await context.client.command("SELECT Trash");
	assertTagged(await context.client.command("STORE 1:4 +FLAGS.SILENT (\\Deleted)"), "OK");
	// t-3's raw key is outside every message namespace; t-4 points at t-5's live bytes.
	exec(context, "UPDATE messages SET raw_r2_key = 'backups/not-a-message.eml' WHERE id = 't-3'");
	exec(context, "UPDATE messages SET raw_r2_key = 'inbound/t-5.eml' WHERE id = 't-4'");
	await context.env.BUCKET.put("backups/not-a-message.eml", "backup");
	const before = state(context);
	const deletes = watchDeletes(context, (key) => key === "inbound/t-2.eml");
	beforeBatch(context, PERMANENT, () => {
		throw new Error("injected batch failure");
	});
	assertTagged(await context.client.command("UID EXPUNGE 1:4"), "NO", /\[UNAVAILABLE\]/);
	assert.equal(state(context), before, "nothing deleted");
	assert.deepEqual(deletes, [], "no storage deletion when the database batch failed");

	await context.env.BUCKET.delete("inbound/t-1.eml");
	deletes.length = 0;
	const result = await context.client.command("UID EXPUNGE 1:4");
	assertTagged(result, "OK");
	assert.deepEqual(texts(result), ["* 4 EXPUNGE", "* 3 EXPUNGE", "* 2 EXPUNGE", "* 1 EXPUNGE"]);
	assert.deepEqual(["t-1", "t-2", "t-3", "t-4"].map((id) => exists(context, id)), [false, false, false, false]);
	assert.ok(deletes.includes("inbound/t-1.eml"), "an already-absent object is fine");
	assert.ok(await stored(context, "inbound/t-2.eml"), "a failed raw delete leaves an orphan");
	assert.equal(await stored(context, kept), false, "the attachment of that message is still removed");
	assert.ok(await stored(context, "backups/not-a-message.eml") && !deletes.includes("backups/not-a-message.eml"), "a disallowed key is never deleted");
	assert.ok(await stored(context, "inbound/t-5.eml") && exists(context, "t-5"), "a key a live row references is never deleted");
	assert.ok(logs.some((line) => line.event === "expunge.cleanup-failed" && line.messageId === "t-2" && line.key === "inbound/t-2.eml"));
	assert.ok(logs.some((line) => line.event === "expunge.cleanup-skipped" && line.messageId === "t-3"));
	assert.ok(logs.some((line) => line.event === "expunge.cleanup-skipped" && line.messageId === "t-4" && /still referenced/.test(line.reason)));
	await assertInvariants(context);
});

// ---- COPYUID on MOVE and UID MOVE ---------------------------------------------------------------------

test("a5.3: MOVE and UID MOVE report COPYUID with the destination's UIDVALIDITY and the allocated UIDs, in source order, before the EXPUNGEs", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3", "m-4", "m-5", "m-6"]);
	await deliverMany(context, ["a-1", "a-2", "a-3"], { status: "archived" });
	await context.client.command("SELECT Archive");
	await context.client.command("SELECT INBOX");
	assert.equal(one(context, "SELECT uid_next FROM imap_folders WHERE folder_key = 'archive'").uid_next, 4, "Archive already holds three UIDs");

	const single = await context.client.command("MOVE 1 Archive");
	assertTagged(single, "OK", /^\S+ OK MOVE completed$/);
	assert.deepEqual(texts(single), [`* OK [COPYUID ${uidValidity(context, "archive")} 1 4] Moved`, "* 1 EXPUNGE"]);
	assert.equal(uidOf(context, "m-1", "archive"), 4);

	// Sequence numbers now name UIDs 2..6; a reversed range is the same set, reported ascending.
	const reversed = await context.client.command("MOVE 4:2 Archive");
	assertTagged(reversed, "OK");
	assert.deepEqual(texts(reversed), [`* OK [COPYUID ${uidValidity(context, "archive")} 3:5 5:7] Moved`, "* 4 EXPUNGE", "* 3 EXPUNGE", "* 2 EXPUNGE"]);
	assert.deepEqual(["m-3", "m-4", "m-5"].map((id) => uidOf(context, id, "archive")), [5, 6, 7]);

	// UID MOVE into a folder with no IMAP state yet: its state row is created by the move.
	assert.equal(uidValidity(context, "junk"), undefined);
	const created = await context.client.command("UID MOVE 2,6,99 Spam");
	assertTagged(created, "OK", /^\S+ OK UID MOVE completed$/);
	const junkValidity = uidValidity(context, "junk");
	assert.ok(junkValidity > 0);
	assert.deepEqual(texts(created), [`* OK [COPYUID ${junkValidity} 2,6 1:2] Moved`, "* 2 EXPUNGE", "* 1 EXPUNGE"], "non-contiguous sources, nonexistent UID 99 ignored");
	await assertInvariants(context);
});

test("a5.3: a destination UID kept from an earlier stay is reported as it is, not guessed; the mapping may run backwards", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	assertTagged(await context.client.command("UID MOVE 2 Archive"), "OK");
	await context.client.command("SELECT Archive");
	assert.equal(uidOf(context, "m-2", "archive"), 1);
	// The web app moves m-2 back to INBOX; Archive is not read again, so its UID 1 mapping is kept.
	await context.client.command("SELECT INBOX");
	exec(context, "UPDATE messages SET status = 'received' WHERE id = 'm-2'");
	assert.deepEqual(texts(await context.client.command("NOOP")), ["* 2 EXISTS"]);
	assert.deepEqual((await context.client.command("UID SEARCH ALL")).untagged[0].text, "* SEARCH 1 3");
	const result = await context.client.command("UID MOVE 1,3 Archive");
	assertTagged(result, "OK");
	assert.deepEqual(texts(result), [`* OK [COPYUID ${uidValidity(context, "archive")} 1,3 2,1] Moved`, "* 2 EXPUNGE", "* 1 EXPUNGE"], "m-1 gets the next UID, m-2 keeps its UID 1");
	assert.deepEqual([uidOf(context, "m-1", "archive"), uidOf(context, "m-2", "archive")], [2, 1]);
	await assertInvariants(context);
});

test("a5.3: no COPYUID for a MOVE that did not commit: policy refusals, unknown destinations, readers, database failures, vanished sources", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	// Archive's IMAP state row exists first (a MOVE creates it before its batch, as since A5.2b).
	await context.client.command("SELECT Archive");
	await context.client.command("SELECT INBOX");
	const before = state(context);
	for (const [command, pattern] of [["MOVE 1 Sent", /\[CANNOT\]/], ["UID MOVE 1 Drafts", /\[CANNOT\]/], ["MOVE 1 INBOX", /\[CANNOT\]/], ["MOVE 1 Nowhere", /\[NONEXISTENT\]/], ["MOVE 9 Archive", /Invalid message sequence number/]]) {
		const result = await context.client.command(command);
		assert.ok(/ (NO|BAD) /.test(result.tagged), command);
		assert.match(result.tagged, pattern, command);
		assert.deepEqual(copyUids(result), [], command);
	}
	beforeBatch(context, RELOCATION, () => {
		throw new Error("injected batch failure");
	});
	const failed = await context.client.command("MOVE 1:2 Archive");
	assertTagged(failed, "NO", /\[UNAVAILABLE\]/);
	assert.deepEqual(copyUids(failed), []);
	assert.equal(state(context), before, "nothing moved");
	// Every source left before the batch: nothing moves, nothing is mapped.
	beforeBatch(context, RELOCATION, () => exec(context, "UPDATE messages SET status = 'spam'"));
	const vanished = await context.client.command("MOVE 1:2 Archive");
	assertTagged(vanished, "NO", /no longer exist/);
	assert.deepEqual(texts(vanished), ["* 2 EXPUNGE", "* 1 EXPUNGE"], "their departure is reported, without COPYUID");
	// Without the bp0003 trigger MOVE is CANNOT.
	await context.deliver("m-3", "Subject: m-3\r\n\r\nx\r\n");
	await context.client.command("NOOP");
	exec(context, "DROP TRIGGER bp_imap_membership_clears_deleted");
	const noTrigger = await context.client.command("MOVE 1 Archive");
	assertTagged(noTrigger, "NO", /\[CANNOT\]/);
	assert.deepEqual(copyUids(noTrigger), []);
	assert.equal(context.row("m-3").status, "received");

	const reader = await connect(context, SHARED);
	await context.deliver("s-1", "Subject: s\r\n\r\ns\r\n", { mailbox_id: "mbx-s" });
	await reader.client.command("SELECT INBOX");
	const denied = await reader.client.command("MOVE 1 Archive");
	assertTagged(denied, "NO", /\[NOPERM\]/);
	assert.deepEqual(copyUids(denied), []);
	assert.equal(context.row("s-1").status, "received");
});

test("a5.3: no COPYUID when access is lost: a revoked app password, removed access, a disabled user or mailbox end the session with BYE; a downgrade is NOPERM", async (t) => {
	for (const [name, revoke, expectBye] of [
		["app password revoked", (context) => exec(context, `DELETE FROM mail_app_passwords WHERE id = '${context.credentialId}'`), true],
		["access removed", (context) => exec(context, "DELETE FROM mailbox_access WHERE id = 'acc-b'"), true],
		["user disabled", (context) => exec(context, "UPDATE users SET disabled = 1 WHERE id = 'user-b'"), true],
		["mailbox disabled", (context) => exec(context, "UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-s'"), true],
		["downgraded to read_only", (context) => exec(context, "UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-b'"), false],
	]) {
		const context = await sharedManager(t);
		await context.deliver("s-1", "Subject: s\r\n\r\ns\r\n", { mailbox_id: "mbx-s" });
		await context.client.command("SELECT INBOX");
		revoke(context);
		const result = await context.client.command("MOVE 1 Archive");
		assert.deepEqual(copyUids(result), [], name);
		assert.equal(context.row("s-1").status, "received", name);
		if (expectBye) assert.ok(result.tagged === null && result.untagged.some((unit) => /^\* BYE /.test(unit.text)), name);
		else assertTagged(result, "NO", /\[NOPERM\]/, name);
	}
});

test("a5.3: a MOVE whose later chunk is refused reports no COPYUID at all (never a partial or guessed mapping); the committed chunk's EXPUNGEs are reported", async (t) => {
	const context = await sharedManager(t);
	const ids = Array.from({ length: 90 }, (_, index) => `s-${String(index + 1).padStart(2, "0")}`);
	await deliverMany(context, ids, { mailbox_id: "mbx-s" });
	await context.client.command("SELECT INBOX");
	afterBatch(context, RELOCATION, () => exec(context, "UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-b'"));
	const result = await context.client.command("MOVE 1:* Archive");
	assertTagged(result, "NO", /\[NOPERM\]/);
	assert.deepEqual(copyUids(result), []);
	assert.equal(texts(result).length, 80, "the first chunk committed and is reported");
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages WHERE status = 'archived'").n, 80);
});

test("a5.3: copyUidData writes exact, order-preserving uid-sets and refuses anything it cannot report exactly", () => {
	const entry = (uid, destinationUid, destinationUidValidity = 77) => ({ uid, messageId: `m-${uid}`, destinationUid, destinationUidValidity });
	assert.equal(app.copyUidData([]), null);
	assert.equal(app.copyUidData([entry(1, 10)]), "77 1 10");
	assert.equal(app.copyUidData([entry(1, 10), entry(2, 11), entry(3, 12)]), "77 1:3 10:12");
	assert.equal(app.copyUidData([entry(2, 10), entry(4, 11), entry(5, 12)]), "77 2,4:5 10:12");
	assert.equal(app.copyUidData([entry(1, 5), entry(2, 3), entry(3, 4)]), "77 1:3 5,3:4", "destination order follows the sources, never sorted");
	assert.equal(app.copyUidData([entry(1, 10), entry(2, null)]), null, "an unknown destination UID is never guessed");
	assert.equal(app.copyUidData([entry(1, 10, 77), entry(2, 11, 78)]), null, "chunks that saw different UIDVALIDITY values");
	assert.equal(app.copyUidData([entry(1, 10, null)]), null);
});
