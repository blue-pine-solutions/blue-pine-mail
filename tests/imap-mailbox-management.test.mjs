import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { assertTagged, createClock, install, loadApp, makeCertificate, memoryClient, tlsClient } from "./support/imap-harness.mjs";

/**
 * A5.5a: IMAP CREATE, RENAME, DELETE (through the R-1 folder-management service, strict naming,
 * DELETE to Trash) and SUBSCRIBE/UNSUBSCRIBE compatibility, over the real A2 verifier, A3 state
 * and R-1 guards (SQLite, no Workers).
 */
const { app, cleanup } = await loadApp("imap-mailbox-management");
test.after(cleanup);

const SHARED = { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" };
const texts = (result) => result.untagged.map((unit) => unit.text);
const exec = (context, query) => context.database.db.exec(query);
const all = (context, query, ...params) => context.database.db.prepare(query).all(...params);
const one = (context, query, ...params) => context.database.db.prepare(query).get(...params);
const folderNames = (context, mailboxId = "mbx-a") => all(context, "SELECT name FROM folders WHERE mailbox_id = ? ORDER BY name", mailboxId).map((row) => row.name);
const folderId = (context, name, mailboxId = "mbx-a") => one(context, "SELECT id FROM folders WHERE mailbox_id = ? AND name = ?", mailboxId, name)?.id ?? null;
const message = (context, id) => one(context, "SELECT status, folder_id, snoozed_until FROM messages WHERE id = ?", id);
/** Everything management could touch. */
const state = (context) =>
	JSON.stringify([
		all(context, "SELECT id, mailbox_id, name FROM folders ORDER BY id"),
		all(context, "SELECT id, mailbox_id, status, folder_id FROM messages ORDER BY id"),
		all(context, "SELECT folder_key, uid_validity, uid_next FROM imap_folders ORDER BY id"),
	]);
/** The names LIST reports (wire form). */
async function listed(client, command = 'LIST "" "*"') {
	return texts(await client.command(command)).map((line) => /"([^"]*)"$/.exec(line)?.[1] ?? line);
}

async function connect(context, { userId = "user-a", mailboxId = "mbx-a", address = "a@example.test" } = {}, hostOverrides, sessionOptions) {
	const { client, session, start } = memoryClient(app, context.env, hostOverrides, sessionOptions);
	await start();
	const { credential, id } = await context.credential(userId, mailboxId);
	assertTagged(await client.login(address, credential), "OK");
	return { client, session, credentialId: id };
}

async function setup(t, account) {
	const context = await install(app, t);
	return { ...context, ...(await connect(context, account)) };
}

/** Run `hook` right before the next D1 batch whose SQL matches `pattern`. */
function beforeBatch(context, pattern, hook) {
	const database = context.database;
	const original = database.batch;
	database.batch = async function (statements) {
		if (pattern.test(statements.map((statement) => statement.sql ?? "").join("\n"))) {
			database.batch = original;
			await hook();
		}
		return original.call(this, statements);
	};
}

// ---- Command surface -------------------------------------------------------------------------------

test("a5.5a: the commands need an authenticated session, add no capability, and malformed arguments are BAD", async (t) => {
	const context = await install(app, t);
	const { client, start } = memoryClient(app, context.env);
	await start();
	for (const command of ["CREATE X", "RENAME Work X", "DELETE Work", "SUBSCRIBE Work", "UNSUBSCRIBE Work"]) assertTagged(await client.command(command), "BAD", /not valid in this state/, command);
	const { credential } = await context.credential("user-a", "mbx-a");
	assertTagged(await client.login("a@example.test", credential), "OK", /\[CAPABILITY IMAP4rev1 ID NAMESPACE UNSELECT SPECIAL-USE MOVE UIDPLUS IDLE\]/);
	const before = state(context);
	for (const command of ["CREATE", "CREATE ", "CREATE a b", "CREATE (x)", "RENAME Work", "RENAME Work a b", "RENAME", "DELETE", "DELETE a b", "SUBSCRIBE", "UNSUBSCRIBE a b", "CREATE  x"]) {
		assertTagged(await client.command(command), "BAD", undefined, command);
	}
	assert.equal(state(context), before);
	assertTagged(await client.command("COPY 1 Trash"), "BAD", /not valid in this state/, "COPY needs a selection");
	// APPEND (A5.7) is Drafts only: INBOX is refused before the continuation, so no octets follow.
	client.write("ap APPEND INBOX {1}\r\n");
	const append = await client.collect("ap");
	assert.deepEqual(append.untagged, [], "no continuation");
	assertTagged(append, "NO", /\[CANNOT\] APPEND is only available for Drafts/);
});

