import assert from "node:assert/strict";
import test from "node:test";
import { assertTagged, fetchAttributes, install, latin1, loadApp, memoryClient } from "./support/imap-harness.mjs";

/**
 * A5.2b: IMAP MOVE and UID MOVE (RFC 6851), over the real A2 verifier, A3 state, bp0003
 * trigger, spam filter and product routes (SQLite + file bucket).
 *
 * - MOVE needs management access and the bp0003 invariant, like EXPUNGE.
 * - The special-folder policy: Sent and Drafts are never destinations, Drafts only go to
 *   Trash (and only their author's), Sent mail never goes to Spam, the same folder is refused.
 * - Each chunk is one atomic relocation: product state, a fresh destination UID without
 *   \Deleted, the source UID released. Nothing is deleted or rewritten.
 * - Moving into Spam trains spam, Spam -> INBOX trains ham, after the move and idempotently.
 */
const { app, cleanup } = await loadApp("imap-move");
test.after(cleanup);

const BASE = "http://mailflare.local";
const TRIGGER = "bp_imap_membership_clears_deleted";
const texts = (result) => result.untagged.map((unit) => unit.text);
const SHARED_READER = { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" };
const SHARED_MANAGER = { userId: "user-x", mailboxId: "mbx-s", address: "sales@example.test" };
const OWNER = { userId: "user-a", mailboxId: "mbx-a" };

async function connect(context, { userId = "user-a", mailboxId = "mbx-a", address = "a@example.test" } = {}) {
	const { client, session, start } = memoryClient(app, context.env);
	await start();
	const { credential, id } = await context.credential(userId, mailboxId);
	assertTagged(await client.login(address, credential), "OK");
	return { client, session, credentialId: id };
}

async function setup(t, account) {
	const context = await install(app, t);
	// user-x is a full_access delegate of the shared mailbox (user-b stays read_only).
	context.database.db.exec("INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('acc-x', 'mbx-s', 'user-x', 'full_access', 1)");
	return { ...context, ...(await connect(context, account)) };
}

async function web(context, handler, path, { body, userId = "user-a" } = {}) {
	const token = await app.createSession(context.env, userId);
	const request = new Request(`${BASE}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const response = await handler(request);
	assert.equal(response.status, 200, `${path} answered ${response.status}`);
}
const bulk = (context, messageIds, action, extra = {}) => web(context, app.bulkRoute, "/api/messages/bulk", { body: { messageIds, action, ...extra } });

let keyCounter = 0;
/** A JMAP Email/set move, through the real JMAP handler and an API key with the jmap scope. */
async function jmapMove(context, messageId, ref) {
	const { fullKey, prefix, hash } = app.generateApiKey();
	context.database.db.prepare("INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, created_at) VALUES (?, 'legacy', 'user-a', 'jmap', ?, ?, ?, 1)").run(`key-${++keyCounter}`, prefix, hash, JSON.stringify(["jmap"]));
	const body = { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [["Email/set", { accountId: "user-a", update: { [messageId]: { mailboxIds: { [app.encodeMailboxRef(ref)]: true } } } }, "0"]] };
	const response = await app.handleJmapRequest(new Request(`${BASE}/jmap/api`, { method: "POST", headers: { Authorization: `Bearer ${fullKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), context.env);
	const result = await response.json();
	assert.deepEqual(result.methodResponses[0][1].updated, { [messageId]: null }, JSON.stringify(result));
}

async function deliverMany(context, ids, values) {
	for (const id of ids) await context.deliver(id, `Subject: ${id}\r\nFrom: sender@elsewhere.test\r\n\r\nbody of ${id} with some words cheap pills offer\r\n`, values);
}

const sql = (context, query, ...params) => context.database.db.prepare(query).all(...params);
const one = (context, query, ...params) => context.database.db.prepare(query).get(...params);
const mapping = (context, messageId) => sql(context, "SELECT f.folder_key AS folder, u.uid, u.deleted FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE u.message_id = ? ORDER BY f.folder_key", messageId);
const uidValidity = (context, key, mailboxId = "mbx-a") => one(context, "SELECT uid_validity FROM imap_folders WHERE mailbox_id = ? AND folder_key = ?", mailboxId, key)?.uid_validity;
/** The COPYUID line a committed MOVE sends first (A5.3). */
const copyUid = (context, key, source, destination, mailboxId = "mbx-a") => `* OK [COPYUID ${uidValidity(context, key, mailboxId)} ${source} ${destination}] Moved`;
const uidNext = (context, key, mailboxId = "mbx-a") => one(context, "SELECT uid_next FROM imap_folders WHERE mailbox_id = ? AND folder_key = ?", mailboxId, key)?.uid_next;
const where = (context, id) => {
	const row = context.row(id);
	return { status: row.status, folder: row.folder_id };
};
const productState = (context) => JSON.stringify([
	sql(context, "SELECT id, status, read, starred, folder_id, raw_r2_key, created_at FROM messages ORDER BY id"),
	sql(context, "SELECT imap_folder_id, uid, message_id, deleted FROM imap_message_uids ORDER BY imap_folder_id, uid"),
	sql(context, "SELECT id, uid_next, uid_validity FROM imap_folders ORDER BY id"),
]);
const feedback = (context, id) => one(context, "SELECT classification, actor_user_id FROM spam_feedback WHERE message_id = ?", id) ?? null;
const tokenTotals = (context, mailboxId = "mbx-a") => one(context, "SELECT COALESCE(SUM(spam_count), 0) AS spam, COALESCE(SUM(ham_count), 0) AS ham, COUNT(*) AS n FROM spam_token_stats WHERE mailbox_id = ?", mailboxId);

/**
 * The A5.2b safety invariants: no message row deleted, stored bytes intact, one UID per
 * message per folder, unique UIDs, nothing in Trash or Drafts marked \Deleted, no message
 * holding a live UID in two folders, and every mapping's message a member of its folder
 * or at most a stale mapping in a folder other than its own.
 */
async function assertInvariants(context, expectedMessages) {
	const rows = sql(context, "SELECT id, raw_r2_key FROM messages ORDER BY id");
	if (expectedMessages !== undefined) assert.equal(rows.length, expectedMessages, "no message row was deleted");
	for (const row of rows) if (row.raw_r2_key) assert.ok(await context.env.BUCKET.get(row.raw_r2_key), `stored bytes of ${row.id} still exist`);
	assert.deepEqual(sql(context, "SELECT imap_folder_id, message_id, COUNT(*) AS n FROM imap_message_uids GROUP BY imap_folder_id, message_id HAVING n > 1"), [], "one UID per message per folder");
	assert.deepEqual(sql(context, "SELECT imap_folder_id, uid, COUNT(*) AS n FROM imap_message_uids GROUP BY imap_folder_id, uid HAVING n > 1"), [], "UIDs are unique per folder");
	assert.deepEqual(sql(context, "SELECT u.uid FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key IN ('trash', 'drafts') AND u.deleted = 1"), [], "nothing in Trash or Drafts is marked \\Deleted");
	assert.deepEqual(sql(context, "SELECT uid_next FROM imap_folders f WHERE uid_next <= (SELECT COALESCE(MAX(uid), 0) FROM imap_message_uids u WHERE u.imap_folder_id = f.id)"), [], "UIDNEXT is above every assigned UID");
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
/** Count the D1 batches whose SQL matches `pattern` until `stop()` is called. */
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
const RELOCATION = /UPDATE messages SET status/;
const TRAINING = /spam_token_stats/;

// ---- Protocol surface -------------------------------------------------------------------------

test("a5.2b/a5.3: MOVE and UIDPLUS are advertised after authentication only; malformed MOVE is BAD and changes nothing", async (t) => {
	const context = await install(app, t);
	const { client, start } = memoryClient(app, context.env);
	const greeting = await start();
	assert.ok(!greeting.text.split(/[ \]]/).includes("MOVE"), "not before authentication");
	assert.deepEqual(texts(await client.command("CAPABILITY")), ["* CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN ID"]);
	assertTagged(await client.command("MOVE 1 Trash"), "BAD", /not valid in this state/);
	const { credential } = await context.credential("user-a", "mbx-a");
	assertTagged(await client.login("a@example.test", credential), "OK", /\[CAPABILITY IMAP4rev1 ID NAMESPACE UNSELECT SPECIAL-USE MOVE UIDPLUS IDLE\]/);
	const capability = texts(await client.command("CAPABILITY"))[0];
	assert.equal(capability, "* CAPABILITY IMAP4rev1 ID NAMESPACE UNSELECT SPECIAL-USE MOVE UIDPLUS IDLE");
	for (const absent of ["CONDSTORE", "QRESYNC", "LITERAL+"]) assert.ok(!capability.split(" ").includes(absent), absent);
	assertTagged(await client.command("MOVE 1 Trash"), "BAD", /not valid in this state/, "authenticated but nothing selected");
	assertTagged(await client.command("UID MOVE 1 Trash"), "BAD", /not valid in this state/);

	await context.deliver("m-1", "Subject: x\r\n\r\nx\r\n");
	await context.deliver("m-2", "Subject: y\r\n\r\ny\r\n");
	await client.command("SELECT INBOX");
	const before = productState(context);
	for (const command of ["MOVE", "MOVE 1", "MOVE 1 ", "MOVE x Trash", "MOVE 1 Trash extra", "MOVE 1 (Trash)", "MOVE 1,,2 Trash", "MOVE 0:x Trash", "UID MOVE", "UID MOVE 1", "UID MOVE ** Trash", "MOVE  1 Trash"]) {
		assertTagged(await client.command(command), "BAD", undefined, command);
	}
	assertTagged(await client.command("MOVE 3 Trash"), "BAD", /Invalid message sequence number/, "beyond the mailbox");
	// UID EXPUNGE (A5.3) with nothing marked changes nothing; COPY is still unimplemented.
	assertTagged(await client.command("UID EXPUNGE 1"), "OK");
	assertTagged(await client.command("COPY 1 Trash"), "NO", /\[CANNOT\]/);
	assertTagged(await client.command("UID COPY 1 Trash"), "NO", /\[CANNOT\]/);
	assert.equal(productState(context), before);
	// EXAMINE is read-only: MOVE is refused before any storage call.
	await client.command("EXAMINE INBOX");
	assertTagged(await client.command("MOVE 1 Trash"), "NO", /read-only/);
	assert.equal(productState(context), before);
	// A mailbox name in any form the listener accepts: quoted, literal, INBOX case-insensitively.
	await client.command("SELECT Archive");
	await client.command("UNSELECT");
	await client.command("SELECT INBOX");
	assertTagged(await client.command('MOVE 2 "Archive"'), "OK");
	client.write("lit MOVE 1 {7}\r\n");
	assert.match((await client.unit()).text, /^\+ /);
	client.write("Archive\r\n");
	assertTagged(await client.collect("lit"), "OK");
	await client.command("SELECT Archive");
	assertTagged(await client.command("MOVE 1:2 inbox"), "OK");
	assert.deepEqual([where(context, "m-1"), where(context, "m-2")], [{ status: "received", folder: null }, { status: "received", folder: null }]);
	await assertInvariants(context, 2);
});

// ---- MOVE and UID MOVE ------------------------------------------------------------------------

test("a5.2b: MOVE relocates messages with fresh destination UIDs, COPYUID, EXPUNGE in the client's sequence space, and nothing else changed", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3", "m-4", "m-5", "m-6"]);
	context.database.db.exec("UPDATE messages SET read = 1 WHERE id = 'm-2'; UPDATE messages SET starred = 1 WHERE id = 'm-4'");
	await context.client.command("SELECT INBOX");
	const original = {};
	for (const [index, id] of ["m-1", "m-2", "m-3", "m-4", "m-5", "m-6"].entries()) {
		const unit = (await context.client.command(`FETCH ${index + 1} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])`)).untagged[0];
		const stored = await context.env.BUCKET.get(`inbound/${id}.eml`);
		original[id] = { attributes: fetchAttributes(unit.text), bytes: latin1(new Uint8Array(await stored.arrayBuffer())) };
	}
	const watcherSource = await connect(context);
	await watcherSource.client.command("SELECT INBOX");
	const watcherDestination = await connect(context);
	const archiveSelect = await watcherDestination.client.command("SELECT Archive");
	assert.ok(texts(archiveSelect).includes("* 0 EXISTS"));
	const archiveNext = uidNext(context, "archive");

	const moved = await context.client.command("MOVE 2,4:5 Archive");
	assertTagged(moved, "OK", /^\S+ OK MOVE completed$/);
	assert.deepEqual(texts(moved), [copyUid(context, "archive", "2,4:5", `${archiveNext}:${archiveNext + 2}`), "* 5 EXPUNGE", "* 4 EXPUNGE", "* 2 EXPUNGE"], "COPYUID first (A5.3), then EXPUNGE highest first, in the sequence numbers the client knew");
	for (const id of ["m-2", "m-4", "m-5"]) {
		assert.deepEqual(where(context, id), { status: "archived", folder: null });
		assert.equal(mapping(context, id).length, 1);
		assert.equal(mapping(context, id)[0].folder, "archive");
		assert.equal(mapping(context, id)[0].deleted, 0);
	}
	assert.deepEqual(["m-2", "m-4", "m-5"].map((id) => mapping(context, id)[0].uid), [archiveNext, archiveNext + 1, archiveNext + 2], "destination UIDs in source UID order");
	assert.equal(uidNext(context, "archive"), archiveNext + 3);
	assert.equal(context.row("m-2").read, 1);
	assert.equal(context.row("m-4").starred, 1);
	// NOOP reports nothing again, and the remaining messages are renumbered 1..3.
	assert.deepEqual(texts(await context.client.command("NOOP")), []);
	assert.deepEqual((await context.client.command("FETCH 1:* (UID)")).untagged.map((unit) => fetchAttributes(unit.text).UID), [1, 3, 6]);
	// Other sessions: the source watcher is told on its next NOOP, the destination one sees arrivals.
	assert.deepEqual(texts(await watcherSource.client.command("NOOP")), ["* 5 EXPUNGE", "* 4 EXPUNGE", "* 2 EXPUNGE"]);
	assert.ok(texts(await watcherDestination.client.command("NOOP")).includes("* 3 EXISTS"));
	// The moved messages serve the same octets, size, date and flags under their new UIDs.
	for (const [seq, id] of [[1, "m-2"], [2, "m-4"], [3, "m-5"]]) {
		const unit = (await watcherDestination.client.command(`FETCH ${seq} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])`)).untagged[0];
		const attributes = fetchAttributes(unit.text);
		assert.equal(attributes["BODY[]"], original[id].attributes["BODY[]"], `${id} bytes`);
		assert.equal(attributes["BODY[]"], original[id].bytes);
		assert.equal(attributes["RFC822.SIZE"], original[id].attributes["RFC822.SIZE"]);
		assert.equal(attributes.INTERNALDATE, original[id].attributes.INTERNALDATE);
		assert.deepEqual(attributes.FLAGS, original[id].attributes.FLAGS);
		assert.equal(context.row(id).raw_r2_key, `inbound/${id}.eml`, "no object copied or rewritten");
	}
	await assertInvariants(context, 6);
});

