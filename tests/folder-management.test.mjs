import assert from "node:assert/strict";
import test from "node:test";
import { install, loadApp } from "./support/imap-harness.mjs";

/**
 * R-1: secure mailbox folder management, over the real JMAP handler and the shared
 * folder-management service (SQLite, no Workers).
 *
 * - Only the mailbox owner, or a full_access delegate while sharing is enabled, may create,
 *   rename or delete folders; send_as, send_on_behalf and read_only may not.
 * - Authority is re-checked inside the database write, so a change between the check and the
 *   write changes nothing.
 * - Every statement is scoped to the authoritative mailbox and a folder verified to belong to
 *   it: a folder id from another mailbox is notFound and reveals nothing.
 * - Deleting a folder requires it to be empty in the deleting statement itself, snoozed
 *   messages included; onDestroyRemoveEmails moves only that mailbox's messages in it.
 */
const { app, cleanup } = await loadApp("folder-management");
test.after(cleanup);

const BASE = "http://mailflare.local";
const exec = (context, query) => context.database.db.exec(query);
const all = (context, query, ...params) => context.database.db.prepare(query).all(...params);
const folder = (context, id) => all(context, "SELECT id, mailbox_id, name FROM folders WHERE id = ?", id)[0] ?? null;
const message = (context, id) => all(context, "SELECT id, mailbox_id, status, folder_id, snoozed_until FROM messages WHERE id = ?", id)[0] ?? null;
/** Every row a folder operation could touch. */
const state = (context) =>
	JSON.stringify([
		all(context, "SELECT id, mailbox_id, user_id, name FROM folders ORDER BY id"),
		all(context, "SELECT id, mailbox_id, status, folder_id, snoozed_until FROM messages ORDER BY id"),
	]);

