import assert from "node:assert/strict";
import test from "node:test";
import { assertTagged, install, loadApp, memoryClient } from "./support/imap-harness.mjs";

/**
 * A5.2c: permanent EXPUNGE and CLOSE in Trash and Drafts, over the real A2 verifier, A3 state,
 * the bp0003 and bp0004 triggers, the product routes and the file bucket (SQLite, no Workers).
 *
 * - \Deleted may be set in Trash by a manager, and in Drafts by a manager on their own drafts
 *   only (bp0004 installed). STORE alone never deletes anything.
 * - EXPUNGE and CLOSE there delete the database rows first, in one guarded batch per chunk of
 *   25, and remove raw bytes and attachment objects only after that batch committed, best
 *   effort, from an allowlist of key shapes, and only for keys no live row still references.
 * - bp0004 releases a draft's Drafts UID whenever its fingerprinted content changes, so an old
 *   UID or an old \Deleted mark can never reach an edited draft.
 * - Every other folder keeps A5.2a's recoverable expunge to Trash.
 */
const { app, cleanup } = await loadApp("imap-permanent");
test.after(cleanup);

const BASE = "http://mailflare.local";
const OWNER = { userId: "user-a", mailboxId: "mbx-a" };
const DRAFT_TRIGGERS = ["bp_imap_draft_content_releases_uid", "bp_imap_draft_attachment_added_releases_uid", "bp_imap_draft_attachment_removed_releases_uid"];
const texts = (result) => result.untagged.map((unit) => unit.text);
const sql = (context, query, ...params) => context.database.db.prepare(query).all(...params);
const one = (context, query, ...params) => context.database.db.prepare(query).get(...params);
const exec = (context, query) => context.database.db.exec(query);
const exists = (context, id) => !!context.row(id);
const stored = async (context, key) => !!(await context.env.BUCKET.get(key));
const uidOf = (context, messageId, key) => one(context, "SELECT u.uid FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE u.message_id = ? AND f.folder_key = ?", messageId, key)?.uid ?? null;
const mappings = (context, messageId) => sql(context, "SELECT f.folder_key AS folder, u.uid, u.deleted FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE u.message_id = ? ORDER BY f.folder_key", messageId);

async function connect(context, { userId = "user-a", mailboxId = "mbx-a", address = "a@example.test" } = {}) {
	const { client, session, start } = memoryClient(app, context.env);
	await start();
	const { credential, id } = await context.credential(userId, mailboxId);
	assertTagged(await client.login(address, credential), "OK");
	return { client, session, credentialId: id, principal: { userId, mailboxId, appPasswordId: id } };
}

async function setup(t, account) {
	const context = await install(app, t);
	return { ...context, ...(await connect(context, account)) };
}

/** Received mail in Trash, with its raw bytes stored. */
async function trash(context, ids, values = {}) {
	for (const id of ids) await context.deliver(id, `Subject: ${id}\r\n\r\nbody of ${id}\r\n`, { status: "trash", ...values });
}

let draftCounter = 0;
/** A draft (no stored representation yet), authored by `userId`. */
function draft(context, id, { userId = "user-a", mailboxId = "mbx-a", subject = id } = {}) {
	context.database.db
		.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, read, created_at) VALUES (?, ?, ?, 'outbound', 'a@example.test', 'b@elsewhere.test', ?, 'draft body', 'draft', 1, ?)")
		.run(id, userId, mailboxId, subject, 1790100000 + ++draftCounter);
}

/** An attachment row and its object, in the shape storeMessageAttachments writes. */
async function attach(context, messageId, attachmentId, content = "attached bytes") {
	const key = `attachments/${messageId}/${attachmentId}/file.txt`;
	await context.env.BUCKET.put(key, content);
	context.database.db
		.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES (?, ?, 'file.txt', 'text/plain', ?, 'attachment', ?, 1)")
		.run(attachmentId, messageId, content.length, key);
	return key;
}

/** Run `hook` right before the next D1 batch whose SQL matches `pattern` executes. */
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
const PERMANENT = /DELETE FROM messages WHERE/;

/** Record every object delete; `fail(key)` decides which throw. */
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

/** Capture the JSON log lines cleanup writes. */
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

