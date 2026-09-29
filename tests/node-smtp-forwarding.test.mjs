import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import nodemailer from "nodemailer";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-smtp-bundle-"));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { parseHeaders, startSmtpListener, withAddedHeaders } from "./server/runtime/smtp.ts";
		`,
		resolveDir: root,
		sourcefile: "smtp-test-entry.ts",
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

const MARKER = { "X-Mailflare-Forwarded": "1" };
const add = (text, headers = MARKER) => app.withAddedHeaders(Buffer.from(text, "latin1"), headers).toString("latin1");
const headerBlock = (text) => text.split(/\r?\n\r?\n/)[0];
const markerCount = (text) => (headerBlock(text).match(/^x-mailflare-forwarded:/gim) ?? []).length;

test("the loop marker is added once at the top and nothing else changes", () => {
	const original = "From: a@example.test\r\nTo: b@example.test\r\nSubject: Hello\r\n\r\nX-Mailflare-Forwarded: 0\r\nBody line\r\n";
	const forwarded = add(original);
	assert.equal(forwarded, `X-Mailflare-Forwarded: 1\r\n${original}`);
	assert.equal(markerCount(forwarded), 1);
	assert.ok(forwarded.endsWith("\r\n\r\nX-Mailflare-Forwarded: 0\r\nBody line\r\n"), "a lookalike line in the body is untouched");
});

test("an existing marker, folded or not, is replaced rather than duplicated", () => {
	assert.equal(
		add("X-Mailflare-Forwarded: 1\r\nSubject: s\r\n\r\nbody"),
		"X-Mailflare-Forwarded: 1\r\nSubject: s\r\n\r\nbody",
	);
	assert.equal(
		add("Subject: s\r\nx-mailflare-forwarded:\r\n 1\r\nTo: t@example.test\r\n\r\nbody"),
		"X-Mailflare-Forwarded: 1\r\nSubject: s\r\nTo: t@example.test\r\n\r\nbody",
	);
	assert.equal(add("Subject: s\r\nX-Mailflare-Forwarded: 1\r\n\r\nbody"), "X-Mailflare-Forwarded: 1\r\nSubject: s\r\n\r\nbody");
	assert.equal(add("X-Mailflare-Forwarded: 1\r\n\r\nbody"), "X-Mailflare-Forwarded: 1\r\n\r\nbody");
});

test("line endings, header-only messages and binary bodies are preserved", () => {
	assert.equal(add("Subject: s\n\nbody\n"), "X-Mailflare-Forwarded: 1\nSubject: s\n\nbody\n");
	assert.equal(add("Subject: s\r\n"), "X-Mailflare-Forwarded: 1\r\nSubject: s\r\n");
	assert.equal(add("Subject: s"), "X-Mailflare-Forwarded: 1\r\nSubject: s");
	assert.equal(add(""), "X-Mailflare-Forwarded: 1");
	const binary = Buffer.concat([Buffer.from("Subject: s\r\n\r\n"), Buffer.from([0, 255, 128, 10, 13, 200])]);
	const forwarded = app.withAddedHeaders(binary, MARKER);
	assert.deepEqual(forwarded.subarray(forwarded.length - 6), Buffer.from([0, 255, 128, 10, 13, 200]));
	assert.equal(app.withAddedHeaders(binary, {}), binary, "no headers requested, message relayed untouched");
});

test("header names and values that could inject lines are refused", () => {
	assert.throws(() => add("Subject: s\r\n\r\nb", { "X-Mailflare-Forwarded": "1\r\nBcc: victim@example.test" }));
	assert.throws(() => add("Subject: s\r\n\r\nb", { "Bad Name": "1" }));
});

/** A real Node SMTP listener over a migrated database, with the outbound relay captured. */
async function listener(t) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-smtp-"));
	const database = new app.SqliteDatabase(join(directory, "mailflare.sqlite"));
	await app.applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('user-a', 'a@example.test', 'hash', 'A', 'admin', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-a', 'example.test', 'manual', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mbx-a', 'user-a', 'domain-1', 'a', 'personal', 1);
		INSERT INTO routing_rules (id, user_id, domain_id, scope, pattern, action, forward_to, mailbox_id, keep_copy, created_at)
		VALUES ('rule-catchall', 'user-a', 'domain-1', 'domain', '*', 'forward', 'outside@elsewhere.test', 'mbx-a', 1, 1);
	`);
	const stored = [];
	const relayed = [];
	const env = { DB: database, BUCKET: { put: async () => {} }, INBOUND_QUEUE: { send: async (payload) => { stored.push(payload.to); } } };
	globalThis.__mailflareNodeEnv = env;
	const mailer = { sendRaw: async (from, to, raw) => { relayed.push({ from, to, raw: raw.toString("latin1") }); return true; } };
	const server = app.startSmtpListener(env, mailer, { port: 0, host: "127.0.0.1", maxSize: 1_000_000, tls: null });
	if (!server.server.listening) await once(server.server, "listening");
	const transport = nodemailer.createTransport({ host: "127.0.0.1", port: server.server.address().port, secure: false, ignoreTLS: true });
	// Close the listener and SQLite before removing the directory: Windows cannot delete an open file.
	t.after(async () => {
		transport.close();
		await new Promise((resolve) => server.close(resolve));
		delete globalThis.__mailflareNodeEnv;
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return { transport, stored, relayed };
}

test("the Node SMTP runtime relays forwarded mail with X-Mailflare-Forwarded: 1", async (t) => {
	const { transport, stored, relayed } = await listener(t);
	await transport.sendMail({ envelope: { from: "sender@elsewhere.test", to: "sales@example.test" }, raw: "From: sender@elsewhere.test\r\nTo: sales@example.test\r\nSubject: Quote\r\nMessage-ID: <q1@elsewhere.test>\r\n\r\nPlease quote.\r\n" });

	assert.equal(relayed.length, 1);
	assert.deepEqual({ from: relayed[0].from, to: relayed[0].to }, { from: "sender@elsewhere.test", to: "outside@elsewhere.test" }, "envelope unchanged");
	const copy = relayed[0].raw;
	assert.equal(markerCount(copy), 1);
	assert.match(headerBlock(copy), /^X-Mailflare-Forwarded: 1$/m);
	for (const header of ["From: sender@elsewhere.test", "To: sales@example.test", "Subject: Quote", "Message-ID: <q1@elsewhere.test>"]) {
		assert.ok(headerBlock(copy).split(/\r?\n/).includes(header), header);
	}
	assert.match(copy, /\r\n\r\nPlease quote\.\r\n$/);
	assert.deepEqual(stored, ["sales@example.test"], "keep-copy still stores locally");

	// What intake reads when this copy comes back in: the message counts as already forwarded.
	assert.equal(app.parseHeaders(Buffer.from(copy, "latin1"))["x-mailflare-forwarded"], "1");
});

test("a message that already carries the marker is relayed with exactly one", async (t) => {
	const { transport, relayed } = await listener(t);
	await transport.sendMail({ envelope: { from: "sender@elsewhere.test", to: "sales@example.test" }, raw: "Subject: Again\r\nX-Mailflare-Forwarded: 1\r\n\r\nbody\r\n" });
	assert.equal(relayed.length, 1);
	assert.equal(markerCount(relayed[0].raw), 1);
});
