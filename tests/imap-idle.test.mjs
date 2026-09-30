import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { assertTagged, createClock, install, loadApp, makeCertificate, memoryClient, tlsClient } from "./support/imap-harness.mjs";

/**
 * A5.4: IMAP IDLE (RFC 2177) over the real A2 verifier and A3 state (SQLite, no Workers), with a
 * deterministic clock, and over the real Node TLS listener with shortened limits.
 *
 * - IDLE is legal in the authenticated and selected states; `+ idling`, then DONE (exact,
 *   case-insensitive) ends it with a tagged OK. The next line is taken raw by the framer.
 * - While idling only the database decides what the client is told: A3's getImapChangeSignal
 *   (authority, mailbox revision, UIDVALIDITY) every poll, the existing refresh when the signal
 *   moved, and an unconditional refresh at the reconciliation interval for IMAP-only state the
 *   revision does not cover (\Deleted marks, attachment-only Drafts UID releases).
 * - Keepalives are `* OK Still here`; autologout counts client input only.
 */
const { app, cleanup } = await loadApp("imap-idle");
test.after(cleanup);

const AUTH = "IMAP4rev1 ID NAMESPACE UNSELECT SPECIAL-USE MOVE UIDPLUS IDLE";
const POLL = 10_000;
const RECONCILE = 300_000;
const KEEPALIVE = 120_000;
const SHARED = { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" };
const texts = (result) => result.untagged.map((unit) => unit.text);
const exec = (context, query) => context.database.db.exec(query);
const one = (context, query, ...params) => context.database.db.prepare(query).get(...params);
const uidOf = (context, messageId, key) => one(context, "SELECT u.uid FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE u.message_id = ? AND f.folder_key = ?", messageId, key)?.uid ?? null;

/** A logged-in session on a virtual clock; `random` 0.5 makes every jittered interval exact. */
async function idler(context, { account = {}, random = () => 0.5, write, onDelay } = {}) {
	const { userId = "user-a", mailboxId = "mbx-a", address = "a@example.test" } = account;
	const clock = createClock();
	let clientRef = null;
	const overrides = {
		now: clock.now,
		delay: (ms, signal) => {
			onDelay?.(ms);
			return clock.delay(ms, signal);
		},
	};
	if (write) overrides.write = (bytes) => write(bytes, clientRef);
	const { client, session, start } = memoryClient(app, context.env, overrides, { random });
	clientRef = client;
	clock.watch(session);
	await start();
	const { credential, id } = await context.credential(userId, mailboxId);
	assertTagged(await client.login(address, credential), "OK");
	return { client, session, clock, credentialId: id };
}

async function other(context, account = {}) {
	const { userId = "user-a", mailboxId = "mbx-a", address = "a@example.test" } = account;
	const { client, start } = memoryClient(app, context.env);
	await start();
	const { credential } = await context.credential(userId, mailboxId);
	assertTagged(await client.login(address, credential), "OK");
	return client;
}

/** Let pending promise callbacks (aborts, cancellations) run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Every complete unit the client has buffered right now. */
async function drain(client) {
	const out = [];
	for (;;) {
		let unit;
		try {
			unit = await client.unit(25);
		} catch {
			break;
		}
		if (!unit) {
			out.push("<closed>");
			break;
		}
		out.push(unit.text);
	}
	return out;
}

/** Send `tag IDLE`, wait for the loop's first poll to finish, and return everything sent so far. */
async function startIdle(idle, tag = "i1") {
	const mark = idle.clock.registrations;
	idle.client.write(`${tag} IDLE\r\n`);
	assert.ok(await idle.clock.settle(mark), "the IDLE loop reaches its first wait");
	return drain(idle.client);
}

async function done(idle, tag = "i1") {
	idle.client.write("DONE\r\n");
	return idle.client.collect(tag);
}

/** Count full refreshes (openImapFolder's entry read) and change-signal reads from now on. */
function countQueries(context) {
	const database = context.database;
	const prepare = database.prepare.bind(database);
	const counts = { refreshes: 0, signals: 0 };
	database.prepare = (query) => {
		if (/^select "imap_message_uids"\."uid", "imap_message_uids"\."deleted", "imap_message_uids"\."rfc822_size"/.test(query)) counts.refreshes += 1;
		if (/^select "revision" from "jmap_mailbox_revisions"/.test(query)) counts.signals += 1;
		return prepare(query);
	};
	counts.stop = () => (database.prepare = prepare);
	return counts;
}

/** Make prepared statements matching `pattern` throw while `active()` holds. */
function failQueries(context, pattern, active = () => true) {
	const database = context.database;
	const prepare = database.prepare.bind(database);
	database.prepare = (query) => {
		if (pattern.test(query) && active()) throw new Error("injected database failure");
		return prepare(query);
	};
	return () => (database.prepare = prepare);
}

async function deliverMany(context, ids, values = {}) {
	for (const id of ids) await context.deliver(id, `Subject: ${id}\r\n\r\nbody of ${id}\r\n`, values);
}

function draft(context, id) {
	context.database.db
		.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, read, created_at) VALUES (?, 'user-a', 'mbx-a', 'outbound', 'a@example.test', 'b@elsewhere.test', ?, 'draft body', 'draft', 1, 1790400000)")
		.run(id, id);
}