async function webDraftPatch(context, id, body, userId = "user-a") {
	const token = await app.createSession(context.env, userId);
	const request = new Request(`${BASE}/api/drafts/${id}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	return app.draftPatchRoute(request, { params: Promise.resolve({ id }) });
}
async function webDraftDelete(context, id, userId = "user-a") {
	const token = await app.createSession(context.env, userId);
	const request = new Request(`${BASE}/api/drafts/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
	return app.draftDeleteRoute(request, { params: Promise.resolve({ id }) });
}

let keyCounter = 0;
async function jmapDestroy(context, messageId) {
	const { fullKey, prefix, hash } = app.generateApiKey();
	context.database.db.prepare("INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, created_at) VALUES (?, 'legacy', 'user-a', 'jmap', ?, ?, ?, 1)").run(`key-${++keyCounter}`, prefix, hash, JSON.stringify(["jmap"]));
	const body = { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [["Email/set", { accountId: "user-a", destroy: [messageId] }, "0"]] };
	const response = await app.handleJmapRequest(new Request(`${BASE}/jmap/api`, { method: "POST", headers: { Authorization: `Bearer ${fullKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), context.env);
	return (await response.json()).methodResponses[0][1];
}

/** Invariants after every scenario: every live row's stored bytes exist, UIDs are unique, no mapping names a deleted message. */
async function assertInvariants(context) {
	for (const row of sql(context, "SELECT id, raw_r2_key FROM messages WHERE raw_r2_key IS NOT NULL")) assert.ok(await stored(context, row.raw_r2_key), `live message ${row.id} still has its bytes`);
	for (const row of sql(context, "SELECT message_id, r2_key FROM message_attachments")) assert.ok(await stored(context, row.r2_key), `live attachment of ${row.message_id} still has its object`);
	assert.deepEqual(sql(context, "SELECT imap_folder_id, uid, COUNT(*) AS n FROM imap_message_uids GROUP BY imap_folder_id, uid HAVING n > 1"), []);
	assert.deepEqual(sql(context, "SELECT imap_folder_id, message_id, COUNT(*) AS n FROM imap_message_uids GROUP BY imap_folder_id, message_id HAVING n > 1"), []);
}

// ---- bp0004: a draft's Drafts UID is released whenever its fingerprinted content changes ------------

test("bp0004: every fingerprinted column change, attachment added or removed releases the draft's Drafts UID; identical saves and other columns do not", async (t) => {
	const context = await install(app, t);
	draft(context, "d-1");
	const resync = async () => (await app.imap.openImapFolder(context.env, OWNER, "drafts")).messages.find((entry) => entry.messageId === "d-1")?.uid;
	let uid = await resync();
	assert.equal(uid, 1);
	const cases = [
		["same subject written again", "UPDATE messages SET subject = subject WHERE id = 'd-1'", false],
		["read", "UPDATE messages SET read = 0 WHERE id = 'd-1'", false],
		["starred", "UPDATE messages SET starred = 1 WHERE id = 'd-1'", false],
		["snippet and raw key", "UPDATE messages SET snippet = 'x', raw_r2_key = 'canonical/d-1/x.eml' WHERE id = 'd-1'", false],
		["from_addr", "UPDATE messages SET from_addr = 'other@example.test' WHERE id = 'd-1'", true],
		["to_addr", "UPDATE messages SET to_addr = 'c@elsewhere.test' WHERE id = 'd-1'", true],
		["cc_addr", "UPDATE messages SET cc_addr = 'cc@elsewhere.test' WHERE id = 'd-1'", true],
		["bcc_addr", "UPDATE messages SET bcc_addr = 'bcc@elsewhere.test' WHERE id = 'd-1'", true],
		["subject", "UPDATE messages SET subject = 'changed' WHERE id = 'd-1'", true],
		["text_body", "UPDATE messages SET text_body = 'changed' WHERE id = 'd-1'", true],
		["html_body", "UPDATE messages SET html_body = '<p>changed</p>' WHERE id = 'd-1'", true],
		["in_reply_to", "UPDATE messages SET in_reply_to = '<x@y>' WHERE id = 'd-1'", true],
		["references_header", "UPDATE messages SET references_header = '<x@y>' WHERE id = 'd-1'", true],
		["a value set to NULL", "UPDATE messages SET cc_addr = NULL WHERE id = 'd-1'", true],
	];
	for (const [name, statement, releases] of cases) {
		exec(context, "UPDATE imap_message_uids SET deleted = 1 WHERE message_id = 'd-1'");
		exec(context, statement);
		assert.equal(uidOf(context, "d-1", "drafts") === null, releases, name);
		const next = await resync();
		if (releases) assert.ok(next > uid, `${name}: the edited draft gets a new UID`);
		else assert.equal(next, uid, `${name}: the UID stays`);
		uid = next;
		assert.equal(mappings(context, "d-1")[0].deleted, releases ? 0 : 1, `${name}: a new UID never inherits \\Deleted`);
	}
	await attach(context, "d-1", "att-1");
	assert.equal(uidOf(context, "d-1", "drafts"), null, "attachment added");
	uid = await resync();
	await app.deleteMessageAttachment(context.env, "d-1", "att-1");
	assert.equal(uidOf(context, "d-1", "drafts"), null, "attachment removed");
	uid = await resync();
	// Received mail keeps its UIDs through content and attachment changes: only Drafts UIDs are released.
	await context.deliver("m-1", "Subject: m\r\n\r\nm\r\n");
	const inboxUid = await app.imap.ensureImapUid(context.env, OWNER, "inbox", "m-1");
	exec(context, "UPDATE messages SET subject = 'renamed' WHERE id = 'm-1'");
	await attach(context, "m-1", "att-m");
	exec(context, "DELETE FROM message_attachments WHERE id = 'att-m'");
	assert.equal(uidOf(context, "m-1", "inbox"), inboxUid);
	// Another draft's UID is untouched.
	draft(context, "d-2");
	await resync();
	const d2 = uidOf(context, "d-2", "drafts");
	exec(context, "UPDATE messages SET subject = 'again' WHERE id = 'd-1'");
	assert.equal(uidOf(context, "d-2", "drafts"), d2);
});

test("bp0004: a web draft edit (PATCH) and the attachment helpers the routes use release the UID in the same statement", async (t) => {
	const context = await install(app, t);
	draft(context, "d-1");
	await app.imap.openImapFolder(context.env, OWNER, "drafts");
	const response = await webDraftPatch(context, "d-1", { mailboxId: "mbx-a", from: "a@example.test", to: "b@elsewhere.test", subject: "d-1", text: "draft body", html: "" });
	assert.equal(response.status, 200);
	assert.equal(uidOf(context, "d-1", "drafts"), null, "a PATCH that changes the body (html cleared) releases the UID");
	await app.imap.openImapFolder(context.env, OWNER, "drafts");
	const uid = uidOf(context, "d-1", "drafts");
	await webDraftPatch(context, "d-1", { mailboxId: "mbx-a", from: "a@example.test", to: "b@elsewhere.test", subject: "d-1", text: "draft body", html: "" });
	assert.equal(uidOf(context, "d-1", "drafts"), uid, "an identical save keeps it");
	await app.storeMessageAttachments(context.env, "d-1", [{ filename: "x.txt", type: "text/plain", content: new TextEncoder().encode("x").buffer }]);
	assert.equal(uidOf(context, "d-1", "drafts"), null);
});

// ---- Trash ----------------------------------------------------------------------------------

test("a5.2c: STORE \\Deleted in Trash for a manager is only a mark; EXPUNGE deletes the row, then its raw bytes and attachment objects", async (t) => {
	const context = await setup(t);
	await trash(context, ["t-1", "t-2"]);
	const attachment = await attach(context, "t-1", "att-1");
	await context.client.command("SELECT Trash");
	const marked = await context.client.command("STORE 1 +FLAGS (\\Deleted)");
	assertTagged(marked, "OK");
	assert.deepEqual(texts(marked), ["* 1 FETCH (FLAGS (\\Deleted))"]);
	assert.ok(exists(context, "t-1") && (await stored(context, "inbound/t-1.eml")), "STORE deletes nothing");
	const expunged = await context.client.command("EXPUNGE");
	assertTagged(expunged, "OK", /EXPUNGE completed/);
	assert.deepEqual(texts(expunged), ["* 1 EXPUNGE"]);
	assert.equal(exists(context, "t-1"), false);
	assert.equal(await stored(context, "inbound/t-1.eml"), false);
	assert.equal(await stored(context, attachment), false);
	assert.deepEqual(sql(context, "SELECT id FROM message_attachments"), []);
	assert.deepEqual(mappings(context, "t-1"), [], "no mapping names the deleted message");
	assert.ok(exists(context, "t-2") && (await stored(context, "inbound/t-2.eml")), "the unmarked message is untouched");
	const again = await context.client.command("EXPUNGE");
	assertTagged(again, "OK");
	assert.deepEqual(texts(again), [], "a repeated EXPUNGE deletes nothing");
	await assertInvariants(context);
});

test("a5.2c: \\Deleted in Trash needs management access: read-only, send-as and send-on-behalf delegates get NOPERM; full access may", async (t) => {
	const context = await install(app, t);
	await context.deliver("s-1", "Subject: s\r\n\r\ns\r\n", { mailbox_id: "mbx-s", status: "trash" });
	for (const permission of ["read_only", "send_as", "send_on_behalf"]) {
		exec(context, `UPDATE mailbox_access SET permission = '${permission}' WHERE id = 'acc-b'`);
		const delegate = await connect(context, { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" });
		const select = await delegate.client.command("SELECT Trash");
		assert.ok(texts(select).includes("* OK [PERMANENTFLAGS (\\Seen \\Flagged)] Flags permitted"), permission);
		assertTagged(await delegate.client.command("STORE 1 +FLAGS (\\Deleted)"), "NO", /\[NOPERM\]/, permission);
		assertTagged(await delegate.client.command("EXPUNGE"), "NO", /\[NOPERM\]/, permission);
		assertTagged(await delegate.client.command("CLOSE"), "OK", undefined, permission);
		assert.ok(exists(context, "s-1"), permission);
	}
	exec(context, "UPDATE mailbox_access SET permission = 'full_access' WHERE id = 'acc-b'");
	const manager = await connect(context, { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" });
	await manager.client.command("SELECT Trash");
	assertTagged(await manager.client.command("STORE 1 +FLAGS (\\Deleted)"), "OK");
	assertTagged(await manager.client.command("EXPUNGE"), "OK");
	assert.equal(exists(context, "s-1"), false, "a full-access delegate may empty the shared Trash");
});

test("a5.2c: deleting a message cascades exactly as the schema defines, cleans the search index and bumps the JMAP revision", async (t) => {
	const context = await setup(t);
	await trash(context, ["t-1"], { subject: "unforgettable subject" });
	draft(context, "d-other");
	await attach(context, "t-1", "att-1");
	const now = 1790000000;
	exec(context, `
		INSERT INTO shared_attachment_links (id, attachment_id, expires_at, created_at) VALUES ('link-1', 'att-1', ${now + 99999}, ${now});
		INSERT INTO spam_feedback (message_id, mailbox_id, classification, training_tokens, reputation_keys, created_at, updated_at) VALUES ('t-1', 'mbx-a', 'spam', '[]', '[]', ${now}, ${now});
		INSERT INTO outbound_jobs (id, user_id, message_id, payload, created_at, updated_at) VALUES ('job-1', 'user-a', 't-1', '{}', ${now}, ${now});
		INSERT INTO audit_logs (id, actor_user_id, message_id, action, created_at) VALUES ('audit-1', 'user-a', 't-1', 'email.delete', ${now});
		INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, next_attempt_at, created_at) VALUES ('aj-source', 'mbx-a', 't-1', 'user-a', ${now}, ${now});
		INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, draft_id, next_attempt_at, created_at) VALUES ('aj-draft', 'mbx-a', 'd-other', 'user-a', 't-1', ${now}, ${now});
		INSERT INTO agent_draft_metadata (draft_id, mailbox_id, origin, source_message_id, created_at) VALUES ('t-1', 'mbx-a', 'auto', NULL, ${now});
		INSERT INTO agent_draft_metadata (draft_id, mailbox_id, origin, source_message_id, created_at) VALUES ('d-other', 'mbx-a', 'auto', 't-1', ${now});
		INSERT INTO agent_send_approvals (id, draft_id, mailbox_id, user_id, revision, payload_hash, expires_at, created_at) VALUES ('asa-1', 't-1', 'mbx-a', 'user-a', 1, 'h', ${now + 99999}, ${now});
	`);
	const search = () => sql(context, "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'unforgettable'").length;
	assert.equal(search(), 1);
	const revision = () => one(context, "SELECT revision FROM jmap_mailbox_revisions WHERE mailbox_id = 'mbx-a'").revision;
	const before = revision();
	await context.client.command("SELECT Trash");
	await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
	assertTagged(await context.client.command("EXPUNGE"), "OK");
	assert.equal(exists(context, "t-1"), false);
	const count = (table, where = "1") => one(context, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).n;
	assert.equal(count("message_attachments"), 0, "attachments cascade");
	assert.equal(count("shared_attachment_links"), 0, "shared links cascade with their attachment");
	assert.equal(count("spam_feedback"), 0, "spam feedback cascades");
	assert.equal(count("agent_send_approvals"), 0, "send approvals cascade");
	assert.equal(count("agent_jobs", "id = 'aj-source'"), 0, "an agent job for the deleted source message cascades");
	assert.equal(one(context, "SELECT draft_id FROM agent_jobs WHERE id = 'aj-draft'").draft_id, null, "an agent job's draft reference is set null");
	assert.equal(count("agent_draft_metadata", "draft_id = 't-1'"), 0, "draft metadata of the deleted message cascades");
	assert.equal(one(context, "SELECT source_message_id FROM agent_draft_metadata WHERE draft_id = 'd-other'").source_message_id, null, "another draft's source reference is set null");
	assert.equal(one(context, "SELECT message_id FROM outbound_jobs WHERE id = 'job-1'").message_id, null, "outbound jobs are kept, message set null");
	assert.equal(one(context, "SELECT message_id FROM audit_logs WHERE id = 'audit-1'").message_id, null, "audit logs are kept, message set null");
	assert.equal(search(), 0, "the full-text index no longer finds it");
	assert.ok(revision() > before, "the JMAP mailbox revision moved");
	assert.ok(exists(context, "d-other"));
});

test("a5.2c: mappings of the deleted message in other folders (no foreign key) are removed with it; other messages' are not", async (t) => {
	const context = await setup(t);
	await trash(context, ["t-1", "t-2"]);
	// A stale Archive UID from an earlier stay, never released because Archive was not read since.
	exec(context, "INSERT INTO imap_folders (id, mailbox_id, folder_key, uid_validity, uid_next, created_at) VALUES ('F-ar', 'mbx-a', 'archive', 7, 3, 1)");
	exec(context, "INSERT INTO imap_message_uids (imap_folder_id, uid, message_id, created_at) VALUES ('F-ar', 1, 't-1', 1), ('F-ar', 2, 't-2', 1)");
	await context.client.command("SELECT Trash");
	await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
	assertTagged(await context.client.command("EXPUNGE"), "OK");
	assert.deepEqual(mappings(context, "t-1"), []);
	assert.deepEqual(mappings(context, "t-2").map((row) => row.folder).sort(), ["archive", "trash"], "t-2's stale mapping is left to the lazy release");
	assert.equal(one(context, "SELECT uid_next FROM imap_folders WHERE id = 'F-ar'").uid_next, 3, "deletion never touches UIDNEXT");
});

test("a5.2c: a full 25-UID chunk, then 45 UIDs in two chunks (25 + 20); responses in the client's sequence space, highest first", async (t) => {
	const context = await setup(t);
	const ids = Array.from({ length: 70 }, (_, index) => `t-${String(index).padStart(2, "0")}`);
	await trash(context, ids);
	const batches = [];
	const original = context.database.batch;
	context.database.batch = async function (statements) {
		if (PERMANENT.test(statements.map((statement) => statement.sql).join("\n"))) batches.push(statements.map((statement) => statement.params.length));
		return original.call(this, statements);
	};
	await context.client.command("SELECT Trash");
	assertTagged(await context.client.command("STORE 1:25 +FLAGS.SILENT (\\Deleted)"), "OK");
	const first = await context.client.command("EXPUNGE");
	assert.deepEqual(texts(first), Array.from({ length: 25 }, (_, index) => `* ${25 - index} EXPUNGE`));
	assert.equal(batches.length, 1, "exactly one batch for 25");
	assertTagged(await context.client.command("STORE 1:45 +FLAGS.SILENT (\\Deleted)"), "OK");
	const second = await context.client.command("EXPUNGE");
	assert.deepEqual(texts(second), Array.from({ length: 45 }, (_, index) => `* ${45 - index} EXPUNGE`));
	assert.equal(batches.length, 3, "45 UIDs are two more batches (25 + 20)");
	for (const counts of batches) for (const params of counts) assert.ok(params < 100, `every statement binds fewer than 100 parameters (${params})`);
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages").n, 0);
	for (const id of ids) assert.equal(await stored(context, `inbound/${id}.eml`), false, id);
	context.database.batch = original;
});

test("a5.2c: interleaved \\Deleted marks: EXPUNGE numbers each removal against the shrinking sequence, highest first", async (t) => {
	const context = await setup(t);
	await trash(context, ["t-1", "t-2", "t-3", "t-4", "t-5"]);
	await context.client.command("SELECT Trash");
	await context.client.command("STORE 2,4,5 +FLAGS.SILENT (\\Deleted)");
	const result = await context.client.command("EXPUNGE");
	assert.deepEqual(texts(result), ["* 5 EXPUNGE", "* 4 EXPUNGE", "* 2 EXPUNGE"]);
	assert.deepEqual(sql(context, "SELECT id FROM messages ORDER BY id").map((row) => row.id), ["t-1", "t-3"]);
	const fetched = await context.client.command("FETCH 1:* (UID)");
	assert.equal(fetched.untagged.length, 2);
});

// ---- Drafts ---------------------------------------------------------------------------------

test("a5.2c: in Drafts a manager may mark and permanently expunge their own drafts only; another user's draft is NOPERM and survives", async (t) => {
	const context = await setup(t);
	draft(context, "d-own");
	draft(context, "d-other", { userId: "user-b" });
	const ownKey = await attach(context, "d-own", "att-own");
	const otherKey = await attach(context, "d-other", "att-other");
	await context.client.command("SELECT Drafts");
	assertTagged(await context.client.command("STORE 2 +FLAGS (\\Deleted)"), "NO", /^\S+ NO \[NOPERM\] Only the author of a draft may mark it deleted$/);
	assertTagged(await context.client.command("STORE 1:2 +FLAGS (\\Deleted)"), "NO", /\[NOPERM\]/, "a set naming another user's draft writes nothing");
	assert.deepEqual(sql(context, "SELECT deleted FROM imap_message_uids WHERE deleted = 1"), []);
	assertTagged(await context.client.command("NOOP"), "OK", undefined, "the session goes on");
	assertTagged(await context.client.command("STORE 1:2 -FLAGS (\\Deleted)"), "OK", undefined, "clearing is harmless");
	assertTagged(await context.client.command("STORE 1:2 FLAGS (\\Seen)"), "OK", undefined, "a replace without \\Deleted is not a mark");
	assertTagged(await context.client.command("STORE 1 +FLAGS (\\Deleted)"), "OK");
	const result = await context.client.command("EXPUNGE");
	assertTagged(result, "OK");
	assert.deepEqual(texts(result), ["* 1 EXPUNGE"]);
	assert.equal(exists(context, "d-own"), false);
	assert.equal(await stored(context, ownKey), false);
	assert.ok(exists(context, "d-other") && (await stored(context, otherKey)));
	await assertInvariants(context);
});

test("a5.2c: another user's draft marked \\Deleted behind the listener's back is still never deleted (authorship is in the delete itself)", async (t) => {
	const context = await setup(t);
	draft(context, "d-other", { userId: "user-b" });
	draft(context, "d-own");
	await context.client.command("SELECT Drafts");
	exec(context, "UPDATE imap_message_uids SET deleted = 1");
	const result = await context.client.command("EXPUNGE");
	assertTagged(result, "OK");
	assert.deepEqual(texts(result).filter((line) => line.endsWith("EXPUNGE")), ["* 2 EXPUNGE"]);
	assert.ok(exists(context, "d-other"));
	assert.equal(exists(context, "d-own"), false);
	// Straight at the primitive, with the other draft's UID: the SQL guard refuses it.
	const folder = await app.imapState.findFolderRow(app.getDb(context.env), "mbx-a", "drafts");
	const direct = await app.imapState.deleteImapMessagesPermanently(app.getDb(context.env), { folder, key: "drafts" }, [uidOf(context, "d-other", "drafts")], 1000, { ...OWNER, sharedAccess: true });
	assert.deepEqual(direct.deleted, []);
	assert.ok(exists(context, "d-other"));
});

test("a5.2c: draft edited after STORE +\\Deleted: bp0004 releases the UID and EXPUNGE deletes nothing; the edited draft reappears under a new UID", async (t) => {
	const context = await setup(t);
	draft(context, "d-1");
	await context.client.command("SELECT Drafts");
	assertTagged(await context.client.command("STORE 1 +FLAGS (\\Deleted)"), "OK");
	assert.equal((await webDraftPatch(context, "d-1", { mailboxId: "mbx-a", from: "a@example.test", to: "b@elsewhere.test", subject: "edited", text: "new body", html: "" })).status, 200);
	const result = await context.client.command("EXPUNGE");
	assertTagged(result, "OK");
	assert.ok(exists(context, "d-1"), "the edited draft survives");
	assert.deepEqual(texts(result), ["* 2 EXISTS", "* 1 EXPUNGE"], "the edited draft is a new message, the old UID is gone");
	const entry = (await app.imap.openImapFolder(context.env, OWNER, "drafts")).messages[0];
	assert.deepEqual([entry.uid, entry.flags.deleted], [2, false]);
});

test("a5.2c: draft edited before STORE, STORE through the old UID or sequence: nothing is marked, nothing deleted", async (t) => {
	const context = await setup(t);
	draft(context, "d-1");
	await context.client.command("SELECT Drafts");
	exec(context, "UPDATE messages SET text_body = 'edited elsewhere' WHERE id = 'd-1'");
	assertTagged(await context.client.command("UID STORE 1 +FLAGS (\\Deleted)"), "OK");
	assert.deepEqual(sql(context, "SELECT deleted FROM imap_message_uids WHERE deleted = 1"), []);
	assertTagged(await context.client.command("EXPUNGE"), "OK");
	assert.ok(exists(context, "d-1"));
});

test("a5.2c: attachment added or removed after STORE +\\Deleted: the UID is released and the draft survives EXPUNGE", async (t) => {
	const context = await setup(t);
	draft(context, "d-add");
	draft(context, "d-remove");
	const kept = await attach(context, "d-remove", "att-r");
	await context.client.command("SELECT Drafts");
	assertTagged(await context.client.command("STORE 1:2 +FLAGS (\\Deleted)"), "OK");
	await app.storeMessageAttachments(context.env, "d-add", [{ filename: "late.txt", type: "text/plain", content: new TextEncoder().encode("late").buffer }]);
	await app.deleteMessageAttachment(context.env, "d-remove", "att-r");
	assertTagged(await context.client.command("EXPUNGE"), "OK");
	assert.ok(exists(context, "d-add") && exists(context, "d-remove"));
	const added = sql(context, "SELECT r2_key FROM message_attachments WHERE message_id = 'd-add'")[0].r2_key;
	assert.ok(await stored(context, added), "the added attachment is kept");
	assert.equal(await stored(context, kept), false, "the removed one was removed by its own route helper, not by IMAP");
	await assertInvariants(context);
});

test("a5.2c: a draft edited before bp0004 existed keeps a stale UID until Drafts is synchronized; STORE and EXPUNGE synchronize first", async (t) => {
	const context = await install(app, t);
	const definitions = sql(context, `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${DRAFT_TRIGGERS.map(() => "?").join(", ")})`, ...DRAFT_TRIGGERS);
	/** Bind a Drafts UID to the current content, then edit it as a pre-bp0004 build would have. */
	const staleUid = async (id) => {
		await app.imap.openImapFolder(context.env, OWNER, "drafts");
		const uid = uidOf(context, id, "drafts");
		for (const name of DRAFT_TRIGGERS) exec(context, `DROP TRIGGER ${name}`);
		exec(context, `UPDATE messages SET subject = 'edited before bp0004' WHERE id = '${id}'`);
		for (const { sql: definition } of definitions) exec(context, definition);
		assert.equal(uidOf(context, id, "drafts"), uid, "the stale mapping survived the pre-bp0004 edit");
		return uid;
	};
	draft(context, "d-1");
	const storeUid = await staleUid("d-1");
	const result = await app.imap.storeImapFlags(context.env, OWNER, "drafts", [storeUid], { mode: "add", flags: ["deleted"] });
	assert.equal(result.get(storeUid), null, "STORE released the stale UID before writing, so it marked nothing");
	assert.equal(uidOf(context, "d-1", "drafts"), null);
	draft(context, "d-2");
	const expungeUid = await staleUid("d-2");
	// Marked while stale (as an older build could have left it): EXPUNGE releases it and deletes nothing.
	exec(context, `UPDATE imap_message_uids SET deleted = 1 WHERE message_id = 'd-2'`);
	assert.deepEqual(await app.imap.expungeImapFolder(context.env, OWNER, "drafts", 1000), []);
	assert.equal(uidOf(context, "d-2", "drafts") === expungeUid, false);
	assert.ok(exists(context, "d-1") && exists(context, "d-2"));
});

// ---- CLOSE, EXAMINE, UNSELECT and the recoverable folders -----------------------------------

test("a5.2c: CLOSE in Trash and Drafts deletes permanently with no untagged EXPUNGE; EXAMINE and UNSELECT never delete", async (t) => {
	const context = await setup(t);
	await trash(context, ["t-1", "t-2"]);
	draft(context, "d-1");
	await context.client.command("SELECT Trash");
	await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
	assertTagged(await context.client.command("UNSELECT"), "OK");
	assert.ok(exists(context, "t-1"), "UNSELECT never expunges");
	await context.client.command("EXAMINE Trash");
	assertTagged(await context.client.command("STORE 1 -FLAGS (\\Deleted)"), "NO", /read-only/);
	assertTagged(await context.client.command("EXPUNGE"), "NO", /read-only/);
	assertTagged(await context.client.command("CLOSE"), "OK");
	assert.ok(exists(context, "t-1"), "CLOSE under EXAMINE never expunges");
	await context.client.command("SELECT Trash");
	const closed = await context.client.command("CLOSE");
	assertTagged(closed, "OK", /CLOSE completed/);
	assert.deepEqual(texts(closed), [], "CLOSE sends no untagged EXPUNGE");
	assert.equal(exists(context, "t-1"), false);
	assert.equal(await stored(context, "inbound/t-1.eml"), false);
	assertTagged(await context.client.command("FETCH 1 FLAGS"), "BAD", /not valid in this state/, "CLOSE left the selected state");
	await context.client.command("SELECT Drafts");
	await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
	assertTagged(await context.client.command("CLOSE"), "OK");
	assert.equal(exists(context, "d-1"), false);
	assert.ok(exists(context, "t-2"));
});

test("a5.2c: a permanent CLOSE that fails answers NO [UNAVAILABLE], keeps the mailbox selected and deletes nothing", async (t) => {
	const context = await setup(t);
	await trash(context, ["t-1"]);
	await context.client.command("SELECT Trash");
	await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
	const deletes = watchDeletes(context);
	beforeBatch(context, PERMANENT, async () => {
		throw new Error("injected database failure");
	});
	assertTagged(await context.client.command("CLOSE"), "NO", /^\S+ NO \[UNAVAILABLE\] Could not expunge, mailbox remains selected$/);
	assert.ok(exists(context, "t-1"));
	assert.deepEqual(deletes, [], "a failed database batch never reaches storage");
	const still = await context.client.command("FETCH 1 FLAGS");
	assertTagged(still, "OK");
	assert.deepEqual(texts(still), ["* 1 FETCH (FLAGS (\\Deleted))"], "still selected, mark kept");
	assertTagged(await context.client.command("EXPUNGE"), "OK");
	assert.equal(exists(context, "t-1"), false);
});

test("a5.2c: INBOX, custom folders, Archive, Spam and Sent keep A5.2a's recoverable expunge and CLOSE; MOVE out of Drafts still only to Trash", async (t) => {
	const context = await setup(t);
	await context.deliver("in-1", "Subject: i\r\n\r\ni\r\n");
	await context.deliver("wk-1", "Subject: w\r\n\r\nw\r\n", { folder_id: "fld-work" });
	await context.deliver("ar-1", "Subject: a\r\n\r\na\r\n", { status: "archived" });
	await context.deliver("sp-1", "Subject: s\r\n\r\ns\r\n", { status: "spam" });
	await context.deliver("se-1", "Subject: o\r\n\r\no\r\n", { status: "sent", direction: "outbound", from_addr: "a@example.test", read: 1 });
	for (const [folder, id, close] of [["INBOX", "in-1", false], ["Work", "wk-1", true], ["Archive", "ar-1", false], ["Spam", "sp-1", true], ["Sent", "se-1", false]]) {
		await context.client.command(`SELECT ${folder}`);
		await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
		assertTagged(await context.client.command(close ? "CLOSE" : "EXPUNGE"), "OK", undefined, folder);
		assert.deepEqual([context.row(id).status, context.row(id).folder_id], ["trash", null], folder);
		assert.ok(await stored(context, `inbound/${id}.eml`), folder);
	}
	draft(context, "d-1");
	await context.client.command("SELECT Drafts");
	assertTagged(await context.client.command("MOVE 1 Archive"), "NO", /\[CANNOT\] Drafts can only be moved to Trash/);
	assertTagged(await context.client.command("MOVE 1 Trash"), "OK");
	assert.equal(context.row("d-1").status, "trash");
});

// ---- Fail closed without bp0003 / bp0004 ----------------------------------------------------

test("a5.2c: without bp0003 nothing in Trash or Drafts can be marked or deleted: STORE and EXPUNGE are CANNOT, CLOSE deletes nothing, the primitive refuses", async (t) => {
	const context = await setup(t);
	await trash(context, ["t-1"]);
	draft(context, "d-1");
	await context.client.command("SELECT Trash");
	await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
	await context.client.command("SELECT Drafts");
	await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
	exec(context, "DROP TRIGGER bp_imap_membership_clears_deleted");
	for (const folder of ["Trash", "Drafts"]) {
		const select = await context.client.command(`SELECT ${folder}`);
		assert.ok(texts(select).includes("* OK [PERMANENTFLAGS (\\Seen \\Flagged)] Flags permitted"), folder);
		assertTagged(await context.client.command("STORE 1 -FLAGS (\\Deleted)"), "NO", /\[CANNOT\]/, folder);
		assertTagged(await context.client.command("EXPUNGE"), "NO", /\[CANNOT\] EXPUNGE is unavailable on this server right now/, folder);
		assertTagged(await context.client.command("CLOSE"), "OK", undefined, folder);
	}
	const db = app.getDb(context.env);
	for (const [key, id] of [["trash", "t-1"], ["drafts", "d-1"]]) {
		const folder = await app.imapState.findFolderRow(db, "mbx-a", key);
		const direct = await app.imapState.deleteImapMessagesPermanently(db, { folder, key }, [uidOf(context, id, key)], 1000, { ...OWNER, sharedAccess: true });
		assert.deepEqual(direct, { released: [], deleted: [] }, `${key}: the batch's own guard refuses`);
	}
	assert.ok(exists(context, "t-1") && exists(context, "d-1"));
	assert.equal(context.session.isClosed, false);
});

