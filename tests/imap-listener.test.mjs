import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";
import test from "node:test";
import { assertTagged, fetchAttributes, install, latin1, loadApp, makeCertificate, tlsClient } from "./support/imap-harness.mjs";

/**
 * A4: the Node IMAP listener over real TLS sockets: TLS configuration and lifecycle,
 * per-instance limits and timeouts, and the full protocol end to end, with a
 * raw client as the primary driver and Python imaplib, curl and openssl as interop checks.
 */
const { app, cleanup } = await loadApp("imap-listener");
test.after(cleanup);

const FAST_LIMITS = { accessCheckIntervalMs: 60_000 };

async function listen(t, { limits = {}, context } = {}) {
	const ctx = context ?? (await install(app, t));
	const certificate = makeCertificate(t);
	const logs = [];
	const config = { port: 0, host: "127.0.0.1", certPath: certificate.certPath, keyPath: certificate.keyPath };
	const listener = await app.startImapListener(ctx.env, config, app.loadTlsMaterial(config), { limits: { ...FAST_LIMITS, ...limits }, log: (event) => logs.push(event) });
	t.after(() => listener.close());
	return { ...ctx, listener, logs, certificate, config };
}

async function connected(port) {
	const client = await tlsClient(port);
	const greeting = await client.unit();
	return { client, greeting };
}

function closedWithin(socket, ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), ms);
		socket.once("close", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

/** Run a command without blocking the event loop (the listener under test lives in this process). */
function run(command, args, { input = "", timeoutMs = 10_000 } = {}) {
	return new Promise((resolve) => {
		const child = spawn(command, args);
		const stdout = [];
		const stderr = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({ status, stdout: Buffer.concat(stdout).toString("latin1"), stderr: Buffer.concat(stderr).toString("latin1") });
		});
		child.stdin.end(input);
	});
}

const tryCommand = (name) => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0 || spawnSync(name, ["version"], { stdio: "ignore" }).status === 0;

// ---- Gate 6: TLS listener, limits and lifecycle ------------------------------------------------

test("gate6: configuration is opt-in and incomplete TLS configuration fails loudly", (t) => {
	assert.equal(app.readImapConfig({}), null);
	assert.equal(app.readImapConfig({ IMAP_PORT: "0" }), null);
	assert.deepEqual(app.readImapConfig({ IMAP_PORT: "993", IMAP_TLS_CERT: "/c.pem", IMAP_TLS_KEY: "/k.pem" }), { port: 993, host: "0.0.0.0", certPath: "/c.pem", keyPath: "/k.pem" });
	assert.equal(app.readImapConfig({ IMAP_PORT: "9993", IMAP_HOST: "127.0.0.1", IMAP_TLS_CERT: "/c", IMAP_TLS_KEY: "/k" }).host, "127.0.0.1");
	assert.throws(() => app.readImapConfig({ IMAP_PORT: "993" }), /IMAP_TLS_CERT and IMAP_TLS_KEY/);
	assert.throws(() => app.readImapConfig({ IMAP_PORT: "993", IMAP_TLS_CERT: "/c.pem" }), /IMAP_TLS_CERT and IMAP_TLS_KEY/);
	assert.throws(() => app.readImapConfig({ IMAP_PORT: "imap" }), /IMAP_PORT/);
	assert.throws(() => app.readImapConfig({ IMAP_PORT: "70000", IMAP_TLS_CERT: "/c", IMAP_TLS_KEY: "/k" }), /IMAP_PORT/);

	const good = makeCertificate(t);
	const other = makeCertificate(t, "other");
	assert.doesNotThrow(() => app.loadTlsMaterial(good));
	assert.throws(() => app.loadTlsMaterial({ certPath: `${good.directory}/missing.pem`, keyPath: good.keyPath }), /IMAP_TLS_CERT .* cannot be read/);
	assert.throws(() => app.loadTlsMaterial({ certPath: good.certPath, keyPath: `${good.directory}/missing.pem` }), /IMAP_TLS_KEY .* cannot be read/);
	assert.throws(() => app.loadTlsMaterial({ certPath: good.write("garbage.pem", "not a certificate"), keyPath: good.keyPath }), /not a PEM certificate/);
	assert.throws(() => app.loadTlsMaterial({ certPath: good.certPath, keyPath: good.write("garbage.key", "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n") }), /unusable together/);
	assert.throws(() => app.loadTlsMaterial({ certPath: good.certPath, keyPath: other.keyPath }), /unusable together/, "a key that does not match the certificate");
	if (process.getuid?.() !== 0) {
		const unreadable = good.write("unreadable.pem", readFileSync(good.certPath));
		chmodSync(unreadable, 0);
		assert.throws(() => app.loadTlsMaterial({ certPath: unreadable, keyPath: good.keyPath }), /cannot be read/);
	}
});

