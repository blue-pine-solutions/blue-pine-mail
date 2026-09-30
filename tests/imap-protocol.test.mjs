import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * A4: the runtime-neutral IMAP protocol layer (src/lib/imap-server/) without any socket or
 * storage: framing, the command grammar, sequence sets, mailbox names and MIME structure.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-imap-protocol-"));
await build({
	stdin: {
		contents: `
			export { CommandFramer } from "./src/lib/imap-server/framer.ts";
			export { CommandReader, ImapSyntaxError } from "./src/lib/imap-server/reader.ts";
			export * as sequences from "./src/lib/imap-server/sequence-set.ts";
			export { readFetchItems } from "./src/lib/imap-server/fetch-parser.ts";
			export { readSearch } from "./src/lib/imap-server/search-parser.ts";
			export { ResponseBuilder } from "./src/lib/imap-server/response.ts";
			export * as bytes from "./src/lib/imap-server/bytes-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "imap-protocol-test-entry.ts",
		loader: "ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "neutral",
	format: "esm",
	target: "es2022",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
test.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

const enc = (text) => app.bytes.binaryToBytes(text);
const LIMITS = { maxLine: 64 * 1024, maxLiteral: 1024, maxLiterals: 16 };

function framer(limits = LIMITS) {
	const continuations = [];
	const instance = new app.CommandFramer(() => limits, () => continuations.push(true));
	return { instance, continuations, push: (text) => instance.push(typeof text === "string" ? enc(text) : text) };
}

function reader(text) {
	const { push } = framer({ ...LIMITS, maxLiteral: 1 << 20 });
	const [item] = push(text.endsWith("\r\n") ? text : `${text}\r\n`);
	assert.equal(item.kind, "command");
	return new app.CommandReader(item.parts);
}

test("framing: CRLF lines, bare LF, pipelining and split input", () => {
	const { push } = framer();
	const items = push("a1 NOOP\r\na2 CAPABILITY\nA3 LOG");
	assert.deepEqual(items.map((item) => item.parts[0].text), ["a1 NOOP", "a2 CAPABILITY"]);
	assert.deepEqual(push("OUT\r\n").map((item) => item.parts[0].text), ["A3 LOGOUT"]);
	// One octet at a time costs linear work and yields the same command.
	const slow = framer();
	const text = "x FETCH 1:* (FLAGS)\r\n";
	const got = [];
	for (const byte of enc(text)) got.push(...slow.push(Uint8Array.of(byte)));
	assert.equal(got.length, 1);
	assert.equal(got[0].parts[0].text, "x FETCH 1:* (FLAGS)");
});

test("framing: synchronizing literals ask for continuation and carry exact octets", () => {
	const { push, continuations } = framer();
	assert.deepEqual(push("a LOGIN {6}\r\n"), []);
	assert.equal(continuations.length, 1);
	assert.deepEqual(push("us\r\ner {3}\r\n"), []);
	assert.equal(continuations.length, 2);
	const [item] = push("p\0w\r\n");
	assert.equal(item.kind, "command");
	assert.deepEqual(item.parts.map((part) => (part.kind === "text" ? part.text : app.bytes.bytesToBinary(part.bytes))), ["a LOGIN ", "us\r\ner", " ", "p\0w", ""]);
	const r = new app.CommandReader(item.parts);
	assert.equal(r.atom(), "a");
	r.sp();
	assert.equal(r.keyword(), "LOGIN");
	r.sp();
	assert.equal(r.astring(), "us\r\ner");
	r.sp();
	assert.equal(r.astring(), "p\0w");
	r.end();
});

test("framing: oversize literals are refused before continuation; oversize lines and LITERAL+ disconnect", () => {
	const small = framer({ maxLine: 64, maxLiteral: 10, maxLiterals: 2 });
	const [refused] = small.push("t1 LOGIN {11}\r\n");
	assert.deepEqual(refused, { kind: "error", tag: "t1", message: "Literal too large", fatal: false });
	assert.equal(small.continuations.length, 0);
	// The stream stays usable: the client never sent the octets.
	assert.equal(small.push("t2 NOOP\r\n")[0].kind, "command");
	const [many] = small.push("t3 X {1}\r\na {1}\r\nb {1}\r\n");
	assert.equal(many.kind, "error");
	assert.equal(many.fatal, false);

	const long = framer({ maxLine: 64, maxLiteral: 10, maxLiterals: 2 });
	const [tooLong] = long.push(`t ${"x".repeat(100)}`);
	assert.equal(tooLong.kind, "error");
	assert.equal(tooLong.fatal, true);
	assert.deepEqual(long.push("t NOOP\r\n"), [], "nothing is framed after a fatal error");

	const plus = framer();
	const [nonSync] = plus.push("t LOGIN {3+}\r\n");
	assert.equal(nonSync.fatal, true);
});

test("framing: a continuation line (AUTHENTICATE response, IDLE's DONE) is not parsed as a command", () => {
	const { instance, push } = framer();
	instance.expectContinuationLine();
	assert.deepEqual(push("AGEAYg== {5}\r\n"), [{ kind: "continuation", line: "AGEAYg== {5}" }], "raw: a trailing {n} announces no literal");
	assert.equal(push("b NOOP\r\n")[0].kind, "command", "one line only");
	instance.expectContinuationLine();
	assert.deepEqual(push("DO"), [], "a line split across chunks waits for its end");
	assert.deepEqual(push("NE\r\nc NOOP\r\n"), [{ kind: "continuation", line: "DONE" }, { kind: "command", parts: [{ kind: "text", text: "c NOOP" }] }], "input after the line is framed as usual");
	const partial = framer();
	partial.push("d SELECT {5}\r\n");
	assert.equal(partial.instance.midCommand, true, "awaiting a literal's octets");
	partial.push("INBOX\r\n");
	assert.equal(partial.instance.midCommand, false);
});

test("framing: next() yields one item at a time so a full queue can stop framing", () => {
	const { instance } = framer();
	instance.feed(enc("a NOOP\r\nb NOOP\r\nc NOOP\r\n"));
	assert.equal(instance.next().parts[0].text, "a NOOP");
	assert.ok(instance.buffered > 0);
	assert.equal(instance.next().parts[0].text, "b NOOP");
	assert.equal(instance.next().parts[0].text, "c NOOP");
	assert.equal(instance.next(), null);
	assert.equal(instance.buffered, 0);
});

test("reader: atoms, quoted strings with escapes, NIL and numbers", () => {
	const r = reader('t LOGIN "a\\"b\\\\c" atom] NIL 4294967295');
	r.atom();
	r.sp();
	r.keyword();
	r.sp();
	assert.equal(r.astring(), 'a"b\\c');
	r.sp();
	assert.equal(r.astring(), "atom]");
	r.sp();
	assert.equal(r.nstringOrNil(), null);
	r.sp();
	assert.equal(r.number(), 4294967295);
	r.end();
	for (const bad of ['"unterminated', '"bad \\q escape"', "4294967296", '"a\\"']) {
		const x = reader(`t ${bad}`);
		x.atom();
		x.sp();
		assert.throws(() => (bad.startsWith('"') ? x.astring() : x.number()), app.ImapSyntaxError, bad);
	}
});

test("sequence sets: ranges, star, order, merging and bounds", () => {
	const { parseSequenceSet, resolveSequenceNumbers, resolveUids, matchSequenceNumbers } = app.sequences;
	assert.deepEqual(resolveSequenceNumbers(parseSequenceSet("3:1,5,*"), 6), [1, 2, 3, 5, 6]);
	assert.deepEqual(resolveSequenceNumbers(parseSequenceSet("1:*"), 3), [1, 2, 3]);
	assert.equal(resolveSequenceNumbers(parseSequenceSet("4"), 3), null);
	assert.equal(resolveSequenceNumbers(parseSequenceSet("1:*"), 0), null);
	assert.deepEqual([...matchSequenceNumbers(parseSequenceSet("2:9"), 3)], [2, 3]);
	const uids = [3, 7, 20, 21];
	assert.deepEqual(resolveUids(parseSequenceSet("1:7"), uids), [3, 7]);
	assert.deepEqual(resolveUids(parseSequenceSet("100:*"), uids), [21], "n:* includes the last UID even past it");
	assert.deepEqual(resolveUids(parseSequenceSet("*"), []), []);
	assert.deepEqual(resolveUids(parseSequenceSet("21,4:3,8:19"), uids), [3, 21]);
	for (const bad of ["0", "1:0", "a", "1::2", "1,", ",1", "1:2:3", "99999999999"]) assert.throws(() => parseSequenceSet(bad), app.ImapSyntaxError, bad);
	assert.throws(() => parseSequenceSet(Array.from({ length: 20_001 }, (_, i) => i + 1).join(",")), app.ImapSyntaxError);
});

const fetch = (text) => {
	const r = reader(`t FETCH 1 ${text}`);
	r.atom();
	r.sp();
	r.keyword();
	r.sp();
	r.token();
	r.sp();
	const items = app.readFetchItems(r);
	r.end();
	return items;
};

test("FETCH attributes: macros, sections, HEADER.FIELDS, MIME and partial ranges", () => {
	assert.deepEqual(fetch("FAST").map((item) => item.kind), ["flags", "internaldate", "rfc822.size"]);
	assert.deepEqual(fetch("ALL").map((item) => item.kind), ["flags", "internaldate", "rfc822.size", "envelope"]);
	assert.deepEqual(fetch("FULL").map((item) => item.kind), ["flags", "internaldate", "rfc822.size", "envelope", "body"]);
	const [section] = fetch("BODY.PEEK[1.2.HEADER.FIELDS.NOT (from \"X-Y\")]<10.20>");
	assert.deepEqual(section, {
		kind: "section",
		peek: true,
		section: { part: [1, 2], text: { kind: "header.fields", not: true, fields: ["FROM", "X-Y"] } },
		partial: { origin: 10, length: 20 },
		label: "1.2.HEADER.FIELDS.NOT (FROM X-Y)",
	});
	const items = fetch("(UID RFC822.SIZE BODY[] BODY[TEXT] BODY[2.MIME] BODY BODYSTRUCTURE ENVELOPE RFC822 RFC822.HEADER RFC822.TEXT INTERNALDATE FLAGS)");
	assert.deepEqual(items.map((item) => item.label ?? item.kind), ["uid", "rfc822.size", "", "TEXT", "2.MIME", "body", "bodystructure", "envelope", "rfc822", "rfc822.header", "rfc822.text", "internaldate", "flags"]);
	for (const bad of ["BODY[MIME]", "BODY.PEEK", "BODY[HEADER.FIELDS ()]", "BODY[0]", "BODY[]<1>", "BODY[]<1.0>", "NOPE", "(FLAGS", "BODY[TEXT", "BODY[1.X]"]) {
		assert.throws(() => fetch(bad), app.ImapSyntaxError, bad);
	}
});

const search = (text) => {
	const r = reader(`t SEARCH ${text}`);
	r.atom();
	r.sp();
	r.keyword();
	r.sp();
	return app.readSearch(r);
};

test("SEARCH grammar: every RFC 3501 key, OR/NOT/parentheses, CHARSET and dates", () => {
	const all = "ALL ANSWERED BCC b BEFORE 1-Feb-2026 BODY x CC c DELETED DRAFT FLAGGED FROM f HEADER X-Y v KEYWORD k LARGER 5 NEW NOT SEEN OLD ON \"01-Feb-2026\" OR TO t SUBJECT s RECENT SEEN SENTBEFORE 1-Jan-2026 SENTON 1-Jan-2026 SENTSINCE 1-Jan-2026 SINCE 1-Jan-2026 SMALLER 9 TEXT t UID 1:* UNANSWERED UNDELETED UNDRAFT UNFLAGGED UNKEYWORD k UNSEEN 1,2:* (SEEN FLAGGED)";
	const parsed = search(all);
	assert.equal(parsed.charset, null);
	assert.equal(parsed.key.kind, "and");
	assert.equal(parsed.key.keys.length, 35);
	assert.deepEqual(search("CHARSET utf-8 SUBJECT {4}\r\ncaf\u00c3\u00a9".replace(/\u00c3\u00a9/, "\xc3\xa9").replace("{4}", "{5}")).key, { kind: "header", field: "SUBJECT", value: "café" });
	assert.equal(search("CHARSET UTF-8 ALL").charset, "UTF-8");
	assert.equal(search("CC x").key.field, "CC", "CC is a key, not the start of CHARSET");
	assert.deepEqual(search("ON 5-Mar-2026").key, { kind: "internaldate", op: "on", day: Date.UTC(2026, 2, 5) / 86_400_000 });
	for (const bad of ["", "BEFORE 31-Feb-2026", "BEFORE 1-Foo-2026", "OR SEEN", "(SEEN", "SEEN)", "NOPE", "HEADER : x", "LARGER x", `${"NOT ".repeat(40)}SEEN`, Array(300).fill("SEEN").join(" ")]) {
		assert.throws(() => search(bad), app.ImapSyntaxError, bad.slice(0, 40));
	}
});

test("responses: quoted when safe, literal otherwise, NUL never emitted", () => {
	const out = (build) => app.bytes.bytesToBinary(build(new app.ResponseBuilder()).bytes());
	assert.equal(out((r) => r.string('a "q" \\')), '"a \\"q\\" \\\\"');
	assert.equal(out((r) => r.string("line\r\nbreak")), "{11}\r\nline\r\nbreak");
	assert.equal(out((r) => r.string("\xe9")), "{1}\r\n\xe9");
	assert.equal(out((r) => r.nstring(null).raw(" ").string("a\0b")), 'NIL "ab"');
	assert.equal(out((r) => r.unicode("é")), "{2}\r\n\xc3\xa9");
});

test("fuzz: random and mutated input never throws outside the syntax error type", () => {
	let seed = 0x9e3779b9;
	const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
	const corpus = [
		"a FETCH 1:* (FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO)]<0.100>)",
		"b SEARCH CHARSET UTF-8 OR (FROM x SINCE 1-Jan-2020) NOT UID 1:5",
		'c LOGIN "user@example.test" {5}',
		"d UID FETCH 1,2,3:9 (UID RFC822.SIZE BODYSTRUCTURE)",
		'e LIST "" "*"',
	];
	const alphabet = ' ()[]<>{}"\\*%.:,0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcxyz+-\0\r\n\x7f\xff';
	for (let round = 0; round < 3000; round += 1) {
		let text = corpus[round % corpus.length];
		const edits = 1 + Math.floor(random() * 6);
		for (let edit = 0; edit < edits; edit += 1) {
			const at = Math.floor(random() * (text.length + 1));
			const op = random();
			const char = alphabet[Math.floor(random() * alphabet.length)];
			text = op < 0.4 ? text.slice(0, at) + char + text.slice(at) : op < 0.7 ? text.slice(0, at) + text.slice(at + 1) : text.slice(0, at) + char + text.slice(at + 1);
		}
		const { push } = framer({ maxLine: 256, maxLiteral: 64, maxLiterals: 4 });
		let items;
		assert.doesNotThrow(() => (items = push(`${text}\r\n${"x".repeat(Math.floor(random() * 80))}\r\n`)), text);
		for (const item of items) {
			if (item.kind !== "command") continue;
			const r = new app.CommandReader(item.parts);
			try {
				r.atom();
				r.sp();
				const command = r.keyword();
				r.sp();
				if (command === "FETCH" || command === "UID") {
					r.token();
					r.sp();
					app.readFetchItems(r);
				} else if (command === "SEARCH") app.readSearch(r);
				else r.astring();
			} catch (error) {
				assert.ok(error instanceof app.ImapSyntaxError, `${JSON.stringify(text)}: ${error}`);
			}
		}
	}
});

test("the protocol layer imports no Node APIs and no listener code", () => {
	const directory = join(root, "src", "lib", "imap-server");
	for (const file of readdirSync(directory)) {
		const source = readFileSync(join(directory, file), "utf8");
		assert.doesNotMatch(source, /from\s+["'](node:|net|tls|fs|buffer|stream|crypto)["/']/, file);
		assert.doesNotMatch(source, /\bBuffer\b|\bprocess\./, file);
		assert.doesNotMatch(source, /server\/runtime/, file);
	}
});