// ---- Protocol ------------------------------------------------------------------------------------

test("a5.4: IDLE is advertised and accepted after authentication only", async (t) => {
	const context = await install(app, t);
	const { client, start } = memoryClient(app, context.env);
	const greeting = await start();
	assert.ok(!greeting.text.includes("IDLE"));
	assert.deepEqual(texts(await client.command("CAPABILITY")), ["* CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN ID"]);
	assertTagged(await client.command("IDLE"), "BAD", /not valid in this state/);
	const { credential } = await context.credential("user-a", "mbx-a");
	assertTagged(await client.login("a@example.test", credential), "OK", new RegExp(`\\[CAPABILITY ${AUTH}\\]`));
	assert.equal(app.AUTH_CAPABILITIES, AUTH);
	assert.deepEqual(texts(await client.command("CAPABILITY")), [`* CAPABILITY ${AUTH}`]);
	assertTagged(await client.command("IDLE extra"), "BAD", /Unexpected extra arguments/);
	assert.deepEqual(app.DEFAULT_IDLE_TIMING, { pollMs: 10_000, pollJitter: 0.2, reconcileMs: 300_000, keepaliveMs: 120_000, authUncertainMs: 60_000, unavailableMs: 120_000 });
});

test("a5.4: IDLE in the authenticated state: continuation, authority polled, keepalive, DONE; no mailbox refresh and no state change", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1"]);
	const idle = await idler(context);
	const counts = countQueries(context);
	assert.deepEqual(await startIdle(idle), ["+ idling"]);
	assert.equal(idle.session.isIdling, true);
	await idle.clock.advance(KEEPALIVE - 1);
	assert.deepEqual(await drain(idle.client), []);
	await idle.clock.advance(1);
	assert.deepEqual(await drain(idle.client), ["* OK Still here"]);
	counts.stop();
	assert.equal(counts.refreshes, 0, "nothing is selected: no mailbox refresh");
	assert.ok(counts.signals >= 12, "authority and the signal were polled every interval");
	assertTagged(await done(idle), "OK", /^i1 OK IDLE completed$/);
	assert.equal(idle.session.isIdling, false);
	assertTagged(await idle.client.command("FETCH 1 FLAGS"), "BAD", /not valid in this state/, "still authenticated, not selected");
});

test("a5.4: SELECT and EXAMINE keep their state across IDLE; DONE is exact and case-insensitive; repeated IDLE/DONE", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1"]);
	const idle = await idler(context);
	await idle.client.command("SELECT INBOX");
	for (const [tag, line] of [["i1", "DONE"], ["i2", "done"], ["i3", "DoNe"]]) {
		assert.deepEqual(await startIdle(idle, tag), ["+ idling"]);
		idle.client.write(`${line}\r\n`);
		assertTagged(await idle.client.collect(tag), "OK", /IDLE completed/, line);
	}
	assertTagged(await idle.client.command("STORE 1 +FLAGS (\\Flagged)"), "OK", undefined, "still selected read-write");
	await idle.client.command("EXAMINE INBOX");
	assert.deepEqual(await startIdle(idle, "i4"), ["+ idling"]);
	assertTagged(await done(idle, "i4"), "OK");
	assertTagged(await idle.client.command("STORE 1 +FLAGS (\\Seen)"), "NO", /read-only/, "still read-only after IDLE");
	assert.equal(idle.clock.pending, 0, "no timer outlives DONE");
});

test("a5.4: a line other than DONE ends IDLE with BAD and is run as a command; whitespace makes it not DONE", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1"]);
	const idle = await idler(context);
	await idle.client.command("SELECT INBOX");
	await startIdle(idle);
	idle.client.write("a2 NOOP\r\n");
	assertTagged(await idle.client.collect("i1"), "BAD", /^i1 BAD Expected DONE$/);
	assertTagged(await idle.client.collect("a2"), "OK", /NOOP completed/, "the line runs as the next command");
	for (const [index, line] of [" DONE", "DONE ", "DONE\tx", "DONEX"].entries()) {
		const tag = `w${index}`;
		await startIdle(idle, tag);
		idle.client.write(`${line}\r\n`);
		assertTagged(await idle.client.collect(tag), "BAD", /Expected DONE/, JSON.stringify(line));
		await drain(idle.client);
	}
	assertTagged(await idle.client.command("NOOP"), "OK", undefined, "the stream is still in sync");
	// LOGOUT instead of DONE still logs out.
	await startIdle(idle, "i9");
	idle.client.write("z LOGOUT\r\n");
	assertTagged(await idle.client.collect("i9"), "BAD", /Expected DONE/);
	const logout = await idle.client.collect("z");
	assertTagged(logout, "OK", /LOGOUT completed/);
	assert.deepEqual(texts(logout), ["* BYE Logging out"]);
	await flush();
	assert.equal(idle.session.isClosed, true);
	assert.equal(idle.clock.pending, 0);
});

