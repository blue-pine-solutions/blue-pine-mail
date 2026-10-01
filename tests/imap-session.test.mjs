import assert from "node:assert/strict";
import test from "node:test";
import { assertTagged, fetchAttributes, install, latin1, loadApp, memoryClient, WEB_PASSWORD } from "./support/imap-harness.mjs";

/**
 * A4: the IMAP session engine driven in memory over the real A2 verifier and A3 state
 * (SQLite + file bucket). Socket, TLS and limits are certified in imap-listener.test.mjs.
 */
const { app, cleanup } = await loadApp("imap-session");
test.after(cleanup);

async function ready(t, hostOverrides) {
	const context = await install(app, t);
	const { client, session, start } = memoryClient(app, context.env, hostOverrides);
	const greeting = await start();
	return { ...context, client, session, greeting };
}

async function loggedIn(t, { userId = "user-a", mailboxId = "mbx-a", address = "a@example.test" } = {}) {
	const context = await ready(t);
	const { credential, id } = await context.credential(userId, mailboxId);
	assertTagged(await context.client.login(address, credential), "OK");
	return { ...context, credential, credentialId: id };
}

const b64 = (text) => Buffer.from(text, "latin1").toString("base64");

// ---- Gate 2: session and authentication ------------------------------------------------

test("gate2: greeting and CAPABILITY advertise exactly the certified set", async (t) => {
	const { client, greeting } = await ready(t);
	assert.equal(greeting.text, "* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN ID] Blue Pine Solutions Mail IMAP4rev1 ready");
	const before = await client.command("CAPABILITY");
	assertTagged(before, "OK");
	assert.deepEqual(before.untagged.map((unit) => unit.text), ["* CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN ID"]);
	for (const absent of ["IMAP4rev2", "STARTTLS", "LOGINDISABLED", "IDLE", "MOVE", "UIDPLUS", "CONDSTORE", "QRESYNC", "ENABLE", "LITERAL+", "LIST-EXTENDED", "UTF8=ACCEPT", "COMPRESS", "QUOTA"]) {
		assert.ok(!before.untagged[0].text.split(" ").includes(absent), absent);
	}
	assertTagged(await client.command("NOOP"), "OK");
	const id = await client.command('ID ("name" "test-client" "version" NIL)');
	assertTagged(id, "OK");
	assert.deepEqual(id.untagged.map((unit) => unit.text), ['* ID ("name" "Blue Pine Solutions Mail")']);
	assertTagged(await client.command("ID NIL"), "OK");
	assertTagged(await client.command("ID (\"a\")"), "BAD");
	assertTagged(await client.command("STARTTLS"), "BAD");
	assertTagged(await client.command("SELECT INBOX"), "BAD", /not valid in this state/);
	assertTagged(await client.command("FROB"), "BAD");
	const logout = await client.command("LOGOUT");
	assertTagged(logout, "OK");
	assert.equal(logout.untagged[0].text, "* BYE Logging out");
	assert.equal(await client.unit(), null, "the connection closes after LOGOUT");
});

test("gate2: LOGIN with a mail app password; capabilities change after authentication", async (t) => {
	const context = await ready(t);
	const { credential } = await context.credential("user-a", "mbx-a");
	const result = await context.client.login("A@Example.TEST ", credential);
	assertTagged(result, "OK", /^t\d+ OK \[CAPABILITY IMAP4rev1 ID NAMESPACE UNSELECT SPECIAL-USE MOVE UIDPLUS IDLE\] Logged in/);
	const after = await context.client.command("CAPABILITY");
	assert.equal(after.untagged[0].text, "* CAPABILITY IMAP4rev1 ID NAMESPACE UNSELECT SPECIAL-USE MOVE UIDPLUS IDLE");
	assertTagged(await context.client.login("a@example.test", credential), "BAD", /not valid/);
	assert.deepEqual(context.client.logs.find((event) => event.event === "auth.success"), { event: "auth.success", userId: "user-a", mailboxId: "mbx-a", appPasswordId: "map-1" });
	// Literal username/password (synchronizing literals) work too.
	const second = memoryClient(app, context.env);
	await second.start();
	second.client.write(`l1 LOGIN {14}\r\n`);
	assert.match((await second.client.unit()).text, /^\+ /);
	second.client.write(`a@example.test {${credential.length}}\r\n`);
	assert.match((await second.client.unit()).text, /^\+ /);
	second.client.write(`${credential}\r\n`);
	assertTagged(await second.client.collect("l1"), "OK");
});

test("gate2: AUTHENTICATE PLAIN, with SASL-IR and with a continuation, and cancellation", async (t) => {
	const context = await ready(t);
	const { credential } = await context.credential("user-a", "mbx-a");
	assertTagged(await context.client.command(`AUTHENTICATE PLAIN ${b64(`\0a@example.test\0${credential}`)}`), "OK");

	const second = memoryClient(app, context.env);
	await second.start();
	second.client.write("p1 AUTHENTICATE PLAIN\r\n");
	assert.equal((await second.client.unit()).text, "+ ");
	second.client.write(`${b64(`a@example.test\0a@example.test\0${credential}`)}\r\n`);
	assertTagged(await second.client.collect("p1"), "OK");

	const third = memoryClient(app, context.env);
	await third.start();
	third.client.write("c1 AUTHENTICATE PLAIN\r\n");
	await third.client.unit();
	third.client.write("*\r\n");
	assertTagged(await third.client.collect("c1"), "BAD", /cancelled/);
	assertTagged(await third.client.command("AUTHENTICATE LOGIN"), "NO", /Unsupported/);
	assertTagged(await third.client.command("AUTHENTICATE PLAIN @@@"), "BAD");
	// An authorization identity other than the mailbox itself is refused like any failure.
	assertTagged(await third.client.command(`AUTHENTICATE PLAIN ${b64(`x@example.test\0a@example.test\0${credential}`)}`), "NO", /AUTHENTICATIONFAILED/);
});