test("gate6: the Node entrypoint validates IMAP TLS before starting anything and closes the listener on shutdown", () => {
	// The entrypoint calls readImapConfig() and loadTlsMaterial() before migrations, Next or any listener.
	const source = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
	const order = ["readImapConfig()", "loadTlsMaterial(imapConfig)", "applyMigrations(", "app.prepare()", "startImapListener(", "imap?.close()"].map((needle) => source.indexOf(needle));
	assert.ok(order.every((index) => index > 0), "every step is present");
	assert.deepEqual([...order].sort((a, b) => a - b), order, "TLS material is validated before anything starts, and the listener is closed on shutdown");
	assert.match(source, /process\.on\("SIGHUP", \(\) => imap\.reloadCertificates\(\)\)/);
});

test("gate6: implicit TLS 1.2+ only; plaintext and old TLS get no IMAP service", async (t) => {
	const { listener, logs } = await listen(t);
	const { client, greeting } = await connected(listener.port);
	assert.match(greeting.text, /^\* OK \[CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN ID\] /);
	assert.ok(["TLSv1.2", "TLSv1.3"].includes(client.socket.getProtocol()));
	client.close();

	const old = connectTls({ host: "127.0.0.1", port: listener.port, rejectUnauthorized: false, maxVersion: "TLSv1.1", minVersion: "TLSv1" });
	const oldError = await new Promise((resolve) => {
		old.once("error", resolve);
		old.once("secureConnect", () => resolve(null));
	});
	assert.ok(oldError, "TLS 1.1 is refused");
	old.destroy();

	const plain = connectTcp({ host: "127.0.0.1", port: listener.port });
	const received = [];
	plain.on("data", (chunk) => received.push(chunk));
	plain.on("error", () => {});
	await new Promise((resolve) => plain.once("connect", resolve));
	plain.write("a1 CAPABILITY\r\na2 LOGIN a@example.test secret\r\n");
	assert.equal(await closedWithin(plain, 5000), true, "a plaintext client is disconnected");
	assert.ok(!Buffer.concat(received).toString("latin1").includes("OK"), "and never sees an IMAP response");
	assert.ok(logs.some((event) => event.event === "tls.error"));
	assert.ok(!JSON.stringify(logs).includes("secret"), "nothing the plaintext client sent is logged");
});

test("gate6: certificates reload on request without dropping sessions; bad material keeps the old ones", async (t) => {
	const { listener, certificate } = await listen(t);
	const fingerprint = async () => {
		const client = await tlsClient(listener.port);
		const value = client.socket.getPeerX509Certificate().fingerprint256;
		client.close();
		return value;
	};
	const { client: open } = await connected(listener.port);
	const before = await fingerprint();
	assert.equal(before, new (await import("node:crypto")).X509Certificate(readFileSync(certificate.certPath)).fingerprint256);
	const next = makeCertificate(t, "rotated");
	writeFileSync(certificate.certPath, readFileSync(next.certPath));
	writeFileSync(certificate.keyPath, readFileSync(next.keyPath));
	assert.equal(listener.reloadCertificates(), true);
	const after = await fingerprint();
	assert.notEqual(after, before, "new connections get the new certificate");
	assertTagged(await open.command("NOOP"), "OK", undefined);
	writeFileSync(certificate.certPath, "broken");
	assert.equal(listener.reloadCertificates(), false);
	assert.equal(await fingerprint(), after, "an invalid replacement is refused and the current certificate stays");
	open.close();
});

