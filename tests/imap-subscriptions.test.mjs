import assert from "node:assert/strict";
import test from "node:test";
import { assertTagged, install, loadApp, makeCertificate, memoryClient, tlsClient } from "./support/imap-harness.mjs";

/**
 * A5.5b: stored IMAP subscriptions, over the real A2 verifier and A3 state (SQLite, no Workers)
 * and the real Node TLS listener.
 *
 * - State is the user's, per mailbox account (user, mailbox), in `imap_unsubscribed_folders`
 *   (bp0005): every visible mailbox is subscribed unless the user unsubscribed it, so databases
 *   from before A5.5b, and folders created on any surface, stay subscribed.
 * - SUBSCRIBE and UNSUBSCRIBE are stored, idempotent, keyed by the folder's stable identity (a
 *   rename keeps the state, a deleted folder's state goes with it); LSUB reflects them on every
 *   later connection; LIST and SPECIAL-USE are unaffected.
 * - Reading the mailbox is the authority needed (a preference no one else sees); a name outside
 *   the principal's mailbox is NONEXISTENT and records nothing; lost access ends the session.
 */
const { app, cleanup } = await loadApp("imap-subscriptions");
test.after(cleanup);

const SHARED = { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" };
const OWNER_SHARED = { userId: "user-a", mailboxId: "mbx-s", address: "sales@example.test" };
const texts = (result) => result.untagged.map((unit) => unit.text);
const exec = (context, query) => context.database.db.exec(query);
const all = (context, query, ...params) => context.database.db.prepare(query).all(...params);
const rows = (context) => all(context, "SELECT user_id, mailbox_id, folder_key FROM imap_unsubscribed_folders ORDER BY user_id, mailbox_id, folder_key");
const SYSTEM = ["INBOX", "Drafts", "Sent", "Archive", "Spam", "Trash"];

async function connect(context, { userId = "user-a", mailboxId = "mbx-a", address = "a@example.test" } = {}) {
	const { client, session, start } = memoryClient(app, context.env);
	await start();
	const { credential, id } = await context.credential(userId, mailboxId);
	assertTagged(await client.login(address, credential), "OK");
	return { client, session, credentialId: id };
}

/** The names a LIST or LSUB reports (wire form), in order. */
async function names(client, command = 'LSUB "" "*"') {
	const result = await client.command(command);
	assertTagged(result, "OK", undefined, command);
	return texts(result).map((line) => /"([^"]*)"$/.exec(line)?.[1] ?? /\) NIL (\S+)$/.exec(line)?.[1] ?? line);
}

async function setup(t) {
	const context = await install(app, t);
	// user-x is a full_access delegate of the shared mailbox; user-b stays read_only.
	exec(context, "INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('acc-x', 'mbx-s', 'user-x', 'full_access', 1)");
	return context;
}

// ---- Upgrade / default state -----------------------------------------------------------------------

test("a5.5b default: with no stored state every visible mailbox is subscribed, as before A5.5b, and LIST is unchanged", async (t) => {
	const context = await setup(t);
	exec(context, "INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-t2', 'user-a', 'mbx-a', 'Trash', 2)");
	const { client } = await connect(context);
	assert.deepEqual(rows(context), [], "a database from before A5.5b has no rows");
	const listed = await names(client, 'LIST "" "*"');
	assert.deepEqual(listed, [...SYSTEM, "Work", "Trash (2)"]);
	assert.deepEqual(await names(client), listed, "LSUB lists every visible mailbox");
	const list = texts(await client.command('LIST "" "*"'));
	assert.ok(list.includes('* LIST (\\Noinferiors \\Archive) NIL "Archive"') && list.includes('* LIST (\\Noinferiors \\Junk) NIL "Spam"'), "SPECIAL-USE attributes on LIST");
	assert.ok(texts(await client.command('LSUB "" "*"')).every((line) => /^\* LSUB \(\\Noinferiors\) NIL /.test(line)), "LSUB carries no special-use attributes, as before");
});

// ---- SUBSCRIBE / UNSUBSCRIBE / LSUB ---------------------------------------------------------------