// ---- CREATE -----------------------------------------------------------------------------------------

test("a5.5a CREATE: atoms, quoted strings with escapes, literals and modified UTF-7; `/` is literal; no IMAP state until first use", async (t) => {
	const context = await setup(t);
	assertTagged(await context.client.command("CREATE Projects"), "OK", /^t\d+ OK CREATE completed$/);
	assertTagged(await context.client.command('CREATE "Say \\"hi\\" \\\\ now"'), "OK");
	context.client.write("lit CREATE {8}\r\n");
	assert.match((await context.client.unit()).text, /^\+ /);
	context.client.write("Literal!\r\n");
	assertTagged(await context.client.collect("lit"), "OK");
	assertTagged(await context.client.command('CREATE "Caf&AOk-"'), "OK");
	assertTagged(await context.client.command('CREATE "A/B"'), "OK");
	assertTagged(await context.client.command('CREATE "Trailing/"'), "OK");
	assertTagged(await context.client.command(`CREATE "${"N".repeat(80)}"`), "OK");
	assert.deepEqual(folderNames(context), ["A/B", "Café", "Literal!", "N".repeat(80), "Projects", 'Say "hi" \\ now', "Trailing/", "Work"]);
	const names = await listed(context.client);
	for (const wire of ["Projects", "Literal!", "Caf&AOk-", "A/B", "Trailing/"]) assert.ok(names.includes(wire), wire);
	assert.ok(texts(await context.client.command('LIST "" "A/B"')).every((line) => line.startsWith("* LIST (\\Noinferiors) NIL ")), "flat, NIL delimiter");
	assert.deepEqual(all(context, "SELECT folder_key FROM imap_folders WHERE folder_key LIKE 'f:%'"), [], "no IMAP state is created eagerly");
	assertTagged(await context.client.command('SELECT "Caf&AOk-"'), "OK", /READ-WRITE/);
	assert.equal(all(context, "SELECT folder_key FROM imap_folders WHERE folder_key LIKE 'f:%'").length, 1, "first use allocates it");
});

test("a5.5a CREATE: invalid, wildcard and colliding names are refused; existing and system names are ALREADYEXISTS", async (t) => {
	const context = await setup(t);
	assertTagged(await context.client.command('CREATE "Caf&AOk-"'), "OK");
	const before = state(context);
	const refused = [
		['""', /\[CANNOT\] Invalid mailbox name/],
		['"   "', /\[CANNOT\] Invalid mailbox name/],
		['" Padded"', /\[CANNOT\] Invalid mailbox name/],
		[`"${"N".repeat(81)}"`, /\[CANNOT\] Invalid mailbox name/],
		['"&AAk-"', /\[CANNOT\] Invalid mailbox name/, "a tab, in modified UTF-7"],
		['"A&AA0ACg-B"', /\[CANNOT\] Invalid mailbox name/, "CR LF"],
		['"&AH8-"', /\[CANNOT\] Invalid mailbox name/, "DEL"],
		['"&AEE-"', /\[CANNOT\] Invalid mailbox name/, "non-canonical modified UTF-7"],
		['"CafÃ©"', /\[CANNOT\] Invalid mailbox name/, "raw 8-bit bytes"],
		['"&Jjo"', /\[CANNOT\] Invalid mailbox name/, "unterminated modified UTF-7"],
		['"a*b"', /\[CANNOT\] Invalid mailbox name/],
		['"50%"', /\[CANNOT\] Invalid mailbox name/],
		["Work", /\[ALREADYEXISTS\]/],
		["INBOX", /\[ALREADYEXISTS\]/],
		["inbox", /\[ALREADYEXISTS\]/],
		["Inbox", /\[ALREADYEXISTS\]/],
		...["Sent", "Drafts", "Archive", "Spam", "Trash"].map((name) => [name, /\[ALREADYEXISTS\]/]),
		["work", /\[CANNOT\] Mailbox name is too similar/],
		["trash", /\[CANNOT\] Mailbox name is too similar/],
		["SENT", /\[CANNOT\] Mailbox name is too similar/],
		['"Cafe&AwE-"', /\[CANNOT\] Mailbox name is too similar/, "NFD of an existing NFC name"],
		['"caf&AMk-"', /\[CANNOT\] Mailbox name is too similar/, "a non-ASCII case variant"],
		['"Work (2)"', /\[CANNOT\] Mailbox name is too similar/, "shaped like a disambiguated name"],
		['"Trash (3)"', /\[CANNOT\] Mailbox name is too similar/],
	];
	for (const [argument, pattern, label] of refused) assertTagged(await context.client.command(`CREATE ${argument}`), "NO", pattern, label ?? argument);
	assert.equal(state(context), before, "nothing was created");
	for (const name of ['"Unrelated (2)"', "Junk", '"Sent Items"', '"Deleted Items"']) assertTagged(await context.client.command(`CREATE ${name}`), "OK", undefined, name);
});

