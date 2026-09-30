import assert from "node:assert/strict";
import test from "node:test";
import { assertTagged, fetchAttributes, install, loadApp, memoryClient } from "./support/imap-harness.mjs";

/**
 * A5.1: read-write selection and flags. SELECT opens a folder read-write for the flags the
 * principal may change (\Seen and \Flagged, which are the product's read and starred state),
 * EXAMINE read-only; STORE / UID STORE and the implicit \Seen of body fetches write through
 * A3's batched storeImapFlags. \Deleted (A5.2a) is certified in imap-expunge.test.mjs. Driven in memory over the real A2
 * verifier, A3 state and product routes (SQLite + file bucket).
 */
const { app, cleanup } = await loadApp("imap-flags");
test.after(cleanup);

const OWNER = { userId: "user-a", mailboxId: "mbx-a" };
const BASE = "http://mailflare.local";
const texts = (result) => result.untagged.map((unit) => unit.text);

async function connect(context, { userId = "user-a", mailboxId = "mbx-a", address = "a@example.test" } = {}, hostOverrides) {
	const { client, session, start } = memoryClient(app, context.env, hostOverrides);
	await start();
	const { credential, id } = await context.credential(userId, mailboxId);
	assertTagged(await client.login(address, credential), "OK");
	return { client, session, credentialId: id };
}

async function setup(t, account) {
	const context = await install(app, t);
	const connection = await connect(context, account);
	return { ...context, ...connection };
}

