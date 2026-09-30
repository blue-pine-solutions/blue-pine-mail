import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * Shared harness for the A4 IMAP tests: the real protocol engine, listener, A2 and A3 over
 * SQLite and the file bucket (no Workers bindings), and a raw IMAP client that speaks to
 * either an in-memory transport or a real TLS socket and parses responses exactly,
 * literals included.
 */
export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function loadApp(name) {
	const bundleDirectory = mkdtempSync(join(root, "node_modules", `mailflare-${name}-`));
	await build({
		stdin: {
			contents: `
				export { ImapSession, PREAUTH_CAPABILITIES, AUTH_CAPABILITIES } from "./src/lib/imap-server/session.ts";
				export { MetadataCache } from "./src/lib/imap-server/metadata-cache.ts";
				export * as mime from "./src/lib/imap-server/mime.ts";
				export * as names from "./src/lib/imap-server/mailbox-names.ts";
				export { MessageView } from "./src/lib/imap-server/fetch.ts";
				export { startImapListener, readImapConfig, loadTlsMaterial, DEFAULT_IMAP_LIMITS } from "./server/runtime/imap.ts";
				export * as limits from "./server/runtime/imap-limits.ts";
				export * as imap from "./src/lib/imap/service.ts";
				export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
				export { applyMigrations } from "./server/runtime/migrate.ts";
				export { FileBucket } from "./server/runtime/file-bucket.ts";
				export * as credentials from "./src/lib/mail-app-passwords/utils.ts";
				export { generateApiKey } from "./src/lib/api-keys.ts";
				export { hashPassword } from "./src/lib/auth/password.ts";
				export { createSession } from "./src/lib/auth/session.ts";
				export { sendEmail } from "./src/lib/email/send.ts";
				export { POST as statusRoute } from "./src/app/api/messages/[messageId]/status/route.ts";
				export { POST as starRoute } from "./src/app/api/messages/[messageId]/star/route.ts";
				export { default as PostalMime } from "postal-mime";
			`,
			resolveDir: root,
			sourcefile: `${name}-entry.ts`,
			loader: "ts",
		},
		outfile: join(bundleDirectory, "entry.mjs"),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		jsx: "automatic",
		tsconfig: join(root, "tsconfig.json"),
		packages: "external",
		alias: {
			"next/headers": "next/headers.js",
			"next/server": "next/server.js",
			"next/link": "next/link.js",
			"next/navigation": "next/navigation.js",
			"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
		},
		logLevel: "silent",
	});
	const app = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
	return { app, cleanup: () => rmSync(bundleDirectory, { recursive: true, force: true }) };
}

export const WEB_PASSWORD = "web-password-a-1";

/**
 * A owns personal mailbox `a` (custom folders) and shared mailbox `sales`, where B has
 * read_only access. X owns an unrelated mailbox. Credentials are minted like A2 does.
 */