// ---- Authorization ---------------------------------------------------------------------------------

test("a5.5a authorization: owner and full_access may manage; read_only, send_as and send_on_behalf get NOPERM", async (t) => {
	for (const [label, account, permission, allowed] of [
		["owner", { userId: "user-a", mailboxId: "mbx-s", address: "sales@example.test" }, "read_only", true],
		["full_access", SHARED, "full_access", true],
		["read_only", SHARED, "read_only", false],
		["send_as", SHARED, "send_as", false],
		["send_on_behalf", SHARED, "send_on_behalf", false],
	]) {
		const context = await install(app, t);
		exec(context, `UPDATE mailbox_access SET permission = '${permission}' WHERE id = 'acc-b'; INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-s', 'user-a', 'mbx-s', 'Leads', 1), ('fld-e', 'user-a', 'mbx-s', 'Empty', 1)`);
		const { client } = await connect(context, account);
		const before = state(context);
		const results = [await client.command("CREATE Created"), await client.command("RENAME Leads Renamed"), await client.command("DELETE Empty")];
		if (allowed) {
			for (const result of results) assertTagged(result, "OK", undefined, label);
			assert.deepEqual(folderNames(context, "mbx-s"), ["Created", "Renamed"], label);
		} else {
			for (const result of results) assertTagged(result, "NO", /\[NOPERM\] This access does not allow managing folders/, label);
			assert.equal(state(context), before, `${label}: nothing changed`);
			assertTagged(await client.command("SUBSCRIBE Leads"), "OK", undefined, `${label} may still subscribe`);
		}
	}
});

test("a5.5a lost access ends the session with BYE: revoked credential, removed imap scope, access, user, mailbox, sharing", async (t) => {
	const previous = process.env.BLUEPINE_DISABLED_FEATURES;
	t.after(() => {
		if (previous === undefined) delete process.env.BLUEPINE_DISABLED_FEATURES;
		else process.env.BLUEPINE_DISABLED_FEATURES = previous;
	});
	const revocations = [
		["credential revoked", (context, session) => exec(context, `DELETE FROM mail_app_passwords WHERE id = '${session.credentialId}'`)],
		["imap scope removed", (context, session) => exec(context, `UPDATE mail_app_passwords SET scopes = '["smtp"]' WHERE id = '${session.credentialId}'`)],
		["access removed", (context) => exec(context, "DELETE FROM mailbox_access WHERE id = 'acc-b'")],
		["user disabled", (context) => exec(context, "UPDATE users SET disabled = 1 WHERE id = 'user-b'")],
		["mailbox disabled", (context) => exec(context, "UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-s'")],
		["sharing disabled", () => (process.env.BLUEPINE_DISABLED_FEATURES = "sharedMailboxes")],
	];
	for (const [timing, pattern] of [["before the command", null], ["between the check and the write", /INSERT INTO folders|UPDATE folders SET name|DELETE FROM folders/]]) {
		for (const [label, revoke] of revocations) {
			// Sharing is process configuration read when the guarded statement is built, not database
			// state, so it has no window between the check and the write (as in R-1).
			if (pattern && label === "sharing disabled") continue;
			for (const command of ["CREATE Created", "RENAME Leads Renamed", "DELETE Leads", "SUBSCRIBE Leads"]) {
				if (pattern && command.startsWith("SUBSCRIBE")) continue;
				delete process.env.BLUEPINE_DISABLED_FEATURES;
				const context = await install(app, t);
				exec(context, "UPDATE mailbox_access SET permission = 'full_access' WHERE id = 'acc-b'; INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-s', 'user-a', 'mbx-s', 'Leads', 1)");
				const session = await connect(context, SHARED);
				const before = state(context);
				if (pattern) beforeBatch(context, pattern, () => revoke(context, session));
				else revoke(context, session);
				const result = await session.client.command(command);
				const name = `${command} / ${label} ${timing}`;
				assert.equal(result.tagged, null, `${name}: no tagged answer`);
				assert.deepEqual(texts(result), ["* BYE Access revoked"], name);
				assert.equal(state(context), before, `${name}: nothing changed`);
			}
		}
	}
});