test("a5.5b UNSUBSCRIBE and SUBSCRIBE are stored and LSUB reflects them; both are idempotent; LIST and SELECT are unaffected", async (t) => {
	const context = await setup(t);
	const { client } = await connect(context);
	const listBefore = texts(await client.command('LIST "" "*"'));
	assertTagged(await client.command("UNSUBSCRIBE Archive"), "OK", /^t\d+ OK UNSUBSCRIBE completed$/);
	assertTagged(await client.command("UNSUBSCRIBE Archive"), "OK", undefined, "repeating it is harmless");
	assertTagged(await client.command("UNSUBSCRIBE Work"), "OK");
	assertTagged(await client.command("UNSUBSCRIBE inbox"), "OK", undefined, "INBOX in any case");
	assert.deepEqual(rows(context), [
		{ user_id: "user-a", mailbox_id: "mbx-a", folder_key: "archive" },
		{ user_id: "user-a", mailbox_id: "mbx-a", folder_key: "f:fld-work" },
		{ user_id: "user-a", mailbox_id: "mbx-a", folder_key: "inbox" },
	], "one row per folder, by stable key");
	assert.deepEqual(await names(client), ["Drafts", "Sent", "Spam", "Trash"]);
	assert.deepEqual(await names(client, 'LSUB "" "S%"'), ["Sent", "Spam"], "LIST's wildcards still apply");
	assert.deepEqual(texts(await client.command('LIST "" "*"')), listBefore, "LIST and its SPECIAL-USE attributes are untouched");
	assertTagged(await client.command("SELECT Archive"), "OK", undefined, "an unsubscribed mailbox is still selectable");
	assertTagged(await client.command("SUBSCRIBE Archive"), "OK", /^t\d+ OK SUBSCRIBE completed$/);
	assertTagged(await client.command("SUBSCRIBE Archive"), "OK", undefined, "repeating it is harmless");
	assertTagged(await client.command("SUBSCRIBE Drafts"), "OK", undefined, "subscribing a subscribed mailbox is harmless");
	assert.deepEqual(await names(client), ["Drafts", "Sent", "Archive", "Spam", "Trash"]);
	assert.equal(rows(context).length, 2);
});

test("a5.5b the Thunderbird case: Archive unsubscribed and resubscribed, each seen by a new connection (and a new app password)", async (t) => {
	const context = await setup(t);
	const first = await connect(context);
	assert.ok((await names(first.client)).includes("Archive"), "Archive starts subscribed");
	assertTagged(await first.client.command("UNSUBSCRIBE Archive"), "OK");
	assertTagged(await first.client.command("LOGOUT"), "OK");
	const second = await connect(context);
	assert.ok(!(await names(second.client)).includes("Archive"), "still unsubscribed after reconnecting with another credential");
	assertTagged(await second.client.command("SUBSCRIBE Archive"), "OK");
	const third = await connect(context);
	assert.ok((await names(third.client)).includes("Archive"), "subscribed again after reconnecting");
	assert.deepEqual(rows(context), []);
});

// ---- Isolation and authorization -----------------------------------------------------------------

test("a5.5b state is per user and per mailbox account: owner, delegates and the owner's other mailbox are independent", async (t) => {
	const context = await setup(t);
	const ownerPersonal = await connect(context);
	const ownerShared = await connect(context, OWNER_SHARED);
	const readOnly = await connect(context, SHARED);
	const fullAccess = await connect(context, { userId: "user-x", mailboxId: "mbx-s", address: "sales@example.test" });
	assertTagged(await ownerPersonal.client.command("UNSUBSCRIBE Archive"), "OK");
	assertTagged(await readOnly.client.command("UNSUBSCRIBE Trash"), "OK", undefined, "read-only access may keep its own preferences");
	assertTagged(await fullAccess.client.command("UNSUBSCRIBE Spam"), "OK");
	assert.deepEqual(await names(ownerPersonal.client), ["INBOX", "Drafts", "Sent", "Spam", "Trash", "Work"]);
	assert.deepEqual(await names(ownerShared.client), SYSTEM, "the owner's view of the shared mailbox is its own");
	assert.deepEqual(await names(readOnly.client), ["INBOX", "Drafts", "Sent", "Archive", "Spam"]);
	assert.deepEqual(await names(fullAccess.client), ["INBOX", "Drafts", "Sent", "Archive", "Trash"]);
	assert.deepEqual(rows(context), [
		{ user_id: "user-a", mailbox_id: "mbx-a", folder_key: "archive" },
		{ user_id: "user-b", mailbox_id: "mbx-s", folder_key: "trash" },
		{ user_id: "user-x", mailbox_id: "mbx-s", folder_key: "junk" },
	]);
});

test("a5.5b names outside the principal's mailbox, nonexistent names and bad syntax record nothing", async (t) => {
	const context = await setup(t);
	const { client } = await connect(context, SHARED);
	// `Work` is mbx-a's folder and `Private` user-x's: neither is visible to this account.
	for (const command of ["UNSUBSCRIBE Work", "SUBSCRIBE Work", "UNSUBSCRIBE Private", "UNSUBSCRIBE Nowhere", "UNSUBSCRIBE archive", 'UNSUBSCRIBE "Trash (2)"']) {
		assertTagged(await client.command(command), "NO", /^\S+ NO \[NONEXISTENT\] No such mailbox$/, command);
	}
	for (const command of ["UNSUBSCRIBE", "UNSUBSCRIBE a b", "SUBSCRIBE"]) assertTagged(await client.command(command), "BAD", undefined, command);
	assert.deepEqual(rows(context), []);
	const { client: anonymous, start } = memoryClient(app, context.env);
	await start();
	assertTagged(await anonymous.command("UNSUBSCRIBE INBOX"), "BAD", /not valid in this state/);
	assertTagged(await anonymous.command("LSUB \"\" \"*\""), "BAD", /not valid in this state/);
	assert.deepEqual(rows(context), []);
});

