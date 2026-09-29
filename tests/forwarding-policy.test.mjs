import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import nodemailer from "nodemailer";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-forwarding-bundle-"));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { generateApiKey } from "./src/lib/api-keys.ts";
			export { intakeIncomingMail } from "./src/lib/email/intake.ts";
			export { MAILFLARE_FORWARDED_HEADER } from "./src/lib/email/account-forwarding.ts";
			export { POST as createAccount } from "./src/app/api/accounts/route.ts";
			export { GET as getAccount, PATCH as updateAccount } from "./src/app/api/accounts/[id]/route.ts";
			export { PATCH as updateForwarding } from "./src/app/api/settings/forwarding/route.ts";
			export { PATCH as updateProfile } from "./src/app/api/settings/profile/route.ts";
			export { GET as me } from "./src/app/api/auth/me/route.ts";
			export { PATCH as updateAccountByKey } from "./src/app/api/v1/accounts/[id]/route.ts";
			export { startSmtpListener } from "./server/runtime/smtp.ts";
		`,
		resolveDir: root,
		sourcefile: "forwarding-test-entry.ts",
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
const LICENSE_WORDING = /license|\bpro\b|\bteam\b|paymug|upgrade/i;
const DISABLED = "Email forwarding is turned off for this deployment";

function setDisabledFeatures(t, value) {
	const saved = process.env.BLUEPINE_DISABLED_FEATURES;
	t.after(() => {
		if (saved === undefined) delete process.env.BLUEPINE_DISABLED_FEATURES;
		else process.env.BLUEPINE_DISABLED_FEATURES = saved;
	});
	if (value === undefined) delete process.env.BLUEPINE_DISABLED_FEATURES;
	else process.env.BLUEPINE_DISABLED_FEATURES = value;
}

/** Admin A with mailbox a@example.test; no license is ever activated. */
async function install(t) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-forwarding-"));
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
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mbx-a', 'user-a', 'domain-1', 'a', 'personal', 1);
	`);
	const stored = [];
	const env = {
		DB: database,
		BUCKET: { put: async () => {} },
		INBOUND_QUEUE: { send: async (payload) => { stored.push(payload.to); } },
	};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const tokenA = await app.createSession(env, "user-a");
	const forwardingOf = (email) => database.db.prepare("SELECT forwarding_email FROM users WHERE email = ?").get(email)?.forwarding_email ?? null;
	return { database, env, tokenA, stored, forwardingOf };
}