test("a5.5a: full_access downgraded to read_only between the check and the write is NOPERM and writes nothing", async (t) => {
	for (const [command, pattern] of [["CREATE Created", /INSERT INTO folders/], ["RENAME Leads Renamed", /UPDATE folders SET name/], ["DELETE Leads", /DELETE FROM folders/]]) {
		const context = await install(app, t);
		exec(context, "UPDATE mailbox_access SET permission = 'full_access' WHERE id = 'acc-b'; INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-s', 'user-a', 'mbx-s', 'Leads', 1)");
		const { client } = await connect(context, SHARED);
		const before = state(context);
		beforeBatch(context, pattern, () => exec(context, "UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-b'"));
		assertTagged(await client.command(command), "NO", /\[NOPERM\]/, command);
		assert.equal(state(context), before, command);
	}
});

// ---- RENAME -----------------------------------------------------------------------------------------

test("a5.5a RENAME: unique names, same name, case-only self rename, and every refusal", async (t) => {
	const context = await setup(t);
	assertTagged(await context.client.command('CREATE "Caf&AOk-"'), "OK");
	const work = folderId(context, "Work");
	assertTagged(await context.client.command("RENAME Work Jobs"), "OK", /RENAME completed/);
	assert.equal(folderId(context, "Jobs"), work, "the same folder, renamed");
	assertTagged(await context.client.command("RENAME Jobs JOBS"), "OK", undefined, "a case-only rename of itself");
	const before = state(context);
	const refused = [
		["JOBS JOBS", /\[ALREADYEXISTS\]/, "the same name"],
		["Nowhere Else", /\[NONEXISTENT\]/],
		['JOBS "Caf&AOk-"', /\[ALREADYEXISTS\]/, "an existing folder"],
		["JOBS Trash", /\[ALREADYEXISTS\]/, "a system folder"],
		["JOBS inbox", /\[ALREADYEXISTS\]/, "INBOX"],
		["JOBS trash", /\[CANNOT\] Mailbox name is too similar/],
		['JOBS "Cafe&AwE-"', /\[CANNOT\] Mailbox name is too similar/, "NFD"],
		['JOBS "Caf&AOk- (2)"', /\[CANNOT\] Mailbox name is too similar/],
		["Sent Elsewhere", /\[CANNOT\] System mailboxes cannot be renamed/],
		["INBOX Elsewhere", /\[CANNOT\] System mailboxes cannot be renamed/],
		["inbox Elsewhere", /\[CANNOT\] System mailboxes cannot be renamed/],
		['JOBS ""', /\[CANNOT\] Invalid mailbox name/],
		['JOBS "a*"', /\[CANNOT\] Invalid mailbox name/],
		['JOBS "&AEE-"', /\[CANNOT\] Invalid mailbox name/],
	];
	for (const [argument, pattern, label] of refused) assertTagged(await context.client.command(`RENAME ${argument}`), "NO", pattern, label ?? argument);
	assert.equal(state(context), before);
});

test("a5.5a RENAME of a selected folder, by this session or another, keeps the selection, its UIDVALIDITY and UIDs", async (t) => {
	const context = await setup(t);
	await context.deliver("w-1", "Subject: w1\r\n\r\nx\r\n", { folder_id: "fld-work" });
	await context.deliver("w-2", "Subject: w2\r\n\r\nx\r\n", { folder_id: "fld-work" });
	const other = await connect(context);
	const selected = texts(await context.client.command("SELECT Work"));
	await other.client.command("SELECT Work");
	const validity = /UIDVALIDITY (\d+)/.exec(selected.join(" "))[1];
	assertTagged(await context.client.command("RENAME Work Jobs"), "OK");
	assert.deepEqual(texts(await context.client.command("UID FETCH 1:* (UID)")), ["* 1 FETCH (UID 1)", "* 2 FETCH (UID 2)"]);
	assertTagged(await context.client.command("STORE 1 +FLAGS (\\Flagged)"), "OK");
	assert.equal(texts(await context.client.command("STATUS Jobs (UIDVALIDITY UIDNEXT)"))[0], `* STATUS "Jobs" (UIDVALIDITY ${validity} UIDNEXT 3)`);
	// The other session goes on too, and can move out of the renamed folder.
	assert.deepEqual(texts(await other.client.command("NOOP")), ["* 1 FETCH (FLAGS (\\Flagged))"]);
	assertTagged(await other.client.command("UID MOVE 2 Archive"), "OK");
	assert.equal(message(context, "w-2").status, "archived");
	assertTagged(await context.client.command("RENAME Jobs Work"), "OK", undefined, "renamed back by the session that has it selected");
	assert.equal(one(context, "SELECT uid_validity FROM imap_folders WHERE folder_key = 'f:fld-work'").uid_validity, Number(validity));
});

