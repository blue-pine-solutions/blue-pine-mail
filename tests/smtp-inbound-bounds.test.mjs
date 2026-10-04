import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-smtp-bounds-"));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { BoundedDataBuffer, INBOUND_DISCARD_ALLOWANCE_BYTES, INBOUND_SMTP_MAX_CLIENTS, startSmtpListener } from "./server/runtime/smtp.ts";
		`,
		resolveDir: root,
		sourcefile: "smtp-bounds-entry.ts",
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

const LIMIT = 100_000;

test("BoundedDataBuffer keeps an exactly-limit message and rejects limit+1", () => {
	const exact = new app.BoundedDataBuffer(10);
	exact.push(Buffer.alloc(4, 1));
	exact.push(Buffer.alloc(6, 2));
	assert.equal(exact.oversized, false);
	assert.equal(exact.retained, 10);
	assert.equal(exact.take()?.length, 10);

	const over = new app.BoundedDataBuffer(10);
	over.push(Buffer.alloc(10, 1));
	over.push(Buffer.alloc(1, 2));
	assert.equal(over.oversized, true);
	assert.equal(over.retained, 0);
	assert.equal(over.take(), null);
});

test("a chunk that crosses the limit is not kept, and nothing after it is retained", () => {
	const buffer = new app.BoundedDataBuffer(1000);
	buffer.push(Buffer.alloc(900));
	buffer.push(Buffer.alloc(500)); // crosses the boundary
	assert.equal(buffer.oversized, true);
	assert.equal(buffer.retained, 0);
	for (let index = 0; index < 1000; index++) buffer.push(Buffer.alloc(4096));
	assert.equal(buffer.retained, 0);
	assert.equal(buffer.received, 900 + 500 + 1000 * 4096);
	assert.equal(buffer.take(), null);
});

test("retained bytes stay at the same ceiling whether the peer sends a little or a lot past the limit", () => {
	const run = (extra) => {
		const buffer = new app.BoundedDataBuffer(LIMIT);
		let peak = 0;
		for (let sent = 0; sent < LIMIT + extra; sent += 8192) {
			buffer.push(Buffer.alloc(8192));
			peak = Math.max(peak, buffer.retained);
		}
		return { peak, final: buffer.retained };
	};
	const small = run(10_000);
	const large = run(50_000_000);
	assert.ok(small.peak <= LIMIT && large.peak <= LIMIT, "never above the limit");
	assert.equal(small.peak, large.peak, "ceiling independent of total stream size");
	assert.equal(small.final, 0);
	assert.equal(large.final, 0);
});

async function listener(t) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-smtp-bounds-"));
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
	const puts = [];
	const env = { DB: database, BUCKET: { put: async (...args) => { puts.push(args[0]); } }, INBOUND_QUEUE: { send: async (payload) => { stored.push(payload.to); } } };
	globalThis.__mailflareNodeEnv = env;
	const mailer = { sendRaw: async (from, to) => { relayed.push({ from, to }); return true; } };
	const server = app.startSmtpListener(env, mailer, { port: 0, host: "127.0.0.1", maxSize: LIMIT, tls: null });
	if (!server.server.listening) await once(server.server, "listening");
	t.after(async () => {
		await new Promise((resolve) => server.close(resolve));
		delete globalThis.__mailflareNodeEnv;
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return { server, port: server.server.address().port, stored, relayed, puts };
}

/** Drive DATA with about `bodyBytes` of body; resolves with the final reply line, or "closed" if the peer hangs up first. */
function sendMessage(port, bodyBytes) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1");
		let buffer = "";
		let step = 0;
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		const commands = ["EHLO test.example\r\n", "MAIL FROM:<sender@elsewhere.test>\r\n", "RCPT TO:<sales@example.test>\r\n", "DATA\r\n"];
		socket.on("error", () => finish("closed"));
		socket.on("close", () => finish("closed"));
		socket.setTimeout(20_000, () => reject(new Error("timeout")));
		socket.on("data", (data) => {
			buffer += data.toString("latin1");
			if (!buffer.endsWith("\r\n")) return;
			const lines = buffer.split("\r\n").filter(Boolean);
			const last = lines[lines.length - 1];
			if (/^\d{3}-/.test(last)) return;
			buffer = "";
			if (step < commands.length) {
				socket.write(commands[step++]);
				return;
			}
			if (step === commands.length) {
				step++;
				assert.match(last, /^354/);
				const line = `${"x".repeat(998)}\r\n`;
				socket.write("From: sender@elsewhere.test\r\nTo: sales@example.test\r\nSubject: s\r\nMessage-ID: <m@elsewhere.test>\r\n\r\n");
				let remaining = bodyBytes;
				const pump = () => {
					while (remaining > 0 && !socket.destroyed) {
						const piece = line.repeat(Math.min(64, Math.ceil(remaining / line.length)));
						remaining -= piece.length;
						if (!socket.write(piece)) return void socket.once("drain", pump);
					}
					if (!socket.destroyed) socket.write(".\r\n");
				};
				pump();
				return;
			}
			finish(last);
		});
	});
}

test("a normal inbound message is accepted and stored as before", async (t) => {
	const { port, stored, relayed } = await listener(t);
	const reply = await sendMessage(port, 20_000);
	assert.match(reply, /^250/);
	assert.deepEqual(stored, ["sales@example.test"]);
	assert.equal(relayed.length, 1);
});

test("oversized inbound DATA is refused with 552 and nothing is stored", async (t) => {
	const { port, stored, relayed, puts } = await listener(t);
	const reply = await sendMessage(port, LIMIT + 200_000);
	assert.match(reply, /^552/);
	assert.deepEqual(stored, []);
	assert.deepEqual(relayed, []);
	assert.deepEqual(puts, []);
});

test("a peer that streams far past the limit is disconnected with nothing stored", async (t) => {
	const { port, stored, relayed, puts } = await listener(t);
	const reply = await sendMessage(port, LIMIT + app.INBOUND_DISCARD_ALLOWANCE_BYTES * 4);
	assert.equal(reply, "closed", "the connection is dropped once the discard allowance is spent");
	assert.deepEqual(stored, []);
	assert.deepEqual(relayed, []);
	assert.deepEqual(puts, []);
	// The listener is still serving ordinary mail afterwards.
	assert.match(await sendMessage(port, 1_000), /^250/);
});

test("the inbound listener is configured with the connection cap", async (t) => {
	const { server } = await listener(t);
	assert.equal(app.INBOUND_SMTP_MAX_CLIENTS, 25);
	assert.equal(server.options.maxClients, app.INBOUND_SMTP_MAX_CLIENTS);
});