test("a5.4: a literal where DONE was expected ends the session; nothing reads the announced octets", async (t) => {
	const context = await install(app, t);
	const idle = await idler(context);
	await startIdle(idle);
	idle.client.write("a2 SELECT {5}\r\n");
	const result = await idle.client.collect("i1");
	assertTagged(result, "BAD", /Expected DONE/);
	const rest = await drain(idle.client);
	assert.deepEqual(rest, ["* BYE Protocol violation: a literal where DONE was expected", "<closed>"]);
	assert.equal(idle.session.isClosed, true);
});

test("a5.4: DONE split across chunks, input pipelined after DONE, and input sent before the continuation", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1"]);
	const idle = await idler(context);
	await idle.client.command("SELECT INBOX");
	await startIdle(idle);
	idle.client.write("DO");
	await idle.clock.advance(POLL);
	assert.equal(idle.session.isIdling, true, "half a line is not DONE");
	idle.client.write("NE\r\na2 NOOP\r\na3 CAPABILITY\r\n");
	assertTagged(await idle.client.collect("i1"), "OK", /IDLE completed/);
	assertTagged(await idle.client.collect("a2"), "OK");
	assertTagged(await idle.client.collect("a3"), "OK");
	// DONE sent without waiting for `+`: accepted.
	idle.client.write("i2 IDLE\r\nDONE\r\n");
	const early = await idle.client.collect("i2");
	assertTagged(early, "OK", /IDLE completed/);
	assert.deepEqual(texts(early), ["+ idling"]);
	// A command sent without waiting for `+`: IDLE ends at once with BAD, the command runs.
	idle.client.write("i3 IDLE\r\na4 NOOP\r\n");
	assertTagged(await idle.client.collect("i3"), "BAD", /Expected DONE/);
	assertTagged(await idle.client.collect("a4"), "OK");
	assert.equal(idle.session.isIdling, false);
	assert.equal(idle.clock.pending, 0);
});

test("a5.4: an overlong line while idling ends the session as the framer's limit requires", async (t) => {
	const context = await install(app, t);
	const idle = await idler(context);
	await startIdle(idle);
	idle.client.write(`${"x".repeat(70 * 1024)}\r\n`);
	const rest = await drain(idle.client);
	assert.deepEqual(rest, ["* BYE Command line too long", "<closed>"]);
	assert.equal(idle.session.isClosed, true);
	assert.equal(idle.clock.pending, 0);
});

test("a5.4: disconnect and server shutdown during IDLE stop the loop: no timer left, nothing written after close", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1"]);
	const idle = await idler(context);
	await idle.client.command("SELECT INBOX");
	await startIdle(idle);
	assert.equal(idle.clock.pending, 1);
	idle.session.transportClosed();
	await flush();
	assert.equal(idle.clock.pending, 0, "the pending wait was cancelled");
	assert.equal(idle.session.isIdling, false);
	await context.deliver("m-2", "Subject: late\r\n\r\nx\r\n");
	await idle.clock.advance(RECONCILE);
	assert.deepEqual(await drain(idle.client), [], "nothing is written after close");
	await idle.clock.delay(1_000_000);
	assert.equal(idle.clock.pending, 0, "a wait requested after close resolves at once");

	const second = await idler(context);
	await second.client.command("SELECT INBOX");
	await startIdle(second);
	await second.session.end("Server shutting down");
	assert.deepEqual(await drain(second.client), ["* BYE Server shutting down", "<closed>"]);
	await flush();
	assert.equal(second.session.isIdling, false);
	assert.equal(second.clock.pending, 0);
});

// ---- Mailbox changes -------------------------------------------------------------------------------

test("a5.4: a new message is announced at the next poll with EXISTS, and UID FETCH works at once", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1", "m-2"]);
	const idle = await idler(context);
	await idle.client.command("SELECT INBOX");
	assert.deepEqual(await startIdle(idle), ["+ idling"]);
	await context.deliver("m-3", "Subject: new\r\n\r\nnew body\r\n");
	await idle.clock.advance(POLL - 1);
	assert.deepEqual(await drain(idle.client), [], "not before the poll");
	await idle.clock.advance(1);
	assert.deepEqual(await drain(idle.client), ["* 3 EXISTS"]);
	assertTagged(await done(idle), "OK");
	const fetched = await idle.client.command(`UID FETCH ${uidOf(context, "m-3", "inbox")} (UID FLAGS)`);
	assertTagged(fetched, "OK");
	assert.deepEqual(texts(fetched), [`* 3 FETCH (UID ${uidOf(context, "m-3", "inbox")} FLAGS ())`]);
	assert.equal(one(context, "SELECT read FROM messages WHERE id = 'm-3'").read, 0, "IDLE never sets \\Seen");
});