const LOSSES = [
	["credential revoked", (context, session) => exec(context, `DELETE FROM mail_app_passwords WHERE id = '${session.credentialId}'`)],
	["imap scope removed", (context, session) => exec(context, `UPDATE mail_app_passwords SET scopes = '["smtp"]' WHERE id = '${session.credentialId}'`)],
	["access removed", (context) => exec(context, "DELETE FROM mailbox_access WHERE id = 'acc-b'")],
	["user disabled", (context) => exec(context, "UPDATE users SET disabled = 1 WHERE id = 'user-b'")],
	["mailbox disabled", (context) => exec(context, "UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-s'")],
	["sharing disabled", () => (process.env.BLUEPINE_DISABLED_FEATURES = "sharedMailboxes")],
];

/** Run `hook` right before the next D1 batch whose SQL matches `pattern` (the guarded write itself). */
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

test("a5.5b lost access ends the session and records nothing, before the command and between its check and its write", async (t) => {
	const previous = process.env.BLUEPINE_DISABLED_FEATURES;
	t.after(() => {
		if (previous === undefined) delete process.env.BLUEPINE_DISABLED_FEATURES;
		else process.env.BLUEPINE_DISABLED_FEATURES = previous;
	});
	for (const timing of ["before the command", "between the check and the write"]) {
		for (const [label, revoke] of LOSSES) {
			// Sharing is process configuration read when the guarded statement is built, so it has
			// no window between the check and the write (as in R-1 and A5.5a).
			if (timing !== "before the command" && label === "sharing disabled") continue;
			for (const command of ["UNSUBSCRIBE Archive", "LSUB \"\" \"*\""]) {
				if (timing !== "before the command" && command.startsWith("LSUB")) continue;
				delete process.env.BLUEPINE_DISABLED_FEATURES;
				const context = await setup(t);
				const session = await connect(context, SHARED);
				if (timing === "before the command") revoke(context, session);
				else beforeBatch(context, /INSERT OR IGNORE INTO imap_unsubscribed_folders/, async () => revoke(context, session));
				const result = await session.client.command(command);
				assert.equal(texts(result).at(-1), "* BYE Access revoked", `${label}, ${timing}: ${command}`);
				assert.equal(result.tagged, null);
				assert.deepEqual(rows(context), [], `${label}, ${timing}: nothing recorded`);
			}
		}
	}
});

// ---- CREATE / RENAME / DELETE ----------------------------------------------------------------------

test("a5.5b CREATE: new folders are subscribed, whichever surface creates them", async (t) => {
	const context = await setup(t);
	const { client } = await connect(context);
	assertTagged(await client.command("UNSUBSCRIBE Work"), "OK");
	assertTagged(await client.command("CREATE Projects"), "OK");
	exec(context, "INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-web', 'user-a', 'mbx-a', 'From the web', 9)");
	assert.deepEqual((await names(client)).sort(), [...SYSTEM, "Projects", "From the web"].sort(), "both new folders are subscribed; Work stays unsubscribed");
	assertTagged(await client.command("SUBSCRIBE Projects"), "OK", undefined, "what Thunderbird sends after CREATE");
	assert.deepEqual(rows(context).map((row) => row.folder_key), ["f:fld-work"]);
});

test("a5.5b RENAME keeps a folder's state (it is the same folder); the old name is gone", async (t) => {
	const context = await setup(t);
	const { client } = await connect(context);
	assertTagged(await client.command("UNSUBSCRIBE Work"), "OK");
	assertTagged(await client.command("RENAME Work Jobs"), "OK");
	assert.ok(!(await names(client)).includes("Jobs"), "the renamed folder is still unsubscribed");
	assert.ok((await names(client, 'LIST "" "*"')).includes("Jobs"));
	assertTagged(await client.command("UNSUBSCRIBE Work"), "NO", /\[NONEXISTENT\]/, "the old name names nothing");
	// Thunderbird's sequence around a rename of a subscribed folder: UNSUBSCRIBE old, RENAME, SUBSCRIBE new.
	assertTagged(await client.command("SUBSCRIBE Jobs"), "OK");
	assertTagged(await client.command("UNSUBSCRIBE Jobs"), "OK");
	assertTagged(await client.command("RENAME Jobs Tasks"), "OK");
	assertTagged(await client.command("SUBSCRIBE Tasks"), "OK");
	assert.ok((await names(client)).includes("Tasks"));
	assert.deepEqual(rows(context), []);
});

