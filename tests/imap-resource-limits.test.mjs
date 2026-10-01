import assert from "node:assert/strict";
import test from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import { assertTagged, createClock, install, loadApp, makeCertificate, memoryClient, tlsClient } from "./support/imap-harness.mjs";

/**
 * A5.6: IMAP resource-safety hardening, over the real A2 verifier and A3 state (SQLite, no
 * Workers), on a virtual clock where time matters, and over the real Node TLS listener.
 *
 * - SEARCH sequence and UID keys are range matchers, never a mailbox-sized set per key (H1).
 * - A connection must authenticate within an absolute deadline that nothing it sends extends (M1).
 * - A whole-message FETCH keeps about one copy of the message: no eager byte string, no
 *   combined response buffer; the literal is written as its own part (M2).
 * - Content permits: 8 in all and 2 per user, held from reading a message until its response is
 *   written, so a client that stops reading holds its user's permits and never more (M3).
 * - 8 KiB lines before authentication, enforced while framing (L2).
 * - Autologout counts complete commands and continuation lines only (L3).
 */
const { app, cleanup } = await loadApp("imap-resource-limits");
test.after(cleanup);

const MINUTE = 60_000;
const TIMEOUTS = { loginMs: 60_000, unauthenticatedIdleMs: 60_000, authenticatedIdleMs: 30 * MINUTE };
const SHARED = { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" };

const tick = async (rounds = 20) => {
	for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Move the virtual clock in steps, letting the session react after each. */
async function advance(clock, ms, step = 1_000) {
	for (let left = ms; left > 0; left -= step) {
		await clock.advance(Math.min(step, left), 50);
		await tick();
	}
}

/** Every response unit already received, without waiting for more. */
async function buffered(client) {
	const out = [];
	for (;;) {
		let unit;
		try {
			unit = await client.unit(20);
		} catch {
			break;
		}
		if (!unit) break;
		out.push(unit.text);
	}
	return out;
}

/** Wait (in real time, bounded) until `predicate` holds. */
async function until(predicate, ms = 5_000, what = "condition") {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await tick(5);
		await sleep(2);
	}
}

/** A session with autologout on a virtual clock, greeted and not logged in. */
async function timed(context, { idle, overrides = {} } = {}) {
	const clock = createClock();
	const { client, session, start } = memoryClient(app, context.env, { now: clock.now, delay: clock.delay, ...overrides }, { timeouts: TIMEOUTS, idle });
	clock.watch(session);
	const greeting = await start();
	assert.match(greeting.text, /^\* OK /);
	return { client, session, clock };
}

async function login(context, client, account = {}) {
	const { userId = "user-a", mailboxId = "mbx-a", address = "a@example.test" } = account;
	const { credential } = await context.credential(userId, mailboxId);
	assertTagged(await client.login(address, credential), "OK");
}

function mulberry32(seed) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

const entry = (uid) => ({ uid, flags: { seen: false, flagged: false, deleted: false, draft: false }, internalDate: new Date(0), rfc822Size: 10 });
function mailbox(uids) {
	return { candidates: uids.map((uid, index) => ({ seq: index + 1, uid, entry: entry(uid) })), info: { count: uids.length, uids } };
}

// ---- A. SEARCH amplification (H1) -------------------------------------------------------------

test("a5.6 A: sequence and UID keys match exactly what the old per-key sets matched", async () => {
	const random = mulberry32(56);
	const pick = (max) => Math.floor(random() * max);
	for (let round = 0; round < 300; round += 1) {
		const count = pick(40);
		const uids = [];
		for (let uid = 1 + pick(3); uids.length < count; uid += 1 + pick(4)) uids.push(uid);
		const top = (uids.at(-1) ?? 0) + 3;
		const set = Array.from({ length: 1 + pick(4) }, () => {
			const bound = () => (random() < 0.15 ? null : pick(Math.max(count, top) + 3));
			return random() < 0.4 ? { from: bound(), to: null } : { from: bound(), to: bound() };
		}).map((range) => (range.to === null && random() < 0.5 ? { from: range.from, to: range.from } : range));
		const { candidates, info } = mailbox(uids);
		const bySeq = app.sequenceSet.matchSequenceNumbers(set, count);
		const byUid = new Set(app.sequenceSet.resolveUids(set, uids));
		const seqs = (await app.search.runSearch({ kind: "sequence", set }, candidates, info, async () => null, () => false)).map((match) => match.seq);
		assert.deepEqual(seqs, candidates.filter((candidate) => bySeq.has(candidate.seq)).map((candidate) => candidate.seq), `sequence ${JSON.stringify(set)} over ${count}`);
		const found = (await app.search.runSearch({ kind: "uid", set }, candidates, info, async () => null, () => false)).map((match) => match.uid);
		assert.deepEqual(found, uids.filter((uid) => byUid.has(uid)), `uid ${JSON.stringify(set)} over ${JSON.stringify(uids)}`);
		const negated = await app.search.runSearch({ kind: "not", key: { kind: "or", left: { kind: "uid", set }, right: { kind: "sequence", set } } }, candidates, info, async () => null, () => false);
		assert.deepEqual(negated.map((match) => match.seq), candidates.filter((candidate) => !bySeq.has(candidate.seq) && !byUid.has(candidate.uid)).map((candidate) => candidate.seq));
	}
	// The edges: `*` in an empty mailbox, reversed ranges, numbers past the end.
	const { candidates, info } = mailbox([3, 7, 9]);
	const run = async (key) => (await app.search.runSearch(key, candidates, info, async () => null, () => false)).map((match) => match.uid);
	assert.deepEqual(await run({ kind: "sequence", set: [{ from: 3, to: 1 }] }), [3, 7, 9]);
	assert.deepEqual(await run({ kind: "uid", set: [{ from: 8, to: null }] }), [9]);
	assert.deepEqual(await run({ kind: "uid", set: [{ from: 100, to: null }] }), [9], "a range from past the last UID to * still includes the last UID");
	assert.deepEqual(await run({ kind: "sequence", set: [{ from: 5, to: 9 }] }), []);
	assert.deepEqual((await app.search.runSearch({ kind: "uid", set: [{ from: null, to: null }] }, [], { count: 0, uids: [] }, async () => null, () => false)), []);
});

test("a5.6 A: 256 `1:*` keys over 20,000 messages build no mailbox-sized set", async () => {
	const uids = Array.from({ length: 20_000 }, (_, index) => index * 2 + 1);
	const { candidates, info } = mailbox(uids);
	const key = { kind: "and", keys: [...Array.from({ length: 128 }, () => ({ kind: "sequence", set: [{ from: 1, to: null }] })), ...Array.from({ length: 128 }, () => ({ kind: "uid", set: [{ from: 1, to: null }] }))] };
	const OriginalSet = globalThis.Set;
	let largest = 0;
	let created = 0;
	globalThis.Set = class extends OriginalSet {
		constructor(values) {
			super(values);
			created += 1;
			largest = Math.max(largest, this.size);
		}
		add(value) {
			super.add(value);
			if (this.size > largest) largest = this.size;
			return this;
		}
	};
	let matches;
	try {
		matches = await app.search.runSearch(key, candidates, info, async () => null, () => false);
	} finally {
		globalThis.Set = OriginalSet;
	}
	assert.equal(matches.length, 20_000);
	assert.ok(largest < 1_000, `largest Set built during SEARCH: ${largest} entries (${created} sets)`);
});

test("a5.6 A: heap probe: 256 keys over 20,000 messages stay within a few MiB while SEARCH runs", async (t) => {
	v8.setFlagsFromString("--expose-gc");
	const gc = vm.runInNewContext("gc");
	const uids = Array.from({ length: 20_000 }, (_, index) => index + 1);
	const { candidates, info } = mailbox(uids);
	// The body key makes every candidate need its octets, so `load` runs while the compiled keys are live.
	const key = { kind: "and", keys: [...Array.from({ length: 255 }, (_, index) => ({ kind: index % 2 ? "uid" : "sequence", set: [{ from: 1, to: null }] })), { kind: "body", value: "x" }] };
	gc();
	const before = process.memoryUsage().heapUsed;
	let during = 0;
	const matches = await app.search.runSearch(
		key,
		candidates,
		info,
		async () => {
			if (!during) {
				gc();
				during = process.memoryUsage().heapUsed;
			}
			return null;
		},
		() => false,
	);
	assert.deepEqual(matches, []);
	const grown = (during - before) / 1024 / 1024;
	t.diagnostic(`heap growth during SEARCH: ${grown.toFixed(2)} MiB`);
	// 255 mailbox-sized sets of 20,000 numbers were well over 100 MiB (A5.6.0).
	assert.ok(grown < 16, `heap grew ${grown.toFixed(1)} MiB during SEARCH`);
});

test("a5.6 A: SEARCH with many sequence and UID keys over a session gives the same answers", async (t) => {
	const context = await install(app, t);
	for (let index = 1; index <= 30; index += 1) await context.deliver(`m-${index}`, `Subject: s${index}\r\n\r\nbody ${index}\r\n`);
	const { client, start } = memoryClient(app, context.env);
	await start();
	await login(context, client);
	await client.command("SELECT INBOX");
	const ids = (result) => result.untagged.find((unit) => unit.text.startsWith("* SEARCH"))?.text;
	assert.equal(ids(await client.command(`SEARCH ${Array(200).fill("1:*").join(" ")} 3:5,29:*`)), "* SEARCH 3 4 5 29 30");
	assert.equal(ids(await client.command(`UID SEARCH ${Array(200).fill("UID 1:*").join(" ")} NOT UID 2:29`)), "* SEARCH 1 30");
	assert.equal(ids(await client.command("SEARCH OR 1 * NOT 2:*")), "* SEARCH 1");
	assert.equal(ids(await client.command("SEARCH OR 1 *")), "* SEARCH 1 30");
});

// ---- B. Login deadline (M1), virtual clock -----------------------------------------------------

async function expectAutologout(session, client, message) {
	assert.equal(session.isClosed, true, "the session was logged out");
	const units = await buffered(client);
	assert.equal(units.at(-1), `* BYE ${message}`);
	return units;
}

test("a5.6 B: a silent connection is logged out 60 s after its greeting", async (t) => {
	const context = await install(app, t);
	const { client, session, clock } = await timed(context);
	await advance(clock, 59_999, 59_999);
	assert.equal(session.isClosed, false);
	await advance(clock, 1);
	await expectAutologout(session, client, "Autologout");
	assert.ok(client.logs.some((event) => event.event === "login.timeout"));
	assert.equal(clock.pending, 0, "no timer outlives the session");
});

test("a5.6 B: dripping bytes, NOOPs, partial lines or a literal never extends the login deadline", async (t) => {
	const context = await install(app, t);
	const scenarios = {
		"byte drip": async ({ client }, second) => client.write(second === 0 ? "a LOGIN " : "x"),
		"NOOP loop": async ({ client }, second) => {
			if (second % 5 === 0) client.write(`n${second} NOOP\r\n`);
		},
		"partial line": async ({ client }, second) => {
			if (second === 0) client.write("a LOGIN user");
		},
		"literal drip": async ({ client }, second) => client.write(second === 0 ? "a LOGIN {1000}\r\n" : "y"),
	};
	for (const [name, act] of Object.entries(scenarios)) {
		const setup = await timed(context);
		for (let second = 0; second < 60; second += 1) {
			await act(setup, second);
			await tick();
			assert.equal(setup.session.isClosed, false, `${name}: still open at ${second} s`);
			await advance(setup.clock, 1_000);
		}
		await tick();
		await expectAutologout(setup.session, setup.client, "Autologout");
	}
});

test("a5.6 B: failed authentications do not extend the login deadline", async (t) => {
	const context = await install(app, t);
	const { client, session, clock } = await timed(context);
	await advance(clock, 30_000);
	const failed = client.login("a@example.test", "wrong-password-1");
	// The failure delay runs on the same clock.
	let result = null;
	failed.then((value) => (result = value));
	await until(() => clock.pending >= 3, 5_000, "the failure delay");
	await advance(clock, 1_000);
	await until(() => result !== null, 5_000, "the failed LOGIN");
	assertTagged(result, "NO", /AUTHENTICATIONFAILED/);
	await advance(clock, 28_999);
	assert.equal(session.isClosed, false);
	await advance(clock, 1);
	await expectAutologout(session, client, "Autologout");
});

test("a5.6 B: a login just before the deadline holds; the authenticated limit takes over", async (t) => {
	const context = await install(app, t);
	const { client, session, clock } = await timed(context);
	await advance(clock, 59_000);
	await login(context, client);
	await advance(clock, 60_000);
	assert.equal(session.isClosed, false, "the login deadline no longer applies");
	assertTagged(await client.command("NOOP"), "OK");
	await advance(clock, 30 * MINUTE - 1_000);
	assert.equal(session.isClosed, false);
	await advance(clock, 1_000);
	await expectAutologout(session, client, "Autologout; idle for too long");
	assert.equal(clock.pending, 0);
});

// ---- C. Authenticated inactivity (L3), virtual clock -------------------------------------------

async function loggedIn(context, options) {
	const setup = await timed(context, options);
	await login(context, setup.client);
	return setup;
}

test("a5.6 C: a silent authenticated session is logged out after 30 minutes", async (t) => {
	const context = await install(app, t);
	const { client, session, clock } = await loggedIn(context);
	await advance(clock, 30 * MINUTE - 1_000, MINUTE);
	assert.equal(session.isClosed, false);
	await advance(clock, 1_000);
	await expectAutologout(session, client, "Autologout; idle for too long");
	assert.ok(client.logs.some((event) => event.event === "idle.timeout" && event.authenticated === true));
});

test("a5.6 C: raw bytes, a partial command or a partial literal are not activity", async (t) => {
	const context = await install(app, t);
	const scenarios = {
		"raw byte drip": (client, minute) => client.write(minute === 0 ? "a SEARCH TEXT " : "z"),
		"partial command": (client, minute) => minute === 0 && client.write("a NOOP"),
		"partial literal": (client, minute) => client.write(minute === 0 ? "a SEARCH TEXT {4000}\r\n" : "q".repeat(10)),
	};
	for (const [name, act] of Object.entries(scenarios)) {
		const { client, session, clock } = await loggedIn(context);
		for (let minute = 0; minute < 30; minute += 1) {
			act(client, minute);
			await tick();
			assert.equal(session.isClosed, false, `${name}: open at ${minute} min`);
			await advance(clock, MINUTE, MINUTE);
		}
		await tick();
		await expectAutologout(session, client, "Autologout; idle for too long");
	}
});

test("a5.6 C: NOOP and any other complete command reset the limit", async (t) => {
	const context = await install(app, t);
	for (const command of ["NOOP", "CAPABILITY", "NAMESPACE", "BOGUS"]) {
		const { client, session, clock } = await loggedIn(context);
		await advance(clock, 20 * MINUTE, MINUTE);
		await client.command(command);
		await advance(clock, 29 * MINUTE, MINUTE);
		assert.equal(session.isClosed, false, `${command} counted`);
		await advance(clock, MINUTE, MINUTE);
		await expectAutologout(session, client, "Autologout; idle for too long");
	}
});

test("a5.6 C: IDLE and its DONE are activity; the server's own writes are not", async (t) => {
	const context = await install(app, t);
	await context.deliver("m-1", "Subject: one\r\n\r\nx\r\n");
	// No poll fires in these windows; keepalives every 2 minutes.
	const idle = { pollMs: 10 * 60 * MINUTE, reconcileMs: 10 * 60 * MINUTE, keepaliveMs: 2 * MINUTE };
	{
		const { client, session, clock } = await loggedIn(context, { idle });
		await client.command("SELECT INBOX");
		await advance(clock, 10 * MINUTE, MINUTE);
		client.write("i1 IDLE\r\n");
		assert.equal((await client.unit(1000)).text, "+ idling");
		await advance(clock, 15 * MINUTE, MINUTE);
		client.write("DONE\r\n");
		assertTagged(await client.collect("i1", 2000), "OK");
		await advance(clock, 29 * MINUTE, MINUTE);
		assert.equal(session.isClosed, false, "DONE counted");
		await advance(clock, MINUTE, MINUTE);
		await expectAutologout(session, client, "Autologout; idle for too long");
	}
	{
		const { client, session, clock } = await loggedIn(context, { idle });
		await client.command("SELECT INBOX");
		client.write("i1 IDLE\r\n");
		assert.equal((await client.unit(1000)).text, "+ idling");
		await advance(clock, 29 * MINUTE, MINUTE);
		assert.equal(session.isClosed, false);
		await advance(clock, MINUTE, MINUTE);
		const units = await expectAutologout(session, client, "Autologout; idle for too long");
		assert.ok(units.filter((text) => text === "* OK Still here").length >= 10, "keepalives were written and did not postpone autologout");
	}
});

// ---- D. Pre-authentication line limit (L2) -----------------------------------------------------

async function fresh(context) {
	const { client, session, start } = memoryClient(app, context.env);
	await start();
	return { client, session };
}

/** A command line of exactly `size` octets (without CRLF). */
const lineOf = (size) => `a ID ("x" "${"y".repeat(size - 13)}")`;

test("a5.6 D: before authentication a line may be 8 KiB, and not one octet more", async (t) => {
	const context = await install(app, t);
	assert.equal(app.PREAUTH_MAX_LINE, 8 * 1024);
	assert.equal(app.MAX_LINE, 64 * 1024);
	assert.equal(lineOf(8192).length, 8192);
	{
		const { client, session } = await fresh(context);
		client.write(`${lineOf(8192)}\r\n`);
		const result = await client.collect("a", 2000);
		assert.ok(result.tagged, "an 8 KiB line is answered");
		assert.equal(session.isClosed, false);
	}
	{
		const { client, session } = await fresh(context);
		client.write(`${lineOf(8193)}\r\n`);
		assert.equal((await client.unit(2000)).text, "* BYE Command line too long");
		assert.equal(await client.unit(2000), null);
		assert.equal(session.isClosed, true);
	}
});

test("a5.6 D: the limit holds across packets, before any newline arrives", async (t) => {
	const context = await install(app, t);
	{
		// Exactly 8 KiB with its CR in one packet and the LF in the next.
		const { client, session } = await fresh(context);
		const line = lineOf(8192);
		client.write(line.slice(0, 5000));
		client.write(`${line.slice(5000)}\r`);
		await tick();
		assert.equal(session.isClosed, false);
		client.write("\n");
		assert.ok((await client.collect("a", 2000)).tagged);
	}
	{
		// One octet over, never terminated: refused as soon as it is over.
		const { client, session } = await fresh(context);
		client.write("b ".padEnd(4096, "x"));
		await tick();
		assert.equal(session.isClosed, false);
		client.write("x".repeat(4097));
		assert.equal((await client.unit(2000)).text, "* BYE Command line too long");
		assert.equal(session.isClosed, true);
	}
	{
		// Split in three, terminated.
		const { client } = await fresh(context);
		const line = lineOf(8193);
		client.write(line.slice(0, 3000));
		client.write(line.slice(3000, 6000));
		client.write(`${line.slice(6000)}\r\n`);
		assert.equal((await client.unit(2000)).text, "* BYE Command line too long");
	}
});

test("a5.6 D: after authentication lines may be 64 KiB, as before", async (t) => {
	const context = await install(app, t);
	{
		const { client, session } = await fresh(context);
		await login(context, client);
		const result = await client.command(`SEARCH TEXT "${"y".repeat(64 * 1024 - 19)}"`, { tag: "a" });
		assert.ok(result.tagged, "a 64 KiB line is answered after authentication");
		assert.equal(session.isClosed, false);
		client.write(`b NOOP ${"y".repeat(64 * 1024)}\r\n`);
		assert.equal((await client.unit(2000)).text, "* BYE Command line too long");
	}
});

// ---- E. FETCH memory (M2) ----------------------------------------------------------------------

test("a5.6 E: MessageView makes its byte string only when something parses the message", () => {
	const raw = Buffer.from("Subject: hi\r\nContent-Type: text/plain\r\n\r\nbody\r\n", "latin1");
	const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
	const view = new app.MessageView(bytes);
	assert.equal(view.section({ part: [], text: null }), bytes, "BODY[] serves the octets themselves");
	assert.equal(view.hasText, false);
	assert.equal(view.section({ part: [], text: { kind: "header" } }).byteLength, 41);
	assert.equal(view.hasText, true, "a section that needs the structure parses it");
	assert.equal(new app.MessageView(bytes).metadata().size, bytes.byteLength);
});

test("a5.6 E: ResponseBuilder parts are bytes() exactly, with large literals by reference", () => {
	const big = new Uint8Array(200 * 1024).fill(65);
	const small = new Uint8Array(100).fill(66);
	const builder = new app.ResponseBuilder().raw("* 1 FETCH (BODY[] ").literal(big).raw(" BODY[1] ").literal(small).raw(" UID 4)\r\n");
	const parts = builder.parts();
	assert.equal(parts.length, 3);
	assert.equal(parts[1], big, "the literal is written as it is, not copied");
	assert.deepEqual(Buffer.concat(parts), Buffer.from(builder.bytes()));
	assert.ok(parts.every((part) => part === big || part.byteLength <= 64 * 1024));
	const many = new app.ResponseBuilder();
	for (let index = 0; index < 50; index += 1) many.raw(`x${index} `).literal(new Uint8Array(10_000).fill(index));
	const manyParts = many.parts();
	assert.deepEqual(Buffer.concat(manyParts), Buffer.from(many.bytes()));
	assert.ok(manyParts.every((part) => part.byteLength <= 64 * 1024), "small values are joined into bounded parts");
});

/** A host whose writes of `threshold` octets or more wait for `release()`. */
function gated(threshold = 64 * 1024) {
	const gate = { held: [], sizes: [], clientRef: null };
	gate.write = (bytes) => {
		gate.sizes.push(bytes.byteLength);
		if (bytes.byteLength < threshold) {
			gate.clientRef.accept(bytes);
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			gate.held.push(() => {
				gate.clientRef.accept(bytes);
				resolve();
			});
		});
	};
	gate.release = () => {
		const held = gate.held;
		gate.held = [];
		for (const finish of held) finish();
	};
	return gate;
}