test("a5.2b: UID MOVE resolves stable UIDs, ignores UIDs that do not exist, moves into a custom folder and reports EXPUNGE", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3", "m-4"]);
	await context.client.command("SELECT INBOX");
	const moved = await context.client.command("UID MOVE 2,4,99 Work");
	assertTagged(moved, "OK", /^\S+ OK UID MOVE completed$/);
	assert.deepEqual(texts(moved), [copyUid(context, "f:fld-work", "2,4", "1:2"), "* 4 EXPUNGE", "* 2 EXPUNGE"]);
	assert.deepEqual(where(context, "m-2"), { status: "received", folder: "fld-work" });
	assert.deepEqual(where(context, "m-4"), { status: "received", folder: "fld-work" });
	assert.deepEqual(mapping(context, "m-2"), [{ folder: "f:fld-work", uid: 1, deleted: 0 }]);
	assert.deepEqual(mapping(context, "m-4"), [{ folder: "f:fld-work", uid: 2, deleted: 0 }]);
	// Every UID named is gone or never existed: nothing happens and the answer is OK.
	const again = await context.client.command("UID MOVE 2,4,99 Work");
	assertTagged(again, "OK");
	assert.deepEqual(texts(again), []);
	// `*` and ranges.
	assertTagged(await context.client.command("UID MOVE 3:* Archive"), "OK");
	assert.deepEqual(where(context, "m-3"), { status: "archived", folder: null });
	assert.deepEqual((await context.client.command("UID FETCH 1:* (UID)")).untagged.map((unit) => fetchAttributes(unit.text).UID), [1]);
	await assertInvariants(context, 4);
});