let keyCounter = 0;
/** One JMAP request as `userId` (an API key with the jmap scope, optionally limited to mailboxes). */
async function jmap(context, userId, calls, { mailboxScope = null } = {}) {
	const { fullKey, prefix, hash } = app.generateApiKey();
	const keyId = `key-${++keyCounter}`;
	context.database.db
		.prepare("INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at) VALUES (?, 'legacy', ?, 'jmap', ?, ?, ?, ?, 1)")
		.run(keyId, userId, prefix, hash, JSON.stringify(["jmap"]), mailboxScope ? 1 : 0);
	for (const mailboxId of mailboxScope ?? []) context.database.db.prepare("INSERT INTO mcp_key_mailboxes (key_id, mailbox_id) VALUES (?, ?)").run(keyId, mailboxId);
	const body = { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: calls };
	const response = await app.handleJmapRequest(new Request(`${BASE}/jmap/api`, { method: "POST", headers: { Authorization: `Bearer ${fullKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), context.env);
	return { status: response.status, body: await response.json() };
}

/** Mailbox/set as `userId`; returns the method's response arguments. */
async function mailboxSet(context, userId, args, options) {
	const { status, body } = await jmap(context, userId, [["Mailbox/set", { accountId: userId, ...args }, "0"]], options);
	assert.equal(status, 200, JSON.stringify(body));
	const [name, result] = body.methodResponses[0];
	assert.equal(name, "Mailbox/set", `a method-level error instead of Mailbox/set: ${JSON.stringify(body.methodResponses[0])}`);
	return result;
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
	return () => (database.batch = original);
}

/**
 * The harness world plus: mailbox mbx-b owned by user-b (so user-b can present its own mailbox
 * prefix), folder fld-s of the shared mailbox mbx-s (owner user-a) with two messages, and
 * fld-work of user-a's personal mailbox with one. user-b's access to mbx-s is `permission`.
 */
async function setup(t, permission = "read_only") {
	const context = await install(app, t);
	exec(context, `
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mbx-b', 'user-b', 'domain-1', 'b', 'personal', 1);
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-s', 'user-a', 'mbx-s', 'Leads', 1);
		UPDATE mailbox_access SET permission = '${permission}' WHERE id = 'acc-b';
	`);
	await context.deliver("s-1", "Subject: s1\r\n\r\nx\r\n", { mailbox_id: "mbx-s", folder_id: "fld-s" });
	await context.deliver("s-2", "Subject: s2\r\n\r\nx\r\n", { mailbox_id: "mbx-s", folder_id: "fld-s" });
	await context.deliver("w-1", "Subject: w1\r\n\r\nx\r\n", { folder_id: "fld-work" });
	return context;
}

const NOT_VISIBLE_CREATE = { type: "invalidProperties", properties: ["parentId"], description: "Folders live directly under a mailbox" };
const FORBIDDEN = { type: "forbidden", description: "This access does not allow managing folders" };

// ---- Authorization matrix ---------------------------------------------------------------------------

test("r-1: create, rename and destroy are allowed to the owner and a full_access delegate only", async (t) => {
	const previous = process.env.BLUEPINE_DISABLED_FEATURES;
	t.after(() => {
		if (previous === undefined) delete process.env.BLUEPINE_DISABLED_FEATURES;
		else process.env.BLUEPINE_DISABLED_FEATURES = previous;
	});
	const cases = [
		// [label, actor, delegate permission, prepare, expected: "allow" | "forbidden" | "hidden"]
		["owner", "user-a", "read_only", () => {}, "allow"],
		["full_access delegate", "user-b", "full_access", () => {}, "allow"],
		["send_as delegate", "user-b", "send_as", () => {}, "forbidden"],
		["send_on_behalf delegate", "user-b", "send_on_behalf", () => {}, "forbidden"],
		["read_only delegate", "user-b", "read_only", () => {}, "forbidden"],
		["no access", "user-x", "read_only", () => {}, "hidden"],
		["revoked access", "user-b", "full_access", (context) => exec(context, "DELETE FROM mailbox_access WHERE id = 'acc-b'"), "hidden"],
		["disabled mailbox (owner)", "user-a", "read_only", (context) => exec(context, "UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-s'"), "hidden"],
		["disabled mailbox (full_access)", "user-b", "full_access", (context) => exec(context, "UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-s'"), "hidden"],
		["sharing disabled (full_access delegate)", "user-b", "full_access", () => (process.env.BLUEPINE_DISABLED_FEATURES = "sharedMailboxes"), "hidden"],
		["sharing disabled (owner of a shared mailbox)", "user-a", "read_only", () => (process.env.BLUEPINE_DISABLED_FEATURES = "sharedMailboxes"), "allow"],
	];
	for (const [label, actor, permission, prepare, expected] of cases) {
		delete process.env.BLUEPINE_DISABLED_FEATURES;
		const context = await setup(t, permission);
		exec(context, "INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-empty', 'user-a', 'mbx-s', 'Empty', 1)");
		prepare(context);
		const before = state(context);
		const created = await mailboxSet(context, actor, { create: { c: { parentId: "mbx-s", name: "Created" } } });
		const renamed = await mailboxSet(context, actor, { update: { "mbx-s~f~fld-s": { name: "Renamed" } } });
		const destroyed = await mailboxSet(context, actor, { destroy: ["mbx-s~f~fld-empty"] });
		if (expected === "allow") {
			assert.ok(created.created.c, `${label}: create`);
			assert.deepEqual(renamed.updated, { "mbx-s~f~fld-s": null }, `${label}: rename`);
			assert.equal(folder(context, "fld-s").name, "Renamed", label);
			assert.deepEqual(destroyed.destroyed, ["mbx-s~f~fld-empty"], `${label}: destroy`);
			assert.equal(folder(context, "fld-empty"), null, label);
		} else {
			const refusal = expected === "forbidden" ? FORBIDDEN : { type: "notFound" };
			assert.deepEqual(created.notCreated.c, expected === "forbidden" ? FORBIDDEN : NOT_VISIBLE_CREATE, `${label}: create`);
			assert.deepEqual(renamed.notUpdated["mbx-s~f~fld-s"], refusal, `${label}: rename`);
			assert.deepEqual(destroyed.notDestroyed["mbx-s~f~fld-empty"], refusal, `${label}: destroy`);
			assert.deepEqual(renamed.updated, {}, `${label}: never reported as updated`);
			assert.deepEqual(destroyed.destroyed, [], `${label}: never reported as destroyed`);
			assert.equal(folder(context, "fld-s").name, "Leads", `${label}: not renamed`);
			assert.ok(folder(context, "fld-empty"), `${label}: not deleted`);
			assert.equal(state(context), before, `${label}: nothing changed`);
		}
	}
});

test("r-1: a disabled user is refused before anything, and a key limited to other mailboxes cannot see this one", async (t) => {
	const context = await setup(t, "full_access");
	exec(context, "UPDATE users SET disabled = 1 WHERE id = 'user-b'");
	const refused = await jmap(context, "user-b", [["Mailbox/set", { accountId: "user-b", update: { "mbx-s~f~fld-s": { name: "X" } } }, "0"]]);
	assert.equal(refused.status, 401);
	assert.equal((await app.folderManagement.renameFolder(app.getDb(context.env), { userId: "user-b" }, "mbx-s", "fld-s", "X")).outcome, "notFound", "the service refuses a disabled user too");
	const scoped = await mailboxSet(context, "user-a", { update: { "mbx-s~f~fld-s": { name: "X" } }, destroy: ["mbx-s~f~fld-s"] }, { mailboxScope: ["mbx-a"] });
	assert.deepEqual(scoped.notUpdated["mbx-s~f~fld-s"], { type: "notFound" });
	assert.deepEqual(scoped.notDestroyed["mbx-s~f~fld-s"], { type: "notFound" });
	assert.equal(folder(context, "fld-s").name, "Leads");
});

// ---- Cross-mailbox --------------------------------------------------------------------------------

test("r-1 cross-mailbox: a foreign folder id under the caller's own mailbox changes nothing and reveals nothing", async (t) => {
	const context = await setup(t, "read_only");
	const before = state(context);
	// A: a read_only delegate of mbx-s presents its own mailbox with the shared folder's id.
	const a = await mailboxSet(context, "user-b", { destroy: ["mbx-b~f~fld-s"], onDestroyRemoveEmails: true });
	assert.deepEqual(a, { ...a, destroyed: [], notDestroyed: { "mbx-b~f~fld-s": { type: "notFound" } } });
	// B: a user with no relation at all, with user-a's folder id.
	const b = await mailboxSet(context, "user-x", { destroy: ["mbx-x~f~fld-work"], onDestroyRemoveEmails: true });
	assert.deepEqual(b.notDestroyed, { "mbx-x~f~fld-work": { type: "notFound" } });
	// C: without onDestroyRemoveEmails there is no mailboxHasEmail oracle: a non-empty and a missing foreign folder answer alike.
	const c = await mailboxSet(context, "user-x", { destroy: ["mbx-x~f~fld-work", "mbx-x~f~fld-nope"] });
	assert.deepEqual(c.notDestroyed, { "mbx-x~f~fld-work": { type: "notFound" }, "mbx-x~f~fld-nope": { type: "notFound" } });
	// D: rename of a foreign folder.
	const d = await mailboxSet(context, "user-x", { update: { "mbx-x~f~fld-work": { name: "Stolen" }, "mbx-x~f~fld-nope": { name: "Ghost" } } });
	assert.deepEqual(d.updated, {});
	assert.deepEqual(d.notUpdated, { "mbx-x~f~fld-work": { type: "notFound" }, "mbx-x~f~fld-nope": { type: "notFound" } });
	assert.equal(state(context), before, "no folder renamed or deleted, no message moved, in any mailbox");
	assert.deepEqual([message(context, "s-1").status, message(context, "s-2").status, message(context, "w-1").status], ["received", "received", "received"]);
});

test("r-1 cross-mailbox: a folder id kept after access was revoked cannot be used afterwards", async (t) => {
	const context = await setup(t, "full_access");
	assert.deepEqual((await mailboxSet(context, "user-b", { update: { "mbx-s~f~fld-s": { name: "While allowed" } } })).updated, { "mbx-s~f~fld-s": null });
	exec(context, "DELETE FROM mailbox_access WHERE id = 'acc-b'");
	const before = state(context);
	for (const prefix of ["mbx-s", "mbx-b"]) {
		const result = await mailboxSet(context, "user-b", { update: { [`${prefix}~f~fld-s`]: { name: "After revocation" } }, destroy: [`${prefix}~f~fld-s`], onDestroyRemoveEmails: true });
		assert.deepEqual(result.updated, {}, prefix);
		assert.deepEqual(result.destroyed, [], prefix);
		assert.deepEqual(result.notDestroyed[`${prefix}~f~fld-s`], { type: "notFound" }, prefix);
	}
	assert.equal(state(context), before);
});

test("r-1 cross-mailbox: onDestroyRemoveEmails moves exactly the mailbox's messages in the verified folder to Trash", async (t) => {
	const context = await setup(t, "read_only");
	exec(context, "INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-keep', 'user-a', 'mbx-s', 'Keep', 1)");
	await context.deliver("s-keep", "Subject: k\r\n\r\nx\r\n", { mailbox_id: "mbx-s", folder_id: "fld-keep" });
	await context.deliver("s-snoozed", "Subject: z\r\n\r\nx\r\n", { mailbox_id: "mbx-s", folder_id: "fld-s", snoozed_until: 1999999999 });
	const result = await mailboxSet(context, "user-a", { destroy: ["mbx-s~f~fld-s"], onDestroyRemoveEmails: true });
	assert.deepEqual(result.destroyed, ["mbx-s~f~fld-s"]);
	assert.equal(folder(context, "fld-s"), null);
	for (const id of ["s-1", "s-2", "s-snoozed"]) assert.deepEqual([message(context, id).status, message(context, id).folder_id], ["trash", null], id);
	assert.deepEqual([message(context, "s-keep").status, message(context, "s-keep").folder_id], ["received", "fld-keep"], "another folder of the same mailbox is untouched");
	assert.deepEqual([message(context, "w-1").status, message(context, "w-1").folder_id], ["received", "fld-work"], "another mailbox is untouched");
});

test("r-1 cross-mailbox: a message of another mailbox still referencing the folder blocks the whole removal", async (t) => {
	const context = await setup(t, "read_only");
	// Data drift: a message of mbx-a filed in mbx-s's folder.
	await context.deliver("drift", "Subject: d\r\n\r\nx\r\n", { folder_id: "fld-s" });
	const before = state(context);
	const result = await mailboxSet(context, "user-a", { destroy: ["mbx-s~f~fld-s"], onDestroyRemoveEmails: true });
	assert.deepEqual(result.notDestroyed, { "mbx-s~f~fld-s": { type: "mailboxHasEmail" } });
	assert.equal(state(context), before, "neither the mailbox's messages nor the folder changed: all or nothing");
});

// ---- Destroy and snoozed messages -------------------------------------------------------------------

test("r-1: a folder holding only snoozed mail is not empty; a non-empty folder survives with its mail filed", async (t) => {
	const context = await setup(t, "read_only");
	exec(context, "INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-snz', 'user-a', 'mbx-a', 'Snoozed', 1)");
	await context.deliver("z-1", "Subject: z\r\n\r\nx\r\n", { folder_id: "fld-snz", snoozed_until: 1999999999 });
	const snoozed = await mailboxSet(context, "user-a", { destroy: ["mbx-a~f~fld-snz"] });
	assert.deepEqual(snoozed.notDestroyed, { "mbx-a~f~fld-snz": { type: "mailboxHasEmail" } });
	assert.ok(folder(context, "fld-snz"));
	assert.deepEqual([message(context, "z-1").status, message(context, "z-1").folder_id], ["received", "fld-snz"], "not reclassified to Inbox");
	const normal = await mailboxSet(context, "user-a", { destroy: ["mbx-a~f~fld-work"] });
	assert.deepEqual(normal.notDestroyed, { "mbx-a~f~fld-work": { type: "mailboxHasEmail" } });
	const removed = await mailboxSet(context, "user-a", { destroy: ["mbx-a~f~fld-snz"], onDestroyRemoveEmails: true });
	assert.deepEqual(removed.destroyed, ["mbx-a~f~fld-snz"], "explicit removal applies to snoozed mail too");
	assert.deepEqual([message(context, "z-1").status, message(context, "z-1").folder_id], ["trash", null]);
});

test("r-1: nothing is reported as done unless it was done", async (t) => {
	const context = await setup(t, "read_only");
	const result = await mailboxSet(context, "user-a", {
		update: { "mbx-a~f~fld-nope": { name: "Ghost" }, "mbx-a~f~fld-gone": { isSubscribed: true }, "mbx-a~f~fld-work": { isSubscribed: false } },
		destroy: ["mbx-a~f~fld-nope"],
	});
	assert.deepEqual(result.updated, { "mbx-a~f~fld-work": null }, "only the existing folder's no-op update succeeds");
	assert.deepEqual(result.notUpdated, { "mbx-a~f~fld-nope": { type: "notFound" }, "mbx-a~f~fld-gone": { type: "notFound" } });
	assert.deepEqual(result.notDestroyed, { "mbx-a~f~fld-nope": { type: "notFound" } });
	const same = await mailboxSet(context, "user-a", { update: { "mbx-a~f~fld-work": { name: " Work " } } });
	assert.deepEqual(same.updated, { "mbx-a~f~fld-work": null }, "renaming to the current (trimmed) name is a successful no-op");
});

// ---- TOCTOU -----------------------------------------------------------------------------------------

// Sharing is process configuration, read when the guarded statement is built (as the IMAP
// authorityGuard does), not database state, so it has no meaningful window to race; it is covered
// by the authorization matrix above.
test("r-1 TOCTOU: authority lost between the check and the write means no write, for every operation", async (t) => {
	const changes = [
		["full_access -> read_only", (context) => exec(context, "UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-b'")],
		["access revoked", (context) => exec(context, "DELETE FROM mailbox_access WHERE id = 'acc-b'")],
		["user disabled", (context) => exec(context, "UPDATE users SET disabled = 1 WHERE id = 'user-b'")],
		["mailbox disabled", (context) => exec(context, "UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-s'")],
	];
	const operations = [
		["create", /INSERT INTO folders/, { create: { c: { parentId: "mbx-s", name: "Created" } } }, (r) => [r.created, r.notCreated.c]],
		["rename", /UPDATE folders SET name/, { update: { "mbx-s~f~fld-s": { name: "Renamed" } } }, (r) => [r.updated, r.notUpdated["mbx-s~f~fld-s"]]],
		["destroy", /DELETE FROM folders/, { destroy: ["mbx-s~f~fld-empty"] }, (r) => [r.destroyed, r.notDestroyed["mbx-s~f~fld-empty"]]],
		["destroy + onDestroyRemoveEmails", /DELETE FROM folders/, { destroy: ["mbx-s~f~fld-s"], onDestroyRemoveEmails: true }, (r) => [r.destroyed, r.notDestroyed["mbx-s~f~fld-s"]]],
	];
	for (const [change, apply] of changes) {
		for (const [operation, pattern, args, pick] of operations) {
			const label = `${operation} / ${change}`;
			const context = await setup(t, "full_access");
			exec(context, "INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-empty', 'user-a', 'mbx-s', 'Empty', 1)");
			const before = state(context);
			let fired = false;
			beforeBatch(context, pattern, () => {
				fired = true;
				apply(context);
			});
			const [done, refusal] = pick(await mailboxSet(context, "user-b", args));
			assert.ok(fired, `${label}: the change landed between the check and the write`);
			assert.ok(Array.isArray(done) ? done.length === 0 : Object.keys(done).length === 0, `${label}: not reported as done`);
			assert.ok(refusal && ["forbidden", "notFound", "invalidProperties"].includes(refusal.type), `${label}: ${JSON.stringify(refusal)}`);
			assert.equal(state(context), before, `${label}: nothing written`);
		}
	}
});

test("r-1 TOCTOU: a message filed into the folder just before its deletion keeps the folder alive", async (t) => {
	const context = await setup(t, "read_only");
	exec(context, "INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-empty', 'user-a', 'mbx-a', 'Empty', 1)");
	beforeBatch(context, /DELETE FROM folders/, () => exec(context, "UPDATE messages SET folder_id = 'fld-empty' WHERE id = 'w-1'"));
	const result = await mailboxSet(context, "user-a", { destroy: ["mbx-a~f~fld-empty"] });
	assert.deepEqual(result.notDestroyed, { "mbx-a~f~fld-empty": { type: "mailboxHasEmail" } });
	assert.ok(folder(context, "fld-empty"));
	assert.deepEqual([message(context, "w-1").status, message(context, "w-1").folder_id], ["received", "fld-empty"], "still filed there");
});

test("r-1 TOCTOU: a name taken between the check and the write is alreadyExists, not a server failure", async (t) => {
	const context = await setup(t, "read_only");
	beforeBatch(context, /UPDATE folders SET name/, () => exec(context, "INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-race', 'user-a', 'mbx-a', 'Taken', 1)"));
	const result = await mailboxSet(context, "user-a", { update: { "mbx-a~f~fld-work": { name: "Taken" } } });
	assert.equal(result.notUpdated["mbx-a~f~fld-work"].description, "A folder with that name already exists");
	assert.equal(folder(context, "fld-work").name, "Work");
});

// ---- Names ------------------------------------------------------------------------------------------

test("r-1 names: create and rename validate alike; duplicates are invalidProperties, never serverFail", async (t) => {
	const context = await setup(t, "read_only");
	const invalid = ["", "   ", 42, null, "N".repeat(81), "A\u0000B", "A\u0001B", "Tab\there", "A\rB", "A\nB", "A\u007fB"];
	for (const name of invalid) {
		const created = await mailboxSet(context, "user-a", { create: { c: { parentId: "mbx-a", name } } });
		assert.deepEqual(created.notCreated.c?.properties, ["name"], `create ${JSON.stringify(name)}`);
		const renamed = await mailboxSet(context, "user-a", { update: { "mbx-a~f~fld-work": { name } } });
		assert.deepEqual(renamed.notUpdated["mbx-a~f~fld-work"]?.properties, ["name"], `rename ${JSON.stringify(name)}`);
	}
	const missing = await mailboxSet(context, "user-a", { create: { c: { parentId: "mbx-a" } } });
	assert.deepEqual(missing.notCreated.c.properties, ["name"]);
	assert.equal(folder(context, "fld-work").name, "Work");
	// Limits and trimming.
	const edge = await mailboxSet(context, "user-a", { create: { a: { parentId: "mbx-a", name: "N".repeat(80) }, b: { parentId: "mbx-a", name: "  Padded  " } } });
	assert.ok(edge.created.a && edge.created.b);
	assert.ok(all(context, "SELECT 1 FROM folders WHERE name = 'Padded'").length === 1, "stored trimmed");
	// Exact duplicates.
	const duplicateCreate = await mailboxSet(context, "user-a", { create: { c: { parentId: "mbx-a", name: "Work" } } });
	assert.equal(duplicateCreate.notCreated.c.description, "A folder with that name already exists");
	const duplicateRename = await mailboxSet(context, "user-a", { update: { "mbx-a~f~fld-work": { name: "Padded" } } });
	assert.deepEqual(duplicateRename.notUpdated["mbx-a~f~fld-work"], { type: "invalidProperties", properties: ["name"], description: "A folder with that name already exists" });
	assert.equal(folder(context, "fld-work").name, "Work");
	// The same name in another mailbox is fine.
	assert.ok((await mailboxSet(context, "user-a", { create: { c: { parentId: "mbx-s", name: "Work" } } })).created.c);
});

test("r-1 names: the deferred A5.5 policy is unchanged: case-only duplicates, system names and NFC/NFD variants are still accepted", async (t) => {
	const context = await setup(t, "read_only");
	const result = await mailboxSet(context, "user-a", {
		create: {
			caseOnly: { parentId: "mbx-a", name: "work" },
			inbox: { parentId: "mbx-a", name: "Inbox" },
			upper: { parentId: "mbx-a", name: "INBOX" },
			trash: { parentId: "mbx-a", name: "Trash" },
			nfc: { parentId: "mbx-a", name: "Café" },
			nfd: { parentId: "mbx-a", name: "Café" },
		},
	});
	assert.deepEqual(Object.keys(result.created).sort(), ["caseOnly", "inbox", "nfc", "nfd", "trash", "upper"]);
	assert.deepEqual(result.notCreated, {});
});

// ---- System folders ---------------------------------------------------------------------------------

test("r-1: system folders and the mailbox itself cannot be renamed or destroyed", async (t) => {
	const context = await setup(t, "read_only");
	const before = state(context);
	const roles = ["inbox", "sent", "drafts", "archive", "junk", "trash"];
	const update = Object.fromEntries([...roles.map((role) => [`mbx-a~${role}`, { name: "X" }]), ["mbx-a", { name: "X" }]]);
	const result = await mailboxSet(context, "user-a", { update, destroy: [...roles.map((role) => `mbx-a~${role}`), "mbx-a"] });
	assert.deepEqual(result.updated, {});
	assert.deepEqual(result.destroyed, []);
	for (const id of Object.keys(update)) {
		assert.equal(result.notUpdated[id].type, "forbidden", id);
		assert.equal(result.notDestroyed[id].type, "forbidden", id);
	}
	assert.equal(state(context), before);
});

// ---- The service directly (future IMAP callers) -------------------------------------------------------

test("r-1 service: outcomes are protocol-neutral; a mail app password actor needs its credential with the imap scope, also inside the write", async (t) => {
	const context = await setup(t, "read_only");
	const db = app.getDb(context.env);
	const service = app.folderManagement;
	const { id: credentialId } = await context.credential("user-a", "mbx-a");
	const actor = { userId: "user-a", appPasswordId: credentialId };
	const created = await service.createFolder(db, actor, "mbx-a", "Via credential");
	assert.equal(created.outcome, "ok");
	assert.deepEqual(await service.renameFolder(db, actor, "mbx-a", created.folderId, "Via credential"), { outcome: "unchanged", name: "Via credential" });
	assert.deepEqual(await service.createFolder(db, actor, "mbx-a", "\u0000"), { outcome: "invalidName" });
	assert.deepEqual(await service.createFolder(db, actor, "mbx-a", "Via credential"), { outcome: "alreadyExists" });
	assert.deepEqual(await service.deleteFolder(db, actor, "mbx-a", "fld-work"), { outcome: "hasMessages" });
	assert.deepEqual(await service.deleteFolder(db, { userId: "user-b" }, "mbx-s", "fld-s"), { outcome: "forbidden" });
	assert.deepEqual(await service.deleteFolder(db, actor, "mbx-a", "fld-s"), { outcome: "notFound" }, "a folder of another mailbox");
	assert.deepEqual(await service.createFolder(db, { userId: "user-a", appPasswordId: credentialId }, "mbx-s", "Wrong mailbox"), { outcome: "notFound" }, "the credential is for mbx-a only");
	// Scope removed, or the credential revoked, between the check and the write.
	for (const [label, revoke] of [
		["scope removed", () => exec(context, `UPDATE mail_app_passwords SET scopes = '["smtp"]' WHERE id = '${credentialId}'`)],
		["credential revoked", () => exec(context, `DELETE FROM mail_app_passwords WHERE id = '${credentialId}'`)],
	]) {
		exec(context, `INSERT OR IGNORE INTO mail_app_passwords (id, user_id, mailbox_id, label, public_id, secret_hash, scopes, created_at) VALUES ('${credentialId}', 'user-a', 'mbx-a', 'test', 'pub-${label.length}', 'h', '["imap"]', 1)`);
		exec(context, `UPDATE mail_app_passwords SET scopes = '["imap"]' WHERE id = '${credentialId}'`);
		const before = state(context);
		beforeBatch(context, /UPDATE folders SET name/, revoke);
		assert.deepEqual(await service.renameFolder(db, actor, "mbx-a", created.folderId, `Renamed ${label}`), { outcome: "notFound" }, label);
		assert.equal(state(context), before, label);
	}
	assert.deepEqual(await service.createFolder(db, actor, "mbx-a", "After revocation"), { outcome: "notFound" });
});