test("a5.4: moves in and out, \\Seen and \\Flagged from another session are reported at the next poll", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1", "m-2", "m-3"]);
	await deliverMany(context, ["a-1"], { status: "archived" });
	const idle = await idler(context);
	const actor = await other(context);
	await idle.client.command("SELECT INBOX");
	await actor.command("SELECT INBOX");
	await startIdle(idle);
	const step = async (label, mutate, expected) => {
		await mutate();
		await idle.clock.advance(POLL);
		assert.deepEqual(await drain(idle.client), expected, label);
	};
	await step("\\Seen", () => actor.command("UID STORE 1 +FLAGS.SILENT (\\Seen)"), ["* 1 FETCH (FLAGS (\\Seen))"]);
	await step("\\Flagged", () => actor.command("UID STORE 1 +FLAGS.SILENT (\\Flagged)"), ["* 1 FETCH (FLAGS (\\Seen \\Flagged))"]);
	await step("MOVE out", () => actor.command("UID MOVE 2 Archive"), ["* 2 EXPUNGE"]);
	await step("move in (another path)", () => exec(context, "UPDATE messages SET status = 'received' WHERE id = 'a-1'"), ["* 3 EXISTS"]);
	await step("nothing", async () => {}, []);
	assertTagged(await done(idle), "OK");
	assert.deepEqual((await idle.client.command("UID SEARCH ALL")).untagged[0].text, `* SEARCH 1 3 ${uidOf(context, "a-1", "inbox")}`);
});

test("a5.4: \\Deleted from another session is not in the fast signal: reported by the reconciliation, not before", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1", "m-2"]);
	const idle = await idler(context);
	const actor = await other(context);
	await idle.client.command("SELECT INBOX");
	await actor.command("SELECT INBOX");
	await startIdle(idle);
	await actor.command("UID STORE 2 +FLAGS.SILENT (\\Deleted)");
	// Counted from here: the other session's STORE refreshes its own view, which is not IDLE's.
	const counts = countQueries(context);
	await idle.clock.advance(RECONCILE - POLL);
	assert.deepEqual(await drain(idle.client), ["* OK Still here", "* OK Still here"], "only keepalives before the reconciliation");
	assert.equal(counts.refreshes, 0, "the unchanged signal caused no refresh");
	await idle.clock.advance(POLL);
	assert.deepEqual(await drain(idle.client), ["* 2 FETCH (FLAGS (\\Deleted))"]);
	assert.equal(counts.refreshes, 1, "exactly one unconditional refresh at the bound");
	counts.stop();
});

test("a5.4: EXPUNGE and UID EXPUNGE to Trash, and permanent EXPUNGE and UID EXPUNGE in Trash, are reported while idling", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1", "m-2", "m-3", "m-4"]);
	await deliverMany(context, ["t-1", "t-2", "t-3"], { status: "trash" });
	const inbox = await idler(context);
	const trash = await idler(context);
	const actor = await other(context);
	await inbox.client.command("SELECT INBOX");
	await trash.client.command("SELECT Trash");
	await startIdle(inbox);
	await startIdle(trash);
	await actor.command("SELECT INBOX");
	await actor.command("UID STORE 1,3 +FLAGS.SILENT (\\Deleted)");
	await actor.command("UID EXPUNGE 3");
	await inbox.clock.advance(POLL);
	assert.deepEqual(await drain(inbox.client), ["* 3 EXPUNGE", "* 1 FETCH (FLAGS (\\Deleted))"], "UID EXPUNGE: only UID 3 left; the mark on UID 1 came with the refresh");
	await actor.command("EXPUNGE");
	await inbox.clock.advance(POLL);
	assert.deepEqual(await drain(inbox.client), ["* 1 EXPUNGE"], "recoverable EXPUNGE");
	await trash.clock.advance(POLL);
	assert.deepEqual(await drain(trash.client), ["* 5 EXISTS"], "both relocated messages arrive in Trash, announced once");
	await actor.command("SELECT Trash");
	await actor.command("UID STORE 1,2 +FLAGS.SILENT (\\Deleted)");
	await actor.command("UID EXPUNGE 1");
	await trash.clock.advance(POLL);
	assert.deepEqual(await drain(trash.client), ["* 1 EXPUNGE", "* 1 FETCH (FLAGS (\\Deleted))"], "permanent UID EXPUNGE, then the mark on what is now message 1");
	await actor.command("EXPUNGE");
	await trash.clock.advance(POLL);
	assert.deepEqual(await drain(trash.client), ["* 1 EXPUNGE"], "permanent EXPUNGE");
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages WHERE id IN ('t-1', 't-2')").n, 0);
});