test("a5.2b: a full 80-UID chunk and a multi-chunk MOVE: 170 messages, three atomic batches, contiguous destination UIDs, 170 EXPUNGEs highest first", async (t) => {
	const context = await setup(t);
	const ids = Array.from({ length: 170 }, (_, index) => `m-${String(index + 1).padStart(3, "0")}`);
	await deliverMany(context, ids);
	await context.client.command("SELECT INBOX");
	const batches = countBatches(context, RELOCATION);
	const moved = await context.client.command("MOVE 1:* Archive");
	batches.stop();
	assertTagged(moved, "OK");
	assert.equal(batches.n, 3, "80 + 80 + 10");
	assert.deepEqual(texts(moved), [copyUid(context, "archive", "1:170", "1:170"), ...Array.from({ length: 170 }, (_, index) => `* ${170 - index} EXPUNGE`)], "one COPYUID covers every chunk");
	assert.deepEqual(ids.map((id) => mapping(context, id)[0].uid), Array.from({ length: 170 }, (_, index) => index + 1));
	assert.equal(uidNext(context, "archive"), 171);
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages WHERE status = 'archived'").n, 170);
	await assertInvariants(context, 170);
});

// ---- \Deleted --------------------------------------------------------------------------------

test("a5.2b: MOVE never carries \\Deleted: a marked message arrives unmarked, and moving it away and back gives a fresh unmarked UID", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	assertTagged(await context.client.command("STORE 1:2 +FLAGS.SILENT (\\Deleted)"), "OK");
	const watcher = await connect(context);
	await watcher.client.command("SELECT Archive");
	assertTagged(await context.client.command("MOVE 1 Archive"), "OK");
	assert.deepEqual(mapping(context, "m-1"), [{ folder: "archive", uid: 1, deleted: 0 }]);
	const seen = texts(await watcher.client.command("NOOP"));
	assert.ok(seen.includes("* 1 EXISTS"));
	assert.deepEqual((await watcher.client.command("FETCH 1 (FLAGS)")).untagged.map((unit) => fetchAttributes(unit.text).FLAGS), [[]], "a second session sees no \\Deleted");
	// The other marked message still carries its mark in INBOX.
	assert.deepEqual(mapping(context, "m-2"), [{ folder: "inbox", uid: 2, deleted: 1 }]);
	// Away and back: INBOX gives it a new UID above the old ones, unmarked.
	assertTagged(await watcher.client.command("MOVE 1 INBOX"), "OK");
	assert.deepEqual(mapping(context, "m-1"), [{ folder: "inbox", uid: 3, deleted: 0 }]);
	assert.ok(texts(await context.client.command("NOOP")).includes("* 2 EXISTS"));
	assert.deepEqual((await context.client.command("FETCH 1:* (UID FLAGS)")).untagged.map((unit) => fetchAttributes(unit.text)), [{ UID: 2, FLAGS: ["\\Deleted"] }, { UID: 3, FLAGS: [] }]);
	// EXPUNGE now moves only m-2.
	assertTagged(await context.client.command("EXPUNGE"), "OK");
	assert.equal(context.row("m-1").status, "received");
	assert.equal(context.row("m-2").status, "trash");
	await assertInvariants(context, 2);
});

// ---- Special-folder policy ----------------------------------------------------------------------

