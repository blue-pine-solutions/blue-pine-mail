import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-app-password-bundle-"));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession, hashSessionToken } from "./src/lib/auth/session.ts";
			export { hashPassword } from "./src/lib/auth/password.ts";
			export { completePasswordReset } from "./src/lib/auth/password-reset.ts";
			export { generateApiKey } from "./src/lib/api-keys.ts";
			export { verifyMailAppPassword } from "./src/lib/mail-app-passwords/verify.ts";
			export * as utils from "./src/lib/mail-app-passwords/utils.ts";
			export { GET as listPasswords, POST as createPassword } from "./src/app/api/settings/mail-app-passwords/route.ts";
			export { DELETE as revokePassword } from "./src/app/api/settings/mail-app-passwords/[id]/route.ts";
			export { PATCH as changePassword } from "./src/app/api/settings/password/route.ts";
			export { PATCH as updateAccount } from "./src/app/api/accounts/[id]/route.ts";
			export { POST as addMailboxMember, DELETE as removeMailboxMember } from "./src/app/api/mailboxes/[id]/access/route.ts";
			export { exportDatabaseRecords, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
		`,
		resolveDir: root,
		sourcefile: "app-password-test-entry.ts",
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

const BASE = "http://mailflare.local";
const WEB_PASSWORD = "web-password-a-1";

/**
 * Admin A owns the domain, A's personal mailbox and the shared inbox `sales`; user B
 * (created by A) has read_only access to `sales`. Everything goes through real routes.
 */
async function install(t) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-app-passwords-"));
	const database = new app.SqliteDatabase(join(directory, "mailflare.sqlite"));
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await app.applyMigrations(database, join(root, "drizzle", "migrations"));
	const hashA = app.hashPassword(WEB_PASSWORD);
	database.db.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('user-a', 'a@example.test', ?, 'A', 'admin', 1)").run(hashA);
	database.db.prepare("INSERT INTO users (id, email, password_hash, name, role, created_by_user_id, created_at) VALUES ('user-b', 'b@example.test', ?, 'B', 'user', 'user-a', 1)").run(app.hashPassword("web-password-b-1"));
	database.db.exec(`
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-a', 'example.test', 'manual', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
			('mbx-a', 'user-a', 'domain-1', 'a', 'personal', 1),
			('mbx-b', 'user-b', 'domain-1', 'b', 'personal', 1),
			('mbx-sales', 'user-a', 'domain-1', 'sales', 'shared', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_by_user_id, created_at) VALUES ('acc-1', 'mbx-sales', 'user-b', 'read_only', 'user-a', 1);
	`);
	const env = { DB: database };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const tokenA = await app.createSession(env, "user-a");
	const tokenB = await app.createSession(env, "user-b");
	const rows = () => database.db.prepare("SELECT * FROM mail_app_passwords ORDER BY created_at, id").all();
	return { database, env, tokenA, tokenB, rows };
}

function call(handler, token, path, { method = "GET", body, params } = {}) {
	const request = new Request(`${BASE}${path}`, {
		method,
		headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	return params ? handler(request, { params: Promise.resolve(params) }) : handler(request);
}

async function create(context, token, body) {
	const response = await call(app.createPassword, token, "/api/settings/mail-app-passwords", { method: "POST", body });
	return { status: response.status, body: await response.json() };
}

const verify = (context, username, password, scope = "imap") => app.verifyMailAppPassword(context.env, { username, password, scope });

/** Captures console output during `fn`, so tests can prove a credential never reaches logs. */
async function captureLogs(fn) {
	const lines = [];
	const saved = {};
	for (const level of ["log", "info", "warn", "error", "debug"]) {
		saved[level] = console[level];
		console[level] = (...args) => lines.push(args.map(String).join(" "));
	}
	try {
		return { result: await fn(), logs: lines.join("\n") };
	} finally {
		Object.assign(console, saved);
	}
}

test("credentials are random 160-bit secrets in a fixed format; the web password and API keys never parse", () => {
	const seen = new Set();
	for (let index = 0; index < 200; index += 1) {
		const { credential, publicId } = app.utils.generateMailAppCredential();
		assert.match(credential, /^bpm_[a-z2-7]{12}_[a-z2-7]{32}$/);
		assert.equal(app.utils.parseMailAppCredential(credential).publicId, publicId);
		seen.add(credential);
	}
	assert.equal(seen.size, 200);
	for (const other of [WEB_PASSWORD, app.generateApiKey().fullKey, "bpm_short_x", "BPM_AAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", ""]) assert.equal(app.utils.parseMailAppCredential(other), null, other);
	assert.equal(app.utils.digestsEqual("ab".repeat(32), "ab".repeat(32)), true);
	assert.equal(app.utils.digestsEqual("ab".repeat(32), `${"ab".repeat(31)}ac`), false);
	assert.equal(app.utils.digestsEqual("ab", "abcd"), false);
});

test("creation returns the credential once, stores only its SHA-256, and validates label, scopes and mailbox", async (t) => {
	const context = await install(t);
	const { result: created, logs } = await captureLogs(() => create(context, context.tokenA, { label: " Phone ", mailboxId: "mbx-a", scopes: ["smtp", "imap", "imap"] }));
	assert.equal(created.status, 201);
	const { credential, password } = created.body;
	assert.match(credential, /^bpm_[a-z2-7]{12}_[a-z2-7]{32}$/);
	assert.deepEqual({ label: password.label, address: password.address, scopes: password.scopes, usable: password.usable, lastUsedAt: password.lastUsedAt }, { label: "Phone", address: "a@example.test", scopes: ["imap", "smtp"], usable: true, lastUsedAt: null });
	assert.equal(password.hint, credential.slice(0, 16));
	assert.ok(!JSON.stringify(password).includes(credential.slice(17)), "the summary never carries the secret");
	assert.ok(!logs.includes(credential.slice(17)), "the secret never reaches logs");

	const [row] = context.rows();
	assert.equal(row.secret_hash, await app.utils.hashMailAppCredential(credential));
	assert.equal(row.public_id, credential.slice(4, 16));
	assert.deepEqual(JSON.parse(row.scopes), ["imap", "smtp"]);
	// The plaintext is nowhere in the database, not even in the audit log.
	const secret = credential.slice(17);
	for (const { name } of context.database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%'").all()) {
		assert.ok(!JSON.stringify(context.database.db.prepare(`SELECT * FROM ${name}`).all()).includes(secret), `${name} contains the secret`);
	}
	const audit = context.database.db.prepare("SELECT action, metadata FROM audit_logs WHERE action = 'mail_app_password.create'").get();
	assert.deepEqual(JSON.parse(audit.metadata), { label: "Phone", credential: password.hint, scopes: ["imap", "smtp"] });

	// Listing never returns the credential or its hash, and there is no way to retrieve it again.
	const listed = await (await call(app.listPasswords, context.tokenA, "/api/settings/mail-app-passwords")).json();
	assert.equal(listed.passwords.length, 1);
	assert.deepEqual(Object.keys(listed.passwords[0]).sort(), ["address", "createdAt", "hint", "id", "label", "lastUsedAt", "mailboxId", "scopes", "usable"]);
	assert.ok(!JSON.stringify(listed).includes(secret) && !JSON.stringify(listed).includes(row.secret_hash));

	for (const [body, status] of [
		[{ label: "", mailboxId: "mbx-a", scopes: ["imap"] }, 400],
		[{ label: "x".repeat(65), mailboxId: "mbx-a", scopes: ["imap"] }, 400],
		[{ label: "bad\u0007", mailboxId: "mbx-a", scopes: ["imap"] }, 400],
		[{ label: "ok", mailboxId: "mbx-a", scopes: [] }, 400],
		[{ label: "ok", mailboxId: "mbx-a", scopes: ["pop3"] }, 400],
		[{ label: "ok", mailboxId: "mbx-a", scopes: "imap" }, 400],
		[{ label: "ok", scopes: ["imap"] }, 400],
		[{ label: "ok", mailboxId: "mbx-b", scopes: ["imap"] }, 404],
		[{ label: "ok", mailboxId: "missing", scopes: ["imap"] }, 404],
	]) assert.equal((await create(context, context.tokenA, body)).status, status, JSON.stringify(body));
	assert.equal((await call(app.createPassword, "sess_not-a-session", "/api/settings/mail-app-passwords", { method: "POST", body: { label: "x", mailboxId: "mbx-a", scopes: ["imap"] } })).status, 401);
	assert.equal(context.rows().length, 1);
});

test("each account may hold at most 20 mail app passwords, enforced by the server", async (t) => {
	const context = await install(t);
	const results = await Promise.all(Array.from({ length: 22 }, (_, index) => create(context, context.tokenA, { label: `Device ${index}`, mailboxId: "mbx-a", scopes: ["imap"] })));
	assert.equal(results.filter((result) => result.status === 201).length, 20);
	assert.deepEqual(results.filter((result) => result.status !== 201).map((result) => result.status), [409, 409]);
	assert.equal(context.rows().length, 20);
	// The limit is per account: B is unaffected.
	assert.equal((await create(context, context.tokenB, { label: "B phone", mailboxId: "mbx-b", scopes: ["imap"] })).status, 201);
	// Revoking frees a slot.
	const id = results.find((result) => result.status === 201).body.password.id;
	assert.equal((await call(app.revokePassword, context.tokenA, `/api/settings/mail-app-passwords/${id}`, { method: "DELETE", params: { id } })).status, 200);
	assert.equal((await create(context, context.tokenA, { label: "Replacement", mailboxId: "mbx-a", scopes: ["imap"] })).status, 201);
});

test("verification needs the bound mailbox address, the right secret and a granted scope; nothing else authenticates", async (t) => {
	const context = await install(t);
	const { body } = await create(context, context.tokenA, { label: "Laptop", mailboxId: "mbx-a", scopes: ["imap"] });
	const credential = body.credential;

	const { result: ok, logs } = await captureLogs(() => verify(context, "A@Example.test ", credential, "imap"));
	assert.equal(ok.ok, true);
	assert.deepEqual(ok.principal, {
		appPasswordId: body.password.id, userId: "user-a", userEmail: "a@example.test", mailboxId: "mbx-a", address: "a@example.test", mailboxType: "personal",
		isOwner: true, permission: "full_access", canRead: true, canSendOnBehalf: true, canSendAs: true, canManage: true, scopes: ["imap"],
	});
	assert.ok(!logs.includes(credential.slice(17)));
	assert.ok(context.rows()[0].last_used_at > 0, "last_used_at recorded");

	const wrongSecret = `${credential.slice(0, -1)}${credential.endsWith("a") ? "b" : "a"}`;
	const unknownId = `bpm_${"a".repeat(12)}${credential.slice(16)}`;
	for (const [username, password, scope, reason] of [
		["a@example.test", wrongSecret, "imap", "invalid_credentials"],
		["a@example.test", unknownId, "imap", "invalid_credentials"],
		["sales@example.test", credential, "imap", "invalid_credentials"],
		["b@example.test", credential, "imap", "invalid_credentials"],
		["a", credential, "imap", "invalid_credentials"],
		["a@example.test", WEB_PASSWORD, "imap", "invalid_credentials"],
		["a@example.test", app.generateApiKey().fullKey, "imap", "invalid_credentials"],
		["a@example.test", "", "imap", "invalid_credentials"],
		["a@example.test", credential, "smtp", "scope_not_granted"],
	]) assert.deepEqual(await verify(context, username, password, scope), { ok: false, reason }, `${username} ${scope}`);

	// A real API key with every scope still does not authenticate.
	const apiKey = app.generateApiKey();
	context.database.db.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, created_at) VALUES ('key-1', 'user-a', 'k', ?, ?, '[\"read\",\"send\",\"jmap\"]', 1)").run(apiKey.prefix, apiKey.hash);
	assert.deepEqual(await verify(context, "a@example.test", apiKey.fullKey), { ok: false, reason: "invalid_credentials" });
});

test("shared mailbox: a read_only member binds a credential to it, other users cannot use it, and removing access revokes it", async (t) => {
	const context = await install(t);
	// B only sees mailboxes B can reach.
	assert.equal((await create(context, context.tokenB, { label: "x", mailboxId: "mbx-a", scopes: ["imap"] })).status, 404);
	const { status, body } = await create(context, context.tokenB, { label: "Sales on phone", mailboxId: "mbx-sales", scopes: ["imap", "smtp"] });
	assert.equal(status, 201);
	assert.equal(body.password.address, "sales@example.test");

	const result = await verify(context, "sales@example.test", body.credential, "imap");
	assert.equal(result.ok, true);
	assert.deepEqual(
		{ userId: result.principal.userId, mailboxId: result.principal.mailboxId, type: result.principal.mailboxType, isOwner: result.principal.isOwner, permission: result.principal.permission, canRead: result.principal.canRead, canSendAs: result.principal.canSendAs, canSendOnBehalf: result.principal.canSendOnBehalf },
		{ userId: "user-b", mailboxId: "mbx-sales", type: "shared", isOwner: false, permission: "read_only", canRead: true, canSendAs: false, canSendOnBehalf: false },
		"the protocol layer learns B holds read_only access, so a future SMTP listener can refuse to send",
	);
	// The owner's listing shows nothing of B's credential; the credential authenticates only B.
	assert.equal((await (await call(app.listPasswords, context.tokenA, "/api/settings/mail-app-passwords")).json()).passwords.length, 0);
	assert.equal((await verify(context, "b@example.test", body.credential)).ok, false);
	// A cannot revoke B's credential through its own session.
	const id = body.password.id;
	assert.equal((await call(app.revokePassword, context.tokenA, `/api/settings/mail-app-passwords/${id}`, { method: "DELETE", params: { id } })).status, 404);

	// A permission change is seen at the next verification.
	assert.equal((await call(app.addMailboxMember, context.tokenA, "/api/mailboxes/mbx-sales/access", { method: "POST", body: { userId: "user-b", permission: "send_as" }, params: { id: "mbx-sales" } })).status, 200);
	assert.equal((await verify(context, "sales@example.test", body.credential, "smtp")).principal.canSendAs, true);

	// Sharing switched off by feature policy: the credential stops working immediately.
	process.env.BLUEPINE_DISABLED_FEATURES = "sharedMailboxes";
	try {
		assert.deepEqual(await verify(context, "sales@example.test", body.credential), { ok: false, reason: "mailbox_unavailable" });
	} finally {
		delete process.env.BLUEPINE_DISABLED_FEATURES;
	}
	assert.equal((await verify(context, "sales@example.test", body.credential)).ok, true);

	// Removing access deletes the credential, so re-granting access later does not revive it.
	const removed = await call(app.removeMailboxMember, context.tokenA, "/api/mailboxes/mbx-sales/access?userId=user-b", { method: "DELETE", params: { id: "mbx-sales" } });
	assert.equal(removed.status, 200);
	assert.deepEqual(await verify(context, "sales@example.test", body.credential), { ok: false, reason: "invalid_credentials" });
	assert.equal(context.rows().length, 0);
	assert.equal((await call(app.addMailboxMember, context.tokenA, "/api/mailboxes/mbx-sales/access", { method: "POST", body: { userId: "user-b", permission: "full_access" }, params: { id: "mbx-sales" } })).status, 200);
	assert.equal((await verify(context, "sales@example.test", body.credential)).ok, false);
});

test("verification re-checks current state: disabled account, disabled or deleted mailbox, deleted domain or user", async (t) => {
	const context = await install(t);
	const own = (await create(context, context.tokenB, { label: "B", mailboxId: "mbx-b", scopes: ["imap"] })).body.credential;
	const shared = (await create(context, context.tokenB, { label: "Sales", mailboxId: "mbx-sales", scopes: ["imap"] })).body.credential;
	const db = context.database.db;

	// Admin disables B: immediate failure, and re-enabling restores the (unchanged) credentials.
	const update = (disabled) => call(app.updateAccount, context.tokenA, "/api/accounts/user-b", { method: "PATCH", body: { name: "B", role: "user", disabled, canManageMailboxes: false }, params: { id: "user-b" } });
	assert.equal((await update(true)).status, 200);
	assert.deepEqual(await verify(context, "b@example.test", own), { ok: false, reason: "account_disabled" });
	assert.equal((await update(false)).status, 200);
	assert.equal((await verify(context, "b@example.test", own)).ok, true);

	db.prepare("UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-b'").run();
	assert.deepEqual(await verify(context, "b@example.test", own), { ok: false, reason: "mailbox_unavailable" });
	db.prepare("UPDATE mailboxes SET disabled = 0 WHERE id = 'mbx-b'").run();

	db.prepare("DELETE FROM mailboxes WHERE id = 'mbx-b'").run();
	assert.deepEqual(await verify(context, "b@example.test", own), { ok: false, reason: "invalid_credentials" });
	assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mail_app_passwords WHERE mailbox_id = 'mbx-b'").get().count, 0, "mailbox deletion cascades");

	db.prepare("DELETE FROM domains WHERE id = 'domain-1'").run();
	assert.equal((await verify(context, "sales@example.test", shared)).ok, false);
	assert.equal(context.rows().length, 0, "domain deletion cascades through its mailboxes");

	const context2 = await install(t);
	const again = (await create(context2, context2.tokenB, { label: "B", mailboxId: "mbx-b", scopes: ["imap"] })).body.credential;
	context2.database.db.prepare("DELETE FROM users WHERE id = 'user-b'").run();
	assert.equal((await verify(context2, "b@example.test", again)).ok, false);
	assert.equal(context2.rows().length, 0, "user deletion cascades");
});

test("changing the web password in any way revokes every mail app password of that account only", async (t) => {
	const context = await install(t);
	const makeA = async () => (await create(context, context.tokenA, { label: "A", mailboxId: "mbx-a", scopes: ["imap"] })).body.credential;
	const keepB = (await create(context, context.tokenB, { label: "B", mailboxId: "mbx-b", scopes: ["imap"] })).body.credential;
	const countA = () => context.database.db.prepare("SELECT COUNT(*) AS count FROM mail_app_passwords WHERE user_id = 'user-a'").get().count;

	// Settings > Security password change.
	let credential = await makeA();
	const changed = await call(app.changePassword, context.tokenA, "/api/settings/password", { method: "PATCH", body: { currentPassword: WEB_PASSWORD, newPassword: "web-password-a-2" } });
	assert.equal(changed.status, 200, `${changed.status} ${await changed.clone().text()}`);
	assert.equal(countA(), 0);
	assert.equal((await verify(context, "a@example.test", credential)).ok, false);
	// The new web password is not a mail app password either.
	assert.equal((await verify(context, "a@example.test", "web-password-a-2")).ok, false);

	// Reset link.
	credential = await makeA();
	const token = "reset-token-a";
	context.database.db.prepare("INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at) VALUES ('prt-1', 'user-a', ?, ?, 1)").run(await app.hashSessionToken(token), Math.floor(Date.now() / 1000) + 600);
	assert.deepEqual(await app.completePasswordReset(context.env, token, "web-password-a-3", new Request(`${BASE}/reset`)), { ok: true });
	assert.equal(countA(), 0);
	assert.equal((await verify(context, "a@example.test", credential)).ok, false);

	// Admin sets B's password: B's credentials go, A's new one stays. The reset above signed A out.
	context.tokenA = await app.createSession(context.env, "user-a");
	credential = await makeA();
	const reset = await call(app.updateAccount, context.tokenA, "/api/accounts/user-b", { method: "PATCH", body: { name: "B", role: "user", disabled: false, canManageMailboxes: false, password: "web-password-b-2" }, params: { id: "user-b" } });
	assert.equal(reset.status, 200);
	assert.equal((await verify(context, "b@example.test", keepB)).ok, false);
	assert.equal((await verify(context, "a@example.test", credential)).ok, true);

	// Updates that leave the hash alone revoke nothing.
	context.database.db.prepare("UPDATE users SET name = 'A renamed', password_hash = password_hash WHERE id = 'user-a'").run();
	assert.equal(countA(), 1);
});

test("explicit revoke is immediate, limited to the owner and audited", async (t) => {
	const context = await install(t);
	const { body } = await create(context, context.tokenA, { label: "Old laptop", mailboxId: "mbx-a", scopes: ["imap", "smtp"] });
	const id = body.password.id;
	assert.equal((await call(app.revokePassword, context.tokenB, `/api/settings/mail-app-passwords/${id}`, { method: "DELETE", params: { id } })).status, 404);
	assert.equal((await call(app.revokePassword, "sess_not-a-session", `/api/settings/mail-app-passwords/${id}`, { method: "DELETE", params: { id } })).status, 401);
	assert.equal((await call(app.revokePassword, context.tokenA, `/api/settings/mail-app-passwords/${id}`, { method: "DELETE", params: { id } })).status, 200);
	assert.equal((await verify(context, "a@example.test", body.credential)).ok, false);
	assert.equal((await call(app.revokePassword, context.tokenA, `/api/settings/mail-app-passwords/${id}`, { method: "DELETE", params: { id } })).status, 404);
	const audit = context.database.db.prepare("SELECT metadata FROM audit_logs WHERE action = 'mail_app_password.revoke'").get();
	assert.deepEqual(JSON.parse(audit.metadata), { label: "Old laptop", credential: body.password.hint });
});

test("backups carry mail app passwords under tables but outside includedTables, and restore them", async (t) => {
	const context = await install(t);
	const { body } = await create(context, context.tokenA, { label: "Phone", mailboxId: "mbx-a", scopes: ["imap"] });
	const before = context.rows();
	const document = JSON.parse(new TextDecoder().decode(await app.exportDatabaseRecords(context.database)));
	assert.equal(document.format, "mailflare-database-backup");
	assert.equal(document.version, 1);
	assert.deepEqual(document.tables.mail_app_passwords, before);
	assert.ok(!document.includedTables.includes("mail_app_passwords"), "never named in includedTables");
	assert.ok(!JSON.stringify(document).includes(body.credential.slice(17)), "the backup holds the hash, never the credential");
	// Excluding the Accounts group leaves the table out as well.
	const partial = JSON.parse(new TextDecoder().decode(await app.exportDatabaseRecords(context.database, ["accounts"])));
	assert.equal(partial.tables.mail_app_passwords, undefined);

	// Revoke after the backup; restoring returns the database to the backup's state.
	context.database.db.prepare("DELETE FROM mail_app_passwords").run();
	await app.restoreDatabaseRecords(context.database, new TextEncoder().encode(JSON.stringify(document)).buffer);
	assert.deepEqual(context.rows(), before);
	assert.equal((await verify(context, "a@example.test", body.credential)).ok, true);

	// A backup without the table (an upstream one, or one made before bp0001) restores with no credentials.
	delete document.tables.mail_app_passwords;
	await app.restoreDatabaseRecords(context.database, new TextEncoder().encode(JSON.stringify(document)).buffer);
	assert.equal(context.rows().length, 0);
});