test("gate2: every authentication failure looks the same to the client", async (t) => {
	const context = await ready(t);
	const { credential } = await context.credential("user-a", "mbx-a");
	const { credential: smtpOnly } = await context.credential("user-a", "mbx-a", ["smtp"]);
	const apiKey = app.generateApiKey().fullKey;
	const attempts = [
		["a@example.test", `${credential.slice(0, -1)}${credential.endsWith("a") ? "b" : "a"}`], // wrong secret
		["a@example.test", WEB_PASSWORD], // web password
		["a@example.test", apiKey], // API key
		["a@example.test", smtpOnly], // no imap scope
		["x@example.test", credential], // another mailbox's address
		["nobody@example.test", "bpm_aaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], // unknown credential
	];
	const answers = new Set();
	for (const [username, password] of attempts) {
		const session = memoryClient(app, context.env);
		await session.start();
		const result = await session.client.login(username, password);
		answers.add(result.tagged.replace(/^t\d+ /, ""));
		for (const event of session.client.logs) assert.ok(!JSON.stringify(event).includes(password) && !JSON.stringify(event).includes(username), "logs carry neither credential nor username");
	}
	assert.deepEqual([...answers], ["NO [AUTHENTICATIONFAILED] Authentication failed"]);

	// Disabled account and disabled mailbox fail the same way.
	context.database.db.prepare("UPDATE users SET disabled = 1 WHERE id = 'user-a'").run();
	let session = memoryClient(app, context.env);
	await session.start();
	assertTagged(await session.client.login("a@example.test", credential), "NO", /AUTHENTICATIONFAILED/);
	context.database.db.prepare("UPDATE users SET disabled = 0 WHERE id = 'user-a'").run();
	context.database.db.prepare("UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-a'").run();
	session = memoryClient(app, context.env);
	await session.start();
	assertTagged(await session.client.login("a@example.test", credential), "NO", /AUTHENTICATIONFAILED/);
});

test("gate2: three failures on one connection end it; the host decides rate limits and delays", async (t) => {
	const delays = [];
	const context = await ready(t, { delay: async (ms) => void delays.push(ms) });
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const result = await context.client.login("a@example.test", "wrong");
		assertTagged(result, "NO", /AUTHENTICATIONFAILED/);
	}
	assert.match((await context.client.unit()).text, /^\* BYE Too many authentication failures/);
	assert.equal(await context.client.unit(), null);
	assert.deepEqual(delays, [1000, 1000, 1000], "each failure is answered after the failure delay");

	const { credential } = await context.credential("user-a", "mbx-a");
	let verified = 0;
	const limited = memoryClient(app, context.env, { beforeAuthenticate: () => ({ allowed: false, delayMs: 0 }), afterAuthenticate: () => void verified++ });
	await limited.start();
	assertTagged(await limited.client.login("a@example.test", credential), "NO", /AUTHENTICATIONFAILED/);
	assert.equal(verified, 0, "a rate-limited attempt never reaches the verifier, and still looks like any failure");
	const full = memoryClient(app, context.env, { claimUserSlot: () => false });
	await full.start();
	assertTagged(await full.client.login("a@example.test", credential), "NO", /\[LIMIT\]/);
});

test("gate2: shared mailbox access and cross-mailbox isolation", async (t) => {
	const context = await ready(t);
	const { credential: forSales } = await context.credential("user-b", "mbx-s");
	assertTagged(await context.client.login("sales@example.test", forSales), "OK");
	await context.deliver("s-1", "Subject: shared\r\n\r\nbody\r\n", { mailbox_id: "mbx-s", user_id: "user-a" });
	await context.deliver("a-1", "Subject: private\r\n\r\nbody\r\n");
	const select = await context.client.command("SELECT INBOX");
	assert.ok(select.untagged.some((unit) => unit.text === "* 1 EXISTS"), "only the shared mailbox's message");
	const fetched = await context.client.command("FETCH 1 BODY[HEADER.FIELDS (SUBJECT)]");
	assert.equal(fetched.literals[0].toString(), "Subject: shared\r\n\r\n");
	const list = await context.client.command('LIST "" "*"');
	assert.ok(!list.untagged.some((unit) => /Work|Private/.test(unit.text)), "no other mailbox's folders");
	// B's credential is for sales; it never opens B's (or A's) personal mailbox.
	const other = memoryClient(app, context.env);
	await other.start();
	assertTagged(await other.client.login("a@example.test", forSales), "NO", /AUTHENTICATIONFAILED/);
});