const FOLDERS = ["INBOX", "Work", "Archive", "Spam", "Trash", "Sent", "Drafts"];
const PLACE = {
	INBOX: { status: "received", folder: null },
	Work: { status: "received", folder: "fld-work" },
	Archive: { status: "archived", folder: null },
	Spam: { status: "spam", folder: null },
	Trash: { status: "trash", folder: null },
	Sent: { status: "sent", folder: null },
	Drafts: { status: "draft", folder: null },
};
/** The A5.2b matrix: destinations each source may MOVE to. */
const ALLOWED = {
	INBOX: ["Work", "Archive", "Spam", "Trash"],
	Work: ["INBOX", "Archive", "Spam", "Trash"],
	Archive: ["INBOX", "Work", "Spam", "Trash"],
	Spam: ["INBOX", "Work", "Archive", "Trash"],
	Trash: ["INBOX", "Work", "Archive", "Spam"],
	Sent: ["INBOX", "Work", "Archive", "Trash"],
	Drafts: ["Trash"],
};

test("a5.2b: the special-folder matrix: every source × destination, with Sent and Drafts never destinations and the same folder refused", async (t) => {
	const context = await setup(t);
	let counter = 0;
	for (const source of FOLDERS) {
		for (const destination of FOLDERS) {
			const id = `c-${++counter}`;
			const outbound = source === "Sent" || source === "Drafts";
			await context.deliver(id, `Subject: ${id}\r\n\r\n${id}\r\n`, { status: PLACE[source].status, folder_id: PLACE[source].folder, direction: outbound ? "outbound" : "inbound", from_addr: outbound ? "a@example.test" : "sender@elsewhere.test" });
			await context.client.command(`SELECT ${source}`);
			const before = productState(context);
			const sourceUid = mapping(context, id)[0].uid;
			const result = await context.client.command(`UID MOVE ${sourceUid} ${destination}`);
			const label = `${source} -> ${destination}`;
			if (ALLOWED[source].includes(destination)) {
				assertTagged(result, "OK", undefined, label);
				assert.equal(texts(result).length, 2, label);
				assert.equal(texts(result)[0], copyUid(context, mapping(context, id)[0].folder, sourceUid, mapping(context, id)[0].uid), `${label}: COPYUID with the destination's UIDVALIDITY and allocated UID`);
				assert.match(texts(result)[1], /^\* \d+ EXPUNGE$/, label);
				assert.deepEqual(where(context, id), PLACE[destination], label);
				assert.equal(mapping(context, id).length, 1, label);
				assert.equal(mapping(context, id)[0].deleted, 0, label);
			} else {
				assertTagged(result, "NO", /^\S+ NO \[CANNOT\] /, label);
				assert.deepEqual(texts(result), [], label);
				assert.equal(productState(context), before, `${label} changes nothing (no UID allocated)`);
				assert.deepEqual(where(context, id), PLACE[source], label);
			}
		}
	}
	assert.equal(context.session.isClosed, false);
	await assertInvariants(context, counter);
});

test("a5.2b: refusal texts name the rule; a nonexistent destination is NONEXISTENT and the session goes on", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1"]);
	await context.deliver("s-1", "Subject: s\r\n\r\ns\r\n", { status: "sent", direction: "outbound" });
	await context.deliver("o-1", "Subject: o\r\n\r\no\r\n", { direction: "outbound" });
	await app.imap.openImapFolder(context.env, OWNER, "sent");
	await context.client.command("SELECT INBOX");
	const before = productState(context);
	assertTagged(await context.client.command("MOVE 1 Sent"), "NO", /\[CANNOT\] Messages cannot be moved into Sent/);
	assertTagged(await context.client.command("MOVE 1 Drafts"), "NO", /\[CANNOT\] Messages cannot be moved into Drafts/);
	assertTagged(await context.client.command("MOVE 1 INBOX"), "NO", /\[CANNOT\] Messages are already in that mailbox/);
	assertTagged(await context.client.command("MOVE 1 Nope"), "NO", /\[NONEXISTENT\]/);
	assertTagged(await context.client.command("MOVE 1 Private"), "NO", /\[NONEXISTENT\]/, "another mailbox's folder cannot be named");
	assertTagged(await context.client.command('MOVE 1 "f:fld-work"'), "NO", /\[NONEXISTENT\]/, "internal keys are not names");
	// Outbound mail in INBOX (moved there earlier) cannot go to Spam, as in the web app.
	assertTagged(await context.client.command("MOVE 1:2 Spam"), "NO", /\[CANNOT\] Sent mail cannot be moved to Spam/);
	await context.client.command("SELECT Sent");
	assertTagged(await context.client.command("MOVE 1 Spam"), "NO", /\[CANNOT\] Sent mail cannot be moved to Spam/);
	await context.client.command("SELECT INBOX");
	assert.equal(productState(context), before);
	assertTagged(await context.client.command("NOOP"), "OK");
	assert.equal(context.session.isClosed, false);
	await assertInvariants(context, 3);
});

// ---- Authorization ------------------------------------------------------------------------------

test("a5.2b: MOVE needs full access: read_only and send_* get NOPERM and keep the session; revocation and app-password revocation end it", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["s-1", "s-2"], { mailbox_id: "mbx-s" });
	for (const permission of ["read_only", "send_as", "send_on_behalf"]) {
		context.database.db.prepare("UPDATE mailbox_access SET permission = ? WHERE id = 'acc-b'").run(permission);
		const reader = await connect(context, SHARED_READER);
		assertTagged(await reader.client.command("SELECT INBOX"), "OK");
		const before = productState(context);
		assertTagged(await reader.client.command("MOVE 1 Archive"), "NO", /^\S+ NO \[NOPERM\] /, permission);
		assertTagged(await reader.client.command("UID MOVE 1:* Trash"), "NO", /\[NOPERM\]/, permission);
		assert.equal(productState(context), before, permission);
		assertTagged(await reader.client.command("NOOP"), "OK", undefined, "the session goes on");
	}
	// Downgraded after SELECT, before the command.
	const manager = await connect(context, SHARED_MANAGER);
	await manager.client.command("SELECT INBOX");
	context.database.db.exec("UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-x'");
	const before = productState(context);
	assertTagged(await manager.client.command("MOVE 1 Archive"), "NO", /\[NOPERM\]/);
	assert.equal(productState(context), before);
	context.database.db.exec("UPDATE mailbox_access SET permission = 'full_access' WHERE id = 'acc-x'");
	assertTagged(await manager.client.command("MOVE 1 Archive"), "OK");
	assert.equal(context.row("s-1").status, "archived");
	// Access revoked entirely: BYE, nothing moves.
	const stateBefore = productState(context);
	context.database.db.exec("DELETE FROM mailbox_access WHERE id = 'acc-x'");
	const revoked = await manager.client.command("MOVE 1 Archive");
	assert.equal(revoked.untagged.at(-1).text, "* BYE Access revoked");
	assert.equal(productState(context), stateBefore);
	// App password revoked: BYE, nothing moves.
	const owner = await connect(context);
	await owner.client.command("SELECT INBOX");
	await deliverMany(context, ["m-1"]);
	await owner.client.command("NOOP");
	const ownerBefore = productState(context);
	context.database.db.prepare("DELETE FROM mail_app_passwords WHERE id = ?").run(owner.credentialId);
	assert.equal((await owner.client.command("MOVE 1 Trash")).untagged.at(-1).text, "* BYE Access revoked");
	assert.equal(productState(context), ownerBefore);
	await assertInvariants(context, 3);
});