test("a5.2c: without one or all bp0004 triggers Drafts refuses \\Deleted and EXPUNGE and CLOSE deletes nothing; Trash still works", async (t) => {
	for (const missing of [[DRAFT_TRIGGERS[0]], [DRAFT_TRIGGERS[1]], [DRAFT_TRIGGERS[2]], DRAFT_TRIGGERS]) {
		const context = await setup(t);
		draft(context, "d-1");
		await trash(context, ["t-1"]);
		await context.client.command("SELECT Drafts");
		await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
		for (const name of missing) exec(context, `DROP TRIGGER ${name}`);
		const select = await context.client.command("SELECT Drafts");
		assert.ok(texts(select).includes("* OK [PERMANENTFLAGS (\\Seen \\Flagged)] Flags permitted"), missing.join());
		assertTagged(await context.client.command("STORE 1 +FLAGS (\\Deleted)"), "NO", /\[CANNOT\] \\Deleted is unavailable in Drafts/, missing.join());
		assertTagged(await context.client.command("EXPUNGE"), "NO", /\[CANNOT\] EXPUNGE is unavailable in Drafts/, missing.join());
		assertTagged(await context.client.command("CLOSE"), "OK");
		const db = app.getDb(context.env);
		const folder = await app.imapState.findFolderRow(db, "mbx-a", "drafts");
		assert.deepEqual((await app.imapState.deleteImapMessagesPermanently(db, { folder, key: "drafts" }, [uidOf(context, "d-1", "drafts")], 1000, { ...OWNER, sharedAccess: true })).deleted, [], missing.join());
		assert.ok(exists(context, "d-1"), missing.join());
		await context.client.command("SELECT Trash");
		assertTagged(await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)"), "OK");
		assertTagged(await context.client.command("EXPUNGE"), "OK");
		assert.equal(exists(context, "t-1"), false, "Trash needs only bp0003");
	}
});