export async function install(app, t) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-imap-a4-"));
	const database = new app.SqliteDatabase(join(directory, "mailflare.sqlite"));
	await app.applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('user-a', 'a@example.test', ?, 'A', 'admin', 1)").run(app.hashPassword(WEB_PASSWORD));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
			('user-b', 'b@example.test', 'h', 'B', 'user', 1),
			('user-x', 'x@example.test', 'h', 'X', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-a', 'example.test', 'manual', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, type, created_at) VALUES
			('mbx-a', 'user-a', 'domain-1', 'a', 'Ann Example', 'personal', 1),
			('mbx-s', 'user-a', 'domain-1', 'sales', 'Sales', 'shared', 1),
			('mbx-x', 'user-x', 'domain-1', 'x', NULL, 'personal', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('acc-b', 'mbx-s', 'user-b', 'read_only', 1);
		INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES
			('fld-work', 'user-a', 'mbx-a', 'Work', 1),
			('fld-x', 'user-x', 'mbx-x', 'Private', 1);
	`);
	const sent = [];
	const env = {
		DB: database,
		BUCKET: new app.FileBucket(join(directory, "blobs")),
		EMAIL: { async send(message) { sent.push(message); return { messageId: `<provider-${sent.length}@mail.example.test>` }; } },
		OUTBOUND_QUEUE: { async send() {} },
	};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => {
		delete globalThis.__mailflareNodeEnv;
		try { database.db.close(); } catch {}
		rmSync(directory, { recursive: true, force: true });
	});
	let counter = 0;
	const context = {
		database,
		env,
		directory,
		sent,
		row: (id) => database.db.prepare("SELECT * FROM messages WHERE id = ?").get(id),
		/** A mail app password as A2 issues it; returns the credential and its row id. */
		credential(userId, mailboxId, scopes = ["imap"]) {
			const { credential, publicId } = app.credentials.generateMailAppCredential();
			const id = `map-${++counter}`;
			return app.credentials.hashMailAppCredential(credential).then((hash) => {
				database.db.prepare("INSERT INTO mail_app_passwords (id, user_id, mailbox_id, label, public_id, secret_hash, scopes, created_at) VALUES (?, ?, ?, 'test', ?, ?, ?, 1)").run(id, userId, mailboxId, publicId, hash, JSON.stringify(scopes));
				return { credential, id };
			});
		},
		/** Store raw octets as received mail. */
		async deliver(id, raw, values = {}) {
			const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
			await env.BUCKET.put(`inbound/${id}.eml`, bytes);
			const row = { id, user_id: "user-a", mailbox_id: "mbx-a", direction: "inbound", from_addr: "sender@elsewhere.test", to_addr: "a@example.test", status: "received", raw_r2_key: `inbound/${id}.eml`, created_at: 1790000000 + ++counter, ...values };
			const columns = Object.keys(row);
			database.db.prepare(`INSERT INTO messages (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => row[column]));
			return bytes;
		},
	};
	return context;
}

const decoder = new TextDecoder("latin1");
export const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

/**
 * A raw IMAP client over any byte transport. Responses are parsed into units: one line
 * with any literals inlined, exactly as sent (as a latin1 byte string).
 */
export class RawClient {
	constructor() {
		this.buffer = Buffer.alloc(0);
		this.waiters = [];
		this.ended = false;
		this.tag = 0;
	}

	accept(bytes) {
		this.buffer = Buffer.concat([this.buffer, Buffer.from(bytes)]);
		this.wake();
	}

	end() {
		this.ended = true;
		this.wake();
	}

	wake() {
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter();
	}

	async waitFor(predicate, timeoutMs = 10_000) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const result = predicate();
			if (result !== undefined) return result;
			if (this.ended) return null;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`timed out waiting for server; buffered: ${JSON.stringify(latin1(this.buffer).slice(0, 300))}`);
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, remaining);
				this.waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}

	/** The next complete response unit, or null at end of stream. */
	async unit(timeoutMs) {
		return this.waitFor(() => {
			let position = 0;
			let text = "";
			const literals = [];
			for (;;) {
				const newline = this.buffer.indexOf("\r\n", position);
				if (newline < 0) return undefined;
				const line = latin1(this.buffer.subarray(position, newline));
				text += line;
				const literal = /\{(\d+)\}$/.exec(line);
				if (!literal) {
					this.buffer = this.buffer.subarray(newline + 2);
					return { text, literals };
				}
				const size = Number(literal[1]);
				const start = newline + 2;
				if (this.buffer.length < start + size) return undefined;
				const data = this.buffer.subarray(start, start + size);
				literals.push(Buffer.from(data));
				text += `\r\n${latin1(data)}`;
				position = start + size;
			}
		}, timeoutMs);
	}

	nextTag() {
		return `t${++this.tag}`;
	}

	/** Send a raw command line and collect every unit up to its tagged completion. */
	async command(text, { tag = this.nextTag(), timeoutMs } = {}) {
		this.write(`${tag} ${text}\r\n`);
		return this.collect(tag, timeoutMs);
	}

	async collect(tag, timeoutMs) {
		const untagged = [];
		for (;;) {
			const unit = await this.unit(timeoutMs);
			if (!unit) return { untagged, tagged: null, closed: true };
			if (unit.text.startsWith(`${tag} `)) return { untagged, tagged: unit.text, ok: unit.text.startsWith(`${tag} OK`), literals: untagged.flatMap((item) => item.literals) };
			untagged.push(unit);
		}
	}

	async login(username, password) {
		const quote = (value) => `"${value.replace(/["\\]/g, "\\$&")}"`;
		return this.command(`LOGIN ${quote(username)} ${quote(password)}`);
	}
}

