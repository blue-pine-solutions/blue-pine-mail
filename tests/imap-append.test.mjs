import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import test from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import { assertTagged, createClock, install, loadApp, makeCertificate, memoryClient, tlsClient } from "./support/imap-harness.mjs";

/**
 * A5.7: IMAP APPEND into Drafts with UIDPLUS APPENDUID, over the real A2 verifier, A3 state and
 * file bucket (SQLite, no Workers), the in-memory transport, a virtual clock where time matters,
 * and the real Node TLS listener.
 *
 * - Drafts only (the stable `drafts` key), for the owner or a full_access delegate.
 * - The message literal has its own path: the framer hands the session the command up to it and
 *   holds; refusals happen before the continuation; accepted octets go into one buffer of
 *   exactly the announced size, under an absolute deadline; then framing resumes at the exact
 *   next octet. At most 10 MiB (JMAP's maxSizeUpload); no LITERAL+, no MULTIAPPEND.
 * - Bytes are stored exactly (`drafts/<id>.eml`), objects before the one guarded commit batch
 *   (message, attachments, then the UID), and the tagged OK carries APPENDUID from that batch.
 */
const { app, cleanup } = await loadApp("imap-append");
test.after(cleanup);

const MAX = 10 * 1024 * 1024;
const POLL = 10_000;
const SHARED = { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" };
const DELEGATE = { userId: "user-x", mailboxId: "mbx-s", address: "sales@example.test" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = async (rounds = 20) => {
	for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
};
const one = (context, query, ...params) => context.database.db.prepare(query).get(...params);
const all = (context, query, ...params) => context.database.db.prepare(query).all(...params);
const appendUid = (result) => {
	const match = /\[APPENDUID (\d+) (\d+)\]/.exec(result.tagged ?? "");
	return match ? { uidValidity: Number(match[1]), uid: Number(match[2]) } : null;
};
const gc = (() => {
	v8.setFlagsFromString("--expose-gc");
	return vm.runInNewContext("gc");
})();
const usedMemory = () => {
	gc();
	gc();
	const memory = process.memoryUsage();
	return memory.heapUsed + memory.arrayBuffers;
};

let messageCounter = 0;
/** A draft as a client writes it, as latin1 octets. */
function draft({ from = "Ann Example <a@example.test>", to = "Bob <bob@elsewhere.test>", subject = "A draft", body = "Hello there.", headers = "", messageId = `<draft-${++messageCounter}@example.test>` } = {}) {
	return Buffer.from(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: Tue, 3 Mar 2026 10:15:00 +0100\r\nMessage-ID: ${messageId}\r\n${headers}\r\n${body}\r\n`, "latin1");
}

/** A text-heavy draft of exactly `size` octets. */
function sizedDraft(size, { from = "Ann Example <a@example.test>", fill = "z" } = {}) {
	const head = Buffer.from(`From: ${from}\r\nTo: bob@elsewhere.test\r\nSubject: big\r\nMessage-ID: <big-${++messageCounter}@example.test>\r\n\r\n`, "latin1");
	const line = Buffer.from(`${fill.repeat(76)}\r\n`, "latin1");
	const out = Buffer.alloc(size);
	head.copy(out, 0);
	for (let offset = head.length; offset < size; offset += line.length) line.copy(out, offset, 0, Math.min(line.length, size - offset));
	return out;
}

/** Send an APPEND; returns the tagged result, or the refusal when no continuation came. */
async function append(client, bytes, { mailbox = "Drafts", flags, date, tag = client.nextTag(), chunk = 64 * 1024, timeoutMs } = {}) {
	client.write(`${tag} APPEND ${mailbox}${flags !== undefined ? ` (${flags})` : ""}${date ? ` "${date}"` : ""} {${bytes.length}}\r\n`);
	const first = await client.unit(timeoutMs);
	if (!first.text.startsWith("+ ")) return { continuation: false, untagged: [], tagged: first.text, ok: false };
	for (let offset = 0; offset < bytes.length; offset += chunk) client.write(bytes.subarray(offset, offset + chunk));
	client.write("\r\n");
	return { continuation: true, ...(await client.collect(tag, timeoutMs)) };
}

async function login(context, client, account = {}) {
	const { userId = "user-a", mailboxId = "mbx-a", address = "a@example.test" } = account;
	const { credential, id } = await context.credential(userId, mailboxId);
	assertTagged(await client.login(address, credential), "OK");
	return id;
}

async function connect(context, account, overrides = {}, options = {}) {
	const { client, session, start } = memoryClient(app, context.env, overrides, options);
	await start();
	const credentialId = await login(context, client, account);
	return { client, session, credentialId };
}

async function setup(t) {
	const context = await install(app, t);
	// user-x is a full_access delegate of the shared mailbox (user-b stays read_only).
	context.database.db.exec("INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('acc-x', 'mbx-s', 'user-x', 'full_access', 1)");
	return context;
}

/** Every stored object key under drafts/ and attachments/. */
function objects(context) {
	const rootDirectory = join(context.directory, "blobs");
	const out = [];
	const walk = (directory) => {
		let entries = [];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (!entry.name.endsWith(".meta.json")) out.push(relative(rootDirectory, path).split("\\").join("/"));
		}
	};
	walk(join(rootDirectory, "drafts"));
	walk(join(rootDirectory, "attachments"));
	return out.sort();
}

const drafts = (context) => all(context, "SELECT * FROM messages WHERE status = 'draft' ORDER BY created_at, id");
const draftUids = (context) => all(context, "SELECT u.uid, u.message_id, u.rfc822_key, u.rfc822_size, u.draft_fingerprint FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key = 'drafts' ORDER BY u.uid");
const draftFolder = (context, mailboxId = "mbx-a") => one(context, "SELECT * FROM imap_folders WHERE mailbox_id = ? AND folder_key = 'drafts'", mailboxId);

function countingPermits(limiter) {
	const permits = { held: 0, granted: 0, requested: 0 };
	permits.acquire = async (userId) => {
		permits.requested += 1;
		const release = limiter ? await limiter.acquire(userId) : () => {};
		permits.granted += 1;
		permits.held += 1;
		let done = false;
		return () => {
			if (done) return;
			done = true;
			permits.held -= 1;
			release();
		};
	};
	return permits;
}

async function until(predicate, ms = 5_000, what = "condition") {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await tick(5);
		await sleep(2);
	}
}

/** Whether a response unit arrives within `ms` (real time). */
async function nothingWithin(client, ms) {
	try {
		const unit = await client.unit(ms);
		return unit === null ? "closed" : unit.text;
	} catch {
		return true;
	}
}

// ---- A. Framer: the APPEND literal path ----------------------------------------------------------

function framer(appendLiterals = true) {
	const continuations = [];
	const instance = new app.CommandFramer(() => ({ maxLine: 64 * 1024, maxLiteral: 64 * 1024, maxLiterals: 16, appendLiterals }), () => continuations.push("+"));
	return { framer: instance, continuations };
}
const bytes = (text) => new Uint8Array(Buffer.from(text, "latin1"));

test("a5.7 A: the framer hands over APPEND before its literal, holds, then fills exactly N octets and resumes at the next octet", () => {
	const { framer: f, continuations } = framer();
	f.feed(bytes("a APPEND Drafts (\\Seen) {15}\r\n"));
	const item = f.next();
	assert.deepEqual({ kind: item.kind, size: item.size, text: item.parts.map((part) => part.text) }, { kind: "append", size: 15, text: ["a APPEND Drafts (\\Seen) "] });
	assert.equal(continuations.length, 0, "no continuation from the framer");
	assert.equal(f.holding, true);
	// A client that does not wait: nothing is framed while held.
	f.feed(bytes("\r\nA9 LOGOUT\r\nxx\r\nb NOOP\r\n"));
	assert.equal(f.next(), null);
	assert.ok(f.midCommand);
	const sink = new Uint8Array(15);
	f.acceptAppend(sink);
	assert.deepEqual(f.next(), { kind: "append-end", trailing: "" });
	assert.equal(Buffer.from(sink).toString("latin1"), "\r\nA9 LOGOUT\r\nxx", "command-looking octets are message data");
	assert.deepEqual(f.next(), { kind: "command", parts: [{ kind: "text", text: "b NOOP" }] });
	assert.equal(f.next(), null);
	assert.equal(f.midCommand, false);
});

test("a5.7 A: split markers, one-octet chunks, a mailbox literal, trailing data, refusal and LITERAL+", () => {
	{
		// One octet at a time, the literal's own octets straight into the sink.
		const { framer: f } = framer();
		const wire = "t1 APPEND \"Drafts\" {5}\r\n";
		for (const char of wire) f.feed(bytes(char));
		const item = f.next();
		assert.equal(item.kind, "append");
		const sink = new Uint8Array(5);
		f.acceptAppend(sink);
		for (const char of "hello\r\nn NOOP\r\n") {
			f.feed(bytes(char));
		}
		assert.deepEqual(f.next(), { kind: "append-end", trailing: "" });
		assert.equal(Buffer.from(sink).toString(), "hello");
		assert.deepEqual(f.next(), { kind: "command", parts: [{ kind: "text", text: "n NOOP" }] });
	}
	{
		// The mailbox as an ordinary literal (with its continuation), then the message literal.
		const { framer: f, continuations } = framer();
		f.feed(bytes("t2 APPEND {6}\r\n"));
		assert.equal(f.next(), null);
		assert.equal(continuations.length, 1, "the mailbox literal is ordinary");
		f.feed(bytes("Drafts {3}\r\n"));
		const item = f.next();
		assert.equal(item.kind, "append");
		assert.equal(item.parts[1].kind, "literal");
		assert.equal(Buffer.from(item.parts[1].bytes).toString(), "Drafts");
		const sink = new Uint8Array(3);
		f.acceptAppend(sink);
		f.feed(bytes("abc {9}\r\n"));
		assert.deepEqual(f.next(), { kind: "append-end", trailing: " {9}" }, "a second message (MULTIAPPEND) comes back raw, not as a literal");
		assert.equal(continuations.length, 1);
	}
	{
		// Refused: the client was sent no continuation, so its next command is framed normally.
		const { framer: f } = framer();
		f.feed(bytes("t3 APPEND Inbox {20}\r\nn NOOP\r\n"));
		assert.equal(f.next().kind, "append");
		f.refuseAppend();
		assert.deepEqual(f.next(), { kind: "command", parts: [{ kind: "text", text: "n NOOP" }] });
	}
	{
		const { framer: f } = framer();
		f.feed(bytes("t4 APPEND Drafts {5+}\r\nhello\r\n"));
		assert.deepEqual(f.next(), { kind: "error", tag: null, message: "Non-synchronizing literals are not supported", fatal: true });
	}
	{
		// Without appendLiterals (before authentication) APPEND's literal is ordinary and bounded as before.
		const { framer: f, continuations } = framer(false);
		f.feed(bytes("t5 APPEND Drafts {70000}\r\n"));
		assert.deepEqual(f.next(), { kind: "error", tag: "t5", message: "Literal too large", fatal: false });
		assert.equal(continuations.length, 0);
	}
});

test("a5.7 A: receive-only memory: one N-octet buffer, no second copy, no growth while held", () => {
	const { framer: f } = framer();
	const size = 8 * 1024 * 1024;
	f.feed(bytes(`a APPEND Drafts {${size}}\r\n`));
	assert.equal(f.next().kind, "append");
	const chunk = new Uint8Array(64 * 1024).fill(0x61);
	// Held: octets sent early are buffered (the session pauses reading), but nothing is allocated for N.
	const base = usedMemory();
	const sink = new Uint8Array(size);
	const allocated = usedMemory() - base;
	f.acceptAppend(sink);
	for (let sent = 0; sent < size - chunk.length; sent += chunk.length) f.feed(chunk);
	const during = usedMemory() - base;
	assert.ok(f.buffered < 64 * 1024, "nothing accumulates outside the buffer");
	const ratio = during / size;
	assert.ok(allocated / size > 0.95, "the buffer is the one N-octet allocation");
	assert.ok(ratio < 1.1, `receive retains ${ratio.toFixed(3)}x the literal (buffer included)`);
	f.feed(chunk);
	f.feed(bytes("\r\n"));
	assert.deepEqual(f.next(), { kind: "append-end", trailing: "" });
	assert.equal(sink[size - 1], 0x61);
});

// ---- B. Session: grammar, refusals before the continuation ---------------------------------------

test("a5.7 B: APPEND Drafts with flags, a date, a quoted or literal mailbox, and APPENDUID", async (t) => {
	const context = await setup(t);
	const { client } = await connect(context);
	const plain = await append(client, draft({ subject: "plain" }));
	assertTagged(plain, "OK", /^t\d+ OK \[APPENDUID \d+ \d+\] APPEND completed$/);
	const withFlags = await append(client, draft({ subject: "flags" }), { flags: "\\Seen \\Draft \\Flagged \\Answered $Label", date: "05-Oct-2026 13:45:10 +0200" });
	assertTagged(withFlags, "OK", /APPENDUID/);
	const quoted = await append(client, draft({ subject: "quoted" }), { mailbox: '"Drafts"' });
	assertTagged(quoted, "OK", /APPENDUID/);
	client.write("lit APPEND {6}\r\n");
	assert.match((await client.unit()).text, /^\+ /, "the mailbox literal is ordinary");
	const message = draft({ subject: "literal mailbox" });
	client.write(`Drafts {${message.length}}\r\n`);
	assert.match((await client.unit()).text, /^\+ Ready/);
	client.write(message);
	client.write("\r\n");
	assertTagged(await client.collect("lit"), "OK", /APPENDUID/);
	assert.deepEqual(drafts(context).map((row) => row.subject).sort(), ["flags", "literal mailbox", "plain", "quoted"]);
	const flagged = drafts(context).find((row) => row.subject === "flags");
	assert.equal(flagged.starred, 1, "\\Flagged stars the draft");
	assert.equal(flagged.read, 1);
	assert.ok(drafts(context).filter((row) => row.subject !== "flags").every((row) => row.starred === 0));
	assertTagged(await client.command("NOOP"), "OK");
});

test("a5.7 B: everything refusable is refused before the continuation, and the stream stays in sync", async (t) => {
	const context = await setup(t);
	context.database.db.exec("INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-d', 'user-a', 'mbx-a', 'Drafts', 2), ('fld-u', 'user-a', 'mbx-a', 'Café', 3)");
	const { client } = await connect(context);
	const list = (await client.command('LIST "" "*"')).untagged.map((unit) => unit.text);
	assert.ok(list.some((text) => text.endsWith('"Drafts (2)"')), "a custom Drafts is listed with a suffix");
	const cases = [
		["Drafts (\\Recent) {5}", "BAD", /Recent/],
		["Drafts (\\Foo) {5}", "BAD", /Unknown system flag/],
		["Drafts (\\Deleted) {5}", "NO", /^\S+ NO \[CANNOT\] \\Deleted cannot be set by APPEND$/],
		['Drafts "32-Jan-2026 10:00:00 +0000" {5}', "BAD", /Invalid date-time/],
		['Drafts "5-Oct-2026 10:00:00 +0000" {5}', "BAD", /Invalid date-time/],
		['Drafts "05-Foo-2026 10:00:00 +0000" {5}', "BAD", /Invalid date-time/],
		['Drafts "05-Oct-2026 24:00:00 +0000" {5}', "BAD", /Invalid date-time/],
		['Drafts "05-Oct-2026 10:00:00 0000" {5}', "BAD", /Invalid date-time/],
		["Drafts{5}", "BAD", undefined],
		["Drafts (\\Seen) extra {5}", "BAD", undefined],
		[`Drafts {${MAX + 1}}`, "NO", /^\S+ NO \[LIMIT\] Message too large$/],
		["Drafts {0}", "NO", /^\S+ NO \[CANNOT\] Empty message$/],
		["drafts {5}", "NO", /^\S+ NO \[NONEXISTENT\] No such mailbox$/],
		["Nowhere {5}", "NO", /\[NONEXISTENT\]/],
		["INBOX {5}", "NO", /^\S+ NO \[CANNOT\] APPEND is only available for Drafts$/],
		['"Drafts (2)" {5}', "NO", /\[CANNOT\] APPEND is only available for Drafts/],
		["Caf&AOk- {5}", "NO", /\[CANNOT\] APPEND is only available for Drafts/],
		["Sent {5}", "NO", /\[CANNOT\]/],
		["Trash {5}", "NO", /\[CANNOT\]/],
		["Work {5}", "NO", /\[CANNOT\]/],
	];
	for (const [args, status, pattern] of cases) {
		const tag = client.nextTag();
		client.write(`${tag} APPEND ${args}\r\n`);
		const result = await client.collect(tag);
		assert.deepEqual(result.untagged, [], `${args}: no continuation`);
		assertTagged(result, status, pattern, args);
		assertTagged(await client.command("NOOP"), "OK", undefined, `${args}: still in sync`);
	}
	assertTagged(await client.command("APPEND Drafts"), "BAD", /needs a message literal/);
	assert.equal(drafts(context).length, 0);
	assert.deepEqual(objects(context), []);
	assert.equal(draftFolder(context), undefined, "nothing was touched, not even IMAP state");
});

test("a5.7 B: before authentication APPEND is refused as before; LITERAL+ ends the session", async (t) => {
	const context = await setup(t);
	const { client, start } = memoryClient(app, context.env);
	await start();
	client.write("a APPEND Drafts {2000}\r\n");
	assertTagged(await client.collect("a"), "BAD", /Literal too large/, "the ordinary 1 KiB pre-authentication limit");
	client.write("b APPEND Drafts {5}\r\n");
	assert.match((await client.unit()).text, /^\+ /);
	client.write("hello\r\n");
	assertTagged(await client.collect("b"), "BAD", /not valid in this state/);
	await login(context, client);
	client.write("c APPEND Drafts {5+}\r\n");
	assert.equal((await client.unit()).text, "* BYE Non-synchronizing literals are not supported");
});

// ---- C. Exact octets, sizes and pipelining ------------------------------------------------------

test("a5.7 C: the stored draft is the literal byte for byte; FETCH serves it; RFC822.SIZE is N", async (t) => {
	const context = await setup(t);
	const { client } = await connect(context);
	const message = Buffer.concat([
		Buffer.from("From: a@example.test\nTo: bob@elsewhere.test\r\nSubject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=\r\nDate: Tue, 3 Mar 2026 10:15:00 +0100\r\nMessage-ID: <exact@example.test>\r\n\r\nbare LF\nNUL \x00 and 8-bit \xff\xfe and invalid UTF-8 \xc3\x28\r\nA9 LOGOUT\r\n.\r\n", "latin1"),
		Buffer.from("no final newline", "latin1"),
	]);
	const result = await append(client, message);
	const { uid, uidValidity } = appendUid(result);
	const row = drafts(context)[0];
	assert.equal(row.raw_r2_key, `drafts/${row.id}.eml`);
	const stored = Buffer.from(await (await context.env.BUCKET.get(row.raw_r2_key)).arrayBuffer());
	assert.deepEqual(stored, message, "stored exactly: no CRLF normalization, no header changes");
	assertTagged(await client.command("SELECT Drafts"), "OK");
	const fetched = await client.command(`UID FETCH ${uid} (RFC822.SIZE BODY.PEEK[])`);
	assert.match(fetched.untagged[0].text, new RegExp(`^\\* 1 FETCH \\(UID ${uid} RFC822\\.SIZE ${message.length} BODY\\[\\] \\{${message.length}\\}`));
	assert.deepEqual(fetched.literals[0], message);
	assert.equal(draftFolder(context).uid_validity, uidValidity);
	assert.equal(row.provider_message_id, "<exact@example.test>");
	assert.equal(row.direction, "outbound");
	assert.equal(row.user_id, "user-a");
	assert.ok(row.text_body.includes("\u0000"), "NUL survives into the parsed text");
});

test("a5.7 C: sizes up to exactly 10 MiB; split and pipelined input; a command after the body runs", async (t) => {
	const context = await setup(t);
	const { client } = await connect(context);
	for (const size of [3 * 1024 * 1024, MAX - 100 * 1024, MAX]) {
		const message = sizedDraft(size);
		const result = await append(client, message, { chunk: 61 * 1024 });
		assertTagged(result, "OK", /APPENDUID/, `${size} octets`);
		const row = one(context, "SELECT * FROM messages WHERE id = (SELECT message_id FROM imap_message_uids WHERE uid = ? AND imap_folder_id = (SELECT id FROM imap_folders WHERE folder_key = 'drafts'))", appendUid(result).uid);
		assert.equal((await context.env.BUCKET.get(row.raw_r2_key)).size, size);
	}
	assert.equal(app.append.MAX_APPEND_SIZE, MAX);
	assert.equal(app.append.MAX_APPEND_SIZE, app.JMAP_LIMITS.maxSizeUpload, "pinned to JMAP's maxSizeUpload");

	// Everything in one write after the continuation: the body (with command-looking lines), its CRLF and the next command.
	const message = draft({ body: "line\r\nA2 LOGOUT\r\nA3 DELETE INBOX\r\n" });
	client.write(`p1 APPEND Drafts {${message.length}}\r\n`);
	assert.match((await client.unit()).text, /^\+ /);
	client.write(Buffer.concat([message, Buffer.from("\r\nA2 NOOP\r\n", "latin1")]));
	assertTagged(await client.collect("p1"), "OK", /APPENDUID/);
	assertTagged(await client.collect("A2"), "OK", /NOOP completed/);
	// A client that sends without waiting for the continuation: reading pauses; its octets become the message.
	const paused = { count: 0, resumed: 0 };
	const eager = await connect(context, undefined, { pause: () => (paused.count += 1), resume: () => (paused.resumed += 1) });
	const early = draft({ subject: "early" });
	eager.client.write(Buffer.concat([Buffer.from(`e1 APPEND Drafts {${early.length}}\r\n`, "latin1"), early, Buffer.from("\r\ne2 NOOP\r\n", "latin1")]));
	assert.match((await eager.client.unit()).text, /^\+ /);
	assertTagged(await eager.client.collect("e1"), "OK", /APPENDUID/);
	assertTagged(await eager.client.collect("e2"), "OK");
	assert.ok(paused.count >= 1 && paused.resumed >= 1, "reading paused while the APPEND was undecided");
	assert.equal(drafts(context).length, 5);
	// Trailing data after the literal (a MULTIAPPEND attempt) stores nothing.
	client.write(`m1 APPEND Drafts {${message.length}}\r\n`);
	assert.match((await client.unit()).text, /^\+ /);
	client.write(message);
	client.write(" (\\Seen) {3}\r\n");
	assertTagged(await client.collect("m1"), "BAD", /Unexpected data after the message/);
	assertTagged(await client.command("NOOP"), "OK");
	assert.equal(drafts(context).length, 5);
});

test("a5.7 C: session receive memory is the buffer itself; a waiting APPEND allocates nothing", async (t) => {
	const context = await setup(t);
	let grant = null;
	const permits = { requested: 0 };
	const { client } = await connect(context, undefined, {
		acquireAppend: () => {
			permits.requested += 1;
			return new Promise((resolve) => (grant = () => resolve(() => {})));
		},
	});
	const size = MAX;
	const message = sizedDraft(size);
	const base = usedMemory();
	client.write(`w1 APPEND Drafts {${size}}\r\n`);
	await until(() => permits.requested === 1, 5_000, "the permit request");
	assert.equal(await nothingWithin(client, 100), true, "no continuation while waiting for a permit");
	const waiting = usedMemory() - base;
	assert.ok(waiting < 1024 * 1024, `waiting for a permit retains ${waiting} octets`);
	grant();
	assert.match((await client.unit()).text, /^\+ /);
	for (let offset = 0; offset < size - 1; offset += 64 * 1024) client.write(message.subarray(offset, Math.min(offset + 64 * 1024, size - 1)));
	const receiving = (usedMemory() - base) / size;
	t.diagnostic(`receive-only (N-1 of N octets received): ${receiving.toFixed(3)}x N`);
	assert.ok(receiving < 1.25, `receiving retains ${receiving.toFixed(3)}x the literal`);
	client.write(message.subarray(size - 1));
	client.write("\r\n");
	assertTagged(await client.collect("w1"), "OK", /APPENDUID/);
});

// ---- D. Deadline, disconnect, shutdown ----------------------------------------------------------

test("a5.7 D: an absolute literal deadline that a drip never extends; nothing stored; permit released", async (t) => {
	const context = await setup(t);
	const clock = createClock();
	const permits = countingPermits();
	const timeouts = { loginMs: 60_000, unauthenticatedIdleMs: 60_000, authenticatedIdleMs: 30 * 60_000, appendLiteralBaseMs: 60_000, appendLiteralMinBytesPerSecond: 16_384 };
	const { client, session } = await connect(context, undefined, { now: clock.now, delay: clock.delay, acquireAppend: permits.acquire }, { timeouts });
	clock.watch(session);
	const message = sizedDraft(32 * 1024);
	client.write(`d1 APPEND Drafts {${message.length}}\r\n`);
	assert.match((await client.unit()).text, /^\+ /);
	// 60 s + 32 KiB at 16 KiB/s = 62 s, from the continuation.
	for (let second = 0; second < 61; second += 1) {
		client.write(message.subarray(second, second + 1));
		await tick();
		await clock.advance(1_000, 50);
		await tick();
		assert.equal(session.isClosed, false, `open at ${second + 1} s`);
	}
	await clock.advance(1_000, 50);
	await tick();
	assert.equal(session.isClosed, true);
	const units = [];
	for (;;) {
		const unit = await client.unit(500).catch(() => null);
		if (!unit) break;
		units.push(unit.text);
	}
	assert.equal(units.at(-1), "* BYE Autologout");
	assert.ok(client.logs.some((event) => event.event === "append.timeout"));
	assert.equal(permits.held, 0);
	assert.equal(drafts(context).length, 0);
	assert.deepEqual(objects(context), []);
	assert.equal(app.append.appendLiteralDeadlineMs(32 * 1024, app.append.DEFAULT_APPEND_TIMING), 62_000);
	assert.equal(app.append.appendLiteralDeadlineMs(MAX, app.append.DEFAULT_APPEND_TIMING), 60_000 + 640_000);
});

test("a5.7 D: a slow sender within the deadline succeeds; disconnect or shutdown mid-literal stores nothing and releases the permit", async (t) => {
	const context = await setup(t);
	{
		const clock = createClock();
		const timeouts = { loginMs: 60_000, unauthenticatedIdleMs: 60_000, authenticatedIdleMs: 30 * 60_000 };
		const { client, session } = await connect(context, undefined, { now: clock.now, delay: clock.delay }, { timeouts });
		clock.watch(session);
		const message = sizedDraft(16 * 1024);
		client.write(`s1 APPEND Drafts {${message.length}}\r\n`);
		assert.match((await client.unit()).text, /^\+ /);
		for (let offset = 0; offset < message.length; offset += 1024) {
			client.write(message.subarray(offset, offset + 1024));
			await clock.advance(3_000, 50);
		}
		client.write("\r\n");
		assertTagged(await client.collect("s1"), "OK", /APPENDUID/, "48 s for 16 KiB, within 61 s");
	}
	for (const way of ["disconnect", "shutdown"]) {
		const permits = countingPermits();
		const { client, session } = await connect(context, undefined, { acquireAppend: permits.acquire });
		const message = sizedDraft(512 * 1024);
		client.write(`x1 APPEND Drafts {${message.length}}\r\n`);
		assert.match((await client.unit()).text, /^\+ /);
		client.write(message.subarray(0, 300 * 1024));
		assert.equal(permits.held, 1);
		if (way === "disconnect") session.transportClosed();
		else await session.end("Server shutting down");
		await tick();
		assert.equal(permits.held, 0, `${way}: permit released`);
		client.write(message.subarray(300 * 1024));
		await tick();
	}
	assert.equal(drafts(context).length, 1);
	assert.equal(objects(context).length, 1);
});

// ---- E. Authorization ---------------------------------------------------------------------------

test("a5.7 E: owner and full_access delegate succeed; send_as, send_on_behalf and read_only are NOPERM before the continuation", async (t) => {
	const context = await setup(t);
	assertTagged(await append((await connect(context)).client, draft()), "OK", /APPENDUID/, "owner");
	assertTagged(await append((await connect(context, DELEGATE)).client, draft({ from: "Sales <sales@example.test>" })), "OK", /APPENDUID/, "full_access delegate");
	for (const permission of ["read_only", "send_on_behalf", "send_as"]) {
		context.database.db.prepare("UPDATE mailbox_access SET permission = ? WHERE id = 'acc-b'").run(permission);
		const { client } = await connect(context, SHARED);
		const result = await append(client, draft({ from: "sales@example.test" }));
		assert.equal(result.continuation, false, permission);
		assertTagged(result, "NO", /^\S+ NO \[NOPERM\] This access does not allow creating drafts$/, permission);
		assertTagged(await client.command("NOOP"), "OK");
	}
	assert.equal(drafts(context).length, 2);
	assert.deepEqual(drafts(context).map((row) => [row.mailbox_id, row.user_id]).sort(), [["mbx-a", "user-a"], ["mbx-s", "user-x"]]);
	// The From must be one the principal may send from in this mailbox; a missing From is refused.
	const { client } = await connect(context);
	assertTagged(await append(client, draft({ from: "Someone <someone@elsewhere.test>" })), "NO", /^\S+ NO \[CANNOT\] The From address cannot be used from this mailbox$/);
	assertTagged(await append(client, Buffer.from("Subject: no from\r\n\r\nx\r\n", "latin1")), "NO", /\[CANNOT\] The message has no From header/);
	assertTagged(await append(client, Buffer.from("just text, no header\r\n", "latin1")), "NO", /\[CANNOT\] The message has no From header/);
	assert.equal(drafts(context).length, 2);
	assert.equal(objects(context).length, 2);
});

/** Ways to lose access, applied to the context; `delegate` ones apply to user-x's full_access. */
const LOSSES = {
	"revoked credential": (context, credentialId) => context.database.db.prepare("DELETE FROM mail_app_passwords WHERE id = ?").run(credentialId),
	"removed imap scope": (context, credentialId) => context.database.db.prepare("UPDATE mail_app_passwords SET scopes = '[\"smtp\"]' WHERE id = ?").run(credentialId),
	"disabled user": (context) => context.database.db.exec("UPDATE users SET disabled = 1 WHERE id IN ('user-a', 'user-x')"),
	"disabled mailbox": (context) => context.database.db.exec("UPDATE mailboxes SET disabled = 1 WHERE id IN ('mbx-a', 'mbx-s')"),
	"sharing disabled": () => (process.env.BLUEPINE_DISABLED_FEATURES = "sharedMailboxes"),
	"downgraded to read_only": (context) => context.database.db.exec("UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-x'"),
};
const DELEGATED = new Set(["sharing disabled", "downgraded to read_only"]);

async function withLoss(t, name, run) {
	const previous = process.env.BLUEPINE_DISABLED_FEATURES;
	try {
		const context = await setup(t);
		const account = DELEGATED.has(name) ? DELEGATE : undefined;
		const from = account ? "sales@example.test" : "a@example.test";
		await run(context, account, from);
	} finally {
		if (previous === undefined) delete process.env.BLUEPINE_DISABLED_FEATURES;
		else process.env.BLUEPINE_DISABLED_FEATURES = previous;
	}
}

const expectedEnd = (name) => (name === "downgraded to read_only" ? /^\S+ NO \[NOPERM\]/ : /^\* BYE Access revoked$/);

async function finish(client, tag) {
	const units = [];
	for (;;) {
		const unit = await client.unit(2_000).catch(() => null);
		if (!unit) return units;
		units.push(unit.text);
		if (unit.text.startsWith(`${tag} `)) return units;
	}
}

test("a5.7 E: access lost before the continuation or during the literal: nothing is stored", async (t) => {
	for (const [name, lose] of Object.entries(LOSSES)) {
		for (const moment of ["before continuation", "during literal"]) {
			await withLoss(t, name, async (context, account, from) => {
				const permits = countingPermits();
				const { client, credentialId } = await connect(context, account, { acquireAppend: permits.acquire });
				const message = draft({ from });
				if (moment === "before continuation") lose(context, credentialId);
				client.write(`r1 APPEND Drafts {${message.length}}\r\n`);
				const first = await client.unit();
				if (moment === "before continuation") {
					assert.ok(!first.text.startsWith("+"), `${name} ${moment}: no continuation`);
					assert.match(first.text, name === "downgraded to read_only" ? /^r1 NO \[NOPERM\]/ : /^\* BYE Access revoked$/, `${name} ${moment}`);
				} else {
					assert.match(first.text, /^\+ /);
					client.write(message.subarray(0, 10));
					lose(context, credentialId);
					client.write(message.subarray(10));
					client.write("\r\n");
					const units = await finish(client, "r1");
					assert.match(units.at(-1), expectedEnd(name), `${name} ${moment}`);
				}
				await tick();
				assert.equal(permits.held, 0, `${name} ${moment}: permit released`);
				assert.equal(drafts(context).length, 0, `${name} ${moment}: nothing stored`);
				assert.deepEqual(objects(context), [], `${name} ${moment}: no objects`);
			});
		}
	}
});

test("a5.7 E: access lost after the checks, while objects are written: only the commit's guard sees it, and it stores nothing", async (t) => {
	// The imap scope alone is not part of the SQL guard (as for A5.2c deletion); it is checked
	// by authorizeImapAccess before the literal and again when APPEND processing starts.
	for (const name of Object.keys(LOSSES).filter((loss) => loss !== "removed imap scope")) {
		for (const moment of ["first object write", "after the last object write"]) {
			await withLoss(t, name, async (context, account, from) => {
				const { client, credentialId } = await connect(context, account);
				const bucket = context.env.BUCKET;
				const put = bucket.put.bind(bucket);
				let writes = 0;
				const attachment = Buffer.from("PDF").toString("base64");
				const message = draft({ from, headers: "Content-Type: multipart/mixed; boundary=b\r\n", body: `--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=a.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachment}\r\n--b--` });
				bucket.put = async (key, value, options) => {
					writes += 1;
					if (moment === "first object write" && writes === 1) LOSSES[name](context, credentialId);
					const result = await put(key, value, options);
					if (moment === "after the last object write" && writes === 2) LOSSES[name](context, credentialId);
					return result;
				};
				try {
					const result = await append(client, message);
					const text = result.tagged ?? "";
					assert.match(text || "* BYE Access revoked", expectedEnd(name), `${name} at ${moment}: ${text}`);
				} finally {
					bucket.put = put;
				}
				assert.equal(writes, 2, "raw and attachment objects were written");
				assert.equal(drafts(context).length, 0, `${name} at ${moment}: no draft`);
				assert.equal(all(context, "SELECT * FROM message_attachments").length, 0);
				assert.deepEqual(objects(context), [], `${name} at ${moment}: objects removed`);
			});
		}
	}
});

// ---- F. Flags, INTERNALDATE ---------------------------------------------------------------------

test("a5.7 F: flags as STORE takes them; INTERNALDATE from the date-time or now; the Date header untouched", async (t) => {
	const context = await setup(t);
	const { client } = await connect(context);
	const before = Math.floor(Date.now() / 1000);
	const dated = draft({ subject: "dated" });
	const results = {
		none: await append(client, draft({ subject: "none" })),
		dated: await append(client, dated, { flags: "\\Flagged", date: "05-Oct-2026 13:45:10 +0200" }),
		padded: await append(client, draft({ subject: "padded" }), { flags: "", date: " 7-mar-2026 00:00:59 -0530" }),
		kept: await append(client, draft({ subject: "kept" }), { flags: "\\Seen \\Draft \\Answered $Forwarded" }),
	};
	const after = Math.ceil(Date.now() / 1000);
	for (const [name, result] of Object.entries(results)) assertTagged(result, "OK", /APPENDUID/, name);
	const rows = Object.fromEntries(drafts(context).map((row) => [row.subject, row]));
	assert.ok(rows.none.created_at >= before && rows.none.created_at <= after, "omitted: now, not the Date header");
	assert.equal(rows.dated.created_at, Date.UTC(2026, 9, 5, 11, 45, 10) / 1000);
	assert.equal(rows.padded.created_at, Date.UTC(2026, 2, 7, 5, 30, 59) / 1000);
	assertTagged(await client.command("SELECT Drafts"), "OK");
	const fetched = (await client.command(`UID FETCH 1:* (FLAGS INTERNALDATE BODY.PEEK[])`)).untagged;
	const byUid = (uid) => fetched.find((unit) => unit.text.includes(`UID ${uid} `));
	const { uid: datedUid } = appendUid(results.dated);
	assert.match(byUid(datedUid).text, /FLAGS \(\\Seen \\Flagged \\Draft\) INTERNALDATE "05-Oct-2026 11:45:10 \+0000"/);
	assert.deepEqual(byUid(datedUid).literals[0], dated, "the Date header is byte-identical");
	assert.match(byUid(appendUid(results.kept).uid).text, /FLAGS \(\\Seen \\Draft\) /, "\\Answered and keywords are accepted and not kept");
	assert.equal(rows.kept.starred, 0);
	assert.equal(app.append.parseDateTime("29-Feb-2028 23:59:59 +1400").toISOString(), "2028-02-29T09:59:59.000Z");
	assert.throws(() => app.append.parseDateTime("29-Feb-2027 10:00:00 +0000"), /Invalid date-time/);
});

// ---- G. UIDs and APPENDUID ----------------------------------------------------------------------

test("a5.7 G: APPENDUID is the UID a later SELECT and UID FETCH show; UIDNEXT advances; a sync keeps it", async (t) => {
	const context = await setup(t);
	const { client } = await connect(context);
	const status = async () => (await client.command("STATUS Drafts (MESSAGES UIDNEXT UIDVALIDITY)")).untagged[0].text;
	assertTagged(await client.command("STATUS Drafts (UIDNEXT)"), "OK");
	const first = appendUid(await append(client, draft({ subject: "one" })));
	const pdf = Buffer.from("%PDF-1.4 tiny").toString("base64");
	const withAttachment = draft({ subject: "two", headers: "Content-Type: multipart/mixed; boundary=b\r\n", body: `--b\r\nContent-Type: text/plain\r\n\r\nsee attached\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="report.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${pdf}\r\n--b\r\nContent-Type: image/png\r\nContent-Disposition: inline; filename=x.png\r\nContent-ID: <img1>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n--b--` });
	const second = appendUid(await append(client, withAttachment));
	const nul = appendUid(await append(client, draft({ subject: "three", body: "NUL \u0000 in the body" })));
	assert.equal(second.uid, first.uid + 1);
	assert.equal(nul.uid, second.uid + 1);
	assert.equal(new Set([first.uidValidity, second.uidValidity, nul.uidValidity]).size, 1);
	assert.equal(await status(), `* STATUS "Drafts" (MESSAGES 3 UIDNEXT ${nul.uid + 1} UIDVALIDITY ${first.uidValidity})`);
	const bound = draftUids(context);
	// Another session's SELECT runs A3's sync, which re-checks every Drafts fingerprint.
	const other = (await connect(context)).client;
	const select = await other.command("SELECT Drafts");
	assert.ok(select.untagged.some((unit) => unit.text === `* OK [UIDVALIDITY ${first.uidValidity}] UIDs valid`));
	assert.deepEqual((await other.command("UID SEARCH ALL")).untagged[0].text, `* SEARCH ${first.uid} ${second.uid} ${nul.uid}`);
	assert.deepEqual(draftUids(context), bound, "the sync kept every UID and its binding: the fingerprints were right at commit");
	const attachments = all(context, "SELECT * FROM message_attachments ORDER BY filename");
	assert.deepEqual(attachments.map((row) => [row.filename, row.content_type, row.disposition, row.content_id, row.size]), [["report.pdf", "application/pdf", "attachment", null, 13], ["x.png", "image/png", "inline", "<img1>", 8]]);
	for (const row of attachments) {
		assert.match(row.r2_key, new RegExp(`^attachments/${row.message_id}/${row.id}/`));
		assert.ok(await context.env.BUCKET.get(row.r2_key), "attachment object stored");
	}
	assert.equal(bound.find((row) => row.uid === second.uid).message_id, attachments[0].message_id, "the attachment rows did not release the UID (bp0004)");
	// UID FETCH of each APPENDUID works in the other session.
	for (const { uid } of [first, second, nul]) assertTagged(await other.command(`UID FETCH ${uid} (UID RFC822.SIZE)`), "OK");
	// Concurrent APPENDs from two sessions get distinct, consecutive UIDs.
	const sessions = [(await connect(context)).client, (await connect(context)).client];
	const concurrent = await Promise.all(sessions.map((session, index) => append(session, draft({ subject: `c${index}` }))));
	const uids = concurrent.map((result) => appendUid(result).uid).sort((a, b) => a - b);
	assert.deepEqual(uids, [nul.uid + 1, nul.uid + 2]);
	// UIDs are never reused: a later draft gets a higher one even after deletions.
	assertTagged(await other.command(`UID STORE ${first.uid} +FLAGS (\\Deleted)`), "OK");
	assertTagged(await other.command(`UID EXPUNGE ${first.uid}`), "OK");
	assert.equal(appendUid(await append(client, draft({ subject: "after" }))).uid, nul.uid + 3);
});

// ---- H. Failure atomicity and cleanup ------------------------------------------------------------

test("a5.7 H: storage or database failures commit nothing, remove the objects written, and use no UID", async (t) => {
	const context = await setup(t);
	const { client } = await connect(context);
	const baseline = appendUid(await append(client, draft({ subject: "baseline" })));
	const nextBefore = draftFolder(context).uid_next;
	const bucket = context.env.BUCKET;
	const put = bucket.put.bind(bucket);
	const pdf = Buffer.from("%PDF").toString("base64");
	const twoAttachments = draft({ headers: "Content-Type: multipart/mixed; boundary=b\r\n", body: `--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=a.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${pdf}\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=b.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${pdf}\r\n--b--` });
	const failures = {
		"raw object write": (key) => key.startsWith("drafts/"),
		"second attachment write": (key) => key.endsWith("/b.pdf"),
	};
	for (const [name, fails] of Object.entries(failures)) {
		bucket.put = async (key, value, options) => {
			if (fails(key)) {
				// A write that fails halfway leaves a partial object behind.
				await put(key, new Uint8Array(3), options);
				throw new Error("disk full");
			}
			return put(key, value, options);
		};
		try {
			const result = await append(client, twoAttachments);
			assertTagged(result, "NO", /^\S+ NO \[UNAVAILABLE\] Temporary failure, try again later$/, name);
		} finally {
			bucket.put = put;
		}
		assert.equal(drafts(context).length, 1, `${name}: no draft`);
		assert.equal(objects(context).length, 1, `${name}: every object written was removed, the partial one too`);
	}
	// A failing statement in the commit batch rolls everything back, UIDNEXT included.
	for (const table of ["messages", "message_attachments", "imap_message_uids"]) {
		context.database.db.exec(`CREATE TRIGGER fail_append BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM messages WHERE id = 'never') OR 1 BEGIN SELECT RAISE(ABORT, 'database failure'); END`);
		try {
			const result = await append(client, twoAttachments);
			assertTagged(result, "NO", /\[UNAVAILABLE\]/, table);
		} finally {
			context.database.db.exec("DROP TRIGGER fail_append");
		}
		assert.equal(drafts(context).length, 1, `${table}: no draft`);
		assert.equal(all(context, "SELECT * FROM message_attachments").length, 0, `${table}: no attachment rows`);
		assert.equal(draftUids(context).length, 1, `${table}: no UID`);
		assert.equal(draftFolder(context).uid_next, nextBefore, `${table}: UIDNEXT unchanged`);
		assert.equal(objects(context).length, 1, `${table}: objects removed`);
	}
	assertTagged(await client.command("NOOP"), "OK", undefined, "the session goes on");
	assert.equal(appendUid(await append(client, draft({ subject: "later" }))).uid, baseline.uid + 1, "the failures used no UID");
	assert.ok(!client.logs.some((event) => JSON.stringify(event).includes(context.directory)), "no internal paths are sent or logged in events");
});

test("a5.7 H: the raw object exists before any row references it; a disconnect after the commit keeps the draft", async (t) => {
	const context = await setup(t);
	const bucket = context.env.BUCKET;
	const put = bucket.put.bind(bucket);
	const seen = [];
	bucket.put = async (key, value, options) => {
		seen.push({ key, rows: one(context, "SELECT COUNT(*) AS count FROM messages WHERE raw_r2_key = ? OR id IN (SELECT message_id FROM message_attachments WHERE r2_key = ?)", key, key).count });
		return put(key, value, options);
	};
	t.after(() => (bucket.put = put));
	const { client, session } = await connect(context, undefined, {});
	const result = await append(client, draft());
	assertTagged(result, "OK", /APPENDUID/);
	assert.deepEqual(seen.map((entry) => entry.rows), [0], "no row referenced the object while it was written");
	// Disconnect before the tagged answer reaches the client: the commit stands.
	let closeOnAnswer = null;
	const second = memoryClient(app, context.env, {
		write: async (bytes) => {
			if (Buffer.from(bytes).toString("latin1").includes("[APPENDUID")) {
				closeOnAnswer?.();
				return;
			}
			second.client.accept(bytes);
		},
	});
	await second.start();
	await login(context, second.client);
	closeOnAnswer = () => second.session.transportClosed();
	const lost = await append(second.client, draft({ subject: "lost answer" }), { tag: "z1" }).catch(() => ({ tagged: null }));
	assert.equal(lost.tagged, null);
	await tick();
	assert.ok(drafts(context).some((row) => row.subject === "lost answer"), "committed before the answer, so it stays (a retry would duplicate it)");
	assert.equal(session.isClosed, false);
});

// ---- I. Cross-surface ----------------------------------------------------------------------------

test("a5.7 I: the draft is the web's and JMAP's draft too; counts, revision and search follow; selected Drafts gets EXISTS", async (t) => {
	const context = await setup(t);
	const { client } = await connect(context);
	assertTagged(await client.command("SELECT Drafts"), "OK");
	const revision = () => one(context, "SELECT * FROM jmap_mailbox_revisions WHERE mailbox_id = 'mbx-a'");
	const revisionBefore = JSON.stringify(revision() ?? null);
	const message = draft({ subject: "Quarterly zebrafish report", to: "Bob <bob@elsewhere.test>, Carol <carol@elsewhere.test>", headers: "Cc: dan@elsewhere.test\r\nIn-Reply-To: <parent@elsewhere.test>\r\nReferences: <root@elsewhere.test> <parent@elsewhere.test>\r\n", body: "The zebrafish numbers are in." });
	const result = await append(client, message);
	assert.deepEqual(result.untagged.map((unit) => unit.text), ["* 1 EXISTS"], "EXISTS before the tagged answer");
	assertTagged(result, "OK", /APPENDUID/);
	assert.notEqual(JSON.stringify(revision() ?? null), revisionBefore, "the mailbox revision moved");
	const row = drafts(context)[0];
	assert.equal(row.subject, "Quarterly zebrafish report");
	assert.equal(row.from_addr.toLowerCase().includes("a@example.test"), true);
	// Formatted by the existing parser (parseRawMime), as JMAP Email/import stores it.
	assert.equal(row.to_addr, '"Bob" <bob@elsewhere.test>, "Carol" <carol@elsewhere.test>');
	assert.equal(row.cc_addr, "dan@elsewhere.test");
	assert.equal(row.in_reply_to, "parent@elsewhere.test");
	assert.equal(row.references_header, "root@elsewhere.test parent@elsewhere.test");
	assert.match(row.snippet, /zebrafish numbers/);
	assert.ok(row.thread_id === null || typeof row.thread_id === "string");
	assert.equal(one(context, "SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'zebrafish'").count, 1, "indexed for search");
	assert.match((await client.command("STATUS Drafts (MESSAGES UNSEEN)")).untagged[0].text, /MESSAGES 1 UNSEEN 0/);
	// The web app's drafts list.
	const token = await app.createSession(context.env, "user-a");
	const web = await (await app.draftsListRoute(new Request("http://localhost/api/drafts?mailboxId=mbx-a", { headers: { Authorization: `Bearer ${token}` } }))).json();
	assert.deepEqual(web.drafts.map((entry) => entry.id), [row.id]);
	// JMAP.
	const { fullKey, prefix, hash } = app.generateApiKey();
	context.database.db.prepare("INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, created_at) VALUES ('key-j', 'legacy', 'user-a', 'jmap', ?, ?, ?, 1)").run(prefix, hash, JSON.stringify(["jmap"]));
	const body = { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [["Email/get", { accountId: "user-a", ids: [row.id], properties: ["subject", "keywords", "mailboxIds"] }, "0"]] };
	const response = await app.handleJmapRequest(new Request("http://localhost/jmap/api", { method: "POST", headers: { Authorization: `Bearer ${fullKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), context.env);
	const email = (await response.json()).methodResponses[0][1].list[0];
	assert.equal(email.subject, "Quarterly zebrafish report");
	assert.deepEqual(Object.keys(email.keywords).sort(), ["$draft", "$seen"]);
	assert.deepEqual(Object.keys(email.mailboxIds), [app.encodeMailboxRef({ kind: "role", mailboxId: "mbx-a", role: "drafts" })]);
	// The usual draft-edit cycle: APPEND the new version, then \Deleted and UID EXPUNGE the old one.
	const old = appendUid(result).uid;
	const replacement = appendUid(await append(client, draft({ subject: "Quarterly zebrafish report v2" })));
	assertTagged(await client.command(`UID STORE ${old} +FLAGS.SILENT (\\Deleted)`), "OK");
	assertTagged(await client.command(`UID EXPUNGE ${old}`), "OK");
	assert.deepEqual(drafts(context).map((entry) => entry.subject), ["Quarterly zebrafish report v2"]);
	assert.equal(draftUids(context)[0].uid, replacement.uid);
});

test("a5.7 I: another session idling on Drafts learns of the draft through the database", async (t) => {
	const context = await setup(t);
	const clock = createClock();
	const { client: idler, session } = await connect(context, undefined, { now: clock.now, delay: clock.delay }, { random: () => 0.5 });
	clock.watch(session);
	assertTagged(await idler.command("SELECT Drafts"), "OK");
	idler.write("i1 IDLE\r\n");
	assert.equal((await idler.unit(1000)).text, "+ idling");
	await clock.advance(POLL);
	const { client } = await connect(context);
	assertTagged(await append(client, draft()), "OK", /APPENDUID/);
	await clock.advance(POLL);
	assert.equal((await idler.unit(2000)).text, "* 1 EXISTS");
	idler.write("DONE\r\n");
	assertTagged(await idler.collect("i1", 2000), "OK");
});

// ---- J. Concurrency and MIME-parser stress ------------------------------------------------------

async function addUsers(context, names) {
	for (const name of names) {
		context.database.db.prepare("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'h', ?, 'user', 1)").run(`user-${name}`, `${name}@example.test`, name.toUpperCase());
		context.database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, type, created_at) VALUES (?, ?, 'domain-1', ?, NULL, 'personal', 1)").run(`mbx-${name}`, `user-${name}`, name);
	}
}

test("a5.7 J: one APPEND per user; another user proceeds; four in all; every permit comes back", async (t) => {
	const context = await setup(t);
	await addUsers(context, ["c", "d", "e"]);
	const limiter = new app.limits.ContentReadLimiter(4, 1);
	const permits = countingPermits(limiter);
	const accounts = [
		{ userId: "user-a", mailboxId: "mbx-a", address: "a@example.test" },
		{ userId: "user-x", mailboxId: "mbx-x", address: "x@example.test" },
		{ userId: "user-c", mailboxId: "mbx-c", address: "c@example.test" },
		{ userId: "user-d", mailboxId: "mbx-d", address: "d@example.test" },
		{ userId: "user-e", mailboxId: "mbx-e", address: "e@example.test" },
	];
	const start = async (account, tag) => {
		const { client } = await connect(context, account, { acquireAppend: permits.acquire });
		const message = draft({ from: account.address, subject: `${account.userId} ${tag}` });
		client.write(`${tag} APPEND Drafts {${message.length}}\r\n`);
		return { client, message, tag };
	};
	// user-a holds its one permit mid-literal; its second APPEND waits before the continuation.
	const first = await start(accounts[0], "a1");
	assert.match((await first.client.unit()).text, /^\+ /);
	first.client.write(first.message.subarray(0, 5));
	const second = await start(accounts[0], "a2");
	assert.equal(await nothingWithin(second.client, 150), true, "same user: no continuation");
	// Another user proceeds at once.
	const others = [];
	for (const account of accounts.slice(1, 4)) {
		const other = await start(account, "o1");
		assert.match((await other.client.unit()).text, /^\+ /, `${account.userId} is not blocked`);
		other.client.write(other.message.subarray(0, 5));
		others.push(other);
	}
	assert.equal(limiter.globalFree, 0, "four in all");
	const fifth = await start(accounts[4], "e1");
	assert.equal(await nothingWithin(fifth.client, 150), true, "a fifth user waits for a global permit");
	// One finishes: the fifth user (first in line for a global permit) gets it.
	const finishLiteral = async (entry) => {
		entry.client.write(entry.message.subarray(5));
		entry.client.write("\r\n");
		return entry.client.collect(entry.tag);
	};
	assertTagged(await finishLiteral(others[0]), "OK", /APPENDUID/);
	assert.match((await fifth.client.unit()).text, /^\+ /);
	fifth.client.write(fifth.message.subarray(0, 5));
	assertTagged(await finishLiteral(first), "OK", /APPENDUID/);
	assert.match((await second.client.unit(3_000)).text, /^\+ /, "user-a's second APPEND continues once its first is done");
	second.client.write(second.message.subarray(0, 5));
	for (const entry of [...others.slice(1), fifth, second]) assertTagged(await finishLiteral(entry), "OK", /APPENDUID/);
	// Each permit is released right after its answer has been written.
	await tick();
	assert.equal(permits.held, 0);
	assert.equal(limiter.globalFree, 4);
	assert.equal(limiter.activeUsers, 0);
	// Errors and refusals release too.
	const refused = await connect(context, undefined, { acquireAppend: permits.acquire });
	assertTagged(await append(refused.client, draft({ from: "nobody@elsewhere.test" })), "NO", /CANNOT/);
	// Released once the answer has been written.
	await tick();
	assert.equal(permits.held, 0);
	assert.equal(limiter.globalFree, 4);
});

test("a5.7 J: MIME-parser stress: four users APPEND maximum-size text-heavy drafts at once", async (t) => {
	const context = await setup(t);
	await addUsers(context, ["c", "d", "e"]);
	const limiter = new app.limits.ContentReadLimiter(4, 1);
	const permits = countingPermits(limiter);
	const accounts = [
		{ userId: "user-a", mailboxId: "mbx-a", address: "a@example.test" },
		{ userId: "user-x", mailboxId: "mbx-x", address: "x@example.test" },
		{ userId: "user-c", mailboxId: "mbx-c", address: "c@example.test" },
		{ userId: "user-d", mailboxId: "mbx-d", address: "d@example.test" },
	];
	const clients = [];
	for (const account of accounts) clients.push({ account, ...(await connect(context, account, { acquireAppend: permits.acquire })) });
	const messages = accounts.map((account, index) => sizedDraft(MAX, { from: account.address, fill: "abcd"[index] }));
	const baseline = usedMemory();
	const rssBefore = process.memoryUsage().rss;
	const maxRssBefore = process.resourceUsage().maxRSS * 1024;
	const loop = monitorEventLoopDelay({ resolution: 10 });
	loop.enable();
	let peak = 0;
	const sampler = setInterval(() => {
		const memory = process.memoryUsage();
		peak = Math.max(peak, memory.heapUsed + memory.arrayBuffers);
	}, 5);
	// Never keeps the process alive, and is stopped however the APPENDs end.
	sampler.unref();
	const started = Date.now();
	let results;
	try {
		// Four maximum-size parses take seconds, more under the parallel load of a full test run.
		results = await Promise.all(clients.map(({ client }, index) => append(client, messages[index], { chunk: 256 * 1024, timeoutMs: 120_000 })));
	} finally {
		clearInterval(sampler);
		loop.disable();
	}
	const elapsed = Date.now() - started;
	const maxRssAfter = process.resourceUsage().maxRSS * 1024;
	for (const [index, result] of results.entries()) assertTagged(result, "OK", /APPENDUID/, accounts[index].userId);
	assert.equal(permits.held, 0);
	assert.equal(limiter.globalFree, 4);
	assert.equal(limiter.activeUsers, 0);
	for (const { account } of clients) assert.equal(one(context, "SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ? AND status = 'draft'", account.mailboxId).count, 1);
	const mib = (value) => (value / 1048576).toFixed(0);
	t.diagnostic(`4 x 10 MiB text-heavy APPENDs: ${elapsed} ms; sampled peak heap+arrayBuffers +${mib(peak - baseline)} MiB (${((peak - baseline) / (4 * MAX)).toFixed(2)}x the 40 MiB of messages); RSS ${mib(rssBefore)} -> max ${mib(maxRssAfter)} MiB (max RSS grew ${mib(Math.max(0, maxRssAfter - maxRssBefore))} MiB); event-loop delay max ${(loop.max / 1e6).toFixed(0)} ms, p99 ${(loop.percentile(99) / 1e6).toFixed(0)} ms`);
	// Operational, not a precise multiplier: the process stays well within memory and keeps serving.
	assert.ok(peak - baseline < 1.5 * 1024 * 1024 * 1024, "under 1.5 GiB of heap growth");
	const { client } = clients[0];
	assertTagged(await client.command("NOOP"), "OK", undefined, "the session still serves");
});

// ---- K. Real Node TLS listener --------------------------------------------------------------------

const LISTENER_LIMITS = { accessCheckIntervalMs: 60_000, shutdownGraceMs: 300 };

async function listen(t, limits = {}) {
	const context = await setup(t);
	await addUsers(context, ["c"]);
	const certificate = makeCertificate(t);
	const config = { port: 0, host: "127.0.0.1", certPath: certificate.certPath, keyPath: certificate.keyPath };
	const logs = [];
	const listener = await app.startImapListener(context.env, config, app.loadTlsMaterial(config), { limits: { ...LISTENER_LIMITS, ...limits }, log: (event) => logs.push(event) });
	t.after(() => listener.close());
	return { context, listener, logs };
}

async function tlsLogin(context, listener, account = {}) {
	const { userId = "user-a", mailboxId = "mbx-a", address = "a@example.test" } = account;
	const client = await tlsClient(listener.port);
	await client.unit();
	const { credential } = await context.credential(userId, mailboxId);
	assertTagged(await client.login(address, credential), "OK");
	return client;
}

test("a5.7 TLS: multi-MiB APPEND with a synchronizing continuation, command-looking body and a pipelined NOOP", async (t) => {
	const { context, listener } = await listen(t);
	const client = await tlsLogin(context, listener);
	const big = sizedDraft(4 * 1024 * 1024);
	const result = await append(client, big, { chunk: 256 * 1024 });
	assertTagged(result, "OK", /APPENDUID/);
	const message = draft({ body: "x\r\nA9 LOGOUT\r\n" });
	client.write(`p1 APPEND Drafts {${message.length}}\r\n`);
	assert.match((await client.unit()).text, /^\+ Ready for literal data$/);
	client.write(Buffer.concat([message, Buffer.from("\r\nA2 NOOP\r\n", "latin1")]));
	assertTagged(await client.collect("p1"), "OK", /APPENDUID/);
	assertTagged(await client.collect("A2"), "OK");
	assertTagged(await client.command("SELECT Drafts"), "OK");
	const fetched = await client.command(`UID FETCH ${appendUid(result).uid} BODY.PEEK[]`, { timeoutMs: 20_000 });
	assert.ok(Buffer.compare(fetched.literals[0], big) === 0, "the 4 MiB draft comes back byte for byte");
	assert.equal(drafts(context).length, 2);
});

test("a5.7 TLS: a slow literal completes; a drip is cut at the absolute deadline; disconnect mid-literal stores nothing", async (t) => {
	const { context, listener, logs } = await listen(t, { appendLiteralBaseMs: 800, appendLiteralMinBytesPerSecond: 1_000_000_000 });
	{
		const client = await tlsLogin(context, listener);
		const message = sizedDraft(64 * 1024);
		client.write(`s1 APPEND Drafts {${message.length}}\r\n`);
		assert.match((await client.unit()).text, /^\+ /);
		for (let offset = 0; offset < message.length; offset += 16 * 1024) {
			client.write(message.subarray(offset, offset + 16 * 1024));
			await sleep(100);
		}
		client.write("\r\n");
		assertTagged(await client.collect("s1"), "OK", /APPENDUID/, "400 ms of a slow literal");
	}
	{
		const client = await tlsLogin(context, listener);
		const message = sizedDraft(64 * 1024);
		client.write(`d1 APPEND Drafts {${message.length}}\r\n`);
		assert.match((await client.unit()).text, /^\+ /);
		const started = Date.now();
		let offset = 0;
		const drip = setInterval(() => !client.ended && client.write(message.subarray(offset, ++offset)), 20);
		t.after(() => clearInterval(drip));
		const seen = [];
		for (;;) {
			const unit = await client.unit(5_000);
			if (!unit) break;
			seen.push(unit.text);
		}
		clearInterval(drip);
		const elapsed = Date.now() - started;
		assert.equal(seen.at(-1), "* BYE Autologout");
		assert.ok(elapsed >= 600 && elapsed < 3_000, `cut after ${elapsed} ms`);
		assert.ok(logs.some((event) => event.event === "append.timeout"));
	}
	{
		const client = await tlsLogin(context, listener);
		const message = sizedDraft(256 * 1024);
		client.write(`x1 APPEND Drafts {${message.length}}\r\n`);
		assert.match((await client.unit()).text, /^\+ /);
		client.write(message.subarray(0, 100 * 1024));
		await sleep(50);
		client.close();
		await sleep(200);
	}
	assert.equal(drafts(context).length, 1);
	assert.equal(objects(context).length, 1);
	// The permits came back: the same user can APPEND again at once.
	const client = await tlsLogin(context, listener);
	assertTagged(await append(client, draft()), "OK", /APPENDUID/);
});

test("a5.7 TLS: same-user APPENDs wait, other users proceed; shutdown mid-literal ends everything", async (t) => {
	const { context, listener } = await listen(t);
	const holder = await tlsLogin(context, listener);
	const message = sizedDraft(128 * 1024);
	holder.write(`h1 APPEND Drafts {${message.length}}\r\n`);
	assert.match((await holder.unit()).text, /^\+ /);
	holder.write(message.subarray(0, 1000));
	const waiter = await tlsLogin(context, listener);
	waiter.write(`w1 APPEND Drafts {${message.length}}\r\n`);
	assert.equal(await nothingWithin(waiter, 300), true, "the same user's second APPEND gets no continuation");
	const other = await tlsLogin(context, listener, { userId: "user-c", mailboxId: "mbx-c", address: "c@example.test" });
	assertTagged(await append(other, draft({ from: "c@example.test" })), "OK", /APPENDUID/, "another user proceeds");
	holder.write(message.subarray(1000));
	holder.write("\r\n");
	assertTagged(await holder.collect("h1"), "OK", /APPENDUID/);
	assert.match((await waiter.unit(3_000)).text, /^\+ /, "then the waiting one continues");
	waiter.write(message.subarray(0, 1000));
	await sleep(50);
	const started = Date.now();
	await listener.close();
	assert.ok(Date.now() - started < 5_000);
	assert.equal(listener.connections, 0);
	const tail = [];
	for (;;) {
		const unit = await waiter.unit(2_000).catch(() => null);
		if (!unit) break;
		tail.push(unit.text);
	}
	assert.equal(tail.at(-1), "* BYE Server shutting down");
	assert.equal(drafts(context).length, 2, "the interrupted APPEND stored nothing");
	assert.equal(objects(context).length, 2);
});