function call(handler, token, path, { method = "GET", body, params } = {}) {
	const request = new Request(`${BASE}${path}`, {
		method,
		headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	return params ? handler(request, { params: Promise.resolve(params) }) : handler(request);
}

async function createUserB(context) {
	const response = await call(app.createAccount, context.tokenA, "/api/accounts", { method: "POST", body: { username: "b", domainId: "domain-1", password: "password-b-1", role: "user" } });
	assert.equal(response.status, 201);
	const id = context.database.db.prepare("SELECT id FROM users WHERE email = 'b@example.test'").get().id;
	return { id, token: await app.createSession(context.env, id) };
}

/** Deliver one message through the real intake (routing, reject, forward, store) and record what happened. */
async function deliver(context, to, headers = {}) {
	const forwards = [];
	const rejects = [];
	const result = await app.intakeIncomingMail(
		context.env,
		{ from: "sender@elsewhere.test", to, raw: new TextEncoder().encode("Subject: hi\r\n\r\nhello").buffer, headers },
		{
			reject: (reason) => { rejects.push(reason); },
			forward: async (destination, extra) => { forwards.push({ destination, headers: extra }); return true; },
		},
	);
	return { action: result.action, forwards, rejects };
}

test("forwarding works without any license when the policy is on", async (t) => {
	setDisabledFeatures(t, undefined);
	const context = await install(t);
	const response = await call(app.updateForwarding, context.tokenA, "/api/settings/forwarding", { method: "PATCH", body: { forwardingEmail: "a-copy@outside.test" } });
	assert.equal(response.status, 200);
	assert.equal(context.forwardingOf("a@example.test"), "a-copy@outside.test");
	assert.equal(context.database.db.prepare("SELECT count(*) AS count FROM license_settings WHERE state = 'active'").get().count, 0);
	assert.equal((await (await call(app.me, context.tokenA, "/api/auth/me")).json()).user.canForwardEmail, true);

	const delivery = await deliver(context, "a@example.test");
	assert.equal(delivery.action, "store");
	assert.deepEqual(delivery.forwards, [{ destination: "a-copy@outside.test", headers: { "X-Mailflare-Forwarded": "1" } }]);
	assert.deepEqual(context.stored, ["a@example.test"], "forwarding keeps the local copy");
});

test("forwarding disabled: changes are refused, configuration is kept, mail is still delivered locally", async (t) => {
	setDisabledFeatures(t, undefined);
	const context = await install(t);
	const userB = await createUserB(context);
	assert.equal((await call(app.updateForwarding, context.tokenA, "/api/settings/forwarding", { method: "PATCH", body: { forwardingEmail: "a-copy@outside.test" } })).status, 200);

	process.env.BLUEPINE_DISABLED_FEATURES = "accountForwarding";
	const refused = [
		await call(app.updateForwarding, context.tokenA, "/api/settings/forwarding", { method: "PATCH", body: { forwardingEmail: "other@outside.test" } }),
		await call(app.updateProfile, context.tokenA, "/api/settings/profile", { method: "PATCH", body: { name: "A", resetEmail: "", forwardingEmail: "other@outside.test" } }),
		await call(app.updateAccount, context.tokenA, `/api/accounts/${userB.id}`, { method: "PATCH", body: { name: "b", role: "user", disabled: false, canManageMailboxes: false, forwardingEmail: "b-copy@outside.test" }, params: { id: userB.id } }),
	];
	for (const response of refused) {
		assert.equal(response.status, 403);
		const { error } = await response.json();
		assert.equal(error, DISABLED);
		assert.doesNotMatch(error, LICENSE_WORDING);
	}
	assert.equal(context.forwardingOf("a@example.test"), "a-copy@outside.test", "stored configuration is kept");
	assert.equal(context.forwardingOf("b@example.test"), null);
	assert.equal((await (await call(app.me, context.tokenA, "/api/auth/me")).json()).user.canForwardEmail, false);
	assert.equal((await (await call(app.getAccount, context.tokenA, `/api/accounts/${userB.id}`, { params: { id: userB.id } })).json()).account.canForwardEmail, false);

	const delivery = await deliver(context, "a@example.test");
	assert.equal(delivery.action, "store");
	assert.deepEqual(delivery.forwards, [], "stored forwarding does not run while the feature is off");
	assert.deepEqual(context.stored, ["a@example.test"], "local delivery continues");

	// Re-enabled: the stored address applies again without being re-entered.
	delete process.env.BLUEPINE_DISABLED_FEATURES;
	const resumed = await deliver(context, "a@example.test");
	assert.deepEqual(resumed.forwards.map((row) => row.destination), ["a-copy@outside.test"]);
	assert.deepEqual(context.stored, ["a@example.test", "a@example.test"]);
});

test("a user cannot change another user's forwarding", async (t) => {
	setDisabledFeatures(t, undefined);
	const context = await install(t);
	const userB = await createUserB(context);

	// 1. A configures A's forwarding.
	assert.equal((await call(app.updateForwarding, context.tokenA, "/api/settings/forwarding", { method: "PATCH", body: { forwardingEmail: "a-copy@outside.test" } })).status, 200);
	// 2. B's own forwarding route only ever writes B's row.
	assert.equal((await call(app.updateForwarding, userB.token, "/api/settings/forwarding", { method: "PATCH", body: { forwardingEmail: "b-copy@outside.test" } })).status, 200);
	assert.equal(context.forwardingOf("b@example.test"), "b-copy@outside.test");
	// 3. B cannot reach A through the admin routes.
	const adminAttempt = await call(app.updateAccount, userB.token, "/api/accounts/user-a", { method: "PATCH", body: { name: "A", role: "admin", disabled: false, canManageMailboxes: false, forwardingEmail: "attacker@outside.test" }, params: { id: "user-a" } });
	assert.equal(adminAttempt.status, 403);
	assert.equal((await adminAttempt.json()).error, "Forbidden");
	const { fullKey, prefix, hash } = app.generateApiKey();
	context.database.db.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, created_at) VALUES ('key-b', ?, 'b', ?, ?, '[\"accounts\"]', 1)").run(userB.id, prefix, hash);
	assert.equal((await call(app.updateAccountByKey, fullKey, "/api/v1/accounts/user-a", { method: "PATCH", body: { name: "A", role: "admin", disabled: false, canManageMailboxes: false, forwardingEmail: "attacker@outside.test" }, params: { id: "user-a" } })).status, 401);
	// 4-5. Back to A: A's configuration is untouched and A still controls it.
	assert.equal(context.forwardingOf("a@example.test"), "a-copy@outside.test");
	assert.equal((await (await call(app.me, context.tokenA, "/api/auth/me")).json()).user.forwardingEmail, "a-copy@outside.test");
	assert.equal((await call(app.updateForwarding, context.tokenA, "/api/settings/forwarding", { method: "PATCH", body: { forwardingEmail: "" } })).status, 200);
	assert.equal(context.forwardingOf("a@example.test"), null);
	assert.equal(context.forwardingOf("b@example.test"), "b-copy@outside.test");
	// A's delivery follows A's settings only; B's forwarding follows B's.
	assert.deepEqual((await deliver(context, "a@example.test")).forwards, []);
	assert.deepEqual((await deliver(context, "b@example.test")).forwards.map((row) => row.destination), ["b-copy@outside.test"]);
});

test("loop protection: forwarded mail is tagged X-Mailflare-Forwarded and never forwarded again", async (t) => {
	setDisabledFeatures(t, undefined);
	const context = await install(t);
	const userB = await createUserB(context);
	assert.equal(app.MAILFLARE_FORWARDED_HEADER, "X-Mailflare-Forwarded");
	// A forwards to B and B forwards back to A: the classic loop.
	assert.equal((await call(app.updateForwarding, context.tokenA, "/api/settings/forwarding", { method: "PATCH", body: { forwardingEmail: "b@example.test" } })).status, 200);
	assert.equal((await call(app.updateForwarding, userB.token, "/api/settings/forwarding", { method: "PATCH", body: { forwardingEmail: "a@example.test" } })).status, 200);

	const first = await deliver(context, "a@example.test");
	assert.deepEqual(first.forwards, [{ destination: "b@example.test", headers: { "X-Mailflare-Forwarded": "1" } }]);
	// The forwarded copy arrives back carrying the header (as the intake parses it: lower-cased).
	const second = await deliver(context, "b@example.test", { "x-mailflare-forwarded": "1" });
	assert.equal(second.action, "store");
	assert.deepEqual(second.forwards, [], "an already-forwarded message is stored but not forwarded again");
	assert.deepEqual(context.stored, ["a@example.test", "b@example.test"]);
	// Forwarding to the recipient's own address is ignored.
	assert.equal((await call(app.updateForwarding, context.tokenA, "/api/settings/forwarding", { method: "PATCH", body: { forwardingEmail: "a@example.test" } })).status, 200);
	assert.deepEqual((await deliver(context, "a@example.test")).forwards, []);
});

test("routing is unchanged: local delivery works and unknown or foreign recipients are rejected", async (t) => {
	for (const disabled of [undefined, "accountForwarding"]) {
		setDisabledFeatures(t, disabled);
		const context = await install(t);
		assert.equal((await deliver(context, "a@example.test")).action, "store");
		for (const to of ["nobody@example.test", "someone@foreign.test"]) {
			const result = await deliver(context, to);
			assert.equal(result.action, "reject", to);
			assert.equal(result.rejects.length, 1, to);
			assert.deepEqual(result.forwards, [], to);
		}
		assert.deepEqual(context.stored, ["a@example.test"]);
	}
});

test("Node SMTP: A forwards to B and B back to A, and the loop marker stops the second hop", async (t) => {
	setDisabledFeatures(t, undefined);
	const context = await install(t);
	const userB = await createUserB(context);
	assert.equal((await call(app.updateForwarding, context.tokenA, "/api/settings/forwarding", { method: "PATCH", body: { forwardingEmail: "b@example.test" } })).status, 200);
	assert.equal((await call(app.updateForwarding, userB.token, "/api/settings/forwarding", { method: "PATCH", body: { forwardingEmail: "a@example.test" } })).status, 200);

	const relayed = [];
	const mailer = { sendRaw: async (from, to, raw) => { relayed.push({ from, to, raw: Buffer.from(raw).toString("latin1") }); return true; } };
	const server = app.startSmtpListener(context.env, mailer, { port: 0, host: "127.0.0.1", maxSize: 1_000_000, tls: null });
	if (!server.server.listening) await once(server.server, "listening");
	const transport = nodemailer.createTransport({ host: "127.0.0.1", port: server.server.address().port, secure: false, ignoreTLS: true });
	t.after(async () => {
		transport.close();
		await new Promise((resolve) => server.close(resolve));
	});
	const markers = (raw) => (raw.split(/\r?\n\r?\n/)[0].match(/^x-mailflare-forwarded:/gim) ?? []).length;

	// Hop 1: mail to A is stored for A and forwarded to B, tagged once.
	await transport.sendMail({ envelope: { from: "sender@elsewhere.test", to: "a@example.test" }, raw: "From: sender@elsewhere.test\r\nTo: a@example.test\r\nSubject: Loop test\r\n\r\nhello\r\n" });
	assert.equal(relayed.length, 1);
	assert.deepEqual({ from: relayed[0].from, to: relayed[0].to }, { from: "sender@elsewhere.test", to: "b@example.test" });
	assert.equal(markers(relayed[0].raw), 1);
	assert.deepEqual(context.stored, ["a@example.test"]);

	// Hop 2: the forwarded copy arrives for B, as a relay would deliver it. B forwards to A,
	// but the marker makes intake store it for B and stop.
	await transport.sendMail({ envelope: { from: "sender@elsewhere.test", to: "b@example.test" }, raw: relayed[0].raw });
	assert.equal(relayed.length, 1, "no second forward: the loop is broken by the marker");
	assert.deepEqual(context.stored, ["a@example.test", "b@example.test"]);

	// Control: an untagged message to B is forwarded normally, so B's forwarding is genuinely active.
	await transport.sendMail({ envelope: { from: "sender@elsewhere.test", to: "b@example.test" }, raw: "Subject: Direct to B\r\n\r\nhi\r\n" });
	assert.deepEqual(relayed.slice(1).map((row) => row.to), ["a@example.test"]);
	assert.equal(markers(relayed[1].raw), 1);
});