test("a5.5b DELETE removes every user's state for the folder; a new folder of the same name starts subscribed", async (t) => {
	const context = await setup(t);
	exec(context, "INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-s', 'user-a', 'mbx-s', 'Leads', 1), ('fld-s2', 'user-a', 'mbx-s', 'Gone', 1)");
	const owner = await connect(context, OWNER_SHARED);
	const delegate = await connect(context, SHARED);
	assertTagged(await owner.client.command("UNSUBSCRIBE Leads"), "OK");
	assertTagged(await delegate.client.command("UNSUBSCRIBE Leads"), "OK");
	assertTagged(await delegate.client.command("UNSUBSCRIBE Gone"), "OK");
	assert.equal(rows(context).length, 3);
	assertTagged(await owner.client.command("DELETE Leads"), "OK");
	// A folder deleted on another surface (the web app) is cleaned up at the next listing too.
	exec(context, "DELETE FROM folders WHERE id = 'fld-s2'");
	assert.deepEqual(await names(delegate.client), SYSTEM);
	assert.deepEqual(rows(context), [], "no state is left for folders that no longer exist");
	assertTagged(await owner.client.command("CREATE Leads"), "OK");
	assert.ok((await names(owner.client)).includes("Leads"), "the new folder does not inherit the old one's state");
	assert.ok((await names(delegate.client)).includes("Leads"));
});

test("a5.5b deleting the mailbox or the user removes their subscription state", async (t) => {
	const context = await setup(t);
	const owner = await connect(context);
	const delegate = await connect(context, SHARED);
	assertTagged(await owner.client.command("UNSUBSCRIBE Archive"), "OK");
	assertTagged(await delegate.client.command("UNSUBSCRIBE Archive"), "OK");
	exec(context, "DELETE FROM users WHERE id = 'user-b'");
	assert.deepEqual(rows(context).map((row) => row.user_id), ["user-a"]);
	exec(context, "DELETE FROM mailbox_access; DELETE FROM folders WHERE mailbox_id = 'mbx-a'; DELETE FROM messages WHERE mailbox_id = 'mbx-a'; DELETE FROM mail_app_passwords WHERE mailbox_id = 'mbx-a'; DELETE FROM mailboxes WHERE id = 'mbx-a'");
	assert.deepEqual(rows(context), []);
});

test("a5.5b concurrent SUBSCRIBE and UNSUBSCRIBE from two sessions of the same user settle on the last one", async (t) => {
	const context = await setup(t);
	const a = await connect(context);
	const b = await connect(context);
	await Promise.all([a.client.command("UNSUBSCRIBE Archive"), b.client.command("UNSUBSCRIBE Archive")]);
	assert.equal(rows(context).length, 1, "one row however many sessions unsubscribe at once");
	assertTagged(await b.client.command("SUBSCRIBE Archive"), "OK");
	assert.ok((await names(a.client)).includes("Archive"), "the other session sees it at its next LSUB");
	assert.deepEqual(rows(context), []);
});

// ---- Real Node TLS listener -------------------------------------------------------------------------

test("a5.5b TLS: the Thunderbird acceptance case over the real listener, across disconnects", async (t) => {
	const context = await setup(t);
	const certificate = makeCertificate(t);
	const config = { port: 0, host: "127.0.0.1", certPath: certificate.certPath, keyPath: certificate.keyPath };
	const listener = await app.startImapListener(context.env, config, app.loadTlsMaterial(config), { limits: { accessCheckIntervalMs: 60_000 }, log: () => {} });
	t.after(() => listener.close());
	const { credential } = await context.credential("user-a", "mbx-a");
	const open = async () => {
		const client = await tlsClient(listener.port);
		await client.unit();
		assertTagged(await client.login("a@example.test", credential), "OK");
		return client;
	};
	let client = await open();
	assert.deepEqual(await names(client), [...SYSTEM, "Work"], "Archive initially subscribed");
	assertTagged(await client.command("UNSUBSCRIBE Archive"), "OK");
	client.close();
	client = await open();
	assert.ok(!(await names(client)).includes("Archive"), "still unchecked after reconnecting");
	assert.ok((await names(client, 'LIST "" "*"')).includes("Archive"), "and still listed by LIST");
	assertTagged(await client.command("SUBSCRIBE Archive"), "OK");
	client.close();
	client = await open();
	assert.ok((await names(client)).includes("Archive"), "checked again after reconnecting");
	assertTagged(await client.command("LOGOUT"), "OK");
});