/** A logged-in session over a gated host, with permits counted; `account` defaults to A in INBOX. */
async function gatedSession(context, { acquireRead, account = {}, threshold } = {}) {
	const gate = gated(threshold);
	const { client, session, start } = memoryClient(app, context.env, { write: gate.write, ...(acquireRead ? { acquireRead } : {}) });
	gate.clientRef = client;
	await start();
	await login(context, client, account);
	await client.command("SELECT INBOX");
	return { client, session, gate };
}

function countingPermits(limiter) {
	const permits = { held: 0, granted: 0, users: [] };
	permits.acquireRead = async (userId) => {
		permits.users.push(userId);
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

const bigMessage = (size) => {
	const line = `${"z".repeat(76)}\r\n`;
	return Buffer.from(`Subject: big\r\nContent-Type: text/plain\r\n\r\n${line.repeat(Math.ceil(size / line.length))}`, "latin1");
};

test("a5.6 E: a whole-message FETCH writes the stored octets as one part, never a combined copy", async (t) => {
	const context = await install(app, t);
	const raw = bigMessage(1024 * 1024);
	await context.deliver("m-1", raw);
	for (const command of ["FETCH 1 BODY.PEEK[]", "FETCH 1 RFC822", "UID FETCH 1 (FLAGS BODY.PEEK[] RFC822.SIZE)"]) {
		const { client, gate } = await gatedSession(context, { threshold: Infinity });
		const result = await client.command(command);
		assertTagged(result, "OK");
		assert.deepEqual(result.literals[0], raw, `${command}: the octets are byte-identical`);
		assert.ok(gate.sizes.includes(raw.byteLength), `${command}: the literal is its own write`);
		assert.ok(Math.max(...gate.sizes) === raw.byteLength, `${command}: no write is larger than the message (${Math.max(...gate.sizes)})`);
	}
});

test("a5.6 E: a stalled whole-message FETCH holds about one copy of the message", async (t) => {
	v8.setFlagsFromString("--expose-gc");
	const gc = vm.runInNewContext("gc");
	const context = await install(app, t);
	const size = 16 * 1024 * 1024;
	await context.deliver("m-1", bigMessage(size));
	const { client, session, gate } = await gatedSession(context);
	// What is still live: the lowest of a few collections a turn apart. Reading the octets leaves
	// stream chunks whose backing stores V8 releases after a collection, later under load; a single
	// gc() can still count them. Anything really retained stays in every reading.
	const used = async () => {
		let lowest = Infinity;
		for (let round = 0; round < 3; round += 1) {
			gc();
			await new Promise((resolve) => setImmediate(resolve));
			const memory = process.memoryUsage();
			lowest = Math.min(lowest, memory.heapUsed + memory.arrayBuffers);
		}
		return lowest;
	};
	const before = await used();
	client.write("f1 FETCH 1 BODY.PEEK[]\r\n");
	await until(() => gate.held.length > 0, 10_000, "the stalled write");
	const during = await used();
	const ratio = (during - before) / size;
	t.diagnostic(`stalled 16 MiB FETCH retains ${ratio.toFixed(2)}x`);
	assert.ok(ratio < 1.3, `a stalled 16 MiB FETCH retains ${ratio.toFixed(2)}x the message`);
	session.transportClosed();
	gate.release();
});

test("a5.6 E: a slow reader keeps its permit until its response is written; closing releases it", async (t) => {
	const context = await install(app, t);
	await context.deliver("m-1", bigMessage(256 * 1024));
	await context.deliver("m-2", bigMessage(256 * 1024));
	const permits = countingPermits();
	const { client, session, gate } = await gatedSession(context, { acquireRead: permits.acquireRead });
	client.write("f1 FETCH 1:2 BODY.PEEK[]\r\n");
	await until(() => gate.held.length === 1, 5_000, "the first stalled write");
	assert.equal(permits.held, 1, "the permit is held while the response is being written");
	gate.release();
	await until(() => gate.held.length === 1 && permits.granted === 2, 5_000, "the second stalled write");
	assert.equal(permits.held, 1, "the first permit was released once its response was written");
	// The client goes away mid-response.
	session.transportClosed();
	gate.release();
	await until(() => permits.held === 0, 5_000, "the release on close");
	assert.equal(permits.granted, 2);
	assert.deepEqual([...new Set(permits.users)], ["user-a"]);
	// Metadata-only FETCH takes no permit.
	const meta = countingPermits();
	const second = await gatedSession(context, { acquireRead: meta.acquireRead });
	assertTagged(await second.client.command("FETCH 1:2 (FLAGS UID INTERNALDATE)"), "OK");
	assert.equal(meta.granted, 0);
});

test("a5.6 E: FETCH output stays byte-identical for every form", async (t) => {
	const context = await install(app, t);
	const multipart = "From: a@b.test\r\nSubject: mp\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\npre\r\n--x\r\nContent-Type: text/plain\r\n\r\nhello\r\n--x\r\nContent-Type: message/rfc822\r\n\r\nSubject: inner\r\n\r\ninner body\r\n--x--\r\n";
	await context.deliver("m-1", multipart);
	const { client, start } = memoryClient(app, context.env);
	await start();
	await login(context, client);
	await client.command("SELECT INBOX");
	const literal = async (item) => (await client.command(`FETCH 1 ${item}`)).literals[0].toString("latin1");
	const headerEnd = multipart.indexOf("\r\n\r\n") + 4;
	assert.equal(await literal("BODY.PEEK[]"), multipart);
	assert.equal(await literal("BODY.PEEK[HEADER]"), multipart.slice(0, headerEnd));
	assert.equal(await literal("BODY.PEEK[TEXT]"), multipart.slice(headerEnd));
	assert.equal(await literal("BODY.PEEK[1]"), "hello");
	assert.equal(await literal("BODY.PEEK[2.TEXT]"), "inner body");
	assert.equal(await literal("BODY.PEEK[]<5.10>"), multipart.slice(5, 15));
	assert.equal(await literal("RFC822.HEADER"), multipart.slice(0, headerEnd));
	assert.match((await client.command("FETCH 1 (RFC822.SIZE BODYSTRUCTURE)")).untagged[0].text, new RegExp(`RFC822\\.SIZE ${multipart.length} BODYSTRUCTURE \\(`));
});

// ---- F. Per-user fairness (M3) -----------------------------------------------------------------

test("a5.6 F: ContentReadLimiter: 2 per user, the third waits, other users progress, 8 in all", async () => {
	const limiter = new app.limits.ContentReadLimiter(8, 2);
	const a1 = await limiter.acquire("a");
	const a2 = await limiter.acquire("a");
	let a3 = null;
	const pendingA3 = limiter.acquire("a").then((release) => (a3 = release));
	await tick();
	assert.equal(a3, null, "a third permit for the same user waits");
	assert.equal(limiter.globalFree, 6, "the waiting request takes no global permit");
	const b1 = await limiter.acquire("b");
	assert.equal(typeof b1, "function", "another user progresses");
	a1();
	a1();
	await pendingA3;
	assert.equal(limiter.globalFree, 5, "releasing twice frees once");
	a2();
	a3();
	b1();
	assert.equal(limiter.globalFree, 8);
	assert.equal(limiter.activeUsers, 0, "no state is kept for users without permits");

	// The global limit: five users at their per-user limit want ten permits; eight are granted.
	const granted = [];
	const waiting = [];
	for (const user of ["u1", "u2", "u3", "u4", "u5"]) for (let index = 0; index < 2; index += 1) waiting.push(limiter.acquire(user).then((release) => granted.push(release)));
	await tick();
	assert.equal(granted.length, 8);
	assert.equal(limiter.globalFree, 0);
	granted[0]();
	await tick();
	assert.equal(granted.length, 9);
	granted[1]();
	await Promise.all(waiting);
	for (const release of granted) release();
	assert.equal(limiter.globalFree, 8);
	assert.equal(limiter.activeUsers, 0);
});

test("a5.6 F: two stalled readers of one user hold its permits; its third FETCH waits while another user's completes", async (t) => {
	const context = await install(app, t);
	await context.deliver("m-1", bigMessage(256 * 1024));
	await context.deliver("s-1", bigMessage(256 * 1024), { mailbox_id: "mbx-s" });
	const limiter = new app.limits.ContentReadLimiter(8, 2);
	const permits = countingPermits(limiter);
	const stalled = [];
	for (let index = 0; index < 2; index += 1) {
		const reader = await gatedSession(context, { acquireRead: permits.acquireRead });
		reader.client.write("f1 FETCH 1 BODY.PEEK[]\r\n");
		await until(() => reader.gate.held.length === 1, 5_000, "a stalled reader");
		stalled.push(reader);
	}
	assert.equal(permits.held, 2);
	assert.equal(limiter.globalFree, 6);

	const third = await gatedSession(context, { acquireRead: permits.acquireRead, threshold: Infinity });
	const thirdResult = third.client.command("FETCH 1 BODY.PEEK[]", { tag: "t3" });
	let thirdDone = false;
	thirdResult.then(() => (thirdDone = true));

	const other = await gatedSession(context, { acquireRead: permits.acquireRead, account: SHARED, threshold: Infinity });
	assertTagged(await other.client.command("FETCH 1 BODY.PEEK[]"), "OK", undefined, "another user is not blocked");
	assert.equal(thirdDone, false, "the user's third content FETCH waits for one of its own permits");
	// Metadata-only work for the same user is not limited.
	const metadataOnly = await gatedSession(context, { acquireRead: permits.acquireRead, threshold: Infinity });
	assertTagged(await metadataOnly.client.command("FETCH 1 (FLAGS RFC822.SIZE UID)"), "OK");
	assert.equal(thirdDone, false);

	// One stalled reader goes away: its permit passes to the waiting FETCH.
	stalled[0].session.transportClosed();
	stalled[0].gate.release();
	assertTagged(await thirdResult, "OK");
	stalled[1].session.end("Server shutting down");
	stalled[1].gate.release();
	await until(() => permits.held === 0, 5_000, "every permit released");
	assert.equal(limiter.globalFree, 8);
	assert.equal(limiter.activeUsers, 0);
});

test("a5.6 F: a failed read releases its permit; content SEARCH takes one per message and gives it back", async (t) => {
	const context = await install(app, t);
	for (let index = 1; index <= 3; index += 1) await context.deliver(`m-${index}`, `Subject: s${index}\r\n\r\nneedle ${index}\r\n`);
	const limiter = new app.limits.ContentReadLimiter(8, 2);
	const permits = countingPermits(limiter);
	let peak = 0;
	const tracked = async (userId) => {
		const release = await permits.acquireRead(userId);
		peak = Math.max(peak, permits.held);
		return release;
	};
	const { client } = await gatedSession(context, { acquireRead: tracked, threshold: Infinity });
	const search = await client.command("SEARCH BODY needle");
	assert.equal(search.untagged.find((unit) => unit.text.startsWith("* SEARCH")).text, "* SEARCH 1 2 3");
	assert.equal(permits.granted, 3);
	assert.equal(peak, 1, "one message at a time");
	assert.equal(permits.held, 0);
	assertTagged(await client.command("SEARCH 1:* UID 1:*"), "OK");
	assert.equal(permits.granted, 3, "SEARCH answered from the snapshot takes no permit");

	const get = context.env.BUCKET.get.bind(context.env.BUCKET);
	context.env.BUCKET.get = async () => {
		throw new Error("storage down");
	};
	try {
		assertTagged(await client.command("FETCH 1:2 BODY.PEEK[]"), "NO", /UNAVAILABLE/);
	} finally {
		context.env.BUCKET.get = get;
	}
	assert.equal(permits.held, 0, "a failed read releases its permit");
	assert.equal(limiter.globalFree, 8);
	assert.equal(limiter.activeUsers, 0);
});

// ---- G. Unchanged limits -----------------------------------------------------------------------

test("a5.6 G: listener limits: two new fields, everything else as before", () => {
	const limits = app.DEFAULT_IMAP_LIMITS;
	assert.equal(limits.loginTimeoutMs, 60_000);
	assert.equal(limits.maxConcurrentReadsPerUser, 2);
	assert.equal(limits.maxConcurrentReads, 8);
	assert.equal(limits.unauthenticatedIdleMs, 60_000);
	assert.equal(limits.authenticatedIdleMs, 30 * MINUTE);
	assert.equal(limits.maxConnections, 500);
	assert.equal(limits.maxConnectionsPerAddress, 20);
	assert.equal(limits.maxSessionsPerUser, 20);
	assert.equal(limits.handshakeTimeoutMs, 10_000);
});

test("a5.6 G: literal limits, the command queue and LOGOUT are unchanged", async (t) => {
	const context = await install(app, t);
	{
		const { client } = await fresh(context);
		client.write("a LOGIN {1025}\r\n");
		assertTagged(await client.collect("a"), "BAD", /Literal too large/);
		client.write("b LOGIN {5+}\r\n");
		assert.match((await client.unit(2000)).text, /^\* BYE Non-synchronizing literals/);
	}
	{
		const { client } = await fresh(context);
		await login(context, client);
		await client.command("SELECT INBOX");
		client.write(`c SEARCH TEXT {${64 * 1024}}\r\n`);
		assert.equal((await client.unit(2000)).text, "+ Ready for literal data");
		client.write(`${"x".repeat(64 * 1024)}\r\n`);
		assertTagged(await client.collect("c"), "OK");
		client.write(`d SEARCH TEXT {${64 * 1024 + 1}}\r\n`);
		assertTagged(await client.collect("d"), "BAD", /Literal too large/);
		client.write("e APPEND INBOX {3}\r\n");
		const append = await client.unit(2000);
		assert.ok(/^e (BAD|NO)/.test(append.text) || append.text === "+ Ready for literal data", append.text);
	}
	{
		// A burst of 40 commands never queues more than 16; all are answered in order.
		const paused = { count: 0 };
		const { client, session, start } = memoryClient(app, context.env, { pause: () => (paused.count += 1) });
		await start();
		client.write(Array.from({ length: 40 }, (_, index) => `n${index} NOOP\r\n`).join(""));
		for (let index = 0; index < 40; index += 1) assertTagged(await client.collect(`n${index}`), "OK");
		assert.ok(paused.count >= 1, "the queue filled and reading paused");
		client.write("z LOGOUT\r\nafter NOOP\r\n");
		assertTagged(await client.collect("z"), "OK");
		await tick();
		assert.equal(session.isClosed, true);
		assert.deepEqual(await buffered(client), [], "nothing after LOGOUT is run");
	}
});

// ---- Real Node TLS listener --------------------------------------------------------------------

const LISTENER_LIMITS = { accessCheckIntervalMs: 60_000, shutdownGraceMs: 300 };

async function listen(t, limits = {}, prepare) {
	const context = await install(app, t);
	await prepare?.(context);
	const certificate = makeCertificate(t);
	const config = { port: 0, host: "127.0.0.1", certPath: certificate.certPath, keyPath: certificate.keyPath };
	const logs = [];
	const listener = await app.startImapListener(context.env, config, app.loadTlsMaterial(config), { limits: { ...LISTENER_LIMITS, ...limits }, log: (event) => logs.push(event) });
	t.after(() => listener.close());
	return { context, listener, logs };
}

async function connectTo(listener) {
	const client = await tlsClient(listener.port);
	await client.unit();
	return client;
}

/** Every unit until the server closes, within `ms` in all (a drip's own answers never extend it). */
async function readUntilClosed(client, ms) {
	const deadline = Date.now() + ms;
	const seen = [];
	for (;;) {
		const left = deadline - Date.now();
		if (left <= 0) throw new Error(`still open after ${ms} ms; last: ${JSON.stringify(seen.slice(-3))}`);
		const unit = await client.unit(left);
		if (!unit) return seen;
		seen.push(unit.text);
	}
}

test("a5.6 TLS: the login deadline holds despite a byte drip and NOOPs", async (t) => {
	const { listener, logs } = await listen(t, { loginTimeoutMs: 800, unauthenticatedIdleMs: 60_000 });
	const client = await connectTo(listener);
	const started = Date.now();
	let index = 0;
	const drip = setInterval(() => {
		if (client.ended) return;
		client.write(index % 3 === 0 ? `n${index} NOOP\r\n` : "x");
		index += 1;
	}, 50);
	t.after(() => clearInterval(drip));
	const seen = await readUntilClosed(client, 5_000);
	clearInterval(drip);
	const elapsed = Date.now() - started;
	assert.equal(seen.at(-1), "* BYE Autologout");
	assert.ok(elapsed >= 700 && elapsed < 3_000, `logged out after ${elapsed} ms`);
	assert.ok(logs.some((event) => event.event === "login.timeout"));
});

test("a5.6 TLS: an authenticated byte drip does not postpone autologout", async (t) => {
	const { context, listener } = await listen(t, { authenticatedIdleMs: 800 });
	const client = await connectTo(listener);
	const { credential } = await context.credential("user-a", "mbx-a");
	assertTagged(await client.login("a@example.test", credential), "OK");
	client.write("a SEARCH TEXT ");
	const started = Date.now();
	const drip = setInterval(() => !client.ended && client.write("y"), 50);
	t.after(() => clearInterval(drip));
	const seen = await readUntilClosed(client, 5_000);
	clearInterval(drip);
	const elapsed = Date.now() - started;
	assert.equal(seen.at(-1), "* BYE Autologout; idle for too long");
	assert.ok(elapsed >= 600 && elapsed < 3_000, `logged out after ${elapsed} ms`);
});

test("a5.6 TLS: non-reading clients hold only their user's permits; closing and shutdown release them", async (t) => {
	const size = 24 * 1024 * 1024;
	const { context, listener } = await listen(t, { maxConcurrentReads: 8, maxConcurrentReadsPerUser: 2 }, async (context) => {
		await context.deliver("m-1", bigMessage(size));
		await context.deliver("s-1", "Subject: shared\r\n\r\nsmall\r\n", { mailbox_id: "mbx-s" });
	});
	const { credential } = await context.credential("user-a", "mbx-a");
	const stuck = [];
	for (let index = 0; index < 2; index += 1) {
		const client = await connectTo(listener);
		assertTagged(await client.login("a@example.test", credential), "OK");
		assertTagged(await client.command("SELECT INBOX"), "OK");
		client.socket.pause();
		client.write("f1 FETCH 1 BODY.PEEK[]\r\n");
		stuck.push(client);
	}
	await sleep(500);

	const third = await connectTo(listener);
	assertTagged(await third.login("a@example.test", credential), "OK");
	assertTagged(await third.command("SELECT INBOX"), "OK");
	let thirdDone = false;
	const thirdResult = third.command("FETCH 1 (BODY.PEEK[]<0.20>)", { tag: "t3", timeoutMs: 20_000 }).then((result) => {
		thirdDone = true;
		return result;
	});

	const { credential: shared } = await context.credential(SHARED.userId, SHARED.mailboxId);
	const other = await connectTo(listener);
	assertTagged(await other.login(SHARED.address, shared), "OK");
	assertTagged(await other.command("SELECT INBOX"), "OK");
	const otherFetch = await other.command("FETCH 1 BODY.PEEK[]", { timeoutMs: 5_000 });
	assertTagged(otherFetch, "OK", undefined, "another user's content FETCH completes");
	assert.equal(thirdDone, false, "the user's third content FETCH waits");

	stuck[0].close();
	assertTagged(await thirdResult, "OK", undefined, "a closed reader's permit is released");
	assert.equal((await thirdResult).literals[0].toString("latin1"), "Subject: big\r\nConten");

	// Shutdown with a permit still held by a non-reading client.
	const started = Date.now();
	await listener.close();
	assert.ok(Date.now() - started < 5_000, "shutdown does not wait for the stalled reader");
	assert.equal(listener.connections, 0);
});