/** A web request as the signed-in user, like the dashboard makes it. */
async function web(context, handler, path, { body, params, userId = "user-a" } = {}) {
	const token = await app.createSession(context.env, userId);
	const request = new Request(`${BASE}${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const response = await (params ? handler(request, { params: Promise.resolve(params) }) : handler(request));
	assert.equal(response.status, 200, `${path} answered ${response.status}`);
	return response;
}

const flagsOf = (context, id) => {
	const row = context.row(id);
	return { read: row.read, starred: row.starred };
};
const revision = (context, mailboxId = "mbx-a") => context.database.db.prepare("SELECT revision FROM jmap_mailbox_revisions WHERE mailbox_id = ?").get(mailboxId)?.revision ?? 0;
const productState = (context) => JSON.stringify([
	context.database.db.prepare("SELECT id, status, read, starred, folder_id FROM messages ORDER BY id").all(),
	context.database.db.prepare("SELECT imap_folder_id, uid, message_id, deleted FROM imap_message_uids ORDER BY imap_folder_id, uid").all(),
]);

async function deliverMany(context, ids, values) {
	for (const id of ids) await context.deliver(id, `Subject: ${id}\r\n\r\nbody of ${id}\r\n`, values);
}

// ---- Selection ------------------------------------------------------------------------------

test("a5.1: SELECT is READ-WRITE with PERMANENTFLAGS (\\Seen \\Flagged); EXAMINE is READ-ONLY with none; no new capability", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1"]);
	const select = await context.client.command("SELECT INBOX");
	assertTagged(select, "OK", /^\S+ OK \[READ-WRITE\] SELECT completed$/);
	assert.ok(texts(select).includes("* FLAGS (\\Seen \\Flagged \\Deleted \\Draft)"), "FLAGS lists every flag a message can show");
	assert.ok(texts(select).includes("* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Deleted)] Flags permitted"), "the owner may also set \\Deleted here (A5.2a), and there is no \\*");
	const examine = await context.client.command("EXAMINE INBOX");
	assertTagged(examine, "OK", /^\S+ OK \[READ-ONLY\] EXAMINE completed$/);
	assert.ok(texts(examine).includes("* OK [PERMANENTFLAGS ()] Read-only mailbox"));
	const capability = texts(await context.client.command("CAPABILITY"))[0];
	assert.equal(capability, `* CAPABILITY ${app.AUTH_CAPABILITIES}`);
	assert.equal(app.AUTH_CAPABILITIES, "IMAP4rev1 ID NAMESPACE UNSELECT SPECIAL-USE MOVE", "only MOVE (A5.2b) is added; no UIDPLUS, IDLE, ...");
	for (const folder of ["Drafts", "Sent", "Archive", "Spam", "Trash", "Work"]) assertTagged(await context.client.command(`SELECT ${folder}`), "OK", /\[READ-WRITE\]/);
});

test("a5.1: a read_only delegate gets READ-WRITE for \\Seen and \\Flagged, as the web app lets it mark read and star", async (t) => {
	const context = await setup(t, { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" });
	await context.deliver("s-1", "Subject: s\r\n\r\ns\r\n", { mailbox_id: "mbx-s" });
	const select = await context.client.command("SELECT INBOX");
	assertTagged(select, "OK", /\[READ-WRITE\]/);
	assert.ok(texts(select).includes("* OK [PERMANENTFLAGS (\\Seen \\Flagged)] Flags permitted"));
	const stored = await context.client.command("STORE 1 +FLAGS (\\Seen \\Flagged)");
	assertTagged(stored, "OK");
	assert.deepEqual(texts(stored), ["* 1 FETCH (FLAGS (\\Seen \\Flagged))"]);
	assert.deepEqual(flagsOf(context, "s-1"), { read: 1, starred: 1 });
	// The same principal through the web app has the same rights (markMessageAsReadForUser and the star route need canRead).
	await web(context, app.starRoute, "/api/messages/s-1/star", { params: { messageId: "s-1" }, userId: "user-b" });
	assert.equal(context.row("s-1").starred, 0);
});

// ---- STORE semantics ------------------------------------------------------------------------

test("a5.1: FLAGS, +FLAGS and -FLAGS (and UID STORE) write messages.read and messages.starred and answer the resulting FLAGS", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3"]);
	await context.client.command("SELECT INBOX");

	let result = await context.client.command("STORE 1 +FLAGS (\\Seen)");
	assertTagged(result, "OK", /OK STORE completed/);
	assert.deepEqual(texts(result), ["* 1 FETCH (FLAGS (\\Seen))"]);
	assert.deepEqual(flagsOf(context, "m-1"), { read: 1, starred: 0 });

	result = await context.client.command("STORE 1:2 +FLAGS \\Flagged");
	assert.deepEqual(texts(result), ["* 1 FETCH (FLAGS (\\Seen \\Flagged))", "* 2 FETCH (FLAGS (\\Flagged))"], "a bare flag list without parentheses");

	result = await context.client.command("STORE 1 -FLAGS (\\Seen)");
	assert.deepEqual(texts(result), ["* 1 FETCH (FLAGS (\\Flagged))"]);
	assert.deepEqual(flagsOf(context, "m-1"), { read: 0, starred: 1 });

	result = await context.client.command("STORE 1:3 FLAGS (\\Seen)");
	assert.deepEqual(texts(result), ["* 1 FETCH (FLAGS (\\Seen))", "* 2 FETCH (FLAGS (\\Seen))", "* 3 FETCH (FLAGS (\\Seen))"], "FLAGS replaces: \\Flagged is cleared");
	assert.deepEqual(["m-1", "m-2", "m-3"].map((id) => flagsOf(context, id)), [{ read: 1, starred: 0 }, { read: 1, starred: 0 }, { read: 1, starred: 0 }]);

	result = await context.client.command("STORE 2 FLAGS ()");
	assert.deepEqual(texts(result), ["* 2 FETCH (FLAGS ())"], "an empty list clears everything");
	assert.deepEqual(flagsOf(context, "m-2"), { read: 0, starred: 0 });

	result = await context.client.command("UID STORE 2:3 +FLAGS (\\Flagged)");
	assertTagged(result, "OK", /OK UID STORE completed/);
	assert.deepEqual(texts(result), ["* 2 FETCH (UID 2 FLAGS (\\Flagged))", "* 3 FETCH (UID 3 FLAGS (\\Seen \\Flagged))"], "UID STORE responses carry the UID");
	result = await context.client.command("UID STORE 1:* -FLAGS (\\Flagged \\Seen)");
	assert.deepEqual(texts(result), ["* 1 FETCH (UID 1 FLAGS ())", "* 2 FETCH (UID 2 FLAGS ())", "* 3 FETCH (UID 3 FLAGS ())"]);
	result = await context.client.command("UID STORE 3 FLAGS (\\Seen \\Flagged)");
	assert.deepEqual(texts(result), ["* 3 FETCH (UID 3 FLAGS (\\Seen \\Flagged))"]);
	assertTagged(await context.client.command("UID STORE 99 +FLAGS (\\Seen)"), "OK", undefined, "UIDs that do not exist are ignored");

	// Persisted: a fresh session and A3 see the same flags.
	const other = await connect(context);
	await other.client.command("EXAMINE INBOX");
	assert.deepEqual(texts(await other.client.command("FETCH 1:3 FLAGS")), ["* 1 FETCH (FLAGS ())", "* 2 FETCH (FLAGS ())", "* 3 FETCH (FLAGS (\\Seen \\Flagged))"]);
	const snapshot = await app.imap.openImapFolder(context.env, OWNER, "inbox");
	assert.deepEqual(snapshot.messages.map((entry) => [entry.flags.seen, entry.flags.flagged]), [[false, false], [false, false], [true, true]]);
});

test("a5.1: .SILENT suppresses this STORE's own FETCH responses, but not changes it did not make", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	for (const [command, expected] of [
		["STORE 1 +FLAGS.SILENT (\\Seen)", { read: 1, starred: 0 }],
		["STORE 1 FLAGS.SILENT (\\Flagged)", { read: 0, starred: 1 }],
		["STORE 1 -FLAGS.SILENT (\\Flagged)", { read: 0, starred: 0 }],
		["UID STORE 1 +FLAGS.SILENT (\\Seen \\Flagged)", { read: 1, starred: 1 }],
		["UID STORE 1 FLAGS.SILENT ()", { read: 0, starred: 0 }],
		["UID STORE 1 -FLAGS.SILENT (\\Seen)", { read: 0, starred: 0 }],
	]) {
		const result = await context.client.command(command);
		assertTagged(result, "OK");
		assert.deepEqual(texts(result), [], command);
		assert.deepEqual(flagsOf(context, "m-1"), expected, command);
	}
	// Nothing is echoed afterwards as if another client had made the change.
	assert.deepEqual(texts(await context.client.command("NOOP")), []);

	// A change someone else made to the same message is still reported, before and within the STORE.
	context.database.db.prepare("UPDATE messages SET starred = 1 WHERE id = 'm-2'").run();
	const silent = await context.client.command("STORE 2 +FLAGS.SILENT (\\Seen)");
	assert.deepEqual(texts(silent), ["* 2 FETCH (FLAGS (\\Flagged))"], "the external \\Flagged, reported by the pre-command refresh; the \\Seen this STORE set is silent");
	assert.deepEqual(texts(await context.client.command("NOOP")), []);

	// A flag that cannot change (outbound mail is always \Seen) is reported even under .SILENT, so the client does not believe it changed.
	await context.deliver("s-1", "Subject: sent\r\n\r\nx\r\n", { direction: "outbound", status: "sent", read: 1 });
	await context.client.command("SELECT Sent");
	const unseen = await context.client.command("STORE 1 -FLAGS.SILENT (\\Seen)");
	assert.deepEqual(texts(unseen), ["* 1 FETCH (FLAGS (\\Seen))"]);
});

test("a5.1: outbound mail stays \\Seen and messages.read is never cleared under it", async (t) => {
	const context = await setup(t);
	await context.deliver("s-read", "Subject: a\r\n\r\na\r\n", { direction: "outbound", status: "sent", read: 1 });
	await context.deliver("s-unread", "Subject: b\r\n\r\nb\r\n", { direction: "outbound", status: "sent", read: 0 });
	await context.client.command("SELECT Sent");
	const before = revision(context);
	const cleared = await context.client.command("STORE 1:2 -FLAGS (\\Seen)");
	assert.deepEqual(texts(cleared), ["* 1 FETCH (FLAGS (\\Seen))", "* 2 FETCH (FLAGS (\\Seen))"]);
	assert.equal(context.row("s-read").read, 1, "read=1 is not written to 0 while IMAP would still show \\Seen");
	assert.equal(context.row("s-unread").read, 0);
	assert.equal(revision(context), before, "nothing was written");
	const replaced = await context.client.command("STORE 1 FLAGS (\\Flagged)");
	assert.deepEqual(texts(replaced), ["* 1 FETCH (FLAGS (\\Seen \\Flagged))"]);
	assert.deepEqual(flagsOf(context, "s-read"), { read: 1, starred: 1 }, "FLAGS without \\Seen does not clear read on outbound mail either");
	// \Seen can still be set: it matches what IMAP already shows.
	assertTagged(await context.client.command("STORE 2 +FLAGS (\\Seen)"), "OK");
	assert.equal(context.row("s-unread").read, 1);
});

test("a5.1: \\Answered, \\Draft and keywords are accepted and not stored; \\Recent and unknown system flags are BAD", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1"]);
	await context.deliver("d-1", "Subject: draft\r\n\r\nd\r\n", { direction: "outbound", status: "draft" });
	await context.client.command("SELECT INBOX");
	const before = productState(context);
	for (const command of ["STORE 1 +FLAGS (\\Answered)", "STORE 1 +FLAGS (\\Draft)", "STORE 1 +FLAGS ($Forwarded NonJunk)", "STORE 1 -FLAGS (\\Answered \\Draft $Label1)"]) {
		const result = await context.client.command(command);
		assertTagged(result, "OK", undefined, command);
		assert.deepEqual(texts(result), ["* 1 FETCH (FLAGS ())"], `${command}: FETCH reports that nothing was kept`);
	}
	assert.equal(productState(context), before, "nothing was written");
	const replaced = await context.client.command("STORE 1 FLAGS (\\Seen $Forwarded \\Answered)");
	assert.deepEqual(texts(replaced), ["* 1 FETCH (FLAGS (\\Seen))"], "FLAGS keeps only what can be kept");

	for (const command of ["STORE 1 +FLAGS (\\Recent)", "STORE 1 FLAGS (\\Recent)", "STORE 1 +FLAGS (\\Important)", "STORE 1 +FLAGS (\\)"]) {
		assertTagged(await context.client.command(command), "BAD", undefined, command);
	}
	// \Draft is derived from the Drafts folder and cannot be removed.
	await context.client.command("SELECT Drafts");
	const draft = await context.client.command("STORE 1 FLAGS (\\Seen)");
	assert.deepEqual(texts(draft), ["* 1 FETCH (FLAGS (\\Seen \\Draft))"]);
	assert.equal(context.row("d-1").status, "draft");
});

test("a5.1/a5.2a/a5.2c: \\Deleted where it cannot change: NO [CANNOT] in Drafts without bp0004 for the owner, NO [NOPERM] without management access, and the session goes on", async (t) => {
	const owner = await setup(t);
	await deliverMany(owner, ["m-1"], { status: "draft", direction: "outbound", from_addr: "a@example.test", raw_r2_key: null });
	owner.database.db.exec("DROP TRIGGER bp_imap_draft_attachment_removed_releases_uid");
	await owner.client.command("SELECT Drafts");
	const before = productState(owner);
	for (const command of ["STORE 1 +FLAGS (\\Deleted)", "STORE 1 FLAGS (\\Seen \\Deleted)", "UID STORE 1 -FLAGS.SILENT (\\Deleted)", "STORE 1 +FLAGS (\\Seen \\Deleted)"]) {
		assertTagged(await owner.client.command(command), "NO", /\[CANNOT\] \\Deleted is unavailable in Drafts on this server right now/, command);
	}
	assert.equal(productState(owner), before, "a refused STORE writes nothing, not even the \\Seen it also named");
	assertTagged(await owner.client.command("NOOP"), "OK");
	assert.equal(owner.session.isClosed, false);

	const delegate = await connect(owner, { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" });
	await owner.deliver("s-1", "Subject: s\r\n\r\ns\r\n", { mailbox_id: "mbx-s" });
	await delegate.client.command("SELECT INBOX");
	const denied = await delegate.client.command("STORE 1 +FLAGS (\\Seen \\Deleted)");
	assertTagged(denied, "NO", /^\S+ NO \[NOPERM\] /);
	assert.equal(owner.row("s-1").read, 0, "nothing was written");
	assert.equal(delegate.session.isClosed, false, "a permission denial never ends the session");
	assertTagged(await delegate.client.command("NOOP"), "OK");
	assertTagged(await delegate.client.command("STORE 1 +FLAGS (\\Seen)"), "OK", undefined, "the principal can still do what it is allowed to");
	assert.ok(!delegate.client.logs.some((event) => event.event === "access.revoked"));
});

test("a5.1: STORE is refused under EXAMINE and outside the selected state", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1"]);
	assertTagged(await context.client.command("STORE 1 +FLAGS (\\Seen)"), "BAD", /not valid in this state/);
	await context.client.command("EXAMINE INBOX");
	const before = productState(context);
	assertTagged(await context.client.command("STORE 1 +FLAGS (\\Seen)"), "NO", /read-only/);
	assertTagged(await context.client.command("UID STORE 1 FLAGS.SILENT (\\Flagged)"), "NO", /read-only/);
	assert.equal(productState(context), before);
	await context.client.command("UNSELECT");
	assertTagged(await context.client.command("UID STORE 1 +FLAGS (\\Seen)"), "BAD", /not valid in this state/);
});

test("a5.1: malformed STORE commands are BAD and leave the connection in sync", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	const before = productState(context);
	const tooMany = `STORE 1 +FLAGS (${Array.from({ length: 65 }, (_, index) => `k${index}`).join(" ")})`;
	for (const command of [
		"STORE",
		"STORE 1",
		"STORE 1 FLAGS",
		"STORE 1 +FLAGS",
		"STORE x FLAGS (\\Seen)",
		"STORE 0 FLAGS (\\Seen)",
		"STORE 1:0x FLAGS (\\Seen)",
		"STORE 1 XFLAGS (\\Seen)",
		"STORE 1 FLAGS.LOUD (\\Seen)",
		"STORE 1 +-FLAGS (\\Seen)",
		"STORE 1 FLAGS (\\Seen",
		"STORE 1 FLAGS \\Seen)",
		"STORE 1 FLAGS (\\Seen) extra",
		"STORE 1 FLAGS ( \\Seen)",
		"STORE 1 FLAGS (\\Seen  \\Flagged)",
		"STORE 1  FLAGS (\\Seen)",
		'STORE 1 FLAGS ("\\Seen")',
		"STORE 1 FLAGS ((\\Seen))",
		tooMany,
		"UID STORE 1 FLAGS",
		"UID STORE * +FLAGS (\\Seen",
	]) {
		assertTagged(await context.client.command(command), "BAD", undefined, command);
	}
	assertTagged(await context.client.command("STORE 3 +FLAGS (\\Seen)"), "BAD", /Invalid message sequence number/, "a sequence number beyond the mailbox");
	// A literal where a flag belongs is framed, then refused as a whole command.
	context.client.write("lit STORE 1 +FLAGS {5}\r\n");
	assert.match((await context.client.unit()).text, /^\+ /);
	context.client.write("\\Seen\r\n");
	assertTagged(await context.client.collect("lit"), "BAD");
	// 64 flags is within bounds.
	assertTagged(await context.client.command(`STORE 1 +FLAGS (${Array.from({ length: 64 }, (_, index) => `k${index}`).join(" ")})`), "OK");
	assert.equal(productState(context), before, "no malformed or keyword-only STORE wrote anything");
	assertTagged(await context.client.command("NOOP"), "OK");
	assert.deepEqual(texts(await context.client.command("STORE 2 +FLAGS (\\Seen)")), ["* 2 FETCH (FLAGS (\\Seen))"], "still in sync");
});

test("a5.1: a large STORE is chunked, written in bounded statements and fully answered", async (t) => {
	const context = await setup(t);
	const ids = Array.from({ length: 205 }, (_, index) => `b-${String(index).padStart(3, "0")}`);
	await deliverMany(context, ids);
	await context.client.command("SELECT INBOX");
	const result = await context.client.command("STORE 1:* +FLAGS (\\Flagged)");
	assertTagged(result, "OK");
	assert.equal(result.untagged.length, 205);
	assert.equal(result.untagged[204].text, "* 205 FETCH (FLAGS (\\Flagged))");
	assert.equal(context.database.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE starred = 1").get().n, 205);
	const silent = await context.client.command("UID STORE 1:* FLAGS.SILENT (\\Seen)");
	assert.deepEqual(texts(silent), []);
	assert.equal(context.database.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE read = 1 AND starred = 0").get().n, 205);
});

// ---- One product state ----------------------------------------------------------------------

test("a5.1: IMAP writes move the web/JMAP revision; web writes reach the IMAP session as FETCH FLAGS", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");

	const jmapBefore = revision(context);
	const realtimeBefore = await app.getUserMailRevision(context.env, "user-a");
	assertTagged(await context.client.command("STORE 1 +FLAGS (\\Seen \\Flagged)"), "OK");
	assert.ok(revision(context) > jmapBefore, "jmap_mailbox_revisions moved (JMAP Email/Mailbox state)");
	assert.notEqual(await app.getUserMailRevision(context.env, "user-a"), realtimeBefore, "the web app's realtime revision moved");
	const settled = revision(context);
	assertTagged(await context.client.command("STORE 1 +FLAGS (\\Seen \\Flagged)"), "OK");
	assertTagged(await context.client.command("STORE 1 +FLAGS (\\Answered)"), "OK");
	assert.equal(revision(context), settled, "a STORE that changes nothing writes nothing");

	// Web actions, through the real routes.
	await web(context, app.starRoute, "/api/messages/m-1/star", { params: { messageId: "m-1" } });
	await web(context, app.bulkRoute, "/api/messages/bulk", { body: { action: "unread", messageIds: ["m-1"] } });
	await web(context, app.readRoute, "/api/messages/m-2/read", { params: { messageId: "m-2" } });
	assert.deepEqual(texts(await context.client.command("NOOP")), ["* 1 FETCH (FLAGS ())", "* 2 FETCH (FLAGS (\\Seen))"]);
	assert.deepEqual(texts(await context.client.command("NOOP")), [], "reported once");
});

test("a5.1: concurrent web and IMAP changes to the same flag: last writer wins, and each side sees it", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1"]);
	await context.client.command("SELECT INBOX");
	// IMAP then web.
	await context.client.command("STORE 1 +FLAGS.SILENT (\\Seen)");
	await web(context, app.bulkRoute, "/api/messages/bulk", { body: { action: "unread", messageIds: ["m-1"] } });
	assert.equal(context.row("m-1").read, 0);
	assert.deepEqual(texts(await context.client.command("NOOP")), ["* 1 FETCH (FLAGS ())"]);
	// Web then IMAP: STORE is answered with the state it produced.
	await web(context, app.starRoute, "/api/messages/m-1/star", { params: { messageId: "m-1" } });
	const stored = await context.client.command("STORE 1 -FLAGS (\\Flagged)");
	assert.deepEqual(texts(stored), ["* 1 FETCH (FLAGS (\\Flagged))", "* 1 FETCH (FLAGS ())"], "the web star is reported first, then this STORE's result");
	assert.equal(context.row("m-1").starred, 0);
	// Interleaved: the web read arrives between two STOREs of the same session.
	await context.client.command("STORE 1 +FLAGS.SILENT (\\Flagged)");
	await web(context, app.readRoute, "/api/messages/m-1/read", { params: { messageId: "m-1" } });
	await context.client.command("STORE 1 -FLAGS.SILENT (\\Seen)");
	assert.deepEqual(flagsOf(context, "m-1"), { read: 0, starred: 1 });
});

test("a5.1: two IMAP sessions changing the same flag see each other's changes", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	const other = await connect(context);
	await context.client.command("SELECT INBOX");
	await other.client.command("SELECT INBOX");
	await context.client.command("STORE 2 +FLAGS.SILENT (\\Flagged)");
	assert.deepEqual(texts(await other.client.command("NOOP")), ["* 2 FETCH (FLAGS (\\Flagged))"]);
	const both = await Promise.all([context.client.command("STORE 2 -FLAGS (\\Flagged)"), other.client.command("STORE 2 +FLAGS (\\Flagged)")]);
	assert.ok(both.every((result) => result.ok));
	const final = context.row("m-2").starred;
	assert.ok(final === 0 || final === 1);
	const expected = final ? "* 2 FETCH (FLAGS (\\Flagged))" : "* 2 FETCH (FLAGS ())";
	// Whichever wrote last, both sessions converge on the stored value.
	for (const session of [context, other]) {
		const flags = await session.client.command("FETCH 2 FLAGS");
		assert.equal(texts(flags).at(-1), expected);
	}
});

// ---- Stale identity -------------------------------------------------------------------------

test("a5.1: a stale sequence number never writes to another message", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3"]);
	await context.client.command("SELECT INBOX");
	// The web app moves message 2 to Archive and deletes message 3; new mail arrives.
	context.database.db.prepare("UPDATE messages SET status = 'archived' WHERE id = 'm-2'").run();
	context.database.db.prepare("DELETE FROM messages WHERE id = 'm-3'").run();
	await context.deliver("m-4", "Subject: m-4\r\n\r\nx\r\n");
	const result = await context.client.command("STORE 2:3 +FLAGS (\\Flagged)");
	assertTagged(result, "NO", /no longer exist/);
	assert.deepEqual(texts(result), ["* 4 EXISTS"], "no EXPUNGE during STORE, no FETCH for vanished messages");
	assert.equal(productState(context).includes('"starred":1'), false, "neither the moved message, nor the new one at a shifted position, was changed");
	assert.equal(context.row("m-2").starred, 0);
	assert.equal(context.row("m-4").starred, 0);
	const noop = await context.client.command("NOOP");
	assert.deepEqual(texts(noop), ["* 3 EXPUNGE", "* 2 EXPUNGE"]);
	assert.deepEqual(texts(await context.client.command("STORE 2 +FLAGS (\\Flagged)")), ["* 2 FETCH (FLAGS (\\Flagged))"]);
	assert.equal(context.row("m-4").starred, 1, "after EXPUNGE, sequence number 2 is the new message");
	assert.equal(context.row("m-2").starred, 0);
});

test("a5.1: UID STORE against a vanished UID, and a UID whose message moved after the session's refresh, write nothing", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2"]);
	await context.client.command("SELECT INBOX");
	context.database.db.prepare("DELETE FROM messages WHERE id = 'm-1'").run();
	const vanished = await context.client.command("UID STORE 1 +FLAGS (\\Seen)");
	assertTagged(vanished, "OK");
	assert.deepEqual(texts(vanished), ["* 1 EXPUNGE"], "UID STORE may report the EXPUNGE; the missing UID is ignored");
	assert.equal(context.row("m-2").read, 0);

	// The race the session cannot see: the message moves between the session's refresh and
	// A3's write. Moving it with no IMAP read in between leaves its INBOX UID mapping in place.
	context.database.db.prepare("UPDATE messages SET status = 'trash' WHERE id = 'm-2'").run();
	const direct = await app.imap.storeImapFlags(context.env, OWNER, "inbox", [2], { mode: "add", flags: ["seen", "flagged"] });
	assert.equal(direct.get(2), null, "A3 reports the UID as gone");
	assert.deepEqual(flagsOf(context, "m-2"), { read: 0, starred: 0 }, "the Trash message was not changed through its old INBOX UID");
	// A UID from one folder never reaches a message of another folder, even with the same number.
	const trashUid = (await app.imap.openImapFolder(context.env, OWNER, "trash")).messages[0].uid;
	assert.equal(trashUid, 1);
	const cross = await app.imap.storeImapFlags(context.env, OWNER, "inbox", [1], { mode: "add", flags: ["flagged"] });
	assert.equal(cross.get(1), null);
	assert.equal(context.row("m-2").starred, 0);
});

// ---- Revocation -----------------------------------------------------------------------------

test("a5.1: revoked credentials or shares end the session with BYE on the next STORE", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1"]);
	await context.client.command("SELECT INBOX");
	context.database.db.prepare("DELETE FROM mail_app_passwords WHERE id = ?").run(context.credentialId);
	const result = await context.client.command("STORE 1 +FLAGS (\\Seen)");
	assert.equal(result.tagged, null);
	assert.equal(result.untagged.at(-1).text, "* BYE Access revoked");
	assert.equal(context.row("m-1").read, 0);

	const shared = await connect(context, { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" });
	await context.deliver("s-1", "Subject: s\r\n\r\ns\r\n", { mailbox_id: "mbx-s" });
	await shared.client.command("SELECT INBOX");
	context.database.db.prepare("DELETE FROM mailbox_access WHERE id = 'acc-b'").run();
	const unshared = await shared.client.command("UID STORE 1 +FLAGS.SILENT (\\Flagged)");
	assert.equal(unshared.untagged.at(-1).text, "* BYE Access revoked");
	assert.equal(context.row("s-1").starred, 0);

	// Service level: lost access is `forbidden` (session-ending), never `denied`.
	await assert.rejects(app.imap.storeImapFlags(context.env, { userId: "user-b", mailboxId: "mbx-s" }, "inbox", [1], { mode: "add", flags: ["seen"] }), (error) => error.code === "forbidden");
	await assert.rejects(app.imap.storeImapFlags(context.env, { userId: "user-b", mailboxId: "mbx-s" }, "inbox", [], { mode: "add", flags: [] }), (error) => error.code === "forbidden", "even an empty request is authorized");
});

test("a5.1: access revoked between reading a body and its implicit \\Seen ends the session without writing", async (t) => {
	const context = await install(app, t);
	await deliverMany(context, ["m-1"]);
	let revokeOnRelease = false;
	let credentialId;
	const connection = await connect(context, undefined, {
		acquireRead: async () => () => {
			if (revokeOnRelease) context.database.db.prepare("DELETE FROM mail_app_passwords WHERE id = ?").run(credentialId);
		},
	});
	credentialId = connection.credentialId;
	await connection.client.command("SELECT INBOX");
	revokeOnRelease = true;
	const result = await connection.client.command("FETCH 1 BODY[]");
	assert.equal(result.tagged, null);
	assert.equal(result.untagged.at(-1).text, "* BYE Access revoked");
	assert.ok(result.untagged.every((unit) => unit.literals.length === 0), "the body was not sent");
	assert.equal(context.row("m-1").read, 0);
});

// ---- Implicit \Seen -------------------------------------------------------------------------

test("a5.1: implicit \\Seen follows RFC 3501 exactly under SELECT, and never under EXAMINE", async (t) => {
	const context = await setup(t);
	const cases = [
		["BODY[]", true],
		["BODY[1]", true],
		["BODY[TEXT]", true],
		["BODY[HEADER]", true],
		["BODY[HEADER.FIELDS (SUBJECT)]", true],
		["BODY[]<0.4>", true],
		["RFC822", true],
		["RFC822.TEXT", true],
		["BODY.PEEK[]", false],
		["BODY.PEEK[TEXT]", false],
		["RFC822.HEADER", false],
		["RFC822.SIZE", false],
		["BODY", false],
		["BODYSTRUCTURE", false],
		["ENVELOPE", false],
		["ALL", false],
		["FULL", false],
		["INTERNALDATE", false],
		["UID", false],
	];
	const ids = cases.map((_, index) => `c-${String(index).padStart(2, "0")}`);
	await deliverMany(context, ids);
	for (const mode of ["EXAMINE", "SELECT"]) {
		await context.client.command(`${mode} INBOX`);
		for (const [index, [items, sets]] of cases.entries()) {
			const seq = index + 1;
			const macro = /^(ALL|FULL)$/.test(items);
			const result = await context.client.command(`FETCH ${seq} ${macro ? items : `(${items})`}`);
			assertTagged(result, "OK", undefined, `${mode} ${items}`);
			const attributes = fetchAttributes(result.untagged.at(-1).text);
			const expectSeen = mode === "SELECT" && sets;
			assert.equal(context.row(ids[index]).read, expectSeen ? 1 : 0, `${mode} FETCH ${items}`);
			if (expectSeen) assert.deepEqual(attributes.FLAGS, ["\\Seen"], `${items}: the response carries the new FLAGS`);
			else if (!macro) assert.equal(attributes.FLAGS, undefined, `${mode} ${items}: no FLAGS added`);
		}
	}
	// Already seen: no write, no FLAGS added.
	const before = revision(context);
	const again = await context.client.command("FETCH 1 (BODY[])");
	assert.equal(fetchAttributes(again.untagged[0].text).FLAGS, undefined);
	assert.equal(revision(context), before);
	// FLAGS already requested is not duplicated, and reflects the change.
	context.database.db.prepare("UPDATE messages SET read = 0 WHERE id = 'c-00'").run();
	await context.client.command("NOOP");
	const both = await context.client.command("FETCH 1 (FLAGS BODY[])");
	assert.equal((both.untagged[0].text.match(/FLAGS/g) ?? []).length, 1);
	assert.deepEqual(fetchAttributes(both.untagged[0].text).FLAGS, ["\\Seen"]);
	// UID FETCH sets \Seen the same way; the web app sees the message as read.
	context.database.db.prepare("UPDATE messages SET read = 0 WHERE id = 'c-01'").run();
	await context.client.command("NOOP");
	const uid = await context.client.command("UID FETCH 2 (BODY[1])");
	assert.deepEqual(fetchAttributes(uid.untagged[0].text).FLAGS, ["\\Seen"]);
	assert.equal(context.row("c-01").read, 1);
	assert.deepEqual(texts(await context.client.command("NOOP")), [], "the implicit \\Seen is not echoed later");
});

test("a5.1: implicit \\Seen in a multi-message FETCH marks exactly the messages whose bodies were sent", async (t) => {
	const context = await setup(t);
	await deliverMany(context, ["m-1", "m-2", "m-3"]);
	// m-2's stored bytes are missing: its FETCH fails, so it must not be marked seen.
	context.database.db.prepare("UPDATE messages SET raw_r2_key = 'inbound/missing.eml' WHERE id = 'm-2'").run();
	await context.client.command("SELECT INBOX");
	const result = await context.client.command("FETCH 1:3 (BODY[])");
	assertTagged(result, "NO", /UNAVAILABLE/);
	assert.deepEqual(["m-1", "m-2", "m-3"].map((id) => context.row(id).read), [1, 0, 1]);
	assert.equal(result.untagged.length, 2);
});