test("gate6: global and per-address connection limits", async (t) => {
	const { listener, logs } = await listen(t, { limits: { maxConnections: 3, maxConnectionsPerAddress: 2 } });
	const first = await connected(listener.port);
	const second = await connected(listener.port);
	const third = tlsClient(listener.port).catch((error) => error);
	const refused = await third;
	assert.ok(refused instanceof Error || (await refused.unit()) === null, "a third connection from one address is refused");
	assert.ok(logs.some((event) => event.event === "connection.refused" && event.reason === "address_limit"));
	first.client.close();
	await new Promise((resolve) => setTimeout(resolve, 100));
	const replacement = await connected(listener.port);
	assert.match(replacement.greeting.text, /^\* OK/, "slots are released when connections close");
	second.client.close();
	replacement.client.close();

	const address = app.limits.clientAddressKey;
	assert.equal(address("::ffff:192.0.2.7"), "192.0.2.7");
	assert.equal(address("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
	assert.equal(address("2001:db8:1:2::9"), "2001:db8:1:2::/64");
	assert.equal(address("2001:db8::1"), "2001:db8:0:0::/64");
	const global = new app.limits.ConcurrencyCounter(2);
	assert.deepEqual([global.tryAcquire("x"), global.tryAcquire("x"), global.tryAcquire("x")], [true, true, false]);
	global.release("x");
	global.release("x");
	assert.equal(global.keys, 0, "counters forget released keys");
	let now = 0;
	const window = new app.limits.SlidingWindowCounter(2, 1000, 3, () => now);
	window.hit("a");
	window.hit("a");
	assert.equal(window.exceeded("a"), true);
	now = 1500;
	assert.equal(window.exceeded("a"), false, "events expire with the window: no permanent lockout");
	for (const key of ["b", "c", "d", "e"]) window.hit(key);
	assert.ok(window.keys <= 3, "the number of tracked keys is bounded");
});

test("gate6: authentication throttling per address and per username, and sessions per user", async (t) => {
	const { listener, logs, credential } = await listen(t, { limits: { authFailuresPerAddress: 2, authFailuresPerUsername: 1, usernameThrottleDelayMs: 400, maxSessionsPerUser: 1 } });
	const { credential: good } = await credential("user-a", "mbx-a");
	const { client } = await connected(listener.port);
	assertTagged(await client.login("a@example.test", "bad-1"), "NO", /AUTHENTICATIONFAILED/);
	const started = Date.now();
	assertTagged(await client.login("a@example.test", "bad-2"), "NO", /AUTHENTICATIONFAILED/);
	assert.ok(Date.now() - started >= 1300, "the username past its limit adds a delay to the failure delay");
	const { client: next } = await connected(listener.port);
	const refused = await next.login("a@example.test", good);
	assertTagged(refused, "NO", /AUTHENTICATIONFAILED/, "an address past its limit is refused even with the right password, and it looks the same");
	assert.ok(logs.some((event) => event.event === "auth.failure" && event.reason === "rate_limited"));
	assert.ok(!JSON.stringify(logs).includes(good) && !JSON.stringify(logs).includes("bad-1") && !JSON.stringify(logs).includes("a@example.test"), "no credential or username in logs");
	client.close();
	next.close();

	const fresh = await listen(t, { limits: { maxSessionsPerUser: 1 } });
	const { credential: again } = await fresh.credential("user-a", "mbx-a");
	const one = await connected(fresh.listener.port);
	assertTagged(await one.client.login("a@example.test", again), "OK");
	const two = await connected(fresh.listener.port);
	assertTagged(await two.client.login("a@example.test", again), "NO", /\[LIMIT\]/);
	one.client.close();
	await new Promise((resolve) => setTimeout(resolve, 100));
	assertTagged(await two.client.login("a@example.test", again), "OK", undefined, "the slot is released on disconnect");
	two.client.close();
});

test("gate6: handshake, unauthenticated and authenticated idle timeouts", async (t) => {
	const { listener, credential } = await listen(t, { limits: { handshakeTimeoutMs: 300, unauthenticatedIdleMs: 300, authenticatedIdleMs: 800 } });
	const raw = connectTcp({ host: "127.0.0.1", port: listener.port });
	raw.on("error", () => {});
	assert.equal(await closedWithin(raw, 3000), true, "a TCP connection that never starts TLS is closed");

	const idle = await connected(listener.port);
	const bye = await idle.client.unit(3000);
	assert.equal(bye.text, "* BYE Autologout; idle for too long");
	assert.equal(await idle.client.unit(3000), null);

	const { credential: good } = await credential("user-a", "mbx-a");
	const active = await connected(listener.port);
	assertTagged(await active.client.login("a@example.test", good), "OK");
	await new Promise((resolve) => setTimeout(resolve, 500));
	assertTagged(await active.client.command("NOOP"), "OK", undefined, "authenticated sessions get the longer timeout");
	assert.equal((await active.client.unit(3000)).text, "* BYE Autologout; idle for too long");
});

test("gate6: oversize input is refused and cannot exhaust memory", async (t) => {
	const { listener } = await listen(t);
	const { client } = await connected(listener.port);
	client.write("a LOGIN {2000}\r\n");
	assertTagged(await client.collect("a"), "BAD", /Literal too large/, "1 KiB literal limit before authentication");
	client.write(`b ${"x".repeat(70 * 1024)}`);
	const bye = await client.unit();
	assert.equal(bye.text, "* BYE Command line too long");
	assert.equal(await client.unit(), null);
	const { client: other } = await connected(listener.port);
	other.write("c LOGIN {5+}\r\nhello\r\n");
	assert.equal((await other.unit()).text, "* BYE Non-synchronizing literals are not supported");
});

test("gate6: an idle session whose access is revoked is closed by the periodic check", async (t) => {
	const context = await install(app, t);
	const { listener } = await listen(t, { context, limits: { accessCheckIntervalMs: 200 } });
	const { credential: good, id } = await context.credential("user-a", "mbx-a");
	const { client } = await connected(listener.port);
	assertTagged(await client.login("a@example.test", good), "OK");
	assertTagged(await client.command("SELECT INBOX"), "OK");
	context.database.db.prepare("DELETE FROM mail_app_passwords WHERE id = ?").run(id);
	assert.equal((await client.unit(3000)).text, "* BYE Access revoked");
	assert.equal(await client.unit(3000), null);
});

test("gate6: shutdown says BYE, closes every session and stops listening", async (t) => {
	const context = await install(app, t);
	const certificate = makeCertificate(t);
	const config = { port: 0, host: "127.0.0.1", certPath: certificate.certPath, keyPath: certificate.keyPath };
	const listener = await app.startImapListener(context.env, config, app.loadTlsMaterial(config), { log: () => {} });
	const { credential: good } = await context.credential("user-a", "mbx-a");
	const a = await connected(listener.port);
	const b = await connected(listener.port);
	assertTagged(await b.client.login("a@example.test", good), "OK");
	const raw = connectTcp({ host: "127.0.0.1", port: listener.port });
	raw.on("error", () => {});
	await new Promise((resolve) => raw.once("connect", resolve));
	const rawClosed = closedWithin(raw, 5000);
	await listener.close();
	assert.equal((await a.client.unit()).text, "* BYE Server shutting down");
	assert.equal((await b.client.unit()).text, "* BYE Server shutting down");
	assert.equal(await a.client.unit(), null);
	assert.equal(await rawClosed, true, "connections still in the handshake are closed too");
	assert.equal(listener.connections, 0, "close() resolves only once every connection is gone");
	const refused = await tlsClient(listener.port).catch((error) => error);
	assert.equal(refused.code, "ECONNREFUSED", "the port is no longer open");
});

// ---- Gate 7: the complete protocol over TLS ------------------------------------------------

const MESSAGE = "Date: Tue, 3 Mar 2026 10:15:00 +0100\r\nFrom: =?UTF-8?Q?J=C3=BCrgen?= <j@elsewhere.test>\r\nTo: a@example.test\r\nSubject: Gr\xc3\xbc\xc3\x9fe \xe2\x9c\x93\r\nMessage-ID: <tls-1@elsewhere.test>\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello \xe2\x9c\x93\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"a.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--b--\r\n";

async function populated(t) {
	const context = await install(app, t);
	context.database.db.prepare("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-u', 'user-a', 'mbx-a', 'Café/Ünïcode', 5)").run();
	const bytes = await context.deliver("m-1", Buffer.from(MESSAGE, "latin1"));
	await context.deliver("m-2", "Subject: second\r\n\r\nplain body\r\n", { read: 1 });
	await context.deliver("m-3", "Subject: filed\r\n\r\nin a folder\r\n", { folder_id: "fld-u" });
	const setup = await listen(t, { context });
	const { credential: good } = await context.credential("user-a", "mbx-a");
	return { ...setup, bytes, good };
}

test("gate7: an end-to-end session over TLS", async (t) => {
	const { listener, good, bytes, database, row } = await populated(t);
	const { client } = await connected(listener.port);
	assert.deepEqual((await client.command("CAPABILITY")).untagged.map((unit) => unit.text), ["* CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN ID"]);
	assertTagged(await client.command(`AUTHENTICATE PLAIN ${Buffer.from(`\0a@example.test\0${good}`).toString("base64")}`), "OK", /\[CAPABILITY IMAP4rev1 ID NAMESPACE UNSELECT SPECIAL-USE\]/);
	const list = await client.command('LIST "" "*"');
	assert.equal(list.untagged.length, 8, "six system folders, Work and the Unicode folder");
	assert.equal(list.untagged.at(-1).text, '* LIST (\\Noinferiors) NIL "Caf&AOk-/&ANw-n&AO8-code"');
	assertTagged(await client.command('LSUB "" "*"'), "OK");
	assert.deepEqual((await client.command("NAMESPACE")).untagged.map((unit) => unit.text), ['* NAMESPACE (("" NIL)) NIL NIL']);
	const status = await client.command('STATUS "Caf&AOk-/&ANw-n&AO8-code" (MESSAGES UNSEEN)');
	assert.deepEqual(status.untagged.map((unit) => unit.text), ['* STATUS "Caf&AOk-/&ANw-n&AO8-code" (MESSAGES 1 UNSEEN 1)']);
	const examine = await client.command("EXAMINE INBOX");
	assertTagged(examine, "OK", /\[READ-ONLY\]/);
	assert.ok(examine.untagged.some((unit) => unit.text === "* OK [PERMANENTFLAGS ()] Read-only mailbox"));
	const fetched = await client.command("FETCH 1 (UID FLAGS RFC822.SIZE INTERNALDATE ENVELOPE BODYSTRUCTURE BODY[])");
	assertTagged(fetched, "OK");
	assert.deepEqual(new Uint8Array(fetched.literals.at(-1)), new Uint8Array(bytes), "exact canonical octets over TLS");
	const attributes = fetchAttributes(fetched.untagged[0].text);
	assert.equal(attributes["RFC822.SIZE"], bytes.byteLength);
	assert.deepEqual(attributes.FLAGS, []);
	assert.equal(Buffer.from(attributes.ENVELOPE[1], "latin1").toString(), "Grüße ✓");
	assert.deepEqual(attributes.BODYSTRUCTURE[1].slice(0, 7), ["application", "pdf", null, null, null, "BASE64", 12]);
	const partial = await client.command("UID FETCH 1 (BODY.PEEK[1]<0.5> BODY.PEEK[2.MIME])");
	assert.deepEqual(partial.literals.map(latin1), ["hello", 'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="a.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n']);
	assert.equal(row("m-1").read, 0, "BODY[] under EXAMINE did not mark the message read");
	assert.deepEqual((await client.command("SEARCH UNSEEN")).untagged.map((unit) => unit.text), ["* SEARCH 1"]);
	assert.deepEqual((await client.command("UID SEARCH BODY hello")).untagged.map((unit) => unit.text), ["* SEARCH 1"]);
	assertTagged(await client.command("STORE 1 +FLAGS (\\Seen)"), "NO", /read-only/);
	const select = await client.command("SELECT INBOX");
	assertTagged(select, "OK", /\[READ-WRITE\]/);
	assert.ok(select.untagged.some((unit) => unit.text === "* OK [PERMANENTFLAGS (\\Seen \\Flagged)] Flags permitted"));
	const stored = await client.command("STORE 1 +FLAGS (\\Flagged)");
	assertTagged(stored, "OK");
	assert.deepEqual(stored.untagged.map((unit) => unit.text), ["* 1 FETCH (FLAGS (\\Flagged))"]);
	assert.equal(row("m-1").starred, 1, "STORE over TLS changes the product's starred state");
	const read = await client.command("FETCH 1 (BODY[TEXT])");
	assertTagged(read, "OK");
	assert.deepEqual(fetchAttributes(read.untagged[0].text).FLAGS, ["\\Seen", "\\Flagged"], "a non-PEEK body fetch under SELECT sets \\Seen and reports it");
	assert.equal(row("m-1").read, 1);
	assertTagged(await client.command("CHECK"), "OK");
	assertTagged(await client.command("UNSELECT"), "OK");
	assertTagged(await client.command("SELECT INBOX"), "OK");
	assertTagged(await client.command("CLOSE"), "OK");
	assertTagged(await client.command("NOOP"), "OK");
	const logout = await client.command("LOGOUT");
	assert.equal(logout.untagged[0].text, "* BYE Logging out");
	assertTagged(logout, "OK");
	assert.equal(await client.unit(), null);
	assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE read = 1").get().n, 2, "the message already read, and the one read under SELECT");
});

test("gate7: pipelined commands run in order and a full queue applies backpressure", async (t) => {
	const { listener, good } = await populated(t);
	const { client } = await connected(listener.port);
	assertTagged(await client.login("a@example.test", good), "OK");
	let batch = "";
	for (let index = 0; index < 40; index += 1) batch += `p${index} ${index % 2 ? "NOOP" : "FETCH 1:* (UID FLAGS)"}\r\n`;
	client.write("s SELECT INBOX\r\n" + batch);
	await client.collect("s");
	for (let index = 0; index < 40; index += 1) assertTagged(await client.collect(`p${index}`), "OK", undefined, `p${index} in order`);
});

test("gate7: Python imaplib interoperates", { skip: !tryCommand("python3") && "python3 is not installed" }, async (t) => {
	const { listener, good, bytes } = await populated(t);
	const script = `
import imaplib, ssl, sys, json
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
m = imaplib.IMAP4_SSL("127.0.0.1", int(sys.argv[1]), ssl_context=ctx)
out = {"caps": list(m.capabilities)}
out["login"] = m.login("a@example.test", sys.argv[2])[0]
out["list"] = [x.decode() for x in m.list()[1]]
typ, data = m.select("INBOX", readonly=True)
out["select"] = [typ, data[0].decode()]
typ, data = m.fetch("1", "(RFC822)")
out["rfc822"] = data[0][1].hex()
typ, data = m.uid("SEARCH", None, "UNSEEN")
out["search"] = data[0].decode()
try:
    out["store"] = m.store("1", "+FLAGS", "\\\\Seen")[0]
except imaplib.IMAP4.error:
    out["store"] = "raised"
typ, data = m.select("INBOX")
out["select_rw"] = [typ, m.response("READ-WRITE")[1] != [None]]
typ, data = m.store("2", "+FLAGS", "(\\\\Flagged)")
out["store_rw"] = [typ, data[0].decode()]
typ, data = m.uid("STORE", "1", "+FLAGS.SILENT", "(\\\\Seen)")
out["uid_store_silent"] = [typ, [x.decode() if x else None for x in data]]
out["logout"] = m.logout()[0]
print(json.dumps(out))
`;
	const result = await new Promise((resolve, reject) => {
		const child = spawn("python3", ["-c", script, String(listener.port), good]);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr))));
	});
	assert.deepEqual(result.caps.sort(), ["AUTH=PLAIN", "ID", "IMAP4REV1", "SASL-IR"]);
	assert.equal(result.login, "OK");
	assert.equal(result.list.length, 8);
	assert.deepEqual(result.select, ["OK", "2"], "INBOX holds two messages; the third is filed in the custom folder");
	assert.equal(result.rfc822, Buffer.from(bytes).toString("hex"), "imaplib receives the exact octets");
	assert.equal(result.search, "1");
	assert.ok(["NO", "raised"].includes(result.store), `STORE refused under EXAMINE (${result.store})`);
	assert.deepEqual(result.select_rw, ["OK", true], "SELECT is READ-WRITE");
	assert.deepEqual(result.store_rw, ["OK", "2 (FLAGS (\\Seen \\Flagged))"]);
	assert.deepEqual(result.uid_store_silent, ["OK", [null]], ".SILENT sends no FETCH");
	assert.equal(result.logout, "BYE");
});