// ---- Races: nothing replaced or unrelated is ever deleted -----------------------------------

/** Two Trash messages with bytes and one attachment each, t-1 marked \Deleted through `context`'s session. */
async function markedTrash(context, ids = ["t-1", "t-2"], marked = [1]) {
	await trash(context, ids);
	const keys = {};
	for (const id of ids) keys[id] = await attach(context, id, `att-${id}`);
	await context.client.command("SELECT Trash");
	for (const sequence of marked) assertTagged(await context.client.command(`STORE ${sequence} +FLAGS.SILENT (\\Deleted)`), "OK");
	return keys;
}

test("a5.2c race: MOVE out of Trash right before the delete batch wins; the moved message keeps its row, bytes and attachment", async (t) => {
	const context = await setup(t);
	const keys = await markedTrash(context);
	const other = await connect(context);
	beforeBatch(context, PERMANENT, async () => {
		const trashView = await app.imap.openImapFolder(context.env, other.principal, "trash");
		await app.imap.moveImapMessages(context.env, other.principal, "trash", [trashView.messages[0].uid], "inbox");
	});
	assertTagged(await context.client.command("EXPUNGE"), "OK");
	assert.equal(context.row("t-1").status, "received");
	assert.ok((await stored(context, "inbound/t-1.eml")) && (await stored(context, keys["t-1"])));
	assert.equal(mappings(context, "t-1").every((row) => row.deleted === 0), true, "the moved message carries no \\Deleted");
	await assertInvariants(context);
});