test("a5.2b: a permission downgrade between chunks keeps the committed chunk, moves nothing more, reports its EXPUNGEs and answers NOPERM", async (t) => {
	const context = await setup(t, SHARED_MANAGER);
	const ids = Array.from({ length: 100 }, (_, index) => `s-${String(index + 1).padStart(3, "0")}`);
	await deliverMany(context, ids, { mailbox_id: "mbx-s" });
	await context.client.command("SELECT INBOX");
	beforeBatch(context, RELOCATION, () => context.database.db.exec("UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-x'"), 1);
	// The downgrade lands before the first batch runs but after the first chunk's check, so the
	// first chunk (authorized when checked) commits; the second chunk is re-authorized and refused.
	const result = await context.client.command("MOVE 1:* Archive");
	assertTagged(result, "NO", /\[NOPERM\]/);
	assert.equal(texts(result).length, 80);
	assert.deepEqual(texts(result).slice(0, 2), ["* 80 EXPUNGE", "* 79 EXPUNGE"]);
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages WHERE status = 'archived'").n, 80);
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages WHERE status = 'received'").n, 20);
	assertTagged(await context.client.command("NOOP"), "OK");
	assert.equal(context.session.isClosed, false);
	// Revoked between chunks: the first chunk stays, the session ends.
	const other = await setup(t, SHARED_MANAGER);
	await deliverMany(other, ids, { mailbox_id: "mbx-s" });
	await other.client.command("SELECT INBOX");
	beforeBatch(other, RELOCATION, () => other.database.db.exec("DELETE FROM mailbox_access WHERE id = 'acc-x'"), 1);
	const gone = await other.client.command("MOVE 1:* Trash");
	assert.equal(gone.untagged.at(-1).text, "* BYE Access revoked");
	assert.equal(one(other, "SELECT COUNT(*) AS n FROM messages WHERE status = 'trash'").n, 80, "the committed chunk stays; nothing half-moved");
	await assertInvariants(context, 100);
	await assertInvariants(other, 100);
});

test("a5.2b: Drafts move only to Trash and only for their author; a manager cannot discard another user's draft", async (t) => {
	const context = await setup(t, SHARED_MANAGER);
	const draft = (id, userId) => context.deliver(id, `Subject: ${id}\r\n\r\n${id}\r\n`, { mailbox_id: "mbx-s", user_id: userId, status: "draft", direction: "outbound", from_addr: "sales@example.test", raw_r2_key: null });
	await draft("d-a", "user-a");
	await draft("d-x", "user-x");
	await context.client.command("SELECT Drafts");
	const uidOf = (id) => mapping(context, id)[0].uid;
	const before = productState(context);
	assertTagged(await context.client.command(`UID MOVE ${uidOf("d-a")} Trash`), "NO", /\[NOPERM\] Only the author of a draft may discard it/);
	assertTagged(await context.client.command("MOVE 1:2 Trash"), "NO", /\[NOPERM\]/, "a set including another user's draft moves nothing");
	assert.equal(productState(context), before);
	assertTagged(await context.client.command(`UID MOVE ${uidOf("d-x")} Archive`), "NO", /\[CANNOT\] Drafts can only be moved to Trash/);
	const draftUid = uidOf("d-x");
	const own = await context.client.command(`UID MOVE ${draftUid} Trash`);
	assertTagged(own, "OK");
	assert.equal(texts(own).length, 2);
	assert.equal(texts(own)[0], copyUid(context, "trash", draftUid, uidOf("d-x"), "mbx-s"), "COPYUID into Trash");
	assert.deepEqual(where(context, "d-x"), { status: "trash", folder: null });
	assert.equal(context.row("d-x").direction, "outbound");
	assert.equal(context.row("d-a").status, "draft");
	// The owner of the mailbox (an admin) may discard their own draft.
	const owner = await connect(context, { userId: "user-a", mailboxId: "mbx-s", address: "sales@example.test" });
	await owner.client.command("SELECT Drafts");
	assertTagged(await owner.client.command("MOVE 1 Trash"), "OK");
	assert.equal(context.row("d-a").status, "trash");
	// Once in Trash, a former draft can go to INBOX like any other message, never back to Drafts.
	await owner.client.command("SELECT Trash");
	assertTagged(await owner.client.command("MOVE 1 Drafts"), "NO", /\[CANNOT\]/);
	await assertInvariants(context, 2);
});

test("a5.2b: the draft owner guard is inside the batch too: a draft whose owner changes after the check does not move", async (t) => {
	const context = await setup(t, SHARED_MANAGER);
	await context.deliver("d-x", "Subject: d\r\n\r\nd\r\n", { mailbox_id: "mbx-s", user_id: "user-x", status: "draft", direction: "outbound", raw_r2_key: null });
	await context.client.command("SELECT Drafts");
	beforeBatch(context, RELOCATION, () => context.database.db.exec("UPDATE messages SET user_id = 'user-a' WHERE id = 'd-x'"));
	const result = await context.client.command("MOVE 1 Trash");
	assertTagged(result, "NO", /could not be moved/);
	assert.equal(context.row("d-x").status, "draft");
	assert.equal(mapping(context, "d-x").length, 1);
	await assertInvariants(context, 1);
});

// ---- Races --------------------------------------------------------------------------------------

test("a5.2b: MOVE racing a web move, a JMAP move or a second IMAP MOVE never overwrites the other move or duplicates the message", async (t) => {
	for (const [name, race] of [
		["web", (context) => bulk(context, ["m-2"], "archive")],
		["jmap", (context) => jmapMove(context, "m-2", { kind: "role", mailboxId: "mbx-a", role: "archive" })],
		["imap", async (context) => {
			const other = await connect(context);
			await other.client.command("SELECT INBOX");
			assertTagged(await other.client.command("MOVE 2 Archive"), "OK");
		}],
	]) {
		const context = await setup(t);
		await deliverMany(context, ["m-1", "m-2", "m-3"]);
		await context.client.command("SELECT INBOX");
		beforeBatch(context, RELOCATION, () => race(context));
		const result = await context.client.command("MOVE 1:3 Trash");
		assertTagged(result, "NO", /no longer exist/, name);
		assert.deepEqual(texts(result), [copyUid(context, "trash", "1,3", "1:2"), "* 3 EXPUNGE", "* 2 EXPUNGE", "* 1 EXPUNGE"], `${name}: COPYUID names only what this MOVE moved; every message that left is reported`);
		assert.deepEqual(where(context, "m-2"), { status: "archived", folder: null }, `${name}: the other move stands`);
		assert.deepEqual(mapping(context, "m-2").map((row) => row.folder).filter((folder) => folder !== "archive"), [], `${name}: no UID for m-2 outside Archive`);
		assert.equal(context.row("m-1").status, "trash", name);
		assert.equal(context.row("m-3").status, "trash", name);
		assert.deepEqual(sql(context, "SELECT message_id FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key = 'trash' ORDER BY uid").map((row) => row.message_id), ["m-1", "m-3"], name);
		await assertInvariants(context, 3);
	}
});