test("a5.4: a draft content edit releases its UID and is reported at the next poll; an attachment-only change at the reconciliation", async (t) => {
	const context = await install(app, t);
	draft(context, "d-1");
	draft(context, "d-2");
	const idle = await idler(context);
	await idle.client.command("SELECT Drafts");
	await startIdle(idle);
	exec(context, "UPDATE messages SET subject = 'edited' WHERE id = 'd-1'");
	await idle.clock.advance(POLL);
	assert.deepEqual(await drain(idle.client), ["* 1 EXPUNGE", "* 2 EXISTS"], "old UID gone, the edited draft reappears");
	await app.storeMessageAttachments(context.env, "d-2", [{ filename: "x.txt", type: "text/plain", content: new TextEncoder().encode("x").buffer }]);
	await idle.clock.advance(POLL);
	assert.deepEqual(await drain(idle.client), [], "an attachment-only change does not move the revision");
	await idle.clock.advance(RECONCILE);
	assert.deepEqual((await drain(idle.client)).filter((line) => !line.includes("Still here")), ["* 1 EXPUNGE", "* 2 EXISTS"], "the reconciliation reports it");
});

test("a5.4: EXAMINE + IDLE receives changes without gaining write authority; only A3's UID bookkeeping is written", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1", "m-2"]);
	const idle = await idler(context);
	const actor = await other(context);
	await idle.client.command("EXAMINE INBOX");
	await actor.command("SELECT INBOX");
	await startIdle(idle);
	const messagesBefore = JSON.stringify(context.database.db.prepare("SELECT id, status, read, starred FROM messages ORDER BY id").all());
	await actor.command("UID STORE 2 +FLAGS.SILENT (\\Flagged)");
	await context.deliver("m-3", "Subject: new\r\n\r\nx\r\n");
	await idle.clock.advance(POLL);
	assert.deepEqual(await drain(idle.client), ["* 2 FETCH (FLAGS (\\Flagged))", "* 3 EXISTS"]);
	const messagesAfter = JSON.parse(JSON.stringify(context.database.db.prepare("SELECT id, status, read, starred FROM messages ORDER BY id").all()));
	assert.deepEqual(messagesAfter.filter((row) => row.id !== "m-3"), JSON.parse(messagesBefore).map((row) => (row.id === "m-2" ? { ...row, starred: 1 } : row)), "IDLE wrote nothing to messages");
	assert.ok(uidOf(context, "m-3", "inbox"), "the new message got its UID through A3's refresh");
	assertTagged(await done(idle), "OK");
	assertTagged(await idle.client.command("STORE 1 +FLAGS (\\Seen)"), "NO", /read-only/);
});

// ---- Signal, reconciliation, UIDVALIDITY -------------------------------------------------------------

test("a5.4: no refresh while the signal is unchanged; repeated IDLE/DONE never forces one; the reconciliation keeps its schedule", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1"]);
	const idle = await idler(context);
	await idle.client.command("SELECT INBOX");
	const counts = countQueries(context);
	await startIdle(idle);
	assert.equal(counts.refreshes, 1, "the first poll after SELECT refreshes once to learn the signal");
	for (let index = 0; index < 5; index += 1) {
		await idle.clock.advance(POLL);
		assertTagged(await done(idle), "OK");
		await startIdle(idle);
	}
	assert.equal(counts.refreshes, 1, "five IDLE/DONE cycles and polls with an unchanged signal refreshed nothing");
	assert.ok(counts.signals >= 11);
	await idle.clock.advance(RECONCILE - 5 * POLL - 1);
	assert.equal(counts.refreshes, 1);
	await idle.clock.advance(POLL);
	assert.equal(counts.refreshes, 2, "the reconciliation ran on schedule across IDLE commands");
	counts.stop();
});

test("a5.4: a mutation landing during a refresh is caught by the next poll", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1"]);
	const idle = await idler(context);
	await idle.client.command("SELECT INBOX");
	await startIdle(idle);
	await context.deliver("m-2", "Subject: two\r\n\r\nx\r\n");
	const database = context.database;
	const prepare = database.prepare.bind(database);
	let injected = false;
	database.prepare = (query) => {
		if (!injected && /^select "imap_message_uids"\."uid", "imap_message_uids"\."deleted"/.test(query)) {
			injected = true;
			database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES ('m-late', 'user-a', 'mbx-a', 'inbound', 's@x', 'a@example.test', 'received', 1790500000)").run();
		}
		return prepare(query);
	};
	await idle.clock.advance(POLL);
	database.prepare = prepare;
	assert.ok(injected);
	assert.deepEqual(await drain(idle.client), ["* 2 EXISTS"], "the refresh saw m-2 only");
	await idle.clock.advance(POLL);
	assert.deepEqual(await drain(idle.client), ["* 3 EXISTS"], "the late insert moved the revision after the signal was read");
});