test("gate7: curl IMAPS interoperates", { skip: !tryCommand("curl") && "curl is not installed" }, async (t) => {
	const { listener, good, bytes } = await populated(t);
	const url = `imaps://127.0.0.1:${listener.port}`;
	const curl = (path, extra = []) => run("curl", ["-sS", "--insecure", "--user", `a@example.test:${good}`, ...extra, `${url}${path}`]);
	const listing = await curl("/");
	assert.equal(listing.status, 0, listing.stderr);
	assert.match(listing.stdout, /\* LIST \(\\Noinferiors\) NIL "INBOX"/);
	const message = await curl("/INBOX;UID=1");
	assert.equal(message.stdout, Buffer.from(bytes).toString("latin1"), "curl downloads the exact canonical message");
	// curl downloads with a non-PEEK BODY[] after SELECT, which sets \Seen (RFC 3501 §6.4.5).
	assert.match((await curl("/INBOX", ["--request", "SEARCH UNSEEN"])).stdout, /^\* SEARCH\r?$/m, "the downloaded message is now seen");
	assert.match((await curl("/INBOX", ["--request", "SEARCH SEEN"])).stdout, /^\* SEARCH 1 2\r?$/m);
	const store = await curl("/INBOX", ["--request", "STORE 1 +FLAGS (\\Flagged)"]);
	assert.equal(store.status, 0, store.stderr);
	assert.match(store.stdout, /^\* 1 FETCH \(FLAGS \(\\Seen \\Flagged\)\)/m, "curl's STORE changes the flag and sees the result");
	const refused = await curl("/INBOX", ["--request", "STORE 1 +FLAGS (\\Deleted)"]);
	assert.notEqual(refused.status, 0, "curl reports the refused \\Deleted");
});