test("a5.2b: the other move committing after MOVE simply wins; the destination mapping is dropped at the next read", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1"]);
	await context.client.command("SELECT INBOX");
	assertTagged(await context.client.command("MOVE 1 Trash"), "OK");
	await bulk(context, ["m-1"], "archive");
	await openTrashAndArchive(context);
	assert.deepEqual(mapping(context, "m-1").map((row) => row.folder), ["archive"]);
	await assertInvariants(context, 1);
});
const openTrashAndArchive = async (context) => {
	await app.imap.openImapFolder(context.env, OWNER, "trash");
	await app.imap.openImapFolder(context.env, OWNER, "archive");
};

test("a5.2b: MOVE and EXPUNGE race in both orders without resurrecting \\Deleted or moving twice", async (t) => {
	// EXPUNGE commits first: the message is in Trash, MOVE finds it gone.
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
	const mover = await connect(context);
	await mover.client.command("SELECT INBOX");
	beforeBatch(context, RELOCATION, async () => assertTagged(await context.client.command("EXPUNGE"), "OK"));
	const result = await mover.client.command("MOVE 1 Archive");
	assertTagged(result, "NO", /no longer exist/);
	assert.deepEqual(where(context, "m-1"), { status: "trash", folder: null });
	assert.deepEqual(mapping(context, "m-1").map((row) => [row.folder, row.deleted]), [["trash", 0]]);
	// MOVE commits first: EXPUNGE finds nothing marked in INBOX any more.
	await context.client.command("SELECT INBOX");
	await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
	await mover.client.command("NOOP");
	beforeBatch(context, RELOCATION, async () => assertTagged(await mover.client.command("MOVE 1 Archive"), "OK"));
	const expunged = await context.client.command("EXPUNGE");
	assertTagged(expunged, "OK");
	assert.deepEqual(where(context, "m-2"), { status: "archived", folder: null }, "not moved to Trash afterwards");
	assert.deepEqual(mapping(context, "m-2"), [{ folder: "archive", uid: 1, deleted: 0 }]);
	await assertInvariants(context, 2);
});

test("a5.2b: MOVE racing STORE +FLAGS/-FLAGS \\Deleted moves regardless and the destination is never \\Deleted; a stale STORE after MOVE changes nothing", async (t) => {
	for (const flags of ["+FLAGS.SILENT (\\Deleted)", "-FLAGS.SILENT (\\Deleted)"]) {
		const context = await setup(t);
		await deliverMany(context, ["m-1"]);
		await context.client.command("SELECT INBOX");
		if (flags.startsWith("-")) await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
		const other = await connect(context);
		await other.client.command("SELECT INBOX");
		beforeBatch(context, RELOCATION, async () => assertTagged(await other.client.command(`STORE 1 ${flags}`), "OK"));
		assertTagged(await context.client.command("MOVE 1 Archive"), "OK", undefined, flags);
		assert.deepEqual(mapping(context, "m-1"), [{ folder: "archive", uid: 1, deleted: 0 }], flags);
		// The other session still thinks UID 1 is in INBOX; its STORE names nothing now.
		const stale = await other.client.command("STORE 1 +FLAGS (\\Deleted)");
		assertTagged(stale, "NO", /no longer exist/, flags);
		assert.deepEqual(mapping(context, "m-1"), [{ folder: "archive", uid: 1, deleted: 0 }], flags);
		await assertInvariants(context, 1);
	}
});

test("a5.2b: a custom destination deleted mid-MOVE moves nothing; afterwards it is NONEXISTENT", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	beforeBatch(context, RELOCATION, () => context.database.db.exec("DELETE FROM folders WHERE id = 'fld-work'"));
	const result = await context.client.command("MOVE 1:2 Work");
	assertTagged(result, "NO", /could not be moved/);
	assert.deepEqual(texts(result), []);
	assert.deepEqual([where(context, "m-1"), where(context, "m-2")], [{ status: "received", folder: null }, { status: "received", folder: null }]);
	assert.deepEqual(sql(context, "SELECT u.uid FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key = 'f:fld-work'"), []);
	assertTagged(await context.client.command("MOVE 1:2 Work"), "NO", /\[NONEXISTENT\]/);
	assertTagged(await context.client.command("NOOP"), "OK");
	await assertInvariants(context, 2);
});

test("a5.2b: source membership changing after the snapshot: only real members move, and a flag change does not count as leaving", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3"]);
	await context.client.command("SELECT INBOX");
	beforeBatch(context, RELOCATION, () => context.database.db.exec("UPDATE messages SET read = 1, starred = 1 WHERE id = 'm-1'; UPDATE messages SET status = 'spam' WHERE id = 'm-2'"));
	const result = await context.client.command("MOVE 1:3 Archive");
	assertTagged(result, "NO", /no longer exist/);
	assert.deepEqual(texts(result), [copyUid(context, "archive", "1,3", "1:2"), "* 3 EXPUNGE", "* 2 EXPUNGE", "* 1 EXPUNGE"]);
	assert.deepEqual(where(context, "m-1"), { status: "archived", folder: null });
	assert.equal(context.row("m-1").read, 1);
	assert.deepEqual(where(context, "m-2"), { status: "spam", folder: null }, "moved elsewhere meanwhile: stays there");
	assert.equal(feedback(context, "m-2"), null, "an IMAP MOVE that did not move it does not train it");
	assert.deepEqual(where(context, "m-3"), { status: "archived", folder: null });
	await assertInvariants(context, 3);
});