test("a5.4: a changed UIDVALIDITY ends the session at the next poll; a deleted selected folder does too", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1"]);
	await deliverMany(context, ["w-1"], { folder_id: "fld-work" });
	const idle = await idler(context);
	await idle.client.command("SELECT INBOX");
	await startIdle(idle);
	exec(context, "UPDATE imap_folders SET uid_validity = uid_validity + 1 WHERE folder_key = 'inbox'");
	await idle.clock.advance(POLL);
	assert.deepEqual(await drain(idle.client), ["* BYE Mailbox UIDVALIDITY changed, select it again", "<closed>"]);

	const work = await idler(context);
	await work.client.command("SELECT Work");
	await startIdle(work);
	exec(context, "DELETE FROM folders WHERE id = 'fld-work'");
	await work.clock.advance(POLL);
	assert.deepEqual(await drain(work.client), ["* BYE Selected mailbox no longer exists", "<closed>"]);
});

test("a5.4: poll intervals stay within ±20% jitter", async (t) => {
	for (const [random, expected] of [[() => 0, 8_000], [() => 0.999999, 12_000], [() => 0.5, 10_000]]) {
		const context = await install(app, t);
		const requested = [];
		const idle = await idler(context, { random, onDelay: (ms) => requested.push(ms) });
		await startIdle(idle);
		await idle.clock.advance(3 * POLL);
		assert.ok(requested.length >= 2);
		for (const ms of requested) assert.ok(Math.abs(ms - expected) <= 1, `${ms} ≈ ${expected}`);
	}
});

// ---- Authorization --------------------------------------------------------------------------------

test("a5.4: revoked access ends IDLE with BYE at the next poll; a downgrade to read_only keeps idling without write authority", async (t) => {
	const cases = [
		["app password revoked", (context, idle) => exec(context, `DELETE FROM mail_app_passwords WHERE id = '${idle.credentialId}'`), true],
		["imap scope removed", (context, idle) => exec(context, `UPDATE mail_app_passwords SET scopes = '["smtp"]' WHERE id = '${idle.credentialId}'`), true],
		["mailbox access removed", (context) => exec(context, "DELETE FROM mailbox_access WHERE id = 'acc-b'"), true],
		["user disabled", (context) => exec(context, "UPDATE users SET disabled = 1 WHERE id = 'user-b'"), true],
		["mailbox disabled", (context) => exec(context, "UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-s'"), true],
		["sharing disabled", () => (process.env.BLUEPINE_DISABLED_FEATURES = "sharedMailboxes"), true],
		["downgraded to read_only", (context) => exec(context, "UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-b'"), false],
	];
	const previous = process.env.BLUEPINE_DISABLED_FEATURES;
	t.after(() => {
		if (previous === undefined) delete process.env.BLUEPINE_DISABLED_FEATURES;
		else process.env.BLUEPINE_DISABLED_FEATURES = previous;
	});
	for (const [name, revoke, bye] of cases) {
		delete process.env.BLUEPINE_DISABLED_FEATURES;
		const context = await install(app, t);
		exec(context, "UPDATE mailbox_access SET permission = 'full_access' WHERE id = 'acc-b'");
		await context.deliver("s-1", "Subject: s\r\n\r\ns\r\n", { mailbox_id: "mbx-s" });
		const idle = await idler(context, { account: SHARED });
		await idle.client.command("SELECT INBOX");
		await startIdle(idle);
		revoke(context, idle);
		await idle.clock.advance(POLL);
		const out = await drain(idle.client);
		if (bye) {
			assert.deepEqual(out, ["* BYE Access revoked", "<closed>"], name);
			assert.equal(idle.clock.pending, 0, name);
		} else {
			assert.deepEqual(out, [], name);
			assert.equal(idle.session.isIdling, true, name);
			assertTagged(await done(idle), "OK", undefined, name);
			assertTagged(await idle.client.command("UID STORE 1 +FLAGS (\\Deleted)"), "NO", /\[NOPERM\]/, `${name}: writes need what they always needed`);
		}
	}
});

// ---- Failure policy -------------------------------------------------------------------------------

test("a5.4: a transient poll failure is logged and retried; IDLE goes on", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1"]);
	const idle = await idler(context);
	await idle.client.command("SELECT INBOX");
	await startIdle(idle);
	let failures = 1;
	const restore = failQueries(context, /jmap_mailbox_revisions/, () => failures-- > 0);
	await context.deliver("m-2", "Subject: two\r\n\r\nx\r\n");
	await idle.clock.advance(POLL);
	assert.deepEqual(await drain(idle.client), []);
	assert.ok(idle.client.logs.some((event) => event.event === "idle.poll-error" && event.unconfirmed === false));
	await idle.clock.advance(POLL);
	assert.deepEqual(await drain(idle.client), ["* 2 EXISTS"], "the next poll succeeds");
	restore();
	assert.equal(idle.session.isIdling, true);
});