test("a5.2c race: STORE -FLAGS \\Deleted right before the delete batch wins", async (t) => {
	const context = await setup(t);
	await markedTrash(context);
	beforeBatch(context, PERMANENT, () => app.imap.storeImapFlags(context.env, OWNER, "trash", [1], { mode: "remove", flags: ["deleted"] }));
	assertTagged(await context.client.command("EXPUNGE"), "OK");
	assert.ok(exists(context, "t-1") && (await stored(context, "inbound/t-1.eml")));
});

test("a5.2c race: two EXPUNGEs at once delete each message exactly once, and each removes its objects only after its own commit", async (t) => {
	const context = await setup(t);
	const ids = Array.from({ length: 30 }, (_, index) => `t-${index}`);
	await trash(context, ids);
	await context.client.command("SELECT Trash");
	await context.client.command("STORE 1:* +FLAGS.SILENT (\\Deleted)");
	const other = await connect(context);
	const deletes = watchDeletes(context);
	const [a, b] = await Promise.all([app.imap.expungeImapFolder(context.env, context.principal, "trash", 1000), app.imap.expungeImapFolder(context.env, other.principal, "trash", 1000)]);
	assert.deepEqual([...new Set([...a, ...b])].sort((x, y) => x - y), Array.from({ length: 30 }, (_, index) => index + 1));
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages").n, 0);
	assert.equal(new Set(deletes).size, 30, "every raw object deleted");
	assert.ok(deletes.length <= 60, "no more than one delete per EXPUNGE per object");
});

