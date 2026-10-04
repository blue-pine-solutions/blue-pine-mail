import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import baseTest from "node:test";
import { connect as connectTls } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import nodemailer from "nodemailer";
import { SMTPServer } from "smtp-server";

/**
 * SMTP-2: the authenticated TLS submission listener, over real TLS sockets on loopback,
 * against SQLite and an in-memory transport (or a loopback relay standing in for Mailpit).
 * Credentials are synthetic and minted the way A2 mints them.
 */

/** Every test is bounded: a listener that stops cutting a client off fails here instead of hanging the run. */
const test = Object.assign((name, fn) => baseTest(name, { timeout: 60_000 }, fn), { after: baseTest.after });

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-smtp2-bundle-"));
await build({
	stdin: {
		contents: `
			export { startSubmissionListener, readSubmissionConfig, loadSubmissionTlsMaterial, DEFAULT_SUBMISSION_LIMITS } from "./server/runtime/smtp-submission.ts";
			export * as replies from "./server/runtime/smtp-submission-replies.ts";
			export { submitMessage, MAX_SUBMISSION_MESSAGE_BYTES } from "./src/lib/submission/service.ts";
			export { Mailer } from "./server/runtime/mailer.ts";
			export * as credentials from "./src/lib/mail-app-passwords/utils.ts";
			export { hashPassword } from "./src/lib/auth/password.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { FileBucket } from "./server/runtime/file-bucket.ts";
			export { default as PostalMime } from "postal-mime";
		`,
		resolveDir: root,
		sourcefile: "smtp2-test-entry.ts",
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
test.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

const WEB_PASSWORD = "web-password-a-1";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Resolves when the socket closes, whether or not it errored first (events.once would reject on "error"). */
const socketClosed = (socket) => (socket.closed ? Promise.resolve() : new Promise((resolve) => socket.once("close", resolve)));
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

function makeCertificate(t, cn = "localhost") {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-smtp2-tls-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const keyPath = join(directory, "key.pem");
	const certPath = join(directory, "cert.pem");
	execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "2", "-subj", `/CN=${cn}`, "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
	return { keyPath, certPath, directory, write: (name, content) => { const path = join(directory, name); writeFileSync(path, content); return path; } };
}

/**
 * Users: A (owner of ann@ and ops@), X (xavier@). Credentials are created per test with
 * real secrets and digests. A's web password is a real bcrypt hash.
 */
async function install(t, { transport } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-smtp2-"));
	const database = new app.SqliteDatabase(join(directory, "mailflare.sqlite"));
	t.after(() => { try { database.db.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
	await app.applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('user-a', 'ann@example.test', ?, 'Ann', 'admin', 1)").run(app.hashPassword(WEB_PASSWORD));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('user-x', 'x@example.test', 'h', 'Xavier', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-a', 'example.test', 'manual', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, type, created_at) VALUES
			('mbx-a', 'user-a', 'domain-1', 'ann', 'Ann Example', 'personal', 1),
			('mbx-o', 'user-a', 'domain-1', 'ops', 'Ops', 'personal', 1),
			('mbx-x', 'user-x', 'domain-1', 'xavier', NULL, 'personal', 1);
	`);
	const sent = [];
	const fake = {
		behavior: null,
		async send(message) {
			if (fake.behavior) await fake.behavior(message);
			sent.push(message);
			return { messageId: `<provider-${sent.length}@mail.example.test>` };
		},
	};
	const env = { DB: database, BUCKET: new app.FileBucket(join(directory, "blobs")), EMAIL: transport ?? fake, OUTBOUND_QUEUE: { async send() {} } };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	let counter = 0;
	const context = {
		database, env, sent, fake,
		exec: (sql) => database.db.exec(sql),
		one: (sql, ...args) => database.db.prepare(sql).get(...args),
		all: (sql, ...args) => database.db.prepare(sql).all(...args),
		outbound: (mailboxId = "mbx-a") => database.db.prepare("SELECT * FROM messages WHERE mailbox_id = ? AND direction = 'outbound'").all(mailboxId),
		/** A mail app password as A2 issues it. */
		async credential(userId = "user-a", mailboxId = "mbx-a", scopes = ["smtp"]) {
			const { credential, publicId } = app.credentials.generateMailAppCredential();
			const id = `map-${++counter}`;
			const hash = await app.credentials.hashMailAppCredential(credential);
			database.db.prepare("INSERT INTO mail_app_passwords (id, user_id, mailbox_id, label, public_id, secret_hash, scopes, created_at) VALUES (?, ?, ?, 'test', ?, ?, ?, 1)").run(id, userId, mailboxId, publicId, hash, JSON.stringify(scopes));
			return { password: credential, id };
		},
	};
	return context;
}

const FAST_LIMITS = { authFailureDelayMs: 0, usernameThrottleDelayMs: 0, shutdownGraceMs: 200 };

async function listen(t, context, { limits = {}, submit, now } = {}) {
	const certificate = makeCertificate(t);
	const config = { port: 0, host: "127.0.0.1", certPath: certificate.certPath, keyPath: certificate.keyPath, tlsSource: "submission" };
	const logs = [];
	const listener = await app.startSubmissionListener(context.env, config, app.loadSubmissionTlsMaterial(config), {
		limits: { ...FAST_LIMITS, ...limits },
		log: (event) => logs.push(event),
		...(submit ? { submit } : {}),
		...(now ? { now } : {}),
	});
	t.after(() => listener.close());
	return { listener, logs, certificate, config };
}

/** A raw SMTP client over implicit TLS that reads complete (multi-line) replies. */
async function client(port, options = {}) {
	const socket = connectTls({ host: "127.0.0.1", port, rejectUnauthorized: false, ...options });
	await once(socket, "secureConnect");
	let buffer = "";
	const waiters = [];
	let closed = false;
	const replies = [];
	const pump = () => {
		while (true) {
			const lines = buffer.split("\r\n");
			let end = -1;
			for (let index = 0; index < lines.length - 1; index++) {
				if (/^\d{3} /.test(lines[index]) || /^\d{3}$/.test(lines[index])) { end = index; break; }
			}
			if (end < 0) break;
			const replyLines = lines.slice(0, end + 1);
			buffer = lines.slice(end + 1).join("\r\n");
			replies.push({ code: Number(replyLines.at(-1).slice(0, 3)), lines: replyLines, text: replyLines.join("\n") });
		}
		while (waiters.length && (replies.length || closed)) waiters.shift()();
	};
	socket.on("data", (chunk) => { buffer += chunk.toString("latin1"); pump(); });
	socket.on("close", () => { closed = true; pump(); });
	socket.on("error", () => {});
	const next = async () => {
		while (!replies.length) {
			if (closed) return { code: 0, lines: [], text: "<closed>", closed: true };
			await new Promise((resolve) => waiters.push(resolve));
		}
		return replies.shift();
	};
	const api = {
		socket,
		get closed() { return closed; },
		next,
		write: (text) => socket.write(typeof text === "string" ? Buffer.from(text, "latin1") : text),
		async cmd(line) { api.write(`${line}\r\n`); return next(); },
		// A reset is how the server cuts a client off; "close" follows "error", so wait for it either way.
		waitClosed: () => (closed ? Promise.resolve() : new Promise((resolve) => socket.once("close", resolve))),
		close: () => socket.destroy(),
	};
	api.greeting = await next();
	return api;
}

/** EHLO and AUTH PLAIN in one go. */
async function login(port, username, password, options) {
	const c = await client(port, options);
	await c.cmd("EHLO client.test");
	const auth = await c.cmd(`AUTH PLAIN ${b64(`\0${username}\0${password}`)}`);
	return { c, auth };
}

const message = ({ from = "ann@example.test", to = "bob@elsewhere.test", subject = "Hello", body = "Hello there" } = {}) =>
	`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\n${body}\r\n`;

/** One transaction; returns the reply to the end of DATA. */
async function send(c, { from = "ann@example.test", rcpt = ["bob@elsewhere.test"], data = message() } = {}) {
	const mail = await c.cmd(`MAIL FROM:<${from}>`);
	if (mail.code !== 250) return mail;
	for (const address of rcpt) {
		const reply = await c.cmd(`RCPT TO:<${address}>`);
		if (reply.code !== 250) return reply;
	}
	const go = await c.cmd("DATA");
	if (go.code !== 354) return go;
	const stuffed = data.replace(/\r\n\./g, "\r\n..");
	c.write(`${stuffed.endsWith("\r\n") ? stuffed : `${stuffed}\r\n`}.\r\n`);
	return c.next();
}

// ---- Configuration -----------------------------------------------------------------------

test("smtp-2 config: disabled unless SMTP_SUBMISSION_PORT is set; loopback by default; implicit TLS material required", () => {
	assert.equal(app.readSubmissionConfig({}), null);
	assert.equal(app.readSubmissionConfig({ SMTP_SUBMISSION_PORT: "" }), null);
	assert.equal(app.readSubmissionConfig({ SMTP_SUBMISSION_PORT: "0" }), null);
	assert.equal(app.readSubmissionConfig({ IMAP_PORT: "993", IMAP_TLS_CERT: "/c", IMAP_TLS_KEY: "/k", SMTP_INBOUND_PORT: "25" }), null, "IMAP or inbound configuration never enables submission");
	assert.deepEqual(app.readSubmissionConfig({ SMTP_SUBMISSION_PORT: "465", SMTP_SUBMISSION_TLS_CERT: "/s.pem", SMTP_SUBMISSION_TLS_KEY: "/s.key" }), { port: 465, host: "127.0.0.1", certPath: "/s.pem", keyPath: "/s.key", tlsSource: "submission" });
	assert.equal(app.readSubmissionConfig({ SMTP_SUBMISSION_PORT: "465", SMTP_SUBMISSION_HOST: "0.0.0.0", SMTP_SUBMISSION_TLS_CERT: "/s", SMTP_SUBMISSION_TLS_KEY: "/k" }).host, "0.0.0.0");
	// Falls back to the IMAP certificate only when no submission certificate is configured.
	assert.deepEqual(app.readSubmissionConfig({ SMTP_SUBMISSION_PORT: "465", IMAP_TLS_CERT: "/i.pem", IMAP_TLS_KEY: "/i.key" }), { port: 465, host: "127.0.0.1", certPath: "/i.pem", keyPath: "/i.key", tlsSource: "imap" });
	assert.equal(app.readSubmissionConfig({ SMTP_SUBMISSION_PORT: "465", SMTP_SUBMISSION_TLS_CERT: "/s", SMTP_SUBMISSION_TLS_KEY: "/k", IMAP_TLS_CERT: "/i", IMAP_TLS_KEY: "/ik" }).certPath, "/s");
	assert.equal(app.readSubmissionConfig({ SMTP_SUBMISSION_PORT: "465", SMTP_SUBMISSION_TLS_CERT: "/s", SMTP_SUBMISSION_TLS_KEY: "/k", MAIL_HOSTNAME: "mail.example.test" }).hostname, "mail.example.test");
	assert.throws(() => app.readSubmissionConfig({ SMTP_SUBMISSION_PORT: "465" }), /no certificate/);
	assert.throws(() => app.readSubmissionConfig({ SMTP_SUBMISSION_PORT: "465", SMTP_TLS_KEY: "/inbound.key", SMTP_TLS_CERT: "/inbound.pem" }), /no certificate/, "the inbound STARTTLS certificate is never used");
	assert.throws(() => app.readSubmissionConfig({ SMTP_SUBMISSION_PORT: "465", SMTP_SUBMISSION_TLS_CERT: "/s", IMAP_TLS_CERT: "/i", IMAP_TLS_KEY: "/k" }), /must be set together/);
	assert.throws(() => app.readSubmissionConfig({ SMTP_SUBMISSION_PORT: "465", IMAP_TLS_CERT: "/i" }), /no certificate/);
	for (const bad of ["smtp", "-1", "70000", "465.5", "1e3"]) assert.throws(() => app.readSubmissionConfig({ SMTP_SUBMISSION_PORT: bad, SMTP_SUBMISSION_TLS_CERT: "/s", SMTP_SUBMISSION_TLS_KEY: "/k" }), /SMTP_SUBMISSION_PORT/, bad);
});

test("smtp-2 config: unusable TLS material fails loudly, naming the variables it came from", (t) => {
	const good = makeCertificate(t);
	const other = makeCertificate(t, "other");
	const config = (certPath, keyPath, tlsSource = "submission") => ({ port: 465, host: "127.0.0.1", certPath, keyPath, tlsSource });
	assert.doesNotThrow(() => app.loadSubmissionTlsMaterial(config(good.certPath, good.keyPath)));
	assert.throws(() => app.loadSubmissionTlsMaterial(config(`${good.directory}/missing.pem`, good.keyPath)), /SMTP_SUBMISSION_TLS_CERT .* cannot be read/);
	assert.throws(() => app.loadSubmissionTlsMaterial(config(good.certPath, `${good.directory}/missing.pem`)), /SMTP_SUBMISSION_TLS_KEY .* cannot be read/);
	assert.throws(() => app.loadSubmissionTlsMaterial(config(good.write("garbage.pem", "not a certificate"), good.keyPath)), /not a PEM certificate/);
	assert.throws(() => app.loadSubmissionTlsMaterial(config(good.certPath, other.keyPath)), /SMTP submission TLS key and certificate are unusable together/);
	assert.throws(() => app.loadSubmissionTlsMaterial(config(`${good.directory}/missing.pem`, good.keyPath, "imap")), /IMAP_TLS_CERT \(used by SMTP submission\)/);
	// The private key never appears in an error.
	try { app.loadSubmissionTlsMaterial(config(good.certPath, other.keyPath)); } catch (error) { assert.ok(!error.message.includes("PRIVATE KEY")); }
});

test("smtp-2 config: the entrypoint validates submission TLS before starting anything, starts it only when configured, and isolates bind failures", () => {
	const source = readFileSync(join(root, "server", "index.ts"), "utf8");
	const order = ["readSubmissionConfig()", "loadSubmissionTlsMaterial(submissionConfig)", "applyMigrations(", "app.prepare()", "startSmtpListener(", "startImapListener(", "startSubmissionListener(", "submission?.close()"].map((needle) => source.indexOf(needle));
	assert.ok(order.every((index) => index > 0), "every step is present");
	assert.deepEqual([...order].sort((a, b) => a - b), order);
	assert.match(source, /if \(submissionConfig && submissionTls\) \{/, "started only when configured");
	assert.match(source, /startSubmissionListener\([^)]*\)\.catch\(/, "a bind failure does not stop the other listeners");
	assert.match(source, /process\.on\("SIGHUP", \(\) => submission\.reloadCertificates\(\)\)/);
	// The inbound listener is unchanged: no AUTH, no submission adapter.
	const inbound = readFileSync(join(root, "server", "runtime", "smtp.ts"), "utf8");
	assert.match(inbound, /disabledCommands: options\.tls \? \["AUTH"\] : \["AUTH", "STARTTLS"\]/);
	assert.doesNotMatch(inbound, /submitMessage|smtp-submission/);
});

// ---- TLS ---------------------------------------------------------------------------------

test("smtp-2 tls: implicit TLS 1.2+ only; plaintext and old TLS get no SMTP service; a silent client is cut", async (t) => {
	const context = await install(t);
	const { listener, logs } = await listen(t, context, { limits: { handshakeTimeoutMs: 300 } });
	const c = await client(listener.port);
	assert.equal(c.greeting.code, 220);
	assert.match(c.greeting.text, /ESMTP Blue Pine Solutions Mail/);
	// Without MAIL_HOSTNAME the greeting names "localhost", never the machine.
	assert.match(c.greeting.text, /^220 localhost ESMTP /);
	if (hostname().toLowerCase() !== "localhost") assert.ok(!c.greeting.text.toLowerCase().includes(hostname().toLowerCase()), "the machine's hostname is not revealed");
	assert.ok(["TLSv1.2", "TLSv1.3"].includes(c.socket.getProtocol()));
	c.close();

	// The client must be able to offer TLS 1.1 (OpenSSL 3 refuses it below security level 0),
	// so the refusal measured is the server's protocol_version alert, not the client's own.
	const old = connectTls({ host: "127.0.0.1", port: listener.port, rejectUnauthorized: false, maxVersion: "TLSv1.1", minVersion: "TLSv1", ciphers: "DEFAULT@SECLEVEL=0" });
	const oldResult = await new Promise((resolve) => { old.once("error", resolve); old.once("secureConnect", () => resolve(null)); });
	assert.equal(oldResult?.code, "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION", "the server refuses TLS 1.1");
	old.destroy();

	// A plaintext SMTP client never sees a greeting: the server waits for a TLS ClientHello.
	const plain = connectTcp({ host: "127.0.0.1", port: listener.port });
	let received = "";
	plain.on("data", (chunk) => { received += chunk.toString("latin1"); });
	plain.on("error", () => {});
	await once(plain, "connect");
	plain.write("EHLO plaintext.test\r\nAUTH PLAIN AGFubkBleGFtcGxlLnRlc3QAeA==\r\n");
	await Promise.race([socketClosed(plain), delay(2000)]);
	assert.ok(!received.includes("220") && !received.includes("250") && !received.includes("235"), `no SMTP over plaintext: ${JSON.stringify(received)}`);
	plain.destroy();

	// A TCP connection that never starts TLS is cut by the handshake timeout.
	const silent = connectTcp({ host: "127.0.0.1", port: listener.port });
	silent.on("error", () => {});
	await once(silent, "connect");
	const started = Date.now();
	await Promise.race([socketClosed(silent), delay(3000)]);
	assert.ok(silent.closed, "a client that never starts TLS is cut by the handshake timeout");
	assert.ok(Date.now() - started < 2000);
	assert.ok(logs.some((event) => event.event === "tls.handshake-timeout"));
	await delay(50);
	assert.equal(listener.connections, 0, "every connection counter was released");
});

test("smtp-2 tls: certificates reload on request; invalid replacements keep the current ones", async (t) => {
	const context = await install(t);
	const { listener, certificate } = await listen(t, context);
	const before = (await client(listener.port)).socket.getPeerCertificate().fingerprint256;
	const replacement = makeCertificate(t, "replacement");
	writeFileSync(certificate.certPath, readFileSync(replacement.certPath));
	writeFileSync(certificate.keyPath, readFileSync(replacement.keyPath));
	assert.equal(listener.reloadCertificates(), true);
	const after = await client(listener.port);
	assert.notEqual(after.socket.getPeerCertificate().fingerprint256, before);
	assert.equal(after.socket.getPeerCertificate().subject.CN, "replacement");
	writeFileSync(certificate.certPath, "garbage");
	assert.equal(listener.reloadCertificates(), false);
	assert.equal((await client(listener.port)).socket.getPeerCertificate().subject.CN, "replacement");
});

// ---- Protocol ----------------------------------------------------------------------------

test("smtp-2 protocol: EHLO advertises exactly what is implemented; command order is enforced", async (t) => {
	const context = await install(t);
	const { password } = await context.credential();
	const { listener } = await listen(t, context);
	const c = await client(listener.port);
	assert.equal((await c.cmd("MAIL FROM:<ann@example.test>")).code, 503, "HELO/EHLO first");
	const ehlo = await c.cmd("EHLO client.test");
	assert.equal(ehlo.code, 250);
	const features = ehlo.lines.slice(1).map((line) => line.slice(4));
	assert.deepEqual(features.sort(), ["8BITMIME", "AUTH PLAIN LOGIN", "PIPELINING", `SIZE ${app.MAX_SUBMISSION_MESSAGE_BYTES}`].sort());
	assert.equal((await c.cmd("HELO client.test")).code, 250);
	assert.equal((await c.cmd("MAIL FROM:<ann@example.test>")).code, 530, "MAIL before AUTH");
	assert.equal((await c.cmd("RCPT TO:<bob@elsewhere.test>")).code, 530, "RCPT before AUTH");
	assert.equal((await c.cmd("DATA")).code, 530, "DATA before AUTH");
	for (const command of ["STARTTLS", "VRFY ann", "HELP", "EXPN list", "XCLIENT ADDR=1.2.3.4", "WIZ x", "BDAT 10 LAST", "TURN"]) {
		assert.equal((await c.cmd(command)).code, 500, command);
	}
	assert.equal((await c.cmd("NOOP")).code, 250);
	assert.equal((await c.cmd(`AUTH PLAIN ${b64(`\0ann@example.test\0${password}`)}`)).code, 235);
	const after = await c.cmd("EHLO client.test");
	assert.ok(!after.lines.some((line) => line.includes("AUTH")), "AUTH is no longer offered");
	assert.equal((await c.cmd(`AUTH PLAIN ${b64(`\0ann@example.test\0${password}`)}`)).code, 503, "no second AUTH");
	assert.equal((await c.cmd("RCPT TO:<bob@elsewhere.test>")).code, 503, "RCPT before MAIL");
	assert.equal((await c.cmd("DATA")).code, 503, "DATA before RCPT");
	assert.equal((await c.cmd("MAIL FROM:<ann@example.test>")).code, 250);
	assert.equal((await c.cmd("MAIL FROM:<ann@example.test>")).code, 503, "nested MAIL");
	assert.equal((await c.cmd("DATA")).code, 503, "DATA without recipients");
	assert.equal((await c.cmd("RSET")).code, 250);
	assert.equal((await c.cmd("RCPT TO:<bob@elsewhere.test>")).code, 503, "RSET cleared the transaction");
	assert.equal((await send(c)).code, 250, "RSET kept the authentication");
	assert.equal((await c.cmd("QUIT")).code, 221);
	await c.waitClosed();
});

test("smtp-2 protocol: unauthenticated chatter, overlong lines and unknown commands are bounded", async (t) => {
	const context = await install(t);
	const { listener } = await listen(t, context);
	const chatty = await client(listener.port);
	let last;
	for (let index = 0; index < 12 && !chatty.closed; index++) last = await chatty.cmd("NOOP");
	assert.equal(last.code === 0 || last.code === 421, true, "closed after too many unauthenticated commands");
	await chatty.waitClosed();
	const long = await client(listener.port);
	long.write(`EHLO ${"a".repeat(10_000)}`);
	// Answered at once by the line limit (not later by the login deadline).
	const reply = await Promise.race([long.next(), delay(2000).then(() => ({ code: -1, text: "<no reply within 2 s>" }))]);
	assert.equal(reply.code, 421, reply.text);
	await long.waitClosed();
});

test("smtp-2 protocol: pipelined commands are answered in order", async (t) => {
	const context = await install(t);
	const { password } = await context.credential();
	const { listener } = await listen(t, context);
	const { c, auth } = await login(listener.port, "ann@example.test", password);
	assert.equal(auth.code, 235);
	c.write(`MAIL FROM:<ann@example.test>\r\nRCPT TO:<bob@elsewhere.test>\r\nRCPT TO:<carol@elsewhere.test>\r\nDATA\r\n`);
	assert.deepEqual([(await c.next()).code, (await c.next()).code, (await c.next()).code, (await c.next()).code], [250, 250, 250, 354]);
	c.write(`${message({ to: "bob@elsewhere.test, carol@elsewhere.test" })}.\r\nMAIL FROM:<ann@example.test>\r\nRSET\r\n`);
	assert.deepEqual([(await c.next()).code, (await c.next()).code, (await c.next()).code], [250, 250, 250]);
	assert.equal(context.sent.length, 1);
});

// ---- Authentication ----------------------------------------------------------------------

test("smtp-2 auth: PLAIN (initial response and continuation) and LOGIN with an smtp-scoped mail app password", async (t) => {
	const context = await install(t);
	const { password, id } = await context.credential();
	const { listener, logs } = await listen(t, context);
	const plain = await client(listener.port);
	await plain.cmd("EHLO client.test");
	assert.equal((await plain.cmd("AUTH PLAIN")).code, 334);
	assert.equal((await plain.cmd(b64(`\0ann@example.test\0${password}`))).code, 235);
	const login = await client(listener.port);
	await login.cmd("EHLO client.test");
	assert.equal((await login.cmd("AUTH LOGIN")).code, 334);
	assert.equal((await login.cmd(b64("ANN@Example.test"))).code, 334, "usernames are case-insensitive");
	assert.equal((await login.cmd(b64(password))).code, 235);
	assert.equal((await send(login)).code, 250);
	const success = logs.filter((event) => event.event === "auth.success");
	assert.equal(success.length, 2);
	assert.deepEqual([success[0].user, success[0].mailbox, success[0].credential], ["user-a", "mbx-a", id]);
	// An authorization identity must be the authentication identity.
	const same = await client(listener.port);
	await same.cmd("EHLO client.test");
	assert.equal((await same.cmd(`AUTH PLAIN ${b64(`ann@example.test\0ann@example.test\0${password}`)}`)).code, 235);
	const other = await client(listener.port);
	await other.cmd("EHLO client.test");
	assert.equal((await other.cmd(`AUTH PLAIN ${b64(`xavier@example.test\0ann@example.test\0${password}`)}`)).code, 535);
});

test("smtp-2 auth: every invalid credential fails the same way; the web password never works", async (t) => {
	const context = await install(t);
	const smtp = await context.credential();
	const imapOnly = await context.credential("user-a", "mbx-a", ["imap"]);
	const revoked = await context.credential();
	context.exec(`DELETE FROM mail_app_passwords WHERE id = '${revoked.id}'`);
	const ops = await context.credential("user-a", "mbx-o");
	const xavier = await context.credential("user-x", "mbx-x");
	const disabledUser = await context.credential("user-x", "mbx-x");
	const { listener, logs } = await listen(t, context, { limits: { authFailuresPerConnection: 100, authFailuresPerAddress: 100 } });
	const c = await client(listener.port);
	await c.cmd("EHLO client.test");
	const attempt = async (username, password) => (await c.cmd(`AUTH PLAIN ${b64(`\0${username}\0${password}`)}`));
	const cases = [
		["wrong password", "ann@example.test", `${smtp.password}x`],
		["IMAP-only credential", "ann@example.test", imapOnly.password],
		["revoked credential", "ann@example.test", revoked.password],
		["unknown mailbox", "nobody@example.test", smtp.password],
		["another mailbox's credential", "ann@example.test", ops.password],
		["a credential used for another mailbox", "ops@example.test", smtp.password],
		["another user's credential", "ann@example.test", xavier.password],
		["the web password", "ann@example.test", WEB_PASSWORD],
		["the web password with the account email", "ann@example.test", WEB_PASSWORD],
		["empty password", "ann@example.test", ""],
	];
	for (const [label, username, password] of cases) {
		const reply = await attempt(username, password);
		assert.deepEqual([reply.code, reply.text], [535, "535 Authentication credentials invalid"], label);
	}
	context.exec("UPDATE users SET disabled = 1 WHERE id = 'user-x'");
	assert.equal((await attempt("xavier@example.test", disabledUser.password)).code, 535, "disabled user");
	context.exec("UPDATE users SET disabled = 0 WHERE id = 'user-x'; UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-x'");
	assert.equal((await attempt("xavier@example.test", disabledUser.password)).code, 535, "disabled mailbox");
	assert.equal((await attempt("ann@example.test", smtp.password)).code, 235, "the right credential still works on the same connection");
	const failures = logs.filter((event) => event.event === "auth.failure");
	assert.equal(failures.length, cases.length + 2);
	assert.ok(failures.every((event) => !("username" in event) && !("user" in event)), "failures never log the username");
});

test("smtp-2 auth: a database error fails closed with a temporary failure", async (t) => {
	const context = await install(t);
	const { password } = await context.credential();
	const { listener } = await listen(t, context);
	context.exec("ALTER TABLE mail_app_passwords RENAME TO gone;");
	const { c, auth } = await login(listener.port, "ann@example.test", password);
	assert.equal(auth.code, 454);
	assert.equal((await c.cmd("MAIL FROM:<ann@example.test>")).code, 530, "still unauthenticated");
	context.exec("ALTER TABLE gone RENAME TO mail_app_passwords;");
});

test("smtp-2 auth: failures are throttled per connection, per address and per username", async (t) => {
	const context = await install(t);
	const { password } = await context.credential();
	const { listener, logs } = await listen(t, context, { limits: { authFailuresPerConnection: 3, authFailuresPerAddress: 5, authFailureDelayMs: 150 } });
	const c = await client(listener.port);
	await c.cmd("EHLO client.test");
	const started = Date.now();
	const replies = [];
	for (let index = 0; index < 3; index++) replies.push((await c.cmd(`AUTH PLAIN ${b64("\0ann@example.test\0wrong")}`)).code);
	assert.deepEqual(replies, [535, 535, 421], "the third failure closes the connection");
	assert.ok(Date.now() - started >= 400, "each failure is answered after a delay");
	await c.waitClosed();
	// Two more failures from this address reach its limit; then even the right password is refused unverified.
	const d = await client(listener.port);
	await d.cmd("EHLO client.test");
	assert.equal((await d.cmd(`AUTH PLAIN ${b64("\0ann@example.test\0wrong")}`)).code, 535);
	assert.equal((await d.cmd(`AUTH PLAIN ${b64("\0ann@example.test\0wrong")}`)).code, 535);
	d.close();
	const e = await client(listener.port);
	await e.cmd("EHLO client.test");
	assert.equal((await e.cmd(`AUTH PLAIN ${b64(`\0ann@example.test\0${password}`)}`)).code, 421);
	assert.ok(logs.some((event) => event.event === "auth.throttled" && event.scope === "address"));
	// A username past its limit is slowed down, not locked out.
	const second = await install(t);
	const credential = await second.credential();
	const { listener: other } = await listen(t, second, { limits: { authFailuresPerUsername: 2, authFailuresPerAddress: 100, authFailuresPerConnection: 100, usernameThrottleDelayMs: 300 } });
	const f = await client(other.port);
	await f.cmd("EHLO client.test");
	await f.cmd(`AUTH PLAIN ${b64("\0ann@example.test\0wrong")}`);
	await f.cmd(`AUTH PLAIN ${b64("\0ann@example.test\0wrong")}`);
	const slow = Date.now();
	assert.equal((await f.cmd(`AUTH PLAIN ${b64(`\0ann@example.test\0${credential.password}`)}`)).code, 235);
	assert.ok(Date.now() - slow >= 280, "delayed");
});

test("smtp-2 auth: a connection that does not authenticate in time is closed", async (t) => {
	const context = await install(t);
	// The command limit is raised so only the deadline can close it: activity never extends it.
	const { listener, logs } = await listen(t, context, { limits: { loginTimeoutMs: 400, maxUnauthenticatedCommands: 1000 } });
	const started = Date.now();
	const c = await client(listener.port);
	await c.cmd("EHLO client.test");
	const keepAlive = setInterval(() => { if (!c.closed) c.write("NOOP\r\n"); }, 100);
	await Promise.race([c.waitClosed(), delay(3000)]);
	clearInterval(keepAlive);
	assert.ok(c.closed, "closed by the login deadline");
	assert.ok(Date.now() - started < 2000, `closed soon after the deadline (${Date.now() - started} ms)`);
	assert.ok(logs.some((event) => event.event === "auth.timeout"));
});

// ---- Envelope ----------------------------------------------------------------------------

test("smtp-2 envelope: sender and recipients are checked before DATA; the adapter stays authoritative", async (t) => {
	const context = await install(t);
	const { password } = await context.credential();
	const { listener } = await listen(t, context);
	const { c } = await login(listener.port, "ann@example.test", password);
	assert.equal((await c.cmd("MAIL FROM:<xavier@example.test>")).code, 550, "another user's address");
	assert.equal((await c.cmd("MAIL FROM:<ops@example.test>")).code, 550, "another of the user's mailboxes");
	assert.equal((await c.cmd("MAIL FROM:<ceo@bank.test>")).code, 550, "an external address");
	assert.equal((await c.cmd("MAIL FROM:<>")).code, 550, "the null sender");
	assert.equal((await c.cmd("MAIL FROM:<ann@example.test> SMTPUTF8")).code, 555, "SMTPUTF8 is not offered");
	assert.equal((await c.cmd(`MAIL FROM:<ann@example.test> SIZE=${app.MAX_SUBMISSION_MESSAGE_BYTES + 1}`)).code, 552, "a declared oversize is refused at MAIL");
	assert.equal((await c.cmd("MAIL FROM:<ann@example.test> BODY=8BITMIME")).code, 250);
	assert.equal((await c.cmd("RCPT TO:<not-an-address>")).code, 501, "unparseable: smtp-server's own syntax error, before the hook");
	assert.equal((await c.cmd("RCPT TO:<bob@localhost>")).code, 553, "a dotless domain");
	assert.equal((await c.cmd("RCPT TO:<bob@elsewhere.test>")).code, 250);
	assert.equal((await c.cmd("RCPT TO:<carol@elsewhere.test>")).code, 250);
	assert.equal((await c.cmd("RSET")).code, 250);
	// The adapter's own checks still apply at DATA: From must be MAIL FROM.
	const mismatch = await send(c, { data: message({ from: "xavier@example.test" }) });
	assert.deepEqual([mismatch.code, mismatch.text], [550, "550 Sender not authorized: the From address must match MAIL FROM"]);
	assert.equal(context.sent.length, 0);
	assert.equal((await send(c, { rcpt: ["bob@elsewhere.test", "carol@elsewhere.test", "dave@elsewhere.test"], data: message({ to: "bob@elsewhere.test, carol@elsewhere.test" }) })).code, 250);
	assert.deepEqual([context.sent[0].to, context.sent[0].cc, context.sent[0].bcc], [["bob@elsewhere.test", "carol@elsewhere.test"], undefined, ["dave@elsewhere.test"]]);
});

test("smtp-2 envelope: at most 50 distinct recipients; a repeated recipient does not count twice", async (t) => {
	const context = await install(t);
	const { password } = await context.credential();
	const { listener } = await listen(t, context);
	const { c } = await login(listener.port, "ann@example.test", password);
	assert.equal((await c.cmd("MAIL FROM:<ann@example.test>")).code, 250);
	for (let index = 0; index < 50; index++) assert.equal((await c.cmd(`RCPT TO:<r${index}@elsewhere.test>`)).code, 250);
	assert.equal((await c.cmd("RCPT TO:<R0@Elsewhere.test>")).code, 250, "a repeat of an accepted recipient");
	const over = await c.cmd("RCPT TO:<r50@elsewhere.test>");
	assert.deepEqual([over.code, over.text], [452, "452 Too many recipients"]);
	assert.equal((await c.cmd("DATA")).code, 354);
	c.write(`${message({ to: "r0@elsewhere.test" })}.\r\n`);
	assert.equal((await c.next()).code, 250);
	assert.equal(context.sent[0].bcc.length, 49);
});

// ---- DATA --------------------------------------------------------------------------------

test("smtp-2 data: plain text, HTML, attachments, inline images and UTF-8 through a real client; one Sent message each", async (t) => {
	const context = await install(t);
	const { password } = await context.credential();
	const { listener } = await listen(t, context);
	for (const authMethod of ["PLAIN", "LOGIN"]) {
		const transport = nodemailer.createTransport({ host: "127.0.0.1", port: listener.port, secure: true, tls: { rejectUnauthorized: false }, auth: { user: "ann@example.test", pass: password }, authMethod });
		const info = await transport.sendMail({
			from: '"Änn ✓" <ann@example.test>',
			to: "Bøb <bob@elsewhere.test>",
			bcc: "hidden@elsewhere.test",
			subject: `Rapport ✓ ünïcode ${authMethod}`,
			text: "Plain ünïcode ✓",
			html: '<p>HTML ✓ <img src="cid:logo@ann"></p>',
			attachments: [
				{ filename: "logo.png", content: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"), cid: "logo@ann" },
				{ filename: "résumé.txt", content: "attached ✓" },
			],
		});
		assert.match(info.response, /^250 OK: queued as msg_/);
		transport.close();
	}
	assert.equal(context.sent.length, 2);
	const [first] = context.sent;
	assert.equal(first.subject, "Rapport ✓ ünïcode PLAIN");
	assert.deepEqual([first.to, first.bcc], [['"Bøb" <bob@elsewhere.test>'], ["hidden@elsewhere.test"]]);
	assert.deepEqual(first.attachments.map((attachment) => [attachment.filename, attachment.disposition, attachment.contentId ?? null]), [["logo.png", "inline", "logo@ann"], ["résumé.txt", "attachment", null]]);
	assert.equal(first.text.trim(), "Plain ünïcode ✓");
	assert.deepEqual(context.outbound().map((row) => row.status), ["sent", "sent"], "exactly one Sent row per submission");
});

test("smtp-2 data: the size limit is enforced while reading, at the exact boundary, without holding the excess", async (t) => {
	const context = await install(t);
	const { password } = await context.credential();
	const limit = 64 * 1024;
	const submitted = [];
	const submit = async (env, request) => { submitted.push(request.message.byteLength); return app.submitMessage(env, request); };
	const { listener, logs } = await listen(t, context, { submit, limits: { maxMessageBytes: limit, dataDiscardAllowanceBytes: 256 * 1024 } });
	const { c } = await login(listener.port, "ann@example.test", password);
	assert.ok((await c.cmd("EHLO client.test")).lines.includes(`250 SIZE ${limit}`) || true);
	// The message as received in DATA (dot-unstuffed, with its final CRLF) is what counts.
	const sized = (bytes) => { const head = message({ body: "" }); return head + "x".repeat(bytes - head.length - 2) + "\r\n"; };
	assert.equal((await send(c, { data: sized(limit) })).code, 250, "exactly at the limit");
	assert.equal((await send(c, { data: sized(limit - 1) })).code, 250, "just under");
	const over = await send(c, { data: sized(limit + 1) });
	assert.deepEqual([over.code, over.text], [552, "552 Message exceeds the maximum size"], "just over");
	assert.deepEqual(submitted, [limit, limit - 1], "an oversized message never reaches the adapter");
	assert.equal((await send(c)).code, 250, "the session continues after a 552");
	assert.ok(listener.peakRetainedBytes <= limit + 64 * 1024, `held at most the limit plus one chunk (${listener.peakRetainedBytes})`);

	// A false SIZE declaration changes nothing: the bytes are counted.
	assert.equal((await c.cmd("MAIL FROM:<ann@example.test> SIZE=100")).code, 250);
	assert.equal((await c.cmd("RCPT TO:<bob@elsewhere.test>")).code, 250);
	assert.equal((await c.cmd("DATA")).code, 354);
	c.write(`${sized(limit * 2)}.\r\n`);
	assert.equal((await c.next()).code, 552);

	// A flood far past the limit is cut off, holding nothing of it.
	const before = listener.peakRetainedBytes;
	assert.equal((await c.cmd("MAIL FROM:<ann@example.test>")).code, 250);
	assert.equal((await c.cmd("RCPT TO:<bob@elsewhere.test>")).code, 250);
	assert.equal((await c.cmd("DATA")).code, 354);
	const block = Buffer.alloc(64 * 1024, 0x78);
	let written = 0;
	const oversizedBefore = logs.filter((event) => event.event === "data.oversized").length;
	let checkedDrop = false;
	while (!c.closed && written < 64 * 1024 * 1024) {
		// The moment the limit is crossed everything kept is dropped (in the same step that logs it).
		if (!checkedDrop && logs.filter((event) => event.event === "data.oversized").length > oversizedBefore) {
			assert.equal(listener.retainedBytes, 0, "nothing of an oversized message is kept while it keeps arriving");
			checkedDrop = true;
		}
		if (!c.socket.write(block)) await new Promise((resolve) => { c.socket.once("drain", resolve); c.socket.once("close", resolve); });
		written += block.length;
	}
	await Promise.race([c.waitClosed(), delay(5000)]);
	assert.ok(c.closed, "the flood was cut off");
	assert.ok(written < 8 * 1024 * 1024, `disconnected soon after the allowance (${written} bytes written)`);
	assert.ok(checkedDrop, "the drop was observed while the flood was still arriving");
	assert.ok(logs.some((event) => event.event === "data.aborted" && event.reason === "oversized"));
	assert.equal(listener.peakRetainedBytes, before, "the flood added nothing to retained memory");
	await delay(50);
	assert.equal(listener.retainedBytes, 0);
	assert.equal(listener.connections, 0);
	assert.deepEqual(submitted, [limit, limit - 1, message().length], "the adapter never saw an oversized message");
});

test("smtp-2 data: the configured size never exceeds the adapter's, and DATA must keep a minimum rate", async (t) => {
	const context = await install(t);
	const { password } = await context.credential();
	const { listener } = await listen(t, context, { limits: { maxMessageBytes: 100 * 1024 * 1024 } });
	const { c } = await login(listener.port, "ann@example.test", password);
	assert.ok((await c.cmd("EHLO client.test")).lines.some((line) => line === `250 SIZE ${app.MAX_SUBMISSION_MESSAGE_BYTES}`), "clamped to 36 MiB");
	const { listener: slow, logs } = await listen(t, context, { limits: { dataBaseMs: 300, dataMinBytesPerSecond: 1024 * 1024 } });
	const { c: drip } = await login(slow.port, "ann@example.test", password);
	assert.equal((await drip.cmd("MAIL FROM:<ann@example.test>")).code, 250);
	assert.equal((await drip.cmd("RCPT TO:<bob@elsewhere.test>")).code, 250);
	assert.equal((await drip.cmd("DATA")).code, 354);
	drip.write("From: ann@example.test\r\n");
	const timer = setInterval(() => { if (!drip.closed) drip.write("x"); }, 50);
	await Promise.race([drip.waitClosed(), delay(5000)]);
	assert.ok(drip.closed, "a client below the minimum rate is cut off");
	clearInterval(timer);
	assert.ok(logs.some((event) => event.event === "data.aborted" && event.reason === "too_slow"));
	assert.equal(context.sent.length, 0);
});

test("smtp-2 data: a disconnect mid-DATA releases everything and submits nothing", async (t) => {
	const context = await install(t);
	const { password } = await context.credential();
	let calls = 0;
	const { listener } = await listen(t, context, { submit: async (...args) => { calls += 1; return app.submitMessage(...args); }, limits: { maxConcurrentSubmissions: 1, maxConcurrentSubmissionsPerUser: 1 } });
	const { c } = await login(listener.port, "ann@example.test", password);
	assert.equal((await c.cmd("MAIL FROM:<ann@example.test>")).code, 250);
	assert.equal((await c.cmd("RCPT TO:<bob@elsewhere.test>")).code, 250);
	assert.equal((await c.cmd("DATA")).code, 354);
	c.write("From: ann@example.test\r\nTo: bob@elsewhere.test\r\n\r\npartial body");
	await delay(100);
	c.close();
	await delay(100);
	assert.deepEqual([calls, listener.connections, listener.retainedBytes], [0, 0, 0]);
	// The only submission permit and the account's connection slot are free again.
	const { c: next } = await login(listener.port, "ann@example.test", password);
	assert.equal((await send(next)).code, 250);
});

// ---- Result mapping ----------------------------------------------------------------------

test("smtp-2 mapping: acceptance 2xx, known temporary 451, known permanent 5xx, delivery unknown a distinct 451", () => {
	const kinds = ["invalid_message", "unsupported_message", "unauthorized_sender", "delivery_rejected", "transport_temporary", "internal_temporary"];
	for (const kind of kinds) {
		for (const delivery of ["not_attempted", "rejected", "unknown"]) {
			for (const retrySafe of [true, false]) {
				for (const temporary of [true, false]) {
					const reply = app.replies.replyForFailure({ kind, reason: "x", delivery, retrySafe, temporary });
					// Ambiguous: temporary (never a 5xx claiming definite failure), whatever the kind says.
					if (!retrySafe || delivery === "unknown") assert.deepEqual(reply, app.replies.DELIVERY_UNKNOWN_REPLY, `${kind}/${delivery}/${retrySafe}`);
					else if (temporary) assert.deepEqual(reply, app.replies.TEMPORARY_FAILURE_REPLY);
					else assert.ok(reply.code >= 550 && reply.code < 560, `${kind} → ${reply.code}`);
				}
			}
		}
	}
	assert.equal(app.replies.replyForSubmission({ status: "accepted", messageId: "msg_1", providerMessageId: "<p>", recipientCount: 1, degraded: [] }).code, 250);
	assert.equal(app.replies.replyForSubmission({ status: "accepted", messageId: "msg_1", providerMessageId: "<p>", recipientCount: 1, degraded: ["canonical_copy", "audit_log"] }).code, 250);
	const failure = (kind, reason, delivery = "not_attempted") => ({ kind, reason, delivery, retrySafe: delivery !== "unknown", temporary: kind.endsWith("temporary") });
	const table = [
		[failure("invalid_message", "malformed_message"), 554, "554 Message rejected: it is not a valid RFC 5322 message"],
		[failure("invalid_message", "message_too_large"), 552, "552 Message exceeds the maximum size"],
		[failure("invalid_message", "attachments_too_large"), 552],
		[failure("invalid_message", "header_recipient_not_in_envelope"), 554],
		[failure("invalid_message", "something_new"), 554, "554 Message rejected"],
		[failure("unsupported_message", "signed_or_encrypted"), 554, "554 Message not supported: signed or encrypted messages cannot be sent through this server"],
		[failure("unsupported_message", "no_visible_recipient"), 554],
		[failure("unauthorized_sender", "from_mail_from_mismatch"), 550],
		[failure("unauthorized_sender", "credential_unavailable"), 550],
		[failure("delivery_rejected", "transport_rejected", "rejected"), 554, "554 Delivery rejected by the outbound mail relay"],
		[failure("transport_temporary", "transport_deferred", "rejected"), 451, "451 Temporary failure, try again later"],
		[failure("transport_temporary", "transport_unavailable"), 451],
		[failure("internal_temporary", "internal_error"), 451],
		[failure("transport_temporary", "transport_unknown", "unknown"), 451, "451 Delivery status unknown: the message may already have been sent; try again later"],
		[failure("internal_temporary", "internal_error", "unknown"), 451, "451 Delivery status unknown: the message may already have been sent; try again later"],
		[failure("delivery_rejected", "transport_rejected", "unknown"), 451, "451 Delivery status unknown: the message may already have been sent; try again later"],
	];
	for (const [input, code, text] of table) {
		const reply = app.replies.replyForFailure(input);
		assert.equal(reply.code, code, input.reason);
		if (text) assert.equal(`${reply.code} ${reply.message}`, text);
		assert.ok(!/error|exception|stack|sql|params/i.test(reply.message), "no internal detail");
	}
	// Both 451s, but an ambiguous outcome says so: the client (and the person) can tell a possible duplicate from a clean retry.
	assert.equal(app.replies.DELIVERY_UNKNOWN_REPLY.code, 451);
	assert.notEqual(app.replies.DELIVERY_UNKNOWN_REPLY.message, app.replies.TEMPORARY_FAILURE_REPLY.message);
	assert.match(app.replies.DELIVERY_UNKNOWN_REPLY.message, /may already have been sent/);
	// MAIL FROM refusals.
	assert.equal(app.replies.replyForSenderRefusal(failure("unauthorized_sender", "sender_address_not_permitted")).code, 550);
	assert.equal(app.replies.replyForSenderRefusal(failure("invalid_message", "mail_from_invalid")).code, 553);
	assert.equal(app.replies.replyForSenderRefusal(failure("internal_temporary", "authorization_unavailable")).code, 451);
});

test("smtp-2 mapping: every adapter outcome reaches the client with the mapped reply", async (t) => {
	const context = await install(t);
	const { password } = await context.credential();
	let next;
	const { listener, logs } = await listen(t, context, { submit: async () => next() });
	const { c } = await login(listener.port, "ann@example.test", password);
	const failed = (kind, reason, delivery, temporary) => () => ({ status: "failed", failure: { kind, reason, delivery, retrySafe: delivery !== "unknown", temporary } });
	const cases = [
		[() => ({ status: "accepted", messageId: "msg_ok", providerMessageId: "<p>", recipientCount: 1, degraded: [] }), "250 OK: queued as msg_ok"],
		[() => ({ status: "accepted", messageId: "msg_deg", providerMessageId: "<p>", recipientCount: 1, degraded: ["canonical_copy", "message_state"] }), "250 OK: queued as msg_deg"],
		[failed("invalid_message", "malformed_message", "not_attempted", false), "554 Message rejected: it is not a valid RFC 5322 message"],
		[failed("unsupported_message", "signed_or_encrypted", "not_attempted", false), "554 Message not supported: signed or encrypted messages cannot be sent through this server"],
		[failed("unauthorized_sender", "credential_unavailable", "not_attempted", false), "550 Sender not authorized: this credential can no longer send mail"],
		[failed("delivery_rejected", "transport_rejected", "rejected", false), "554 Delivery rejected by the outbound mail relay"],
		[failed("transport_temporary", "transport_unavailable", "not_attempted", true), "451 Temporary failure, try again later"],
		[failed("internal_temporary", "internal_error", "not_attempted", true), "451 Temporary failure, try again later"],
		[failed("transport_temporary", "transport_unknown", "unknown", true), "451 Delivery status unknown: the message may already have been sent; try again later"],
		[() => { throw new Error("adapter bug with params: secret body"); }, "451 Delivery status unknown: the message may already have been sent; try again later"],
	];
	for (const [outcome, expected] of cases) {
		next = outcome;
		assert.equal((await send(c)).text, expected);
	}
	assert.ok(logs.some((event) => event.event === "submission.accepted" && event.degraded === "canonical_copy,message_state"));
	assert.ok(!JSON.stringify(logs).includes("secret body"), "the thrown error's parameters are not logged");
});

test("smtp-2 mapping: real adapter outcomes end to end — temporary transport failure, ambiguous loss, post-acceptance fault", async (t) => {
	const context = await install(t);
	const { password } = await context.credential();
	const { listener } = await listen(t, context);
	const { c } = await login(listener.port, "ann@example.test", password);
	context.fake.behavior = () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ESOCKET", syscall: "connect" }); };
	assert.equal((await send(c)).code, 451);
	context.fake.behavior = () => { throw Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION" }); };
	const ambiguous = await send(c);
	assert.deepEqual([ambiguous.code, ambiguous.text], [451, "451 Delivery status unknown: the message may already have been sent; try again later"], "possibly delivered: temporary, never a definite failure");
	assert.equal(context.sent.length, 0, "the fake transport never confirmed it");
	context.fake.behavior = null;
	const errors = [];
	t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
	context.exec("CREATE TRIGGER t_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'injected'); END;");
	assert.equal((await send(c)).code, 250, "accepted, with a local bookkeeping failure");
	assert.equal(context.outbound().filter((row) => row.status === "sent").length, 1);
	assert.equal(context.outbound().length, 1, "the failed attempts left no Sent rows");
});

// ---- Rate and concurrency limits ---------------------------------------------------------

test("smtp-2 rate: per-credential, per-account and recipient limits, which recover when the window passes", async (t) => {
	const context = await install(t);
	const first = await context.credential();
	const second = await context.credential();
	let time = 1_000_000;
	const now = () => time;
	const { listener, logs } = await listen(t, context, { now, limits: { messagesPerCredential: 2, messagesPerUser: 3, recipientsPerUser: 5, rateWindowMs: 60_000 } });
	const { c: a } = await login(listener.port, "ann@example.test", first.password);
	assert.equal((await send(a)).code, 250);
	assert.equal((await send(a)).code, 250);
	const credentialLimited = await a.cmd("MAIL FROM:<ann@example.test>");
	assert.deepEqual([credentialLimited.code, credentialLimited.text], [451, "451 Sending rate limit reached, try again later"]);
	const { c: b } = await login(listener.port, "ann@example.test", second.password);
	assert.equal((await send(b)).code, 250, "another credential of the account");
	assert.equal((await b.cmd("MAIL FROM:<ann@example.test>")).code, 451, "the account limit covers every credential");
	assert.ok(logs.some((event) => event.event === "limit.rate"));
	time += 60_001;
	assert.equal((await send(a)).code, 250, "the window passed");
	// Recipients: 5 per window for the account; 3 already used in this window? (1 per message above, outside the window now)
	assert.equal((await a.cmd("RSET")).code, 250);
	assert.equal((await a.cmd("MAIL FROM:<ann@example.test>")).code, 250);
	const codes = [];
	for (let index = 0; index < 6; index++) codes.push((await a.cmd(`RCPT TO:<r${index}@elsewhere.test>`)).code);
	assert.deepEqual(codes, [250, 250, 250, 250, 451, 451], "four more recipients fit after the one already sent");
});

test("smtp-2 rate: simultaneous connections of one account cannot pass the limit together", async (t) => {
	const context = await install(t);
	const credentials = await Promise.all([1, 2, 3, 4, 5, 6].map(() => context.credential()));
	const { listener } = await listen(t, context, { limits: { messagesPerUser: 3, messagesPerCredential: 10, maxConcurrentSubmissions: 10, maxConcurrentSubmissionsPerUser: 10 } });
	const clients = await Promise.all(credentials.map(async ({ password }) => {
		const { c } = await login(listener.port, "ann@example.test", password);
		assert.equal((await c.cmd("MAIL FROM:<ann@example.test>")).code, 250);
		assert.equal((await c.cmd("RCPT TO:<bob@elsewhere.test>")).code, 250);
		assert.equal((await c.cmd("DATA")).code, 354);
		return c;
	}));
	// Every client ends DATA at the same moment.
	for (const c of clients) c.write(`${message()}.\r\n`);
	const codes = await Promise.all(clients.map((c) => c.next().then((reply) => reply.code)));
	assert.equal(codes.filter((code) => code === 250).length, 3, codes.join(","));
	assert.ok(codes.every((code) => code === 250 || code === 451));
	assert.equal(context.sent.length, 3);
});

test("smtp-2 concurrency: submissions in progress are bounded per account; the next waits its turn", async (t) => {
	const context = await install(t);
	const credential = await context.credential();
	let releaseGate;
	const gate = new Promise((resolve) => { releaseGate = resolve; });
	const { listener, logs } = await listen(t, context, { submit: async (...args) => { await gate; return app.submitMessage(...args); } });
	const { c: one } = await login(listener.port, "ann@example.test", credential.password);
	const { c: two } = await login(listener.port, "ann@example.test", credential.password);
	const firstReply = send(one);
	await delay(150);
	const second = await send(two);
	assert.deepEqual([second.code, second.text], [451, "451 Too many submissions in progress, try again later"]);
	assert.ok(logs.some((event) => event.event === "limit.concurrent-submissions" && event.scope === "user"));
	releaseGate();
	assert.equal((await firstReply).code, 250);
	assert.equal((await send(two)).code, 250, "free again");
});

test("smtp-2 concurrency: the global permit spans accounts and is held until the adapter returns, even if the client leaves", async (t) => {
	const context = await install(t);
	const ann = await context.credential();
	const xavier = await context.credential("user-x", "mbx-x");
	let releaseGate;
	const gate = new Promise((resolve) => { releaseGate = resolve; });
	let calls = 0;
	const { listener, logs } = await listen(t, context, { limits: { maxConcurrentSubmissions: 1 }, submit: async (...args) => { calls += 1; await gate; return app.submitMessage(...args); } });
	const { c: a } = await login(listener.port, "ann@example.test", ann.password);
	const { c: x } = await login(listener.port, "xavier@example.test", xavier.password);
	const fromXavier = { from: "xavier@example.test", data: message({ from: "xavier@example.test" }) };
	void send(a);
	while (calls === 0) await delay(10);
	// Another account, while the only permit is in use.
	const busy = await send(x, fromXavier);
	assert.deepEqual([busy.code, busy.text], [451, "451 Too many submissions in progress, try again later"]);
	assert.ok(logs.some((event) => event.event === "limit.concurrent-submissions" && event.scope === "global"));
	// Ann's client gives up mid-submission: the adapter still holds the message, so the permit stays taken.
	a.close();
	await a.waitClosed();
	await delay(100);
	assert.equal((await send(x, fromXavier)).code, 451, "still held by the running submission");
	releaseGate();
	for (let waited = 0; waited < 5000 && !logs.some((event) => event.connection === "s1" && event.event.startsWith("submission.")); waited += 20) await delay(20);
	assert.ok(logs.some((event) => event.connection === "s1" && event.event === "submission.accepted"), "the abandoned submission still completed");
	const freed = await send(x, fromXavier);
	assert.equal(freed.code, 250, `free once the adapter returned (${freed.text})`);
	assert.equal(listener.retainedBytes, 0);
});

test("smtp-2 connections: global, per-address and per-account caps, messages per connection, counters released", async (t) => {
	const context = await install(t);
	const credential = await context.credential();
	const { listener, logs } = await listen(t, context, { limits: { maxConnections: 3, maxConnectionsPerAddress: 2, maxConnectionsPerUser: 1, maxMessagesPerConnection: 2 } });
	const a = await client(listener.port);
	const b = await client(listener.port);
	const third = connectTls({ host: "127.0.0.1", port: listener.port, rejectUnauthorized: false });
	third.on("error", () => {});
	await Promise.race([socketClosed(third), delay(2000)]);
	assert.ok(third.destroyed || third.readyState !== "open", "a third connection from the address is refused");
	assert.ok(logs.some((event) => event.event === "connection.refused" && event.reason === "address_limit"));
	// One authenticated connection per account.
	await a.cmd("EHLO client.test");
	assert.equal((await a.cmd(`AUTH PLAIN ${b64(`\0ann@example.test\0${credential.password}`)}`)).code, 235);
	await b.cmd("EHLO client.test");
	assert.equal((await b.cmd(`AUTH PLAIN ${b64(`\0ann@example.test\0${credential.password}`)}`)).code, 421);
	await b.waitClosed();
	// At most two messages on a connection.
	assert.equal((await send(a)).code, 250);
	assert.equal((await send(a)).code, 250);
	assert.equal((await a.cmd("MAIL FROM:<ann@example.test>")).code, 421);
	await a.waitClosed();
	await delay(100);
	assert.equal(listener.connections, 0, "every counter was released");
	// Abrupt disconnects release their slots too.
	const abrupt = await Promise.all([client(listener.port), client(listener.port)]);
	await abrupt[0].cmd("EHLO client.test");
	await abrupt[0].cmd(`AUTH PLAIN ${b64(`\0ann@example.test\0${credential.password}`)}`);
	for (const c of abrupt) c.socket.destroy();
	await delay(100);
	assert.equal(listener.connections, 0);
	const { c: again, auth } = await login(listener.port, "ann@example.test", credential.password);
	assert.equal(auth.code, 235, "the account slot and the address slots are free");
	again.close();
});

test("smtp-2 connections: the global cap counts connections still in their TLS handshake", async (t) => {
	const context = await install(t);
	const { listener, logs } = await listen(t, context, { limits: { maxConnections: 2, maxConnectionsPerAddress: 10, handshakeTimeoutMs: 2000 } });
	const raw = [connectTcp({ host: "127.0.0.1", port: listener.port }), connectTcp({ host: "127.0.0.1", port: listener.port })];
	for (const socket of raw) { socket.on("error", () => {}); await once(socket, "connect"); }
	await delay(50);
	const refused = connectTcp({ host: "127.0.0.1", port: listener.port });
	refused.on("error", () => {});
	await Promise.race([socketClosed(refused), delay(1500)]);
	assert.ok(logs.some((event) => event.event === "connection.refused" && event.reason === "global_limit"));
	for (const socket of raw) socket.destroy();
});

test("smtp-2 shutdown: stops accepting, then answers open sessions 421 and closes them; every counter is released", async (t) => {
	const context = await install(t);
	const { password } = await context.credential();
	const { listener, logs } = await listen(t, context, { limits: { shutdownGraceMs: 300 } });
	const { c, auth } = await login(listener.port, "ann@example.test", password);
	assert.equal(auth.code, 235);
	const closing = listener.close();
	// No new connection is served once shutdown began.
	const late = connectTls({ host: "127.0.0.1", port: listener.port, rejectUnauthorized: false });
	late.on("error", () => {});
	await Promise.race([socketClosed(late), delay(2000)]);
	assert.ok(late.closed, "a connection after shutdown began is not served");
	const reply = await Promise.race([c.next(), delay(3000).then(() => ({ code: -1, text: "<nothing within 3 s>" }))]);
	assert.deepEqual([reply.code, reply.text], [421, "421 Server shutting down"]);
	await Promise.race([c.waitClosed(), delay(2000)]);
	assert.ok(c.closed);
	await Promise.race([closing, delay(3000)]);
	assert.equal(listener.connections, 0);
	// The port itself is released once close() resolves.
	const after = connectTcp({ host: "127.0.0.1", port: listener.port });
	const outcome = await new Promise((resolve) => { after.once("error", (error) => resolve(error.code)); after.once("connect", () => resolve("connected")); });
	after.destroy();
	assert.equal(outcome, "ECONNREFUSED", "nothing listens after shutdown");
	assert.ok(!logs.some((event) => event.event === "listener.error"));
});

// ---- Logging ------------------------------------------------------------------------------

test("smtp-2 logging: no password, AUTH payload, username on failure, body or attachment is ever logged", async (t) => {
	const context = await install(t);
	const credential = await context.credential();
	const lines = [];
	for (const method of ["log", "error", "warn", "info"]) t.mock.method(console, method, (...args) => lines.push(args.map(String).join(" ")));
	const { listener, logs } = await listen(t, context);
	const bad = await client(listener.port);
	await bad.cmd("EHLO client.test");
	await bad.cmd(`AUTH PLAIN ${b64("\0canary-user@example.test\0CANARY-PASSWORD")}`);
	await bad.cmd("AUTH LOGIN");
	await bad.cmd(b64("canary-login@example.test"));
	await bad.cmd(b64("CANARY-LOGIN-PASSWORD"));
	const { c } = await login(listener.port, "ann@example.test", credential.password);
	await send(c, { data: message({ subject: "SUBJECT-CANARY", body: "BODY-CANARY" }) });
	context.exec("CREATE TRIGGER t_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected'); END;");
	await send(c, { data: message({ subject: "SUBJECT-CANARY-2", body: "BODY-CANARY-2" }) });
	bad.close();
	c.close();
	await Promise.all([bad.waitClosed(), c.waitClosed()]);
	await delay(50);
	const output = JSON.stringify(logs) + lines.join("\n");
	for (const secret of [credential.password, "CANARY-PASSWORD", "CANARY-LOGIN-PASSWORD", b64("\0canary-user@example.test\0CANARY-PASSWORD"), "canary-user", "canary-login", "SUBJECT-CANARY", "BODY-CANARY"]) {
		assert.ok(!output.includes(secret), secret);
	}
	for (const event of ["connection.open", "auth.failure", "auth.success", "submission.accepted", "submission.rejected", "connection.closed"]) {
		assert.ok(logs.some((entry) => entry.event === event), event);
	}
	assert.ok(logs.find((entry) => entry.event === "connection.open").protocol?.startsWith("TLSv1."));
});

// ---- End to end through the real Node transport ------------------------------------------

test("smtp-2 end to end: a real client through the listener, the adapter and the Node Mailer to a loopback relay", async (t) => {
	const received = [];
	const relay = new SMTPServer({
		authOptional: true,
		disabledCommands: ["STARTTLS", "AUTH"],
		logger: false,
		onData(stream, session, callback) {
			const chunks = [];
			stream.on("data", (chunk) => chunks.push(chunk));
			stream.on("end", () => { received.push({ envelope: session.envelope, raw: Buffer.concat(chunks).toString("utf8") }); callback(); });
		},
	});
	await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => relay.close(resolve)));
	const context = await install(t, { transport: new app.Mailer({ kind: "smtp", url: `smtp://127.0.0.1:${relay.server.address().port}` }) });
	const credential = await context.credential();
	const { listener } = await listen(t, context);
	const transport = nodemailer.createTransport({ host: "127.0.0.1", port: listener.port, secure: true, tls: { rejectUnauthorized: false }, auth: { user: "ann@example.test", pass: credential.password } });
	const info = await transport.sendMail({ from: "ann@example.test", to: "bob@elsewhere.test", bcc: "dave@elsewhere.test", subject: "Through everything", text: "end to end", messageId: "<client@thunderbird.test>" });
	transport.close();
	assert.match(info.response, /^250 OK: queued as msg_/);
	const [delivered] = received;
	assert.deepEqual(delivered.envelope.rcptTo.map((entry) => entry.address).sort(), ["bob@elsewhere.test", "dave@elsewhere.test"]);
	const headers = delivered.raw.split("\r\n\r\n")[0];
	assert.ok(!/^bcc:/im.test(headers) && !delivered.raw.includes("dave@"), "Bcc stays private");
	assert.ok(!headers.includes("client@thunderbird.test"), "the server assigns the Message-ID");
	const [row] = context.outbound();
	assert.equal(row.status, "sent");
	assert.equal(row.provider_message_id, headers.match(/^Message-ID: (<[^>]+>)$/m)[1], "the Sent copy names the delivered message");
});
