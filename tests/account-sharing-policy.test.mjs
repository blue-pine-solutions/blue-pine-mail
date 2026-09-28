import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-sharing-bundle-"));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { generateApiKey } from "./src/lib/api-keys.ts";
			export { getDb } from "./src/db/index.ts";
			export { getMailboxAccessLevel, listAccessibleMailboxIds } from "./src/lib/mailboxes/access.ts";
			export { getMailboxNotificationUserIds } from "./src/lib/realtime/utils.ts";
			export { GET as listAccounts, POST as createAccount } from "./src/app/api/accounts/route.ts";
			export { GET as listMailboxes, POST as createMailbox } from "./src/app/api/mailboxes/route.ts";
			export { GET as listMailboxMembers, POST as addMailboxMember } from "./src/app/api/mailboxes/[id]/access/route.ts";
			export { GET as listMessages } from "./src/app/api/messages/route.ts";
			export { GET as listAccountsByKey } from "./src/app/api/v1/accounts/route.ts";
			export { POST as createMailboxByKey } from "./src/app/api/v1/mailboxes/route.ts";
		`,
		resolveDir: root,
		sourcefile: "sharing-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
test.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

const LICENSE_WORDING = /license|\bpro\b|\bteam\b|paymug|upgrade/i;
const BASE = "http://mailflare.local";

function setDisabledFeatures(t, value) {
	const saved = process.env.BLUEPINE_DISABLED_FEATURES;
	t.after(() => {
		if (saved === undefined) delete process.env.BLUEPINE_DISABLED_FEATURES;
		else process.env.BLUEPINE_DISABLED_FEATURES = saved;
	});
	if (value === undefined) delete process.env.BLUEPINE_DISABLED_FEATURES;
	else process.env.BLUEPINE_DISABLED_FEATURES = value;
}

/**
 * Admin A owns the domain, A's personal mailbox and two shared inboxes (sales, support),
 * each holding one message. No license is activated at any point.
 */
async function install(t) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-sharing-"));
	const database = new app.SqliteDatabase(join(directory, "mailflare.sqlite"));
	// Close before removing the directory: Windows cannot delete an open SQLite file.
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await app.applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('user-a', 'a@example.test', 'hash', 'A', 'admin', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-a', 'example.test', 'manual', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('mbx-a', 'user-a', 'domain-1', 'a', 'personal', 1),
			('mbx-sales', 'user-a', 'domain-1', 'sales', 'shared', 1),
			('mbx-support', 'user-a', 'domain-1', 'support', 'shared', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, thread_id, created_at) VALUES
			('msg-a', 'user-a', 'mbx-a', 'inbound', 'x@elsewhere.test', 'a@example.test', 'A private', 'private', 'received', 't-a', 2),
			('msg-sales', 'user-a', 'mbx-sales', 'inbound', 'x@elsewhere.test', 'sales@example.test', 'Sales lead', 'lead', 'received', 't-s', 2),
			('msg-support', 'user-a', 'mbx-support', 'inbound', 'x@elsewhere.test', 'support@example.test', 'Support ticket', 'ticket', 'received', 't-t', 2);
	`);
	const env = { DB: database };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const db = app.getDb(env);
	const tokenA = await app.createSession(env, "user-a");
	const count = (sql) => database.db.prepare(sql).get().count;
	return { database, env, db, tokenA, count };
}