// ---- DELETE -----------------------------------------------------------------------------------------

test("a5.5a DELETE: moves every message of the folder (snoozed ones too) to Trash and deletes it; refusals change nothing", async (t) => {
	const context = await setup(t);
	await context.deliver("w-1", "Subject: w1\r\n\r\nx\r\n", { folder_id: "fld-work" });
	await context.deliver("w-z", "Subject: wz\r\n\r\nx\r\n", { folder_id: "fld-work", snoozed_until: 1999999999 });
	await context.deliver("x-1", "Subject: x1\r\n\r\nx\r\n", { mailbox_id: "mbx-x", folder_id: "fld-x", user_id: "user-x" });
	assertTagged(await context.client.command("CREATE Empty"), "OK");
	const before = state(context);
	for (const [argument, pattern] of [["Trash", /\[CANNOT\] System mailboxes cannot be deleted/], ["INBOX", /\[CANNOT\] System mailboxes/], ["inbox", /\[CANNOT\] System mailboxes/], ["Sent", /\[CANNOT\] System mailboxes/], ["Nowhere", /\[NONEXISTENT\]/], ["Private", /\[NONEXISTENT\]/]]) {
		assertTagged(await context.client.command(`DELETE ${argument}`), "NO", pattern, argument);
	}
	assert.equal(state(context), before, "another mailbox's folder is not even visible");
	assertTagged(await context.client.command("DELETE Empty"), "OK", /DELETE completed/);
	assertTagged(await context.client.command("DELETE Work"), "OK");
	assert.deepEqual(folderNames(context), []);
	assert.deepEqual(message(context, "w-1"), { status: "trash", folder_id: null, snoozed_until: null });
	assert.deepEqual(message(context, "w-z"), { status: "trash", folder_id: null, snoozed_until: 1999999999 }, "the snoozed message too");
	assert.deepEqual(message(context, "x-1"), { status: "received", folder_id: "fld-x", snoozed_until: null }, "another mailbox is untouched");
	assert.ok(!(await listed(context.client)).includes("Work"));
	const trash = texts(await context.client.command("SELECT Trash"));
	assert.ok(trash.includes("* 2 EXISTS"), "the messages are recoverable in Trash");
	assertTagged(await context.client.command("DELETE Work"), "NO", /\[NONEXISTENT\]/);
});

test("a5.5a DELETE of the folder this session has selected is INUSE; another session's selection ends with BYE, in and outside IDLE", async (t) => {
	const context = await setup(t);
	await context.deliver("w-1", "Subject: w1\r\n\r\nx\r\n", { folder_id: "fld-work" });
	await context.client.command("SELECT Work");
	const before = state(context);
	assertTagged(await context.client.command("DELETE Work"), "NO", /^t\d+ NO \[INUSE\] The mailbox is selected in this session$/);
	assert.equal(state(context), before);
	assertTagged(await context.client.command("FETCH 1 (UID)"), "OK", undefined, "the selection is intact");
	// Outside IDLE: the other session learns at its next command.
	const plain = await connect(context);
	await plain.client.command("SELECT Work");
	// Under IDLE: at the next poll.
	const clock = createClock();
	const idler = await connect(context, undefined, { now: clock.now, delay: clock.delay }, { random: () => 0.5 });
	clock.watch(idler.session);
	await idler.client.command("SELECT Work");
	const mark = clock.registrations;
	idler.client.write("i1 IDLE\r\n");
	await clock.settle(mark);
	await context.client.command("UNSELECT");
	assertTagged(await context.client.command("DELETE Work"), "OK");
	assert.deepEqual(texts(await plain.client.command("NOOP")), ["* BYE Selected mailbox no longer exists"]);
	await clock.advance(10_000);
	const bye = [];
	for (let unit = await idler.client.unit(500).catch(() => null); unit; unit = await idler.client.unit(500).catch(() => null)) bye.push(unit.text);
	assert.ok(bye.includes("* BYE Selected mailbox no longer exists"), JSON.stringify(bye));
});