test("a5.2c race: JMAP destroy before or after the IMAP delete batch: one of them deletes, neither fails, nothing unrelated is touched", async (t) => {
	const context = await setup(t);
	await markedTrash(context, ["t-1", "t-2", "t-3"], [1, 2]);
	beforeBatch(context, PERMANENT, async () => assert.deepEqual((await jmapDestroy(context, "t-1")).destroyed, ["t-1"]));
	assertTagged(await context.client.command("EXPUNGE"), "OK");
	assert.equal(exists(context, "t-1"), false);
	assert.equal(exists(context, "t-2"), false);
	assert.deepEqual((await jmapDestroy(context, "t-2")).notDestroyed, { "t-2": { type: "notFound" } }, "a JMAP destroy after the IMAP deletion finds nothing");
	assert.ok(exists(context, "t-3") && (await stored(context, "inbound/t-3.eml")));
	await assertInvariants(context);
});

test("a5.2c race: the web draft delete right before the IMAP delete batch wins; nothing else is deleted", async (t) => {
	const context = await setup(t);
	draft(context, "d-1");
	draft(context, "d-2");
	await context.client.command("SELECT Drafts");
	await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
	beforeBatch(context, PERMANENT, async () => assert.equal((await webDraftDelete(context, "d-1")).status, 200));
	assertTagged(await context.client.command("EXPUNGE"), "OK");
	assert.equal(exists(context, "d-1"), false);
	assert.ok(exists(context, "d-2"));
});

test("a5.2c race: a draft edit, an attachment added or removed right before the delete batch: the draft survives", async (t) => {
	for (const [name, change] of [
		["content edit", (context) => webDraftPatch(context, "d-1", { mailboxId: "mbx-a", from: "a@example.test", to: "b@elsewhere.test", subject: "raced", text: "raced", html: "" })],
		["attachment added", (context) => app.storeMessageAttachments(context.env, "d-1", [{ filename: "r.txt", type: "text/plain", content: new TextEncoder().encode("r").buffer }])],
		["attachment removed", (context) => app.deleteMessageAttachment(context.env, "d-1", "att-d")],
	]) {
		const context = await setup(t);
		draft(context, "d-1");
		await attach(context, "d-1", "att-d");
		await context.client.command("SELECT Drafts");
		await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
		beforeBatch(context, PERMANENT, () => change(context));
		assertTagged(await context.client.command("EXPUNGE"), "OK", undefined, name);
		assert.ok(exists(context, "d-1"), name);
		await assertInvariants(context);
	}
});