test("gate7: openssl s_client sees implicit TLS and the greeting", { skip: !tryCommand("openssl") && "openssl is not installed" }, async (t) => {
	const { listener, certificate } = await listen(t);
	const output = await new Promise((resolve) => {
		const child = spawn("openssl", ["s_client", "-connect", `127.0.0.1:${listener.port}`, "-servername", "localhost", "-tls1_2", "-quiet", "-verify_quiet"]);
		let text = "";
		child.stdout.on("data", (chunk) => {
			text += chunk;
			if (text.includes("OK LOGOUT")) child.stdin.end();
		});
		child.stderr.on("data", () => {});
		child.stdin.write("a CAPABILITY\r\nb LOGOUT\r\n");
		child.on("close", () => resolve(text));
		setTimeout(() => child.kill(), 5000);
	});
	assert.match(output, /^\* OK \[CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN ID\]/);
	assert.match(output, /\* CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN ID\r\na OK/);
	assert.match(output, /\* BYE Logging out\r\nb OK LOGOUT completed/);
	const tls13 = await run("openssl", ["s_client", "-connect", `127.0.0.1:${listener.port}`, "-tls1_3", "-brief"], { input: "a LOGOUT\r\n" });
	assert.match(tls13.stderr + tls13.stdout, /TLSv1\.3/);
	const tls11 = await run("openssl", ["s_client", "-connect", `127.0.0.1:${listener.port}`, "-tls1_1", "-brief"]);
	assert.notEqual(tls11.status, 0, "TLS 1.1 handshakes fail");
	const presented = await run("openssl", ["s_client", "-connect", `127.0.0.1:${listener.port}`, "-showcerts"]);
	const fingerprint = (pem) => createHash("sha256").update(Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64")).digest("hex");
	const served = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(presented.stdout)[0];
	assert.equal(fingerprint(served), fingerprint(readFileSync(certificate.certPath, "utf8")), "the configured certificate is presented");
});