test("a5.5a: a deleted folder's IMAP state is kept; recreating the name gives a new folder and a higher UIDVALIDITY", async (t) => {
	const context = await setup(t);
	await context.client.command("SELECT Work");
	await context.client.command("UNSELECT");
	const old = one(context, "SELECT folder_key, uid_validity FROM imap_folders WHERE folder_key = 'f:fld-work'");
	assertTagged(await context.client.command("DELETE Work"), "OK");
	assertTagged(await context.client.command("CREATE Work"), "OK");
	const recreated = folderId(context, "Work");
	assert.notEqual(recreated, "fld-work");
	assert.ok(one(context, "SELECT 1 FROM imap_folders WHERE folder_key = 'f:fld-work'"), "the old state row stays, so UIDVALIDITY keeps increasing");
	const selected = texts(await context.client.command("SELECT Work")).join(" ");
	const validity = Number(/UIDVALIDITY (\d+)/.exec(selected)[1]);
	assert.ok(validity > old.uid_validity, `${validity} > ${old.uid_validity}`);
});

// ---- The A5.5.0 collision hazard ---------------------------------------------------------------------

test("a5.5a regression: a disambiguated name that shifts to another folder can never rename or delete the wrong folder", async (t) => {
	const context = await setup(t);
	exec(context, `
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES
			('fld-A', 'user-a', 'mbx-a', 'Foo', 10),
			('fld-B', 'user-a', 'mbx-a', 'foo', 20),
			('fld-C', 'user-a', 'mbx-a', 'foo (2)', 30),
			('fld-T', 'user-a', 'mbx-a', 'Trash', 40);
	`);
	await context.deliver("b-1", "Subject: b\r\n\r\nx\r\n", { folder_id: "fld-B" });
	await context.deliver("c-1", "Subject: c\r\n\r\nx\r\n", { folder_id: "fld-C" });
	const cached = await listed(context.client);
	assert.deepEqual(cached.slice(-5), ["Work", "Foo", "foo (2)", "foo (2) (2)", "Trash (2)"], "the client caches: foo (2) = B, foo (2) (2) = C");
	const before = state(context);
	for (const name of ["Foo", '"foo (2)"', '"foo (2) (2)"', '"Trash (2)"']) {
		assertTagged(await context.client.command(`RENAME ${name} Elsewhere`), "NO", /\[CANNOT\] This folder's name collides/, `RENAME ${name}`);
		assertTagged(await context.client.command(`DELETE ${name}`), "NO", /\[CANNOT\] This folder's name collides/, `DELETE ${name}`);
	}
	assert.equal(state(context), before);
	// Folder A disappears through another path; "foo (2)" silently becomes folder C's name.
	exec(context, "DELETE FROM folders WHERE id = 'fld-A'");
	const now = await listed(context.client);
	assert.deepEqual(now.slice(-4), ["Work", "foo", "foo (2)", "Trash (2)"], "foo (2) now names C, not B");
	const shifted = state(context);
	// The client still believes "foo (2)" is B: nothing it sends through that name may touch C (or B).
	assertTagged(await context.client.command('DELETE "foo (2)"'), "NO", /\[CANNOT\]/);
	assertTagged(await context.client.command('RENAME "foo (2)" Moved'), "NO", /\[CANNOT\]/);
	assert.equal(state(context), shifted, "no folder renamed or deleted, no message moved");
	assert.deepEqual([message(context, "b-1").folder_id, message(context, "c-1").folder_id], ["fld-B", "fld-C"]);
});

// ---- Strict atomic guard ----------------------------------------------------------------------------

test("a5.5a: an ASCII case variant taken between the check and the write is refused in SQL; non-ASCII variants may race and are disambiguated", async (t) => {
	const context = await setup(t);
	beforeBatch(context, /INSERT INTO folders/, () => exec(context, "INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-race', 'user-a', 'mbx-a', 'REPORT', 1)"));
	assertTagged(await context.client.command("CREATE Report"), "NO", /\[CANNOT\] Mailbox name is too similar/);
	assert.deepEqual(folderNames(context), ["REPORT", "Work"]);
	beforeBatch(context, /UPDATE folders SET name/, () => exec(context, "INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-race2', 'user-a', 'mbx-a', 'JOBS', 1)"));
	assertTagged(await context.client.command("RENAME Work Jobs"), "NO", /\[CANNOT\] Mailbox name is too similar/);
	assert.equal(folderId(context, "Work"), "fld-work", "not renamed");
	beforeBatch(context, /INSERT INTO folders/, () => exec(context, "INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-exact', 'user-a', 'mbx-a', 'Exact', 1)"));
	assertTagged(await context.client.command("CREATE Exact"), "NO", /\[ALREADYEXISTS\]/, "an exact name taken meanwhile");
	// Known limitation: SQLite's lower() folds ASCII only, so a racing non-ASCII case variant gets through; the listing disambiguates it.
	beforeBatch(context, /INSERT INTO folders/, () => exec(context, "INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-ete', 'user-a', 'mbx-a', 'ÉTÉ', 1)"));
	assertTagged(await context.client.command('CREATE "&AOk-t&AOk-"'), "OK");
	const names = await listed(context.client);
	assert.ok(names.includes("&AMk-T&AMk-") && names.includes("&AOk-t&AOk- (2)"), JSON.stringify(names));
	for (const name of ['"&AMk-T&AMk-"', '"&AOk-t&AOk- (2)"']) assertTagged(await context.client.command(`DELETE ${name}`), "NO", /\[CANNOT\]/, `the raced pair is protected: ${name}`);
});

// ---- SUBSCRIBE / UNSUBSCRIBE / LSUB -------------------------------------------------------------------

test("a5.5a SUBSCRIBE and UNSUBSCRIBE are OK for any visible mailbox (reading is enough) and never touch folders or messages", async (t) => {
	const context = await setup(t);
	const before = state(context);
	for (const name of ["INBOX", "inbox", "Trash", "Work"]) assertTagged(await context.client.command(`SUBSCRIBE ${name}`), "OK", /SUBSCRIBE completed/, name);
	// Stored since A5.5b (certified in imap-subscriptions.test.mjs).
	for (const name of ["Work", "INBOX"]) assertTagged(await context.client.command(`UNSUBSCRIBE ${name}`), "OK", /^t\d+ OK UNSUBSCRIBE completed$/, name);
	for (const command of ["SUBSCRIBE Nowhere", "UNSUBSCRIBE Nowhere", "SUBSCRIBE Private", "UNSUBSCRIBE Private"]) assertTagged(await context.client.command(command), "NO", /\[NONEXISTENT\]/, command);
	assert.equal(state(context), before);
	for (const permission of ["read_only", "full_access"]) {
		exec(context, `UPDATE mailbox_access SET permission = '${permission}' WHERE id = 'acc-b'`);
		const delegate = await connect(context, SHARED);
		assertTagged(await delegate.client.command("SUBSCRIBE INBOX"), "OK", undefined, permission);
		assertTagged(await delegate.client.command("SUBSCRIBE Work"), "NO", /\[NONEXISTENT\]/, `${permission}: another mailbox's folder`);
	}
});

test("a5.5a LSUB lists every visible mailbox until one is unsubscribed (A5.5b), with LIST's wildcards; a deleted mailbox disappears (the documented deviation)", async (t) => {
	const context = await setup(t);
	assertTagged(await context.client.command("CREATE Wanted"), "OK");
	const list = await listed(context.client, 'LIST "" "*"');
	assert.deepEqual(await listed(context.client, 'LSUB "" "*"'), list.map((name) => name.replace(/^\* LIST/, "* LSUB")));
	assert.deepEqual(await listed(context.client, 'LSUB "" "W%"'), ["Work", "Wanted"]);
	assertTagged(await context.client.command("SUBSCRIBE Wanted"), "OK");
	assertTagged(await context.client.command("DELETE Wanted"), "OK");
	assert.ok(!(await listed(context.client, 'LSUB "" "*"')).includes("Wanted"));
});

// ---- Pipelining and multi-instance --------------------------------------------------------------------

test("a5.5a: pipelined management commands and a literal split across packets", async (t) => {
	const context = await setup(t);
	context.client.write("a1 CREATE X\r\na2 RENAME X Y\r\na3 SUBSCRIBE Y\r\na4 DELETE Y\r\n");
	for (const tag of ["a1", "a2", "a3", "a4"]) assertTagged(await context.client.collect(tag), "OK", undefined, tag);
	context.client.write("s1 CREATE {5}\r\n");
	assert.match((await context.client.unit()).text, /^\+ /);
	context.client.write("Sp");
	context.client.write("lit\r\n");
	assertTagged(await context.client.collect("s1"), "OK");
	assert.deepEqual(folderNames(context), ["Split", "Work"]);
});

test("a5.5a multi-instance: folders created, renamed and deleted through another database connection are seen at the next LIST and command", async (t) => {
	const context = await setup(t);
	const elsewhere = new app.SqliteDatabase(join(context.directory, "mailflare.sqlite"));
	try {
		elsewhere.db.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-far', 'user-a', 'mbx-a', 'Far', 1)").run();
		assert.ok((await listed(context.client)).includes("Far"));
		assertTagged(await context.client.command("CREATE far"), "NO", /\[CANNOT\]/, "collisions are judged on current database state");
		elsewhere.db.prepare("UPDATE folders SET name = 'Farther' WHERE id = 'fld-far'").run();
		assertTagged(await context.client.command("RENAME Far X"), "NO", /\[NONEXISTENT\]/);
		assertTagged(await context.client.command("RENAME Farther Nearer"), "OK");
		elsewhere.db.prepare("DELETE FROM folders WHERE id = 'fld-far'").run();
		assertTagged(await context.client.command("DELETE Nearer"), "NO", /\[NONEXISTENT\]/);
	} finally {
		elsewhere.db.close();
	}
});

// ---- Real TLS listener ---------------------------------------------------------------------------------

test("a5.5a listener: CREATE with a literal, RENAME, SUBSCRIBE/UNSUBSCRIBE and DELETE over TLS", async (t) => {
	const context = await install(app, t);
	await context.deliver("w-1", "Subject: w1\r\n\r\nx\r\n", { folder_id: "fld-work" });
	const certificate = makeCertificate(t);
	const config = { port: 0, host: "127.0.0.1", certPath: certificate.certPath, keyPath: certificate.keyPath };
	const listener = await app.startImapListener(context.env, config, app.loadTlsMaterial(config), { limits: { accessCheckIntervalMs: 60_000 }, log: () => {} });
	t.after(() => listener.close());
	const { credential } = await context.credential("user-a", "mbx-a");
	const client = await tlsClient(listener.port);
	await client.unit();
	assertTagged(await client.login("a@example.test", credential), "OK");
	client.write("c1 CREATE {9}\r\n");
	assert.match((await client.unit(2000)).text, /^\+ /);
	client.write("Caf&AOk-!\r\n");
	assertTagged(await client.collect("c1", 2000), "OK");
	assertTagged(await client.command('RENAME "Caf&AOk-!" "Caf&AOk- 2"'), "OK");
	assertTagged(await client.command('SUBSCRIBE "Caf&AOk- 2"'), "OK");
	assertTagged(await client.command('UNSUBSCRIBE "Caf&AOk- 2"'), "OK", undefined, "stored since A5.5b");
	assertTagged(await client.command("DELETE Work"), "OK");
	assertTagged(await client.command('CREATE "work"'), "OK", undefined, "the deleted name is free again");
	assert.deepEqual(folderNames(context), ["Café 2", "work"]);
	assert.equal(message(context, "w-1").status, "trash");
	client.close();
});

// ---- The strict policy itself --------------------------------------------------------------------------

test("a5.5a naming policy: verdicts and collision groups", () => {
	const { imapFolderNameVerdict, ambiguousFolderIds } = app.imapUtils;
	const folders = [{ name: "Work" }, { name: "Café" }];
	assert.equal(imapFolderNameVerdict("Jobs", folders), "ok");
	assert.equal(imapFolderNameVerdict("Work", folders), "exists");
	assert.equal(imapFolderNameVerdict("WORK", folders), "collides");
	assert.equal(imapFolderNameVerdict("Café", folders), "collides");
	assert.equal(imapFolderNameVerdict("Sent", folders), "exists");
	assert.equal(imapFolderNameVerdict("sent", folders), "collides");
	assert.equal(imapFolderNameVerdict("iNbOx", folders), "exists");
	assert.equal(imapFolderNameVerdict("Spam (4)", folders), "collides");
	assert.equal(imapFolderNameVerdict("Solo (4)", folders), "ok");
	assert.equal(imapFolderNameVerdict("a%", folders), "invalid");
	assert.equal(imapFolderNameVerdict(" x", folders), "invalid");
	assert.deepEqual(
		[...ambiguousFolderIds([
			{ id: "a", name: "Foo" }, { id: "b", name: "foo" }, { id: "c", name: "foo (2)" }, { id: "t", name: "Trash" },
			{ id: "n", name: "Café" }, { id: "m", name: "Café" }, { id: "s", name: "Solo" }, { id: "p", name: "Solo (2) extra" }, { id: "q", name: "Lonely (2)" },
		])].sort(),
		["a", "b", "c", "m", "n", "t"],
	);
});