test("a5.4: authority unconfirmable for 60 s ends the session (fail closed); a failing database after authority was confirmed ends it after 2 minutes with [UNAVAILABLE]", async (t) => {
	const context = await install(app, t);
	const idle = await idler(context);
	await idle.client.command("SELECT INBOX");
	await startIdle(idle);
	const restore = failQueries(context, /from "users"/);
	await idle.clock.advance(50_000);
	assert.equal(idle.session.isIdling, true, "still within the uncertainty window");
	assert.ok(idle.client.logs.some((event) => event.event === "idle.poll-error" && event.unconfirmed === true));
	await idle.clock.advance(10_000);
	assert.deepEqual(await drain(idle.client), ["* BYE Access could not be confirmed", "<closed>"]);
	restore();

	const second = await idler(context);
	await second.client.command("SELECT INBOX");
	await startIdle(second);
	const restoreRevision = failQueries(context, /jmap_mailbox_revisions/);
	await second.clock.advance(120_000);
	assert.equal(second.session.isIdling, true, "authority is confirmed every poll, so 60 s pass; 120 s are not over");
	await second.clock.advance(POLL);
	assert.deepEqual((await drain(second.client)).filter((line) => !line.includes("Still here")), ["* BYE [UNAVAILABLE] Mailbox state is unavailable", "<closed>"]);
	restoreRevision();
});

// ---- Keepalive, backpressure, multi-instance ---------------------------------------------------------

test("a5.4: keepalive 120 s after the last write; a notification restarts that clock", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1"]);
	const idle = await idler(context);
	await idle.client.command("SELECT INBOX");
	await startIdle(idle);
	await idle.clock.advance(60_000);
	await context.deliver("m-2", "Subject: two\r\n\r\nx\r\n");
	await idle.clock.advance(POLL);
	assert.deepEqual(await drain(idle.client), ["* 2 EXISTS"]);
	await idle.clock.advance(KEEPALIVE - POLL);
	assert.deepEqual(await drain(idle.client), [], "120 s have not passed since the EXISTS");
	await idle.clock.advance(POLL);
	assert.deepEqual(await drain(idle.client), ["* OK Still here"]);
});

test("a5.4: a client that stops reading stalls the loop: one pending write, no keepalive racing it, no queue", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1"]);
	let stalled = false;
	let writes = 0;
	const write = async (bytes, client) => {
		writes += 1;
		if (stalled) return new Promise(() => {});
		client.accept(bytes);
	};
	const idle = await idler(context, { write });
	await idle.client.command("SELECT INBOX");
	await startIdle(idle);
	stalled = true;
	const before = writes;
	await context.deliver("m-2", "Subject: two\r\n\r\nx\r\n");
	await idle.clock.advance(POLL, 200);
	for (let index = 0; index < 10; index += 1) {
		await context.deliver(`m-x${index}`, "Subject: x\r\n\r\nx\r\n");
		await idle.clock.advance(KEEPALIVE, 50);
	}
	assert.equal(writes, before + 1, "exactly one write is pending; nothing else was produced");
	assert.equal(idle.clock.pending, 0, "the loop is parked on the write, not polling");
	// The listener's autologout ends such a session; ending must not wait for the stalled write.
	void idle.session.end("Autologout; idle for too long");
	assert.equal(idle.session.isClosed, true, "closed at once, before the BYE was written");
});

test("a5.4: no keepalive while another write is in flight (the loop's own writes are awaited; this guards writes started elsewhere)", async (t) => {
	const context = await install(app, t);
	const decoder = new TextDecoder();
	const write = async (bytes, client) => {
		if (decoder.decode(bytes).startsWith("* OK Held")) return new Promise(() => {});
		client.accept(bytes);
	};
	const idle = await idler(context, { write });
	await startIdle(idle);
	// A write that never completes, started outside the IDLE loop (the session's host wrapper counts it).
	void idle.session.host.write(new TextEncoder().encode("* OK Held\r\n"));
	await idle.clock.advance(3 * KEEPALIVE);
	assert.deepEqual(await drain(idle.client), [], "no keepalive raced the pending write");
	assert.equal(idle.session.isIdling, true, "polling went on");
});