test("a5.2b: a destination UIDNEXT that moved meanwhile is honored; an exhausted one rolls the whole chunk back and leaves the session usable", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await deliverMany(context, ["a-1"], { status: "archived" });
	await context.client.command("SELECT INBOX");
	await app.imap.openImapFolder(context.env, OWNER, "archive");
	beforeBatch(context, RELOCATION, async () => {
		await deliverMany(context, ["a-2"], { status: "archived" });
		await app.imap.openImapFolder(context.env, OWNER, "archive");
	});
	assertTagged(await context.client.command("MOVE 1 Archive"), "OK");
	assert.deepEqual(sql(context, "SELECT u.uid, u.message_id FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key = 'archive' ORDER BY uid"), [{ uid: 1, message_id: "a-1" }, { uid: 2, message_id: "a-2" }, { uid: 3, message_id: "m-1" }]);
	assert.equal(uidNext(context, "archive"), 4);
	// Exhausted: nothing moves, the answer is a temporary failure, and a MOVE elsewhere still works.
	context.database.db.exec("UPDATE imap_folders SET uid_next = 4294967296 WHERE mailbox_id = 'mbx-a' AND folder_key = 'archive'");
	const before = productState(context);
	assertTagged(await context.client.command("MOVE 1 Archive"), "NO", /\[UNAVAILABLE\]/);
	assert.equal(productState(context), before, "status, mappings and UIDNEXT untouched");
	assert.equal(context.session.isClosed, false);
	assertTagged(await context.client.command("MOVE 1 Trash"), "OK");
	assert.equal(context.row("m-2").status, "trash");
	await assertInvariants(context, 4);
});

test("a5.2b: an injected batch failure rolls back; retries, stale sessions and repeated MOVEs never duplicate a move", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	const stale = await connect(context);
	await stale.client.command("SELECT INBOX");
	await app.imap.openImapFolder(context.env, OWNER, "archive");
	const before = productState(context);
	beforeBatch(context, RELOCATION, () => {
		throw new Error("injected D1 failure");
	});
	assertTagged(await context.client.command("MOVE 1 Archive"), "NO", /\[UNAVAILABLE\]/);
	assert.equal(productState(context), before);
	assertTagged(await context.client.command("MOVE 1 Archive"), "OK", undefined, "the retry moves it");
	const archived = mapping(context, "m-1");
	// The same command again now names m-2 (renumbered), so use UIDs for the retry-after-success case.
	assertTagged(await context.client.command("UID MOVE 1 Archive"), "OK");
	assert.deepEqual(mapping(context, "m-1"), archived, "a retry after success changes nothing");
	// A session that has not seen the move still names m-1 as 1: its MOVE finds it gone.
	const result = await stale.client.command("MOVE 1 Trash");
	assertTagged(result, "NO", /no longer exist/);
	assert.deepEqual(texts(result), ["* 1 EXPUNGE"]);
	assert.deepEqual(mapping(context, "m-1"), archived);
	assert.equal(context.row("m-2").status, "received", "a stale sequence number never reaches another message");
	await assertInvariants(context, 2);
});

test("a5.2b: MOVE without the bp0003 trigger is refused (CANNOT) and moves nothing; a trigger dropped after the check blocks the batch", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	await context.client.command("STORE 2 +FLAGS.SILENT (\\Deleted)");
	await app.imap.openImapFolder(context.env, OWNER, "archive");
	const before = productState(context);
	beforeBatch(context, RELOCATION, () => context.database.db.exec(`DROP TRIGGER ${TRIGGER}`));
	const raced = await context.client.command("MOVE 1:2 Archive");
	assertTagged(raced, "NO", /could not be moved/);
	assert.equal(productState(context), before, "the relocation's own guard kept both in place");
	assertTagged(await context.client.command("MOVE 1 Archive"), "NO", /^\S+ NO \[CANNOT\] MOVE is unavailable/);
	assert.equal(productState(context), before);
	assert.equal(context.session.isClosed, false);
	await assertInvariants(context, 2);
});

// ---- Spam and ham training -------------------------------------------------------------------------

test("a5.2b: MOVE into Spam trains spam, Spam -> INBOX trains ham, and other moves out of Spam train nothing", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3", "m-4", "m-5"]);
	await context.client.command("SELECT INBOX");
	assert.deepEqual(tokenTotals(context), { spam: 0, ham: 0, n: 0 });
	assertTagged(await context.client.command("MOVE 1 Spam"), "OK");
	assert.deepEqual(where(context, "m-1"), { status: "spam", folder: null });
	assert.deepEqual(feedback(context, "m-1"), { classification: "spam", actor_user_id: "user-a" });
	const afterSpam = tokenTotals(context);
	assert.ok(afterSpam.spam > 0 && afterSpam.ham === 0, JSON.stringify(afterSpam));
	assert.ok(one(context, "SELECT COUNT(*) AS n FROM spam_reputation WHERE mailbox_id = 'mbx-a' AND spam_count > 0").n > 0);
	assert.deepEqual(JSON.parse(one(context, "SELECT metadata FROM audit_logs WHERE message_id = 'm-1' AND action = 'email.spam_feedback'").metadata), { classification: "spam", via: "imap" });
	// Spam -> INBOX: ham, undoing the spam counts.
	await context.client.command("SELECT Spam");
	assertTagged(await context.client.command("MOVE 1 INBOX"), "OK");
	assert.deepEqual(where(context, "m-1"), { status: "received", folder: null });
	assert.equal(feedback(context, "m-1").classification, "ham");
	const afterHam = tokenTotals(context);
	assert.equal(afterHam.spam, 0);
	assert.equal(afterHam.ham, afterSpam.spam);
	// Into Spam and out again to Work, Archive and Trash: trained spam once each, never ham.
	await context.client.command("SELECT INBOX");
	assertTagged(await context.client.command("MOVE 2:4 Spam"), "OK");
	for (const id of ["m-3", "m-4", "m-5"]) assert.equal(feedback(context, id).classification, "spam", id);
	const trained = tokenTotals(context);
	await context.client.command("SELECT Spam");
	for (const destination of ["Work", "Archive", "Trash"]) assertTagged(await context.client.command(`MOVE 1 ${destination}`), "OK", undefined, destination);
	assert.deepEqual(tokenTotals(context), trained, "no training for Spam -> Work, Archive or Trash");
	for (const id of ["m-3", "m-4", "m-5"]) assert.equal(feedback(context, id).classification, "spam", id);
	// Trash -> Spam again: already trained as spam, so nothing is counted twice.
	await context.client.command("SELECT Trash");
	assertTagged(await context.client.command("MOVE 1 Spam"), "OK");
	assert.deepEqual(tokenTotals(context), trained);
	await assertInvariants(context, 5);
});