test("gate2: revocation of the credential, the account, the mailbox or the share ends live sessions", async (t) => {
	const context = await loggedIn(t);
	assertTagged(await context.client.command("SELECT INBOX"), "OK");
	assert.equal(await context.session.checkAccess(), true);
	context.database.db.prepare("DELETE FROM mail_app_passwords WHERE id = ?").run(context.credentialId);
	// Idle connection: the periodic check closes it.
	assert.equal(await context.session.checkAccess(), false);
	assert.equal((await context.client.unit()).text, "* BYE Access revoked");
	assert.equal(await context.client.unit(), null);

	// Active connection: the next command's A3 call closes it.
	const active = await loggedIn(t);
	active.database.db.prepare("UPDATE users SET disabled = 1 WHERE id = 'user-a'").run();
	const result = await active.client.command("LIST \"\" \"*\"");
	assert.equal(result.tagged, null);
	assert.equal(result.untagged.at(-1).text, "* BYE Access revoked");

	const shared = await loggedIn(t, { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" });
	assertTagged(await shared.client.command("SELECT INBOX"), "OK");
	shared.database.db.prepare("DELETE FROM mailbox_access WHERE id = 'acc-b'").run();
	const afterUnshare = await shared.client.command("NOOP");
	assert.equal(afterUnshare.untagged.at(-1).text, "* BYE Access revoked");

	const mailbox = await loggedIn(t);
	mailbox.database.db.prepare("UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-a'").run();
	assert.equal(await mailbox.session.checkAccess(), false);
});

// ---- Gate 3: mailboxes, selection and snapshots ------------------------------------------------

const texts = (result) => result.untagged.map((unit) => unit.text);

test("gate3: LIST, LSUB and NAMESPACE describe a flat namespace with special-use folders", async (t) => {
	const { client } = await loggedIn(t);
	const list = await client.command('LIST "" "*"');
	assertTagged(list, "OK");
	assert.deepEqual(texts(list), [
		'* LIST (\\Noinferiors) NIL "INBOX"',
		'* LIST (\\Noinferiors \\Drafts) NIL "Drafts"',
		'* LIST (\\Noinferiors \\Sent) NIL "Sent"',
		'* LIST (\\Noinferiors \\Archive) NIL "Archive"',
		'* LIST (\\Noinferiors \\Junk) NIL "Spam"',
		'* LIST (\\Noinferiors \\Trash) NIL "Trash"',
		'* LIST (\\Noinferiors) NIL "Work"',
	]);
	assert.deepEqual(texts(await client.command('LIST "" ""')), ['* LIST (\\Noselect) NIL ""']);
	assert.deepEqual(texts(await client.command('LIST "" "%"')), texts(list), "% and * are equivalent without hierarchy");
	assert.deepEqual(texts(await client.command('LIST "" "inbox"')), ['* LIST (\\Noinferiors) NIL "INBOX"'], "INBOX matches case-insensitively");
	assert.deepEqual(texts(await client.command('LIST "S" "*"')), ['* LIST (\\Noinferiors \\Sent) NIL "Sent"', '* LIST (\\Noinferiors \\Junk) NIL "Spam"'], "reference and pattern concatenate");
	assert.deepEqual(texts(await client.command('LIST "" "work"')), [], "other names are case-sensitive");
	const lsub = await client.command('LSUB "" "*"');
	assertTagged(lsub, "OK");
	assert.equal(lsub.untagged.length, 7);
	assert.ok(lsub.untagged.every((unit) => unit.text.startsWith("* LSUB (\\Noinferiors) NIL ")), "every folder counts as subscribed");
	const namespace = await client.command("NAMESPACE");
	assert.deepEqual(texts(namespace), ['* NAMESPACE (("" NIL)) NIL NIL']);
	assertTagged(await client.command('LIST "" "' + "*".repeat(2000) + '"'), "OK");
});

test("gate3: every valid folder name round-trips through modified UTF-7 without collisions", async (t) => {
	const context = await loggedIn(t);
	const names = ["Projects/2026", "Reports.Q1", "Café & Co", "inbox", "日本語", "tab\there", "100%*", "Sent", "Work", "&-", "~peter/mail/台北/日本語", "emoji 📬", "Trash (2)"];
	context.database.db.exec("DELETE FROM folders WHERE mailbox_id = 'mbx-a'");
	names.forEach((name, index) => context.database.db.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES (?, 'user-a', 'mbx-a', ?, ?)").run(`f-${index}`, name, 10 + index));
	const a3 = await app.imap.listImapMailboxes(context.env, { userId: "user-a", mailboxId: "mbx-a" });
	const list = await context.client.command('LIST "" "*"');
	const wires = list.untagged.map((unit) => (/NIL "((?:[^"\\]|\\.)*)"$/.exec(unit.text) ?? /NIL \{\d+\}\r\n([\s\S]*)$/.exec(unit.text))[1].replace(/\\(.)/g, "$1"));
	assert.equal(wires.length, a3.length);
	assert.equal(new Set(wires).size, wires.length, "distinct folders never share an exposed name");
	assert.equal(new Set(wires.map((wire) => wire.toUpperCase())).size, wires.length, "not even case-insensitively");
	for (const [index, mailbox] of a3.entries()) {
		const wire = wires[index];
		assert.match(wire, /^[\x20-\x7e]+$/, "7-bit on the wire");
		assert.equal(mailbox.role === "inbox" ? "INBOX" : app.names.decodeMailboxName(wire), mailbox.role === "inbox" ? "INBOX" : mailbox.name, "decodes to A3's exact name");
		const status = await context.client.command(`STATUS ${JSON.stringify(wire)} (MESSAGES UIDVALIDITY)`);
		assertTagged(status, "OK", undefined);
		const select = await context.client.command(`EXAMINE ${JSON.stringify(wire)}`);
		assertTagged(select, "OK", /\[READ-ONLY\]/);
	}
	assert.deepEqual(wires.slice(6), [
		"Projects/2026", "Reports.Q1", "Caf&AOk- &- Co", "inbox (2)", "&ZeVnLIqe-", "tab&AAk-here", "100%*", "Sent (2)", "Work", "&--", "~peter/mail/&U,BTFw-/&ZeVnLIqe-", "emoji &2D3c7A-", "Trash (2)",
	].map((value) => value), "RFC 3501 examples and A3's collision suffixes");
	assert.equal(app.names.decodeMailboxName("&U,BTFw-&ZeVnLIqe-"), null, "non-canonical encodings (two adjacent runs) are rejected");
	assert.equal(app.names.decodeMailboxName("&AGE-"), null, "printable ASCII must not be base64-encoded");
	assert.equal(app.names.decodeMailboxName("Caf\xe9"), null, "8-bit names are not modified UTF-7");
	// The system folder name "Sent" is taken; the custom folder of that name is "Sent (2)".
	assertTagged(await context.client.command('SELECT "Sent (2)"'), "OK");
	assertTagged(await context.client.command('SELECT "Nope"'), "NO", /NONEXISTENT/);
	assertTagged(await context.client.command('SELECT "caf&AOk- &- co"'), "NO", /NONEXISTENT/);
});

test("gate3: SELECT opens the folder read-write and EXAMINE read-only, with A3's UIDVALIDITY and UIDNEXT", async (t) => {
	const context = await loggedIn(t);
	await context.deliver("m-1", "Subject: one\r\n\r\n1\r\n");
	await context.deliver("m-2", "Subject: two\r\n\r\n2\r\n", { read: 1 });
	await context.deliver("m-3", "Subject: three\r\n\r\n3\r\n", { starred: 1 });
	for (const command of ["SELECT", "EXAMINE"]) {
		const result = await context.client.command(`${command} inbox`);
		const snapshot = await app.imap.openImapFolder(context.env, { userId: "user-a", mailboxId: "mbx-a" }, "inbox");
		const writable = command === "SELECT";
		assert.equal(result.tagged, `${result.tagged.split(" ")[0]} OK [${writable ? "READ-WRITE" : "READ-ONLY"}] ${command} completed`);
		assert.deepEqual(texts(result), [
			"* FLAGS (\\Seen \\Flagged \\Deleted \\Draft)",
			writable ? "* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Deleted)] Flags permitted" : "* OK [PERMANENTFLAGS ()] Read-only mailbox",
			"* 3 EXISTS",
			"* 0 RECENT",
			"* OK [UNSEEN 1] First unseen message",
			`* OK [UIDVALIDITY ${snapshot.uidValidity}] UIDs valid`,
			`* OK [UIDNEXT ${snapshot.uidNext}] Predicted next UID`,
		]);
	}
	const status = await context.client.command("STATUS INBOX (UIDNEXT MESSAGES UNSEEN RECENT UIDVALIDITY)");
	const a3 = await app.imap.getImapFolderStatus(context.env, { userId: "user-a", mailboxId: "mbx-a" }, "inbox");
	assert.deepEqual(texts(status), [`* STATUS "INBOX" (UIDNEXT ${a3.uidNext} MESSAGES 3 UNSEEN 2 RECENT 0 UIDVALIDITY ${a3.uidValidity})`]);
	assertTagged(await context.client.command("STATUS INBOX (SIZE)"), "BAD");
	assertTagged(await context.client.command("CHECK"), "OK");
	assertTagged(await context.client.command("UNSELECT"), "OK");
	assertTagged(await context.client.command("FETCH 1 FLAGS"), "BAD", /not valid in this state/);
	assertTagged(await context.client.command("SELECT INBOX"), "OK");
	assertTagged(await context.client.command("CLOSE"), "OK");
	assertTagged(await context.client.command("CLOSE"), "BAD", /not valid in this state/);
	assertTagged(await context.client.command("SELECT INBOX"), "OK");
	assertTagged(await context.client.command("SELECT Nowhere"), "NO", /NONEXISTENT/);
	assertTagged(await context.client.command("FETCH 1 FLAGS"), "BAD", /not valid in this state/, "a failed SELECT leaves nothing selected");
});

test("gate3: sequence numbers follow the session snapshot; EXPUNGE is withheld during FETCH and SEARCH", async (t) => {
	const context = await loggedIn(t);
	for (const id of ["m-1", "m-2", "m-3", "m-4"]) await context.deliver(id, `Subject: ${id}\r\n\r\n${id}\r\n`);
	await context.client.command("SELECT INBOX");
	const uidsBefore = await context.client.command("FETCH 1:* (UID)");
	assert.deepEqual(texts(uidsBefore), ["* 1 FETCH (UID 1)", "* 2 FETCH (UID 2)", "* 3 FETCH (UID 3)", "* 4 FETCH (UID 4)"]);

	// Another client (the web app) moves message 2 to Trash and deletes message 3.
	context.database.db.prepare("UPDATE messages SET status = 'trash' WHERE id = 'm-2'").run();
	context.database.db.prepare("DELETE FROM messages WHERE id = 'm-3'").run();
	const during = await context.client.command("FETCH 1:4 (UID)");
	assertTagged(during, "NO", /no longer exist/);
	assert.deepEqual(texts(during), ["* 1 FETCH (UID 1)", "* 4 FETCH (UID 4)"], "no EXPUNGE while answering FETCH, and numbers keep their meaning");
	const search = await context.client.command("SEARCH ALL");
	assert.deepEqual(texts(search), ["* SEARCH 1 4"], "SEARCH keeps the old numbering and omits vanished messages");
	const noop = await context.client.command("NOOP");
	assert.deepEqual(texts(noop), ["* 3 EXPUNGE", "* 2 EXPUNGE"], "highest first, so each number is valid when applied");
	assert.deepEqual(texts(await context.client.command("FETCH 1:* (UID)")), ["* 1 FETCH (UID 1)", "* 2 FETCH (UID 4)"]);
	assertTagged(await context.client.command("FETCH 3 (UID)"), "BAD", /Invalid message sequence number/);

	// New mail and a flag change reported by NOOP; UID commands may report EXPUNGE too.
	await context.deliver("m-5", "Subject: m-5\r\n\r\nm-5\r\n");
	context.database.db.prepare("UPDATE messages SET starred = 1 WHERE id = 'm-1'").run();
	context.database.db.prepare("UPDATE messages SET status = 'archived' WHERE id = 'm-4'").run();
	const uidFetch = await context.client.command("UID FETCH 1:* (FLAGS)");
	assert.deepEqual(texts(uidFetch), ["* 2 EXPUNGE", "* 1 FETCH (FLAGS (\\Flagged))", "* 2 EXISTS", "* 1 FETCH (UID 1 FLAGS (\\Flagged))", "* 2 FETCH (UID 5 FLAGS ())"]);
	// The moved message has a UID of its own in its new folder.
	const archive = await app.imap.openImapFolder(context.env, { userId: "user-a", mailboxId: "mbx-a" }, "archive");
	assert.deepEqual(archive.messages.map((entry) => entry.messageId), ["m-4"]);
});

test("gate3: a UIDVALIDITY change or a vanished selected folder ends the session", async (t) => {
	const context = await loggedIn(t);
	await context.client.command("SELECT INBOX");
	context.database.db.prepare("UPDATE imap_folders SET uid_validity = uid_validity + 1 WHERE mailbox_id = 'mbx-a' AND folder_key = 'inbox'").run();
	const result = await context.client.command("NOOP");
	assert.equal(result.tagged, null);
	assert.equal(result.untagged.at(-1).text, "* BYE Mailbox UIDVALIDITY changed, select it again");

	const other = await loggedIn(t);
	assertTagged(await other.client.command("SELECT Work"), "OK");
	other.database.db.prepare("DELETE FROM folders WHERE id = 'fld-work'").run();
	const gone = await other.client.command("FETCH 1:* (UID)");
	assert.equal(gone.untagged.at(-1).text, "* BYE Selected mailbox no longer exists");
});

test("gate3: COPY, not yet implemented, and APPEND outside Drafts are refused without touching A3 or product state", async (t) => {
	const context = await loggedIn(t);
	await context.deliver("m-1", "Subject: x\r\n\r\nx\r\n");
	await context.client.command("SELECT INBOX");
	const state = () => JSON.stringify([
		context.database.db.prepare("SELECT id, status, read, starred, folder_id FROM messages ORDER BY id").all(),
		context.database.db.prepare("SELECT * FROM imap_folders ORDER BY id").all(),
		context.database.db.prepare("SELECT imap_folder_id, uid, message_id, deleted FROM imap_message_uids ORDER BY imap_folder_id, uid").all(),
		context.database.db.prepare("SELECT id, name FROM folders ORDER BY id").all(),
	]);
	const before = state();
	// STORE is certified in imap-flags.test.mjs, EXPUNGE and CLOSE in imap-expunge.test.mjs, MOVE in imap-move.test.mjs,
	// UID EXPUNGE in imap-uidplus.test.mjs, CREATE/RENAME/DELETE/SUBSCRIBE/UNSUBSCRIBE in imap-mailbox-management.test.mjs.
	for (const command of ["COPY 1 Trash", "UID COPY 1 Trash"]) {
		assertTagged(await context.client.command(command), "NO", /\[CANNOT\] .* not available on this server/);
	}
	// APPEND (A5.7, certified in imap-append.test.mjs) is Drafts only: refused before the continuation.
	context.client.write("ap APPEND INBOX (\\Seen) {12}\r\n");
	assertTagged(await context.client.collect("ap"), "NO", /\[CANNOT\] APPEND is only available for Drafts/);
	context.client.write("big APPEND INBOX {70000}\r\n");
	assertTagged(await context.client.collect("big"), "NO", /\[CANNOT\] APPEND is only available for Drafts/);
	// IDLE (A5.4) is certified in imap-idle.test.mjs.
	for (const command of ["ENABLE CONDSTORE", "COMPRESS DEFLATE", "GETQUOTAROOT INBOX", "XLIST \"\" *"]) {
		assertTagged(await context.client.command(command), "BAD", /Unknown command/);
	}
	// UID EXPUNGE (A5.3) of a message not marked \Deleted changes nothing.
	assertTagged(await context.client.command("UID EXPUNGE 1"), "OK");
	assertTagged(await context.client.command("NOOP"), "OK");
	assert.equal(state(), before);
});

// ---- Gate 4: FETCH over the canonical octets ------------------------------------------------

const CRLF = (text) => text.replace(/\r?\n/g, "\r\n");
const PNG64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAJJRU5ErkJggg==";

/** Multipart/mixed: alternative(text, related(html, inline CID png)), an RFC 2231 attachment and an attached message. */
const COMPLEX = CRLF(`Return-Path: <sender@elsewhere.test>
Date: Tue, 3 Mar 2026 10:15:00 +0100
From: =?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?= <juergen@elsewhere.test>
Sender: "List, Sender" <list@elsewhere.test>
To: Team: ann@example.test, "Bob \\"B\\" Jones" <bob@example.test>;,
 carol@example.test (Carol C)
Cc: undisclosed-recipients:;
Subject: =?UTF-8?B?UmFwcG9ydCDinJM=?=
 folded
Message-ID: <complex-1@elsewhere.test>
In-Reply-To: <earlier@elsewhere.test>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="outer"

preamble is ignored
--outer
Content-Type: multipart/alternative; boundary=alt

--alt
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 8bit

Grüße, plain ✓
--alt
Content-Type: multipart/related; boundary="rel"; type="text/html"

--rel
Content-Type: text/html; charset=utf-8

<p>Grüße <img src="cid:logo@x"></p>
--rel
Content-Type: image/png
Content-Transfer-Encoding: base64
Content-ID: <logo@x>
Content-Disposition: inline; filename="logo.png"

${PNG64}
--rel--
--alt--
--outer
Content-Type: text/plain; name*=utf-8''r%C3%A9sum%C3%A9.txt
Content-Disposition: attachment; filename*=utf-8''r%C3%A9sum%C3%A9.txt
Content-Transfer-Encoding: quoted-printable
Content-Language: fr, en
Content-Description: CV

r=C3=A9sum=C3=A9
--outer
Content-Type: message/rfc822

From: Inner <inner@elsewhere.test>
To: a@example.test
Subject: inner message
Message-ID: <inner-1@elsewhere.test>
Content-Type: multipart/mixed; boundary=in

--in
Content-Type: text/plain

inner body
--in
Content-Type: application/octet-stream

AAAA
--in--
--outer--
epilogue is ignored
`);

/** Legacy mail stored with bare LF line endings and no closing boundary. */
const LEGACY = `From: old@elsewhere.test\nTo: a@example.test\nSubject: legacy\nContent-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain\n\nline one\nline two\n--b\nContent-Type: text/plain\n\nunterminated part\n`;

/** Header-only message: no blank line and no body. */
const HEADER_ONLY = "Subject: only headers\r\nFrom: x@elsewhere.test";

/** The part paths of a BODYSTRUCTURE and, for each leaf, its declared size and (text) line count. */
function leaves(structure, prefix = []) {
	if (Array.isArray(structure[0])) {
		const out = [];
		const children = structure.slice(0, structure.findIndex((item) => !Array.isArray(item)));
		children.forEach((child, index) => out.push(...leaves(child, [...prefix, index + 1])));
		return out;
	}
	const [type, subtype] = [String(structure[0]).toLowerCase(), String(structure[1]).toLowerCase()];
	const leaf = { path: prefix.length ? prefix : [1], type: `${type}/${subtype}`, size: structure[6] };
	if (type === "text") leaf.lines = structure[7];
	if (type === "message" && subtype === "rfc822") {
		leaf.lines = structure[9];
		leaf.inner = structure[8];
	}
	return [leaf];
}

function lineCount(text) {
	if (!text.length) return 0;
	const breaks = (text.match(/\n/g) ?? []).length;
	return text.endsWith("\n") ? breaks : breaks + 1;
}

test("gate4: BODY[], RFC822 and RFC822.SIZE are A3's canonical octets exactly; reads under EXAMINE never set \\Seen", async (t) => {
	const context = await loggedIn(t);
	const complex = await context.deliver("c-1", COMPLEX);
	const legacy = await context.deliver("l-1", LEGACY);
	const headerOnly = await context.deliver("h-1", HEADER_ONLY);
	// Under SELECT these fetches set \Seen (imap-flags.test.mjs); EXAMINE keeps this a pure read.
	await context.client.command("EXAMINE INBOX");
	const owner = { userId: "user-a", mailboxId: "mbx-a" };
	for (const [seq, bytes] of [[1, complex], [2, legacy], [3, headerOnly]]) {
		const a3 = await app.imap.fetchImapMessage(context.env, owner, "inbox", seq);
		assert.deepEqual(new Uint8Array(a3.bytes), new Uint8Array(bytes));
		const result = await context.client.command(`FETCH ${seq} (RFC822.SIZE BODY.PEEK[] RFC822 BODY[]<5.10> BODY[]<999999.10>)`);
		assertTagged(result, "OK");
		const [whole, rfc822, partial, beyond] = result.literals;
		assert.deepEqual(new Uint8Array(whole), new Uint8Array(bytes), "BODY[] is byte-identical");
		assert.deepEqual(new Uint8Array(rfc822), new Uint8Array(bytes), "RFC822 is byte-identical");
		assert.match(result.untagged[0].text, new RegExp(`^\\* ${seq} FETCH \\(RFC822\\.SIZE ${bytes.byteLength} BODY\\[\\] \\{${bytes.byteLength}\\}`));
		assert.equal(a3.size, bytes.byteLength);
		assert.deepEqual(new Uint8Array(partial), new Uint8Array(bytes).subarray(5, 15));
		assert.match(result.untagged[0].text, /BODY\[\]<5> \{10\}/);
		assert.equal(beyond.length, 0);
	}
	const flags = await context.client.command("FETCH 1:3 (FLAGS)");
	assert.deepEqual(texts(flags), ["* 1 FETCH (FLAGS ())", "* 2 FETCH (FLAGS ())", "* 3 FETCH (FLAGS ())"]);
	assert.deepEqual(context.database.db.prepare("SELECT read, starred FROM messages ORDER BY id").all().map((row) => [row.read, row.starred]), [[0, 0], [0, 0], [0, 0]], "messages.read and starred unchanged");
	const a3Flags = (await app.imap.openImapFolder(context.env, owner, "inbox")).messages.map((entry) => entry.flags);
	assert.ok(a3Flags.every((entry) => !entry.seen && !entry.flagged && !entry.deleted));
	// Other items: INTERNALDATE, UID, macros.
	const internal = await context.client.command("FETCH 1 (INTERNALDATE UID)");
	const created = new Date(context.row("c-1").created_at * 1000);
	assert.equal(fetchAttributes(internal.untagged[0].text).INTERNALDATE, `${String(created.getUTCDate()).padStart(2, "0")}-${created.toUTCString().slice(8, 11)}-${created.getUTCFullYear()} ${created.toISOString().slice(11, 19)} +0000`);
	const fast = await context.client.command("FETCH 2 FAST");
	assert.deepEqual(Object.keys(fetchAttributes(fast.untagged[0].text)), ["FLAGS", "INTERNALDATE", "RFC822.SIZE"]);
	const full = await context.client.command("FETCH 2 FULL");
	assert.deepEqual(Object.keys(fetchAttributes(full.untagged[0].text)), ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE", "BODY"]);
});

test("gate4: sections slice exactly the octets BODYSTRUCTURE describes (multipart, nested, CID, attachment, message/rfc822)", async (t) => {
	const context = await loggedIn(t);
	await context.deliver("c-1", COMPLEX);
	await context.client.command("SELECT INBOX");
	const text = Buffer.from(COMPLEX).toString("latin1");
	const structure = fetchAttributes((await context.client.command("FETCH 1 BODYSTRUCTURE")).untagged[0].text).BODYSTRUCTURE;
	const parts = leaves(structure);
	assert.deepEqual(parts.map((part) => [part.path.join("."), part.type]), [
		["1.1", "text/plain"], ["1.2.1", "text/html"], ["1.2.2", "image/png"], ["2", "text/plain"], ["3", "message/rfc822"],
	]);
	for (const part of parts) {
		const result = await context.client.command(`FETCH 1 (BODY.PEEK[${part.path.join(".")}] BODY.PEEK[${part.path.join(".")}.MIME])`);
		const [body, mime] = result.literals.map(latin1);
		assert.equal(body.length, part.size, `size of ${part.path.join(".")}`);
		if (part.lines !== undefined) assert.equal(lineCount(body), part.lines, `lines of ${part.path.join(".")}`);
		assert.ok(text.includes(mime + body), `${part.path.join(".")}.MIME + body are contiguous canonical octets`);
		assert.match(mime, /\r\n\r\n$/);
	}
	const byPath = Object.fromEntries(parts.map((part) => [part.path.join("."), part]));
	// Nested message/rfc822: its envelope and structure, and its own sections.
	const inner = byPath["3"];
	assert.equal(inner.inner.at(-1 - 4), "mixed");
	const nested = await context.client.command("FETCH 1 (BODY.PEEK[3.HEADER] BODY.PEEK[3.TEXT] BODY.PEEK[3.1] BODY.PEEK[3.2] BODY.PEEK[3.HEADER.FIELDS (SUBJECT)] BODY.PEEK[3])");
	const [innerHeader, innerText, first, second, subject, whole] = nested.literals.map(latin1);
	assert.equal(innerHeader + innerText, whole, "HEADER and TEXT of the attached message partition it");
	assert.equal(first, "inner body");
	assert.equal(second, "AAAA");
	assert.equal(subject, "Subject: inner message\r\n\r\n");
	// Top-level sections.
	const top = await context.client.command("FETCH 1 (BODY.PEEK[HEADER] BODY.PEEK[TEXT] RFC822.HEADER RFC822.TEXT BODY.PEEK[HEADER.FIELDS (to subject x-none)] BODY.PEEK[HEADER.FIELDS.NOT (Return-Path To Subject Cc Sender From Date Message-ID In-Reply-To)])");
	const [header, bodyText, rfcHeader, rfcText, fields, notFields] = top.literals.map(latin1);
	assert.equal(header + bodyText, text);
	assert.equal(rfcHeader, header);
	assert.equal(rfcText, bodyText);
	assert.equal(fields, "To: Team: ann@example.test, \"Bob \\\"B\\\" Jones\" <bob@example.test>;,\r\n carol@example.test (Carol C)\r\nSubject: =?UTF-8?B?UmFwcG9ydCDinJM=?=\r\n folded\r\n\r\n", "folded fields are returned whole, in message order");
	assert.equal(notFields, "MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"outer\"\r\n\r\n");
	assert.match(top.untagged[0].text, /BODY\[HEADER\.FIELDS \(TO SUBJECT X-NONE\)\] \{/);
	// Sections that do not exist are empty, not errors.
	const missing = await context.client.command("FETCH 1 (BODY.PEEK[9] BODY.PEEK[1.1.HEADER] BODY.PEEK[2.3])");
	assertTagged(missing, "OK");
	assert.deepEqual(missing.literals.map((item) => item.length), [0, 0, 0]);
	// Structure details: CID, disposition, RFC 2231 parameters passed through, language, description, encoding.
	const png = structure[0][1][1];
	assert.deepEqual(png.slice(0, 7), ["image", "png", null, "<logo@x>", null, "BASE64", PNG64.length]);
	assert.deepEqual(png[8], ["inline", ["filename", "logo.png"]]);
	const attachment = structure[1];
	assert.deepEqual(attachment.slice(0, 6), ["text", "plain", ["name*", "utf-8''r%C3%A9sum%C3%A9.txt"], null, "CV", "QUOTED-PRINTABLE"]);
	assert.deepEqual(attachment[9], ["attachment", ["filename*", "utf-8''r%C3%A9sum%C3%A9.txt"]]);
	assert.deepEqual(attachment[10], ["fr", "en"]);
	assert.deepEqual(structure.slice(3), ["mixed", ["boundary", "outer"], null, null, null]);
	// BODY is the non-extensible form of the same structure.
	const body = fetchAttributes((await context.client.command("FETCH 1 BODY")).untagged[0].text).BODY;
	assert.deepEqual(body.at(-1), "mixed");
	assert.deepEqual(body[1].slice(0, 7), attachment.slice(0, 7));
	assert.equal(body[1].length, 8, "no extension data in BODY");
});

test("gate4: legacy LF mail, header-only mail and defaults are described consistently", async (t) => {
	const context = await loggedIn(t);
	await context.deliver("l-1", LEGACY);
	await context.deliver("h-1", HEADER_ONLY);
	await context.deliver("p-1", "Subject: plain\r\n\r\nno content type\r\n");
	await context.client.command("SELECT INBOX");
	const legacy = fetchAttributes((await context.client.command("FETCH 1 BODYSTRUCTURE")).untagged[0].text).BODYSTRUCTURE;
	const parts = leaves(legacy);
	for (const part of parts) {
		const result = await context.client.command(`FETCH 1 BODY.PEEK[${part.path.join(".")}]`);
		assert.equal(result.literals[0].length, part.size);
		assert.equal(lineCount(latin1(result.literals[0])), part.lines);
	}
	assert.deepEqual(parts.map((part) => part.size), [17, 18], "the LF before a boundary belongs to the delimiter; an unterminated last part runs to the end");
	const header = await context.client.command("FETCH 1 (BODY.PEEK[HEADER] BODY.PEEK[1.MIME])");
	assert.equal(latin1(header.literals[0]), "From: old@elsewhere.test\nTo: a@example.test\nSubject: legacy\nContent-Type: multipart/mixed; boundary=b\n\n");
	assert.equal(latin1(header.literals[1]), "Content-Type: text/plain\n\n");
	const headerOnly = await context.client.command("FETCH 2 (BODYSTRUCTURE BODY.PEEK[HEADER] BODY.PEEK[TEXT] BODY.PEEK[1])");
	assert.deepEqual(fetchAttributes(headerOnly.untagged[0].text).BODYSTRUCTURE, ["text", "plain", ["charset", "us-ascii"], null, null, "7BIT", 0, 0, null, null, null, null]);
	assert.deepEqual(headerOnly.literals.map(latin1), [HEADER_ONLY, "", ""]);
	const plain = await context.client.command("FETCH 3 (BODYSTRUCTURE BODY.PEEK[1])");
	assert.deepEqual(fetchAttributes(plain.untagged[0].text).BODYSTRUCTURE.slice(0, 8), ["text", "plain", ["charset", "us-ascii"], null, null, "7BIT", 17, 1]);
	assert.equal(latin1(plain.literals[0]), "no content type\r\n", "part 1 of a non-multipart message is its body");
});

test("gate4: ENVELOPE comes from the canonical header, raw: groups, quoting, folding, defaults", async (t) => {
	const context = await loggedIn(t);
	await context.deliver("c-1", COMPLEX);
	await context.deliver("u-1", CRLF(`From: "Zoë" <zoe@elsewhere.test>\nTo: broken@, <>, just-text, a@example.test\nSubject: Grüße ✓\nMessage-ID: <u@x>\n\nbody\n`));
	await context.client.command("SELECT INBOX");
	const envelope = fetchAttributes((await context.client.command("FETCH 1 ENVELOPE")).untagged[0].text).ENVELOPE;
	assert.deepEqual(envelope, [
		"Tue, 3 Mar 2026 10:15:00 +0100",
		"=?UTF-8?B?UmFwcG9ydCDinJM=?= folded",
		[["=?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?=", null, "juergen", "elsewhere.test"]],
		[["List, Sender", null, "list", "elsewhere.test"]],
		[["=?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?=", null, "juergen", "elsewhere.test"]],
		[[null, null, "Team", null], [null, null, "ann", "example.test"], ['Bob "B" Jones', null, "bob", "example.test"], [null, null, null, null], ["Carol C", null, "carol", "example.test"]],
		[[null, null, "undisclosed-recipients", null], [null, null, null, null]],
		null,
		"<earlier@elsewhere.test>",
		"<complex-1@elsewhere.test>",
	]);
	const unicode = await context.client.command("FETCH 2 ENVELOPE");
	const parsed = fetchAttributes(unicode.untagged[0].text).ENVELOPE;
	assert.equal(Buffer.from(parsed[1], "latin1").toString("utf8"), "Grüße ✓", "8-bit header octets travel as a literal, unchanged");
	assert.match(unicode.untagged[0].text, /\{\d+\}\r\nGr/);
	assert.equal(Buffer.from(parsed[2][0][0], "latin1").toString("utf8"), "Zoë");
	assert.deepEqual(parsed[5], [[null, null, "broken", ""], [null, null, "just-text", ""], [null, null, "a", "example.test"]], "malformed addresses stay well-formed ENVELOPE entries; empty ones are dropped");
	assert.equal(parsed[3][0][2], "zoe", "Sender defaults to From");
});

test("gate4: sent mail with Bcc, inline CID and attachment is served as A1 stored it", async (t) => {
	const context = await loggedIn(t);
	const { messageId } = await app.sendEmail(context.env, {
		userId: "user-a", mailboxId: "mbx-a", from: "a@example.test", to: "Bob <bob@elsewhere.test>", bcc: "hidden@elsewhere.test",
		subject: "Rapport ✓ ünïcode", text: "Grüße", html: '<p>Grüße <img src="cid:logo"></p>',
		attachments: [
			{ filename: "logo.png", type: "image/png", content: Buffer.from(PNG64, "base64").buffer.slice(0), disposition: "inline", contentId: "logo" },
			{ filename: "résumé.txt", type: "text/plain", content: new TextEncoder().encode("attached ✓").buffer, disposition: "attachment" },
		],
	});
	await context.client.command("SELECT Sent");
	const stored = new Uint8Array(await (await context.env.BUCKET.get(context.row(messageId).raw_r2_key)).arrayBuffer());
	const result = await context.client.command("FETCH 1 (FLAGS RFC822.SIZE ENVELOPE BODYSTRUCTURE BODY.PEEK[])");
	assert.deepEqual(new Uint8Array(result.literals.at(-1)), stored, "exactly the stored canonical object");
	const attributes = fetchAttributes(result.untagged[0].text);
	assert.equal(attributes["RFC822.SIZE"], stored.byteLength);
	assert.deepEqual(attributes.FLAGS, ["\\Seen"], "outbound mail is seen (A3), not because it was read");
	assert.deepEqual(attributes.ENVELOPE[7].map((address) => `${address[2]}@${address[3]}`), ["hidden@elsewhere.test"], "the sender's copy keeps Bcc, as A1 stores it");
	const parts = leaves(attributes.BODYSTRUCTURE);
	for (const part of parts) {
		const body = await context.client.command(`FETCH 1 BODY.PEEK[${part.path.join(".")}]`);
		assert.equal(body.literals[0].length, part.size);
	}
	assert.ok(parts.some((part) => part.type === "image/png"));
});

test("gate4: metadata is cached per (mailbox, folder, UIDVALIDITY, UID); unreadable messages do not end the session", async (t) => {
	let reads = 0;
	const context = await ready(t, { acquireRead: async () => { reads += 1; return () => {}; } });
	const { credential } = await context.credential("user-a", "mbx-a");
	await context.client.login("a@example.test", credential);
	await context.deliver("c-1", COMPLEX);
	await context.deliver("gone", "x", { raw_r2_key: "inbound/missing.eml", direction: "inbound" });
	await context.deliver("c-2", "Subject: after\r\n\r\nok\r\n");
	await context.client.command("SELECT INBOX");
	await context.client.command("FETCH 1 (ENVELOPE BODYSTRUCTURE RFC822.SIZE)");
	assert.equal(reads, 1);
	const again = await context.client.command("FETCH 1 (ENVELOPE BODYSTRUCTURE BODY RFC822.SIZE)");
	assert.equal(reads, 1, "served from derived metadata without re-reading the message");
	assertTagged(again, "OK");
	const mixed = await context.client.command("FETCH 1:3 (UID BODY.PEEK[HEADER])");
	assertTagged(mixed, "NO", /UNAVAILABLE/);
	assert.deepEqual(mixed.untagged.map((unit) => unit.text.split(" (")[0]), ["* 1 FETCH", "* 3 FETCH"], "other messages are still answered");
	assertTagged(await context.client.command("NOOP"), "OK");
	const cache = new app.MetadataCache(2, 1_000_000);
	cache.set("a", { size: 1, envelope: "x", body: "y", bodyStructure: "z" });
	cache.set("b", { size: 1, envelope: "x", body: "y", bodyStructure: "z" });
	cache.get("a");
	cache.set("c", { size: 1, envelope: "x", body: "y", bodyStructure: "z" });
	assert.deepEqual([cache.get("a") !== undefined, cache.get("b") !== undefined, cache.get("c") !== undefined], [true, false, true], "LRU bounded by entries");
	const small = new app.MetadataCache(100, 500);
	for (let index = 0; index < 20; index += 1) small.set(`k${index}`, { size: 1, envelope: "x".repeat(50), body: "", bodyStructure: "" });
	assert.ok(small.weight <= 500 && small.size < 20, "and by bytes");
});

test("gate4: MIME parsing is bounded in depth and part count", () => {
	let nested = "Content-Type: text/plain\r\n\r\nleaf\r\n";
	for (let depth = 0; depth < 60; depth += 1) nested = `Content-Type: multipart/mixed; boundary=b${depth}\r\n\r\n--b${depth}\r\n${nested}--b${depth}--\r\n`;
	const root = app.mime.parseMessage(nested);
	let depth = 0;
	for (let entity = root; entity.children.length; entity = entity.children[0]) depth += 1;
	assert.equal(depth, app.mime.MAX_MIME_DEPTH, "parsing stops at the depth bound");
	const many = `Content-Type: multipart/mixed; boundary=z\r\n\r\n${"--z\r\n\r\nx\r\n".repeat(5000)}--z--\r\n`;
	const wide = app.mime.parseMessage(many);
	assert.ok(wide.children.length < app.mime.MAX_MIME_ENTITIES);
	assert.doesNotThrow(() => new app.MessageView(Buffer.from(many)).metadata());
	for (const garbage of ["", "\r\n", ":", "Content-Type: multipart/mixed\r\n\r\nx", "Content-Type: multipart/mixed; boundary=\"\"\r\n\r\n--\r\n", "Content-Type: message/rfc822\r\n\r\n", "\0\0\0"]) {
		assert.doesNotThrow(() => new app.MessageView(Buffer.from(garbage)).metadata(), JSON.stringify(garbage));
	}
});

// ---- Gate 5: SEARCH ------------------------------------------------

async function searchMailbox(t, hostOverrides) {
	const context = await ready(t, hostOverrides);
	const { credential } = await context.credential("user-a", "mbx-a");
	await context.client.login("a@example.test", credential);
	// 1: seen, To header differs from the stored envelope recipient; encoded subject.
	await context.deliver("s-1", CRLF(`Date: Mon, 2 Mar 2026 23:30:00 -0800\nFrom: Alice Sender <alice@elsewhere.test>\nTo: Team List <team@lists.test>\nCc: carol@example.test\nSubject: =?UTF-8?Q?Caf=C3=A9_menu?=\nX-Tag: alpha\n\nLunch is at noon.\n`), { read: 1, to_addr: "a@example.test", created_at: Date.UTC(2026, 2, 3, 12) / 1000 });
	// 2: flagged, quoted-printable body, HTML alternative.
	await context.deliver("s-2", CRLF(`Date: 5 Mar 26 08:00 GMT\nFrom: bob@elsewhere.test\nTo: a@example.test\nBcc: secret@elsewhere.test\nSubject: Report\nContent-Type: multipart/alternative; boundary=x\n\n--x\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nr=C3=A9sum=C3=A9 attached\n--x\nContent-Type: text/html\n\n<p>Visible <b>html</b> words</p>\n--x--\n`), { starred: 1, created_at: Date.UTC(2026, 2, 5, 9) / 1000 });
	// 3: large, unseen, no Date header.
	await context.deliver("s-3", CRLF(`From: carol@example.test\nTo: a@example.test\nSubject: big one\n\n${"padding ".repeat(500)}\n`), { created_at: Date.UTC(2026, 2, 7, 9) / 1000 });
	await context.client.command("SELECT INBOX");
	return context;
}

const searched = (result) => {
	assertTagged(result, "OK");
	assert.equal(result.untagged.length, 1);
	return result.untagged[0].text.replace(/^\* SEARCH ?/, "").split(" ").filter(Boolean).map(Number);
};

test("gate5: flag, sequence, UID, date and size keys", async (t) => {
	const { client } = await searchMailbox(t);
	assert.deepEqual(searched(await client.command("SEARCH ALL")), [1, 2, 3]);
	assert.deepEqual(searched(await client.command("SEARCH SEEN")), [1]);
	assert.deepEqual(searched(await client.command("SEARCH UNSEEN")), [2, 3]);
	assert.deepEqual(searched(await client.command("SEARCH FLAGGED")), [2]);
	assert.deepEqual(searched(await client.command("SEARCH UNFLAGGED UNSEEN")), [3]);
	assert.deepEqual(searched(await client.command("SEARCH DELETED")), []);
	assert.deepEqual(searched(await client.command("SEARCH UNDELETED DRAFT")), []);
	assert.deepEqual(searched(await client.command("SEARCH ANSWERED")), []);
	assert.deepEqual(searched(await client.command("SEARCH UNANSWERED OLD")), [1, 2, 3]);
	assert.deepEqual(searched(await client.command("SEARCH NEW")), []);
	assert.deepEqual(searched(await client.command("SEARCH RECENT")), []);
	assert.deepEqual(searched(await client.command("SEARCH KEYWORD $Junk")), []);
	assert.deepEqual(searched(await client.command("SEARCH UNKEYWORD $Junk")), [1, 2, 3]);
	assert.deepEqual(searched(await client.command("SEARCH 2:*")), [2, 3]);
	assert.deepEqual(searched(await client.command("SEARCH UID 3,1")), [1, 3]);
	assert.deepEqual(searched(await client.command("UID SEARCH UID 2:*")), [2, 3]);
	assert.deepEqual(searched(await client.command("SEARCH NOT 2")), [1, 3]);
	assert.deepEqual(searched(await client.command("SEARCH OR SEEN FLAGGED")), [1, 2]);
	assert.deepEqual(searched(await client.command("SEARCH (SEEN) (OR 1 3)")), [1]);
	assert.deepEqual(searched(await client.command("SEARCH ON 5-Mar-2026")), [2]);
	assert.deepEqual(searched(await client.command("SEARCH BEFORE 5-Mar-2026")), [1]);
	assert.deepEqual(searched(await client.command('SEARCH SINCE "05-Mar-2026"')), [2, 3]);
	assert.deepEqual(searched(await client.command("SEARCH LARGER 1000")), [3]);
	assert.deepEqual(searched(await client.command("SEARCH SMALLER 1000")), [1, 2]);
	assertTagged(await client.command("SEARCH FROB"), "BAD");
	assertTagged(await client.command("SEARCH ON 32-Mar-2026"), "BAD");
});

test("gate5: header and body keys use the canonical octets, not database columns", async (t) => {
	const { client } = await searchMailbox(t);
	assert.deepEqual(searched(await client.command("SEARCH TO team@lists")), [1], "the To header, not the stored envelope recipient");
	assert.deepEqual(searched(await client.command("SEARCH TO a@example.test")), [2, 3]);
	assert.deepEqual(searched(await client.command('SEARCH FROM "alice sender"')), [1], "case-insensitive substring over the display name");
	assert.deepEqual(searched(await client.command("SEARCH CC carol")), [1]);
	assert.deepEqual(searched(await client.command("SEARCH BCC secret")), [2]);
	assert.deepEqual(searched(await client.command("SEARCH SUBJECT MENU")), [1], "encoded words are decoded before matching");
	client.write("u1 SEARCH CHARSET UTF-8 SUBJECT {5}\r\n");
	await client.unit();
	client.write("Caf\xc3\xa9\r\n");
	assert.deepEqual(searched(await client.collect("u1")), [1]);
	assert.deepEqual(searched(await client.command("SEARCH HEADER X-Tag alp")), [1]);
	assert.deepEqual(searched(await client.command('SEARCH HEADER X-Tag ""')), [1], "an empty string matches every message with the field");
	assert.deepEqual(searched(await client.command("SEARCH HEADER Date GMT")), [2]);
	client.write("u2 SEARCH CHARSET UTF-8 BODY {6}\r\n");
	await client.unit();
	client.write("r\xc3\xa9sum\r\n");
	assert.deepEqual(searched(await client.collect("u2")), [2], "bodies are decoded (quoted-printable, charset)");
	assert.deepEqual(searched(await client.command("SEARCH BODY \"html words\"")), [], "markup is not text");
	assert.deepEqual(searched(await client.command("SEARCH BODY \"visible\"")), [2]);
	assert.deepEqual(searched(await client.command("SEARCH BODY report")), [], "BODY excludes the header");
	assert.deepEqual(searched(await client.command("SEARCH TEXT report")), [2], "TEXT includes it");
	assert.deepEqual(searched(await client.command("SEARCH SENTON 2-Mar-2026")), [1], "SENT* use the Date header's own calendar date");
	assert.deepEqual(searched(await client.command("SEARCH SENTSINCE 3-Mar-2026")), [2], "two-digit years; no Date header never matches");
	assert.deepEqual(searched(await client.command("SEARCH SENTBEFORE 3-Mar-2026")), [1]);
	assert.deepEqual(searched(await client.command("SEARCH CHARSET US-ASCII NOT FROM alice")), [2, 3]);
	assertTagged(await client.command("SEARCH CHARSET ISO-8859-1 FROM x"), "NO", /\[BADCHARSET \(US-ASCII UTF-8\)\]/);
});

test("gate5: SEARCH reads octets only when needed, one message at a time, and stops when the client leaves", async (t) => {
	let reads = 0;
	let active = 0;
	let peak = 0;
	const context = await searchMailbox(t, {
		acquireRead: async () => {
			reads += 1;
			active += 1;
			peak = Math.max(peak, active);
			return () => { active -= 1; };
		},
	});
	const { client } = context;
	reads = 0;
	assert.deepEqual(searched(await client.command("SEARCH SEEN UNSEEN FROM alice")), []);
	assert.equal(reads, 0, "cheap keys that already decide the answer avoid every read");
	assert.deepEqual(searched(await client.command("SEARCH SEEN FROM alice")), [1]);
	assert.equal(reads, 1, "only the candidate the flags leave open is read");
	assert.deepEqual(searched(await client.command("SEARCH OR FLAGGED FROM alice")), [1, 2]);
	assert.equal(reads, 3);
	assert.equal(peak, 1, "never more than one message in flight per session");
	reads = 0;
	await client.command("FETCH 1:* RFC822.SIZE");
	assert.equal(reads, 1, "A3 recorded the sizes of the two messages already read; only the third is read");
	reads = 0;
	assert.deepEqual(searched(await client.command("SEARCH LARGER 1000")), [3]);
	assert.equal(reads, 0, "known sizes answer LARGER/SMALLER without reads");

	// Disconnect during a search: no reads after the transport goes away.
	for (let index = 0; index < 20; index += 1) await context.deliver(`bulk-${index}`, `Subject: bulk ${index}\r\n\r\nx\r\n`);
	await client.command("NOOP");
	reads = 0;
	const stopping = memoryClient(app, context.env, {
		acquireRead: async () => {
			reads += 1;
			if (reads === 3) stopping.session.transportClosed();
			return () => {};
		},
	});
	await stopping.start();
	const { credential } = await context.credential("user-a", "mbx-a");
	await stopping.client.login("a@example.test", credential);
	await stopping.client.command("SELECT INBOX");
	stopping.client.write("z SEARCH BODY nothing-matches\r\n");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(reads, 3, "the search stopped at the disconnect");
});

test("gate5: unreadable and malformed messages do not break SEARCH", async (t) => {
	const context = await searchMailbox(t);
	await context.deliver("gone", "x", { raw_r2_key: "inbound/missing.eml" });
	await context.deliver("junk", "\0\0\xff\xfe not mime at all \r\n--\r\n");
	await context.client.command("NOOP");
	const result = await context.client.command("SEARCH BODY lunch");
	assert.equal(result.untagged[0].text, "* SEARCH 1");
	assertTagged(result, "NO", /UNAVAILABLE/);
	const text = await context.client.command("SEARCH TEXT mime");
	assert.equal(text.untagged[0].text, "* SEARCH 5", "the malformed message is still searched");
	assertTagged(text, "NO", /UNAVAILABLE/);
	assertTagged(await context.client.command("NOOP"), "OK");
});