test("a5.4 multi-instance: a change through an independent database connection, with no realtime hub, is detected by polling", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1"]);
	assert.equal(context.env.REALTIME, undefined, "no process-local event path exists");
	const idle = await idler(context);
	await idle.client.command("SELECT INBOX");
	await startIdle(idle);
	// A second connection to the same database file stands for another instance.
	const elsewhere = new app.SqliteDatabase(join(context.directory, "mailflare.sqlite"));
	try {
		elsewhere.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES ('m-far', 'user-a', 'mbx-a', 'inbound', 's@x', 'a@example.test', 'received', 1790600000)").run();
		elsewhere.db.prepare("UPDATE messages SET starred = 1 WHERE id = 'm-1'").run();
	} finally {
		elsewhere.db.close();
	}
	await idle.clock.advance(POLL);
	assert.deepEqual(await drain(idle.client), ["* 1 FETCH (FLAGS (\\Flagged))", "* 2 EXISTS"]);
});

// ---- Real Node TLS listener ------------------------------------------------------------------------

const LISTENER_LIMITS = { accessCheckIntervalMs: 60_000, idlePollMs: 60, idlePollJitter: 0, idleReconcileMs: 60_000, idleKeepaliveMs: 250, authenticatedIdleMs: 1_500 };

async function listening(t, limits = {}) {
	const context = await install(app, t);
	await deliverMany(context, ["m-1"]);
	const certificate = makeCertificate(t);
	const config = { port: 0, host: "127.0.0.1", certPath: certificate.certPath, keyPath: certificate.keyPath };
	const logs = [];
	const listener = await app.startImapListener(context.env, config, app.loadTlsMaterial(config), { limits: { ...LISTENER_LIMITS, ...limits }, log: (event) => logs.push(event) });
	t.after(() => listener.close());
	const { credential } = await context.credential("user-a", "mbx-a");
	const client = await tlsClient(listener.port);
	await client.unit();
	assertTagged(await client.login("a@example.test", credential), "OK", /IDLE/);
	return { context, listener, client, logs };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeouts = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

test("a5.4 listener: IDLE over TLS: continuation, a notification, keepalives, DONE", async (t) => {
	const { context, client } = await listening(t);
	assert.match((await client.command("CAPABILITY")).untagged[0].text, / IDLE$/);
	await client.command("SELECT INBOX");
	client.write("i1 IDLE\r\n");
	assert.equal((await client.unit(2000)).text, "+ idling");
	await context.deliver("m-2", "Subject: two\r\n\r\nx\r\n");
	assert.equal((await client.unit(2000)).text, "* 2 EXISTS");
	assert.equal((await client.unit(2000)).text, "* OK Still here");
	client.write("DONE\r\n");
	const finished = await client.collect("i1", 2000);
	assertTagged(finished, "OK", /IDLE completed/);
	assertTagged(await client.command("NOOP"), "OK");
});

test("a5.4 listener: autologout counts client input only: keepalives do not postpone it, DONE/IDLE cycles do", async (t) => {
	const { client } = await listening(t);
	await client.command("SELECT INBOX");
	// Client input keeps the session: 2.4 s of IDLE/DONE cycles every 400 ms against a 1.5 s limit.
	for (let index = 0; index < 6; index += 1) {
		client.write(`k${index} IDLE\r\n`);
		assert.equal((await client.unit(1000)).text, "+ idling");
		await sleep(400);
		client.write("DONE\r\n");
		const result = await client.collect(`k${index}`, 1000);
		assertTagged(result, "OK");
	}
	// Silent client while the server keeps writing keepalives: logged out on time.
	client.write("z IDLE\r\n");
	const started = Date.now();
	const seen = [];
	for (;;) {
		const unit = await client.unit(4000);
		if (!unit) break;
		seen.push(unit.text);
	}
	const elapsed = Date.now() - started;
	assert.ok(seen.filter((text) => text === "* OK Still here").length >= 3, "keepalives were written");
	assert.equal(seen.at(-1), "* BYE Autologout; idle for too long");
	assert.ok(elapsed >= 1_300 && elapsed < 3_500, `logged out after ${elapsed} ms`);
});

test("a5.4 listener: disconnect during IDLE leaves no timer running; shutdown sends BYE to an idling client", async (t) => {
	const { listener, client } = await listening(t, { idlePollMs: 30_000, idleKeepaliveMs: 30_000 });
	await client.command("SELECT INBOX");
	await sleep(50);
	const baseline = timeouts();
	client.write("i1 IDLE\r\n");
	assert.equal((await client.unit(1000)).text, "+ idling");
	await sleep(50);
	assert.ok(timeouts() > baseline, "the IDLE wait holds a timer");
	client.close();
	await sleep(200);
	assert.equal(listener.connections, 0);
	assert.ok(timeouts() <= baseline - 1, "the IDLE wait and the autologout timer are gone");

	const { listener: second, client: idling } = await listening(t, { idlePollMs: 30_000 });
	await idling.command("SELECT INBOX");
	idling.write("i1 IDLE\r\n");
	assert.equal((await idling.unit(1000)).text, "+ idling");
	await second.close();
	assert.equal((await idling.unit(2000)).text, "* BYE Server shutting down");
	assert.equal(await idling.unit(2000), null);
});