test("a5.2b: IMAP training matches the web app's report-spam for the same content, and the web path behaves as before", async (t) => {
	const context = await setup(t);
	const raw = "Subject: Cheap pills\r\nFrom: promo@spammy.test\r\n\r\nBuy cheap pills now http://spammy.test/offer\r\n";
	await context.deliver("imap-1", raw, { subject: "Cheap pills", text_body: "Buy cheap pills now http://spammy.test/offer", from_addr: "promo@spammy.test" });
	await context.deliver("web-1", raw, { subject: "Cheap pills", text_body: "Buy cheap pills now http://spammy.test/offer", from_addr: "promo@spammy.test", mailbox_id: "mbx-s" });
	await context.client.command("SELECT INBOX");
	assertTagged(await context.client.command("MOVE 1 Spam"), "OK");
	await bulk(context, ["web-1"], "spam");
	const record = (id) => one(context, "SELECT classification, training_tokens, reputation_keys, tokenizer_version FROM spam_feedback WHERE message_id = ?", id);
	assert.deepEqual(record("imap-1"), record("web-1"));
	const tokens = (mailboxId) => sql(context, "SELECT token, spam_count, ham_count FROM spam_token_stats WHERE mailbox_id = ? ORDER BY token", mailboxId);
	assert.deepEqual(tokens("mbx-a"), tokens("mbx-s"));
	assert.deepEqual(where(context, "web-1"), { status: "spam", folder: null });
	// The web path's other branches are unchanged: repeated report-spam moves without re-counting,
	// not-spam trains ham and moves to INBOX, outbound mail is not reported.
	const counted = tokens("mbx-s");
	await bulk(context, ["web-1"], "spam");
	assert.deepEqual(tokens("mbx-s"), counted);
	await bulk(context, ["web-1"], "inbox");
	assert.equal(feedback(context, "web-1").classification, "ham");
	assert.deepEqual(where(context, "web-1"), { status: "received", folder: null });
	assert.ok(tokens("mbx-s").every((row) => row.spam_count === 0 && row.ham_count === 1));
	await context.deliver("web-out", "Subject: o\r\n\r\no\r\n", { direction: "outbound", status: "sent" });
	assert.equal(await app.spamFeedback.applySpamFeedback(context.env, { id: "user-a", role: "admin" }, "web-out", "spam"), false);
	assert.equal(context.row("web-out").status, "sent");
	await assertInvariants(context, 3);
});

test("a5.2b: spam training is idempotent under retries and concurrent trainings", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1"]);
	await context.client.command("SELECT INBOX");
	assertTagged(await context.client.command("MOVE 1 Spam"), "OK");
	const once = tokenTotals(context);
	assert.deepEqual(await app.imap.trainImapSpamFeedback(context.env, OWNER, ["m-1"], "spam"), []);
	assert.deepEqual(tokenTotals(context), once, "a retry counts nothing more");
	// Two trainings of an untrained message at once: the guarded batch lets exactly one count.
	await deliverMany(context, ["m-2"], { status: "spam" });
	const input = { messageId: "m-2", mailboxId: "mbx-a", actorUserId: "user-a", classification: "spam", status: "spam" };
	const results = await Promise.all([app.spamFeedback.recordSpamTraining(context.env, input), app.spamFeedback.recordSpamTraining(context.env, input)]);
	assert.deepEqual(results.sort(), [false, true]);
	assert.equal(tokenTotals(context).spam, once.spam * 2);
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM audit_logs WHERE message_id = 'm-2' AND action = 'email.spam_feedback'").n, 1);
	// A message no longer where the move put it is not trained.
	await deliverMany(context, ["m-3"]);
	assert.equal(await app.spamFeedback.recordSpamTraining(context.env, { ...input, messageId: "m-3" }), false);
	assert.equal(feedback(context, "m-3"), null);
	await assertInvariants(context, 3);
});

test("a5.2b: a spam-training failure after a committed MOVE leaves the message moved, answers OK, is logged, and a later retry trains it", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	beforeBatch(context, TRAINING, () => {
		throw new Error("injected training failure");
	});
	const result = await context.client.command("MOVE 1 Spam");
	assertTagged(result, "OK", /MOVE completed/);
	assert.deepEqual(texts(result), [copyUid(context, "junk", "1", "1"), "* 1 EXPUNGE"], "the move committed, so COPYUID is reported whatever the training does");
	assert.deepEqual(where(context, "m-1"), { status: "spam", folder: null });
	assert.deepEqual(mapping(context, "m-1").map((row) => [row.folder, row.deleted]), [["junk", 0]]);
	assert.equal(feedback(context, "m-1"), null, "moved but untrained");
	assert.deepEqual(tokenTotals(context), { spam: 0, ham: 0, n: 0 });
	const logged = context.client.logs.find((event) => event.event === "move.spam-training-error");
	assert.equal(logged?.messageId, "m-1");
	assert.match(logged.error, /injected training failure/);
	assert.deepEqual(await app.imap.trainImapSpamFeedback(context.env, OWNER, ["m-1"], "spam"), []);
	assert.equal(feedback(context, "m-1").classification, "spam");
	// Access lost between the move and the training: the move stands, the session ends.
	beforeBatch(context, TRAINING, () => undefined);
	const other = await connect(context);
	await other.client.command("SELECT INBOX");
	const move = other.client.command("MOVE 1 Spam");
	const database = context.database;
	const original = database.batch;
	database.batch = async function (statements) {
		const output = await original.call(this, statements);
		if (RELOCATION.test(statements.map((statement) => statement.sql ?? "").join("\n"))) {
			database.batch = original;
			database.db.prepare("DELETE FROM mail_app_passwords WHERE id = ?").run(other.credentialId);
		}
		return output;
	};
	assert.equal((await move).untagged.at(-1).text, "* BYE Access revoked");
	assert.deepEqual(where(context, "m-2"), { status: "spam", folder: null });
	assert.equal(feedback(context, "m-2"), null);
	await assertInvariants(context, 2);
});

test("a5.2b: the service refuses what the listener refuses: same folder, bad destinations, readers, and nonexistent keys", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1"]);
	await app.imap.openImapFolder(context.env, OWNER, "inbox");
	const code = (promise) => promise.then(() => "ok", (error) => error.code);
	assert.equal(await code(app.imap.moveImapMessages(context.env, OWNER, "inbox", [1], "inbox")), "unsupported");
	assert.equal(await code(app.imap.moveImapMessages(context.env, OWNER, "inbox", [1], "sent")), "unsupported");
	assert.equal(await code(app.imap.moveImapMessages(context.env, OWNER, "inbox", [1], "f:fld-x")), "nonexistent-destination");
	assert.equal(await code(app.imap.moveImapMessages(context.env, OWNER, "inbox", [1], "f:nope")), "nonexistent-destination");
	assert.equal(await code(app.imap.moveImapMessages(context.env, OWNER, "f:nope", [1], "inbox")), "nonexistent");
	assert.equal(await code(app.imap.moveImapMessages(context.env, { userId: "user-b", mailboxId: "mbx-s" }, "inbox", [1], "trash")), "denied");
	assert.equal(await code(app.imap.moveImapMessages(context.env, { userId: "user-x", mailboxId: "mbx-a" }, "inbox", [1], "trash")), "forbidden");
	assert.equal(context.row("m-1").status, "received");
	const result = await app.imap.moveImapMessages(context.env, OWNER, "inbox", [1, 1, 0, -1, 2.5, 77], "archive");
	assert.deepEqual(result, { moved: [{ uid: 1, messageId: "m-1", destinationUid: 1, destinationUidValidity: uidValidity(context, "archive") }], training: null });
	await assertInvariants(context, 1);
});