test("a5.2c: authority is re-checked inside the delete: a credential revoked, access downgraded or removed, account or mailbox disabled after the JS check deletes nothing", async (t) => {
	const cases = [
		["app password revoked", (context) => exec(context, `DELETE FROM mail_app_passwords WHERE id = '${context.credentialId}'`)],
		["mailbox access removed", (context) => exec(context, "DELETE FROM mailbox_access WHERE id = 'acc-b'")],
		["downgraded to read_only", (context) => exec(context, "UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-b'")],
		["downgraded to send_as", (context) => exec(context, "UPDATE mailbox_access SET permission = 'send_as' WHERE id = 'acc-b'")],
		["user disabled", (context) => exec(context, "UPDATE users SET disabled = 1 WHERE id = 'user-b'")],
		["mailbox disabled", (context) => exec(context, "UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-s'")],
	];
	for (const [name, revoke] of cases) {
		const context = await install(app, t);
		exec(context, "UPDATE mailbox_access SET permission = 'full_access' WHERE id = 'acc-b'");
		await context.deliver("s-1", "Subject: s\r\n\r\ns\r\n", { mailbox_id: "mbx-s", status: "trash" });
		const session = { ...context, ...(await connect(context, { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" })) };
		await session.client.command("SELECT Trash");
		await session.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
		const deletes = watchDeletes(context);
		beforeBatch(context, PERMANENT, () => revoke(session));
		await session.client.command("EXPUNGE");
		assert.ok(exists(context, "s-1"), name);
		assert.ok(await stored(context, "inbound/s-1.eml"), name);
		assert.deepEqual(deletes, [], `${name}: storage untouched`);
	}
});

test("a5.2c: access lost between chunks: earlier chunks stay deleted (and cleaned), later ones are refused; revocation is BYE, a downgrade NOPERM", async (t) => {
	for (const [name, revoke, expectBye] of [
		["app password revoked", (context) => exec(context, `DELETE FROM mail_app_passwords WHERE id = '${context.credentialId}'`), true],
		["downgraded to read_only", (context) => exec(context, "UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-b'"), false],
		["mailbox access removed", (context) => exec(context, "DELETE FROM mailbox_access WHERE id = 'acc-b'"), true],
	]) {
		const context = await install(app, t);
		exec(context, "UPDATE mailbox_access SET permission = 'full_access' WHERE id = 'acc-b'");
		const ids = Array.from({ length: 30 }, (_, index) => `s-${String(index).padStart(2, "0")}`);
		for (const id of ids) await context.deliver(id, `Subject: ${id}\r\n\r\nx\r\n`, { mailbox_id: "mbx-s", status: "trash" });
		const session = { ...context, ...(await connect(context, { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" })) };
		await session.client.command("SELECT Trash");
		await session.client.command("STORE 1:* +FLAGS.SILENT (\\Deleted)");
		afterBatch(context, PERMANENT, () => revoke(session));
		const result = await session.client.command("EXPUNGE");
		const remaining = sql(context, "SELECT id FROM messages ORDER BY id").map((row) => row.id);
		assert.deepEqual(remaining, ids.slice(25), `${name}: the first chunk of 25 committed, the rest was refused`);
		for (const id of ids.slice(0, 25)) assert.equal(await stored(context, `inbound/${id}.eml`), false, `${name}: committed chunk cleaned`);
		for (const id of ids.slice(25)) assert.ok(await stored(context, `inbound/${id}.eml`), name);
		if (expectBye) assert.ok(result.closed || result.untagged.some((unit) => unit.text.startsWith("* BYE")), name);
		else {
			assertTagged(result, "NO", /\[NOPERM\]/, name);
			assert.equal(texts(result).filter((line) => line.endsWith("EXPUNGE")).length, 25, `${name}: what was deleted is still reported`);
		}
	}
});

test("a5.2c: stale sequence numbers, stale UIDs and a source UID that disappeared never reach another message; a retry deletes nothing", async (t) => {
	const context = await setup(t);
	await trash(context, ["t-1", "t-2", "t-3"]);
	const other = await connect(context);
	await context.client.command("SELECT Trash");
	await other.client.command("SELECT Trash");
	// Another session deletes t-1; this one still sees it as sequence 1.
	await other.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)");
	await other.client.command("EXPUNGE");
	assertTagged(await context.client.command("STORE 1 +FLAGS.SILENT (\\Deleted)"), "NO", /no longer exist/);
	assert.deepEqual(sql(context, "SELECT message_id FROM imap_message_uids WHERE deleted = 1"), [], "the stale sequence number marked nobody");
	const uidStore = await context.client.command("UID STORE 1,99 +FLAGS.SILENT (\\Deleted)");
	assertTagged(uidStore, "OK");
	assert.deepEqual(texts(uidStore), ["* 1 EXPUNGE"], "a UID command reports the other session's deletion (RFC 3501 §7.4.1)");
	assert.deepEqual(sql(context, "SELECT message_id FROM imap_message_uids WHERE deleted = 1"), [], "stale and unknown UIDs mark nobody");
	// t-2 is marked, then moved away by the web app before EXPUNGE: its source UID disappears.
	await context.client.command("UID STORE 2 +FLAGS.SILENT (\\Deleted)");
	exec(context, "UPDATE messages SET status = 'received' WHERE id = 't-2'");
	const result = await context.client.command("EXPUNGE");
	assertTagged(result, "OK");
	assert.deepEqual(texts(result), ["* 1 EXPUNGE"], "t-2's vanished UID, now sequence 1, is reported; nothing was deleted");
	assert.ok(exists(context, "t-2") && exists(context, "t-3"));
	const deletes = watchDeletes(context);
	assert.deepEqual(await app.imap.expungeImapFolder(context.env, context.principal, "trash", 1000), []);
	assert.deepEqual(deletes, [], "a retry after the committed deletion touches no storage");
});

// ---- Storage: database first, objects after, best effort ------------------------------------

test("a5.2c storage: an object already absent is fine; delete failures of raw bytes or attachments are logged and never undo or fail the committed deletion", async (t) => {
	const context = await setup(t);
	const logs = captureLogs(t);
	const keys = await markedTrash(context, ["t-1", "t-2", "t-3"], [1, 2, 3]);
	await context.env.BUCKET.delete("inbound/t-1.eml");
	const deletes = watchDeletes(context, (key) => key === "inbound/t-2.eml" || key === keys["t-3"]);
	const result = await context.client.command("EXPUNGE");
	assertTagged(result, "OK", /EXPUNGE completed/);
	assert.deepEqual(texts(result), ["* 3 EXPUNGE", "* 2 EXPUNGE", "* 1 EXPUNGE"]);
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages").n, 0, "all three rows are deleted regardless");
	assert.ok(deletes.includes("inbound/t-1.eml"), "an absent object is deleted without error");
	assert.equal(await stored(context, keys["t-1"]), false);
	assert.equal(await stored(context, keys["t-2"]), false, "the attachment of the message whose raw delete failed is still removed");
	assert.ok(await stored(context, "inbound/t-2.eml"), "the failed raw object is left as an orphan");
	assert.ok(await stored(context, keys["t-3"]), "the failed attachment object is left as an orphan");
	const failures = logs.filter((line) => line.event === "expunge.cleanup-failed");
	assert.deepEqual(failures.map((line) => [line.messageId, line.key, line.stage]).sort(), [["t-2", "inbound/t-2.eml", "delete"], ["t-3", keys["t-3"], "delete"]]);
	assert.ok(failures.every((line) => /injected storage failure/.test(line.error) && !("body" in line)));
});

test("a5.2c storage: keys outside the message's own namespaces, and keys another live row references, are never deleted", async (t) => {
	const context = await setup(t);
	const logs = captureLogs(t);
	await trash(context, ["t-1", "t-2", "t-3", "t-4", "t-5"]);
	await context.env.BUCKET.put("backups/b-1/backup.json", "{}");
	await context.env.BUCKET.put("canonical/t-9/x.eml", "someone else's");
	await context.env.BUCKET.put("inbound/shared.eml", "shared");
	exec(context, `
		UPDATE messages SET raw_r2_key = 'backups/b-1/backup.json' WHERE id = 't-1';
		UPDATE messages SET raw_r2_key = 'canonical/t-9/x.eml' WHERE id = 't-2';
		UPDATE messages SET raw_r2_key = 'inbound/shared.eml' WHERE id IN ('t-3', 't-4');
		UPDATE messages SET raw_r2_key = 'inbound/../backups/b-1/backup.json' WHERE id = 't-5';
	`);
	await context.client.command("SELECT Trash");
	await context.client.command("STORE 1,2,3,5 +FLAGS.SILENT (\\Deleted)");
	const deletes = watchDeletes(context);
	assertTagged(await context.client.command("EXPUNGE"), "OK");
	assert.deepEqual(sql(context, "SELECT id FROM messages").map((row) => row.id), ["t-4"]);
	assert.deepEqual(deletes, [], "nothing was deleted from storage");
	assert.ok(await stored(context, "backups/b-1/backup.json"));
	assert.ok(await stored(context, "canonical/t-9/x.eml"));
	assert.ok(await stored(context, "inbound/shared.eml"), "t-4 still references it");
	const skipped = logs.filter((line) => line.event === "expunge.cleanup-skipped").map((line) => [line.messageId, line.reason]).sort();
	assert.deepEqual(skipped, [["t-1", "not a key this message owns"], ["t-2", "not a key this message owns"], ["t-3", "still referenced by a live row"], ["t-5", "not a key this message owns"]]);
});

test("a5.2c storage: only attachment keys of messages the guarded DELETE actually removed are cleaned up", async (t) => {
	const context = await setup(t);
	const keys = await markedTrash(context, ["t-1", "t-2"], [1, 2]);
	// t-2's mark is cleared by a concurrent writer right before the batch: S1's candidate set shrinks with the delete's.
	beforeBatch(context, PERMANENT, () => exec(context, "UPDATE imap_message_uids SET deleted = 0 WHERE message_id = 't-2'"));
	assertTagged(await context.client.command("EXPUNGE"), "OK");
	assert.equal(exists(context, "t-1"), false);
	assert.ok(exists(context, "t-2") && (await stored(context, keys["t-2"])) && (await stored(context, "inbound/t-2.eml")));
	// And at the primitive: attachment keys come back only for deleted messages.
	await trash(context, ["t-3"]);
	const k3 = await attach(context, "t-3", "att-t-3");
	const db = app.getDb(context.env);
	await app.imap.openImapFolder(context.env, OWNER, "trash");
	exec(context, "UPDATE imap_message_uids SET deleted = 1 WHERE message_id = 't-3'");
	const folder = await app.imapState.findFolderRow(db, "mbx-a", "trash");
	const direct = await app.imapState.deleteImapMessagesPermanently(db, { folder, key: "trash" }, [uidOf(context, "t-2", "trash"), uidOf(context, "t-3", "trash")], 1000, { ...OWNER, sharedAccess: true });
	assert.deepEqual(direct.deleted.map((row) => [row.messageId, row.rawKey, row.attachmentKeys]), [["t-3", "inbound/t-3.eml", [k3]]]);
	assert.ok(exists(context, "t-2"));
});

test("a5.2c storage: a failing database batch never reaches storage; cleanup is idempotent when repeated", async (t) => {
	const context = await setup(t);
	const keys = await markedTrash(context, ["t-1"], [1]);
	const deletes = watchDeletes(context);
	beforeBatch(context, PERMANENT, async () => {
		throw new Error("injected database failure");
	});
	assertTagged(await context.client.command("EXPUNGE"), "NO", /\[UNAVAILABLE\]/);
	assert.ok(exists(context, "t-1"));
	assert.deepEqual(deletes, []);
	const deleted = [{ uid: 1, messageId: "t-1", rawKey: "inbound/t-1.eml", attachmentKeys: [keys["t-1"]] }];
	exec(context, "DELETE FROM messages WHERE id = 't-1'");
	const first = await app.cleanupDeletedMessageObjects(context.env, app.getDb(context.env), deleted);
	const second = await app.cleanupDeletedMessageObjects(context.env, app.getDb(context.env), deleted);
	assert.deepEqual(first, { removed: ["inbound/t-1.eml", keys["t-1"]], skipped: [], failed: [] });
	assert.deepEqual(second, first, "a repeated cleanup of already-absent objects succeeds the same way");
});

test("a5.2c: the object-key allowlist accepts exactly the shapes the writers produce", () => {
	const ok = (kind, key, id = "msg_1") => app.imapUtils.isDeletableMessageObjectKey(kind, key, id);
	assert.ok(ok("raw", "inbound/1790000000000-abc.eml"));
	assert.ok(ok("raw", "imports/msg_1.eml"));
	assert.ok(ok("raw", "drafts/msg_1.eml"));
	assert.ok(ok("raw", "copies/msg_1.eml"), "IMAP COPY's raw objects (A5.8)");
	assert.ok(ok("raw", "canonical/msg_1/0123456789abcdef0123456789abcdef-11111111-2222-3333-4444-555555555555.eml"));
	assert.ok(ok("attachment", "attachments/msg_1/att_1/report final.pdf"));
	for (const [kind, key] of [
		["raw", "backups/x/backup.json"], ["raw", "jmap-uploads/u/x"], ["raw", "imports/msg_2.eml"], ["raw", "drafts/msg_2.eml"], ["raw", "copies/msg_2.eml"], ["raw", "copies/msg_1.eml/x"], ["raw", "copies/msg_1"], ["raw", "canonical/msg_2/x.eml"],
		["raw", "inbound/../backups/x.eml"], ["raw", "inbound/"], ["raw", "inbound/a/b.eml"], ["raw", "/inbound/x.eml"], ["raw", "inbound/x.txt"], ["raw", "attachments/msg_1/a/b"],
		["attachment", "attachments/msg_2/att/x"], ["attachment", "attachments/msg_1/att/.."], ["attachment", "attachments/msg_1/x"], ["attachment", "inbound/x.eml"], ["raw", null], ["raw", ""], ["raw", "inbound\\x.eml"],
	]) assert.equal(ok(kind, key), false, `${kind} ${key}`);
});