/** A session driven in memory: no socket, same protocol engine. */
export function memoryClient(app, env, hostOverrides = {}) {
	const client = new RawClient();
	const logs = [];
	const host = {
		write: async (bytes) => client.accept(bytes),
		close: () => client.end(),
		pause() {},
		resume() {},
		delay: async () => {},
		log: (event) => logs.push(event),
		beforeAuthenticate: () => ({ allowed: true, delayMs: 0 }),
		afterAuthenticate() {},
		claimUserSlot: () => true,
		acquireRead: async () => () => {},
		onAuthenticated() {},
		...hostOverrides,
	};
	const session = new app.ImapSession(env, host, { serverName: "Blue Pine Solutions Mail", cache: new app.MetadataCache() });
	client.write = (text) => session.receive(typeof text === "string" ? Buffer.from(text, "latin1") : text);
	client.session = session;
	client.logs = logs;
	return { client, session, start: () => session.start().then(() => client.unit()) };
}

/** A self-signed certificate for 127.0.0.1/localhost, generated now with openssl. */
export function makeCertificate(t, cn = "localhost") {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-imap-tls-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const keyPath = join(directory, "key.pem");
	const certPath = join(directory, "cert.pem");
	execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "2", "-subj", `/CN=${cn}`, "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
	return { keyPath, certPath, directory, write: (name, content) => { const path = join(directory, name); writeFileSync(path, content); return path; } };
}

/** A raw client over a real TLS connection. */
export function tlsClient(port, options = {}) {
	const client = new RawClient();
	return new Promise((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ...options }, () => resolve(client));
		socket.on("data", (chunk) => client.accept(chunk));
		socket.on("close", () => client.end());
		socket.on("error", (error) => {
			client.error = error;
			reject(error);
		});
		client.write = (text) => socket.write(typeof text === "string" ? Buffer.from(text, "latin1") : text);
		client.socket = socket;
		client.close = () => socket.destroy();
	});
}

export function assertTagged(result, status, pattern) {
	assert.ok(result.tagged, `no tagged response (closed: ${result.closed})`);
	assert.match(result.tagged, new RegExp(`^\\S+ ${status}\\b`), result.tagged);
	if (pattern) assert.match(result.tagged, pattern);
}

export { decoder };

/** Parse an IMAP data item (lists, quoted strings, literals, NIL, atoms) from a byte string. */
export function parseSexp(text, start = 0) {
	let index = start;
	const skip = () => {
		while (text[index] === " ") index += 1;
	};
	const value = () => {
		skip();
		const char = text[index];
		if (char === "(") {
			index += 1;
			const list = [];
			for (;;) {
				skip();
				if (text[index] === ")") {
					index += 1;
					return list;
				}
				if (index >= text.length) throw new Error("unterminated list");
				list.push(value());
			}
		}
		if (char === '"') {
			let out = "";
			index += 1;
			while (text[index] !== '"') {
				if (text[index] === "\\") index += 1;
				out += text[index++];
			}
			index += 1;
			return out;
		}
		if (char === "{") {
			const close = text.indexOf("}", index);
			const size = Number(text.slice(index + 1, close));
			const begin = close + 3;
			index = begin + size;
			return text.slice(begin, index);
		}
		let atom = "";
		let bracket = false;
		while (index < text.length && (bracket || !" ()".includes(text[index]))) {
			if (text[index] === "[") bracket = true;
			else if (text[index] === "]") bracket = false;
			atom += text[index++];
		}
		if (atom === "NIL") return null;
		return /^\d+$/.test(atom) ? Number(atom) : atom;
	};
	const result = value();
	return { value: result, end: index };
}

/** The attributes of one `* n FETCH (...)` unit as a map from item name to value. */
export function fetchAttributes(unitText) {
	const open = unitText.indexOf("(");
	const list = parseSexp(unitText, open).value;
	const out = {};
	for (let index = 0; index < list.length; index += 2) out[String(list[index])] = list[index + 1];
	return out;
}