function call(handler, token, path, { method = "GET", body, params } = {}) {
	const request = new Request(`${BASE}${path}`, {
		method,
		headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	return params ? handler(request, { params: Promise.resolve(params) }) : handler(request);
}

/** Creates B as a normal user through the real admin route, then signs B in. */
async function createUserB(context) {
	const response = await call(app.createAccount, context.tokenA, "/api/accounts", { method: "POST", body: { username: "b", domainId: "domain-1", password: "password-b-1", role: "user" } });
	assert.equal(response.status, 201, await response.clone().text());
	const userB = context.database.db.prepare("SELECT id, role, created_by_user_id FROM users WHERE email = 'b@example.test'").get();
	assert.deepEqual({ role: userB.role, createdBy: userB.created_by_user_id }, { role: "user", createdBy: "user-a" });
	return { id: userB.id, token: await app.createSession(context.env, userB.id) };
}

async function messageIdsFor(token, mailboxId) {
	const response = await call(app.listMessages, token, `/api/messages?mailboxId=${mailboxId}`);
	return { status: response.status, ids: response.status === 200 ? (await response.json()).messages.map((row) => row.id) : [] };
}

async function mailboxIdsFor(token) {
	const response = await call(app.listMailboxes, token, "/api/mailboxes");
	assert.equal(response.status, 200);
	return (await response.json()).mailboxes.map((row) => row.id).sort();
}

function shareSalesWithB(context, userB) {
	return call(app.addMailboxMember, context.tokenA, "/api/mailboxes/mbx-sales/access", { method: "POST", body: { userId: userB.id, permission: "read_only" }, params: { id: "mbx-sales" } });
}

async function createApiKey(context, userId, scopes) {
	const { fullKey, prefix, hash } = app.generateApiKey();
	context.database.db.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, created_at) VALUES (?, ?, 'test', ?, ?, ?, 1)").run(`key-${userId}`, userId, prefix, hash, JSON.stringify(scopes));
	return fullKey;
}

test("multiple accounts: an admin manages accounts without any license", async (t) => {
	setDisabledFeatures(t, undefined);
	const context = await install(t);
	const userB = await createUserB(context);
	const listed = await call(app.listAccounts, context.tokenA, "/api/accounts");
	assert.equal(listed.status, 200);
	assert.ok((await listed.json()).accounts.some((account) => account.id === userB.id));
	assert.equal(context.count("SELECT count(*) AS count FROM license_settings WHERE state = 'active'"), 0);

	const key = await createApiKey(context, "user-a", ["accounts"]);
	const byKey = await call(app.listAccountsByKey, key, "/api/v1/accounts");
	assert.equal(byKey.status, 200);
	assert.ok((await byKey.json()).accounts.some((account) => account.id === userB.id));
});

test("multiple accounts disabled: refused by policy and existing accounts are kept", async (t) => {
	setDisabledFeatures(t, undefined);
	const context = await install(t);
	const userB = await createUserB(context);
	const key = await createApiKey(context, "user-a", ["accounts"]);

	process.env.BLUEPINE_DISABLED_FEATURES = "multipleAccounts";
	for (const response of [
		await call(app.listAccounts, context.tokenA, "/api/accounts"),
		await call(app.createAccount, context.tokenA, "/api/accounts", { method: "POST", body: { username: "c", domainId: "domain-1", password: "password-c-1", role: "user" } }),
		await call(app.listAccountsByKey, key, "/api/v1/accounts"),
	]) {
		assert.equal(response.status, 403);
		const { error } = await response.json();
		assert.equal(error, "Account management is turned off for this deployment");
		assert.doesNotMatch(error, LICENSE_WORDING);
	}
	assert.equal(context.count("SELECT count(*) AS count FROM users WHERE email = 'c@example.test'"), 0);
	assert.equal(context.count(`SELECT count(*) AS count FROM users WHERE id = '${userB.id}'`), 1);
	// B still signs in to, and reads, B's own mailbox.
	assert.deepEqual(await mailboxIdsFor(userB.token), context.database.db.prepare(`SELECT id FROM mailboxes WHERE user_id = '${userB.id}'`).all().map((row) => row.id).sort());
});

test("enabling features never grants account administration to a normal user", async (t) => {
	setDisabledFeatures(t, undefined);
	const context = await install(t);
	const userB = await createUserB(context);
	const forbidden = [
		await call(app.listAccounts, userB.token, "/api/accounts"),
		await call(app.createAccount, userB.token, "/api/accounts", { method: "POST", body: { username: "c", domainId: "domain-1", password: "password-c-1", role: "admin" } }),
		await call(app.listMailboxMembers, userB.token, "/api/mailboxes/mbx-sales/access", { params: { id: "mbx-sales" } }),
		await call(app.addMailboxMember, userB.token, "/api/mailboxes/mbx-sales/access", { method: "POST", body: { userId: userB.id, permission: "full_access" }, params: { id: "mbx-sales" } }),
		await call(app.createMailbox, userB.token, "/api/mailboxes", { method: "POST", body: { domainId: "domain-1", localPart: "sneaky", type: "shared" } }),
	];
	for (const response of forbidden) {
		assert.equal(response.status, 403);
		assert.equal((await response.json()).error, "Forbidden");
	}
	const listed = await call(app.listMailboxes, userB.token, "/api/mailboxes");
	assert.equal((await listed.json()).canCreateShared, false);
	const userKey = await createApiKey(context, userB.id, ["accounts", "mailboxes"]);
	assert.equal((await call(app.listAccountsByKey, userKey, "/api/v1/accounts")).status, 401);
	assert.equal((await call(app.createMailboxByKey, userKey, "/api/v1/mailboxes", { method: "POST", body: { domainId: "domain-1", localPart: "sneaky", type: "shared" } })).status, 401);
	assert.equal(context.count("SELECT count(*) AS count FROM users WHERE email = 'c@example.test'"), 0);
	assert.equal(context.count("SELECT count(*) AS count FROM mailboxes WHERE local_part = 'sneaky'"), 0);
	assert.equal(context.count(`SELECT count(*) AS count FROM mailbox_access WHERE user_id = '${userB.id}'`), 0);
});

test("shared mailboxes: owners are isolated until a real delegation exists", async (t) => {
	setDisabledFeatures(t, undefined);
	const context = await install(t);
	const userB = await createUserB(context);
	const b = { id: userB.id, role: "user" };

	// A. Owner isolation, with the feature on.
	assert.equal((await app.getMailboxAccessLevel(context.db, { id: "user-a", role: "admin" }, "mbx-a"))?.isOwner, true);
	for (const mailboxId of ["mbx-a", "mbx-sales", "mbx-support"]) {
		assert.equal(await app.getMailboxAccessLevel(context.db, b, mailboxId), null, mailboxId);
		assert.deepEqual(await messageIdsFor(userB.token, mailboxId), { status: 404, ids: [] });
	}

	// B. A delegates sales to B through the real admin route.
	assert.equal((await shareSalesWithB(context, userB)).status, 200);
	const access = await app.getMailboxAccessLevel(context.db, b, "mbx-sales");
	assert.deepEqual({ isOwner: access?.isOwner, canRead: access?.canRead, canManage: access?.canManage }, { isOwner: false, canRead: true, canManage: false });
	assert.deepEqual(await messageIdsFor(userB.token, "mbx-sales"), { status: 200, ids: ["msg-sales"] });
	assert.ok((await mailboxIdsFor(userB.token)).includes("mbx-sales"));
	assert.ok((await app.getMailboxNotificationUserIds(context.env, "mbx-sales", "user-a")).includes(userB.id));

	// E. Delegation is per mailbox: support and A's personal mailbox stay closed.
	for (const mailboxId of ["mbx-a", "mbx-support"]) {
		assert.equal(await app.getMailboxAccessLevel(context.db, b, mailboxId), null, mailboxId);
		assert.deepEqual(await messageIdsFor(userB.token, mailboxId), { status: 404, ids: [] });
	}
	const unscoped = await call(app.listMessages, userB.token, "/api/messages");
	assert.deepEqual((await unscoped.json()).messages.map((row) => row.id).sort(), ["msg-sales"]);
	assert.ok(!(await mailboxIdsFor(userB.token)).includes("mbx-support"));
});

test("shared mailboxes disabled: delegates lose access, owners keep theirs, records survive", async (t) => {
	setDisabledFeatures(t, undefined);
	const context = await install(t);
	const userB = await createUserB(context);
	const b = { id: userB.id, role: "user" };
	assert.equal((await shareSalesWithB(context, userB)).status, 200);

	// C. Turn the feature off.
	process.env.BLUEPINE_DISABLED_FEATURES = "sharedMailboxes";
	assert.equal(await app.getMailboxAccessLevel(context.db, b, "mbx-sales"), null);
	assert.deepEqual(await messageIdsFor(userB.token, "mbx-sales"), { status: 404, ids: [] });
	assert.ok(!(await mailboxIdsFor(userB.token)).includes("mbx-sales"));
	assert.ok(!(await app.listAccessibleMailboxIds(context.db, { id: userB.id, email: "b@example.test", role: "user" })).includes("mbx-sales"));
	assert.ok(!(await app.getMailboxNotificationUserIds(context.env, "mbx-sales", "user-a")).includes(userB.id));
	assert.equal((await app.getMailboxAccessLevel(context.db, { id: "user-a", role: "admin" }, "mbx-sales"))?.isOwner, true);
	assert.deepEqual(await messageIdsFor(context.tokenA, "mbx-sales"), { status: 200, ids: ["msg-sales"] });
	assert.equal(context.count(`SELECT count(*) AS count FROM mailbox_access WHERE mailbox_id = 'mbx-sales' AND user_id = '${userB.id}'`), 1);

	const manage = await call(app.listMailboxMembers, context.tokenA, "/api/mailboxes/mbx-sales/access", { params: { id: "mbx-sales" } });
	assert.equal(manage.status, 403);
	assert.equal((await manage.json()).error, "Shared mailboxes are turned off for this deployment");
	const create = await call(app.createMailbox, context.tokenA, "/api/mailboxes", { method: "POST", body: { domainId: "domain-1", localPart: "billing", type: "shared" } });
	assert.equal(create.status, 403);
	assert.doesNotMatch((await create.json()).error, LICENSE_WORDING);
	assert.equal((await (await call(app.listMailboxes, context.tokenA, "/api/mailboxes")).json()).canCreateShared, false);
	const key = await createApiKey(context, "user-a", ["mailboxes"]);
	const createByKey = await call(app.createMailboxByKey, key, "/api/v1/mailboxes", { method: "POST", body: { domainId: "domain-1", localPart: "billing", type: "shared" } });
	assert.equal(createByKey.status, 403);
	assert.equal(context.count("SELECT count(*) AS count FROM mailboxes WHERE local_part = 'billing'"), 0);

	// D. Turn it back on: the stored delegation applies again without being recreated.
	delete process.env.BLUEPINE_DISABLED_FEATURES;
	assert.equal((await app.getMailboxAccessLevel(context.db, b, "mbx-sales"))?.canRead, true);
	assert.deepEqual(await messageIdsFor(userB.token, "mbx-sales"), { status: 200, ids: ["msg-sales"] });
	assert.equal(await app.getMailboxAccessLevel(context.db, b, "mbx-support"), null);
	assert.equal((await (await call(app.listMailboxes, context.tokenA, "/api/mailboxes")).json()).canCreateShared, true);
});

test("A -> B -> A: switching users leaks no mailbox access either way", async (t) => {
	setDisabledFeatures(t, undefined);
	const context = await install(t);
	const userB = await createUserB(context);
	assert.equal((await shareSalesWithB(context, userB)).status, 200);
	const personalB = context.database.db.prepare(`SELECT id FROM mailboxes WHERE user_id = '${userB.id}'`).get().id;

	const seenByA = await mailboxIdsFor(context.tokenA);
	assert.deepEqual(seenByA, ["mbx-a", "mbx-sales", "mbx-support"]);
	assert.deepEqual(await messageIdsFor(context.tokenA, "mbx-a"), { status: 200, ids: ["msg-a"] });

	assert.deepEqual(await mailboxIdsFor(userB.token), [personalB, "mbx-sales"].sort());
	assert.deepEqual(await messageIdsFor(userB.token, "mbx-a"), { status: 404, ids: [] });
	assert.deepEqual(await messageIdsFor(userB.token, "mbx-support"), { status: 404, ids: [] });
	assert.deepEqual(await messageIdsFor(userB.token, "mbx-sales"), { status: 200, ids: ["msg-sales"] });

	assert.deepEqual(await mailboxIdsFor(context.tokenA), seenByA);
	assert.deepEqual(await messageIdsFor(context.tokenA, "mbx-a"), { status: 200, ids: ["msg-a"] });
	assert.deepEqual(await messageIdsFor(context.tokenA, personalB), { status: 404, ids: [] }, "an admin does not read another account's personal mailbox");
});
