import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-canonical-bundle-"));
await build({
	stdin: {
		contents: `
			export { buildCanonicalMime, classifyMessage, foldedEncodedWordBase64 } from "./src/lib/email/canonical-message-utils.ts";
			export { resolveCanonicalMessage, invalidateDraftRepresentation, runCanonicalMessageMaintenance } from "./src/lib/email/canonical-message.ts";
			export { sendEmail } from "./src/lib/email/send.ts";
			export { readBlob } from "./src/lib/jmap/blobs.ts";
			export { messageBlobId } from "./src/lib/jmap/ids.ts";
			export { GET as originalRoute } from "./src/app/api/messages/[messageId]/original/route.ts";
			export { PATCH as patchDraft } from "./src/app/api/drafts/[id]/route.ts";
			export { deleteMessageWithObjects } from "./src/lib/email/message-cleanup.ts";
			export { exportDatabaseRecords, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { FileBucket } from "./server/runtime/file-bucket.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { getDb } from "./src/db/index.ts";
			export { default as PostalMime } from "postal-mime";
		`,
		resolveDir: root,
		sourcefile: "canonical-test-entry.ts",
		loader: "ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
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

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const bytesOf = async (body) => new Uint8Array(body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer());
const textOf = async (body) => new TextDecoder().decode(await bytesOf(body));

/** An R2-shaped in-memory bucket, as the Workers binding presents it. */
function memoryBucket() {
	const objects = new Map();
	const counts = { put: 0, get: 0, delete: 0 };
	const toObject = (key, stored) => ({ key, size: stored.byteLength, body: new Blob([stored]).stream(), arrayBuffer: async () => stored.slice().buffer, text: async () => new TextDecoder().decode(stored), httpMetadata: {} });
	return {
		counts, objects,
		async put(key, value) { counts.put += 1; const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value); objects.set(key, bytes); return { key, size: bytes.byteLength }; },
		async get(key) { counts.get += 1; const stored = objects.get(key); return stored ? toObject(key, stored) : null; },
		async head(key) { const stored = objects.get(key); return stored ? toObject(key, stored) : null; },
		async delete(key) { counts.delete += 1; for (const item of [key].flat()) objects.delete(item); },
	};
}

async function install(t, { bucket: kind = "file" } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-canonical-"));
	const database = new app.SqliteDatabase(join(directory, "mailflare.sqlite"));
	t.after(() => { database.db.close(); rmSync(directory, { recursive: true, force: true }); });
	await app.applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('user-a', 'owner@example.test', 'hash', 'Ann', 'admin', 1);
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('user-b', 'other@example.test', 'hash', 'Bob', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-a', 'example.test', 'manual', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, type, created_at) VALUES ('mbx-a', 'user-a', 'domain-1', 'ann', 'Ann Example', 'personal', 1);
	`);
	const bucket = kind === "file" ? new app.FileBucket(join(directory, "blobs")) : memoryBucket();
	const sent = [];
	const env = {
		DB: database,
		BUCKET: bucket,
		EMAIL: { async send(message) { sent.push(message); return { messageId: `<provider-${sent.length}@mail.example.test>` }; } },
		OUTBOUND_QUEUE: { async send() {} },
	};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const db = app.getDb(env);
	const row = (id) => database.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
	const load = async (id) => (await db.query.messages.findFirst({ where: (messages, { eq }) => eq(messages.id, id) }));
	return { database, env, bucket, sent, row, load, directory };
}

const insertMessage = (database, values) => {
	const row = { user_id: "user-a", mailbox_id: "mbx-a", direction: "outbound", from_addr: "Ann Example <ann@example.test>", to_addr: "bob@elsewhere.test", status: "sent", created_at: 1790000000, ...values };
	const columns = Object.keys(row);
	database.db.prepare(`INSERT INTO messages (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => row[column]));
};

test("the canonical builder writes a parseable, 7-bit, CRLF message with every header, body and attachment", async () => {
	const longSubject = "Quarterly report – ünïcode ✓ ".repeat(40).trim();
	const raw = app.buildCanonicalMime({
		from: '"Ann Example" <ann@example.test>',
		to: ["Bob <bob@elsewhere.test>", "carol@elsewhere.test"],
		cc: ["dave@elsewhere.test"],
		bcc: ["erin@elsewhere.test"],
		subject: longSubject,
		date: new Date("2026-09-29T12:00:00Z"),
		messageId: "provider-1@mail.example.test",
		inReplyTo: "parent@elsewhere.test",
		references: ["root@elsewhere.test", "<parent@elsewhere.test>"],
		text: "Plain ünïcode body",
		html: '<p>HTML <img src="cid:logo1"></p>',
		headers: { "List-Unsubscribe": "<mailto:stop@example.test>", "X-Injected\r\nBcc": "evil", "X-Note": "line\r\nBcc: evil@example.test" },
		attachments: [
			{ filename: "logo.png", type: "image/png", content: PNG, disposition: "inline", contentId: "logo1" },
			{ filename: 'résumé "final".pdf', type: "application/pdf", content: new Uint8Array(4000).fill(65), disposition: "attachment" },
		],
	});
	const lines = raw.split("\r\n");
	assert.ok(!/[^\r]\n/.test(raw), "CRLF line endings only");
	assert.ok(lines.every((line) => line.length <= 998), "no line exceeds the RFC 5322 limit, even for a long subject");
	assert.ok(![...raw].some((character) => character.charCodeAt(0) > 127), "7-bit clean");
	assert.doesNotMatch(raw, /^Bcc: evil/m, "header values cannot inject headers");
	const parsed = await app.PostalMime.parse(raw);
	assert.deepEqual(parsed.from, { address: "ann@example.test", name: "Ann Example" });
	assert.deepEqual(parsed.to.map((entry) => entry.address), ["bob@elsewhere.test", "carol@elsewhere.test"]);
	assert.deepEqual(parsed.cc.map((entry) => entry.address), ["dave@elsewhere.test"]);
	assert.deepEqual(parsed.bcc.map((entry) => entry.address), ["erin@elsewhere.test"], "the sender's copy keeps Bcc");
	assert.equal(parsed.subject, longSubject);
	assert.equal(parsed.date, "2026-09-29T12:00:00.000Z");
	assert.equal(parsed.messageId, "<provider-1@mail.example.test>");
	assert.equal(parsed.inReplyTo, "<parent@elsewhere.test>");
	assert.equal(parsed.references, "<root@elsewhere.test> <parent@elsewhere.test>");
	assert.equal(parsed.text.trim(), "Plain ünïcode body");
	assert.equal(parsed.html.trim(), '<p>HTML <img src="cid:logo1"></p>');
	assert.ok(parsed.headers.some((header) => header.key === "list-unsubscribe"));
	assert.deepEqual(parsed.attachments.map((attachment) => [attachment.filename, attachment.mimeType, attachment.disposition, attachment.contentId ?? null, attachment.content.byteLength]), [
		["logo.png", "image/png", "inline", "<logo1>", PNG.byteLength],
		['résumé "final".pdf', "application/pdf", "attachment", null, 4000],
	]);
});

test("received mail keeps its original bytes, byte for byte, on every read", async (t) => {
	const { database, env, bucket } = await install(t);
	const original = "Received: from mx\r\nFrom: sender@elsewhere.test\r\nTo: ann@example.test\r\nSubject: hi\r\nMessage-ID: <orig@elsewhere.test>\r\n\r\nexact  bytes\ttabs\r\n";
	await bucket.put("inbound/1-original.eml", new TextEncoder().encode(original));
	insertMessage(database, { id: "msg-in", direction: "inbound", status: "received", raw_r2_key: "inbound/1-original.eml", provider_message_id: "<orig@elsewhere.test>" });
	const row = await app.getDb(env).query.messages.findFirst({ where: (messages, { eq }) => eq(messages.id, "msg-in") });
	const first = await app.resolveCanonicalMessage(env, row);
	const second = await app.resolveCanonicalMessage(env, row);
	assert.equal(first.source, "original");
	assert.equal(await textOf(first.body), original);
	assert.equal(await textOf(second.body), original);
	assert.equal(first.size, new TextEncoder().encode(original).byteLength);
});

test("a sent message stores one canonical copy under the transport's Message-ID, and reads never regenerate it", async (t) => {
	const { env, sent, row, load, directory } = await install(t);
	const result = await app.sendEmail(env, {
		userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test",
		to: "Bob <bob@elsewhere.test>", cc: "carol@elsewhere.test", bcc: "hidden@elsewhere.test",
		subject: "Canonical ✓", text: "Hello text", html: '<p>Hello <img src="cid:sig"></p>',
		inReplyTo: "parent@elsewhere.test", references: ["root@elsewhere.test", "parent@elsewhere.test"],
		attachments: [
			{ filename: "sig.png", type: "image/png", content: PNG.buffer.slice(0), disposition: "inline", contentId: "sig" },
			{ filename: "notes.txt", type: "text/plain", content: new TextEncoder().encode("attached notes").buffer, disposition: "attachment" },
		],
	});
	assert.equal(sent.length, 1);
	const stored = row(result.messageId);
	assert.equal(stored.status, "sent");
	assert.equal(stored.provider_message_id, "<provider-1@mail.example.test>");
	assert.match(stored.raw_r2_key, /^canonical\/msg_[^/]+\/[0-9a-f-]{36}\.eml$/);

	const message = await load(result.messageId);
	const first = await app.resolveCanonicalMessage(env, message);
	const second = await app.resolveCanonicalMessage(env, message);
	assert.equal(first.source, "stored");
	const firstBytes = await bytesOf(first.body);
	assert.deepEqual(await bytesOf(second.body), firstBytes, "identical bytes on every read");
	assert.equal(first.size, firstBytes.byteLength);
	assert.equal(second.size, firstBytes.byteLength);
	assert.equal(row(result.messageId).raw_r2_key, stored.raw_r2_key, "reading never replaces the stored copy");

	const parsed = await app.PostalMime.parse(firstBytes);
	assert.equal(parsed.messageId, "<provider-1@mail.example.test>", "the canonical copy carries the transport-assigned Message-ID");
	assert.deepEqual(parsed.from, { address: "ann@example.test", name: "Ann Example" });
	assert.deepEqual(parsed.to.map((entry) => entry.address), ["bob@elsewhere.test"]);
	assert.deepEqual(parsed.cc.map((entry) => entry.address), ["carol@elsewhere.test"]);
	assert.deepEqual(parsed.bcc.map((entry) => entry.address), ["hidden@elsewhere.test"]);
	assert.equal(parsed.subject, "Canonical ✓");
	assert.equal(parsed.inReplyTo, "<parent@elsewhere.test>");
	assert.equal(parsed.references, "<root@elsewhere.test> <parent@elsewhere.test>");
	assert.equal(parsed.text.trim(), "Hello text");
	assert.equal(parsed.html.trim(), '<p>Hello <img src="cid:sig"></p>');
	assert.deepEqual(parsed.attachments.map((attachment) => [attachment.filename, attachment.mimeType, attachment.disposition, attachment.contentId ?? null]), [
		["sig.png", "image/png", "inline", "<sig>"],
		["notes.txt", "text/plain", "attachment", null],
	]);
	assert.ok(Math.abs(new Date(parsed.date).getTime() - Date.now()) < 60_000, "Date is the time the transport accepted it");
	void directory;
});

test("a failed send never gets a stored canonical copy, and its representation is generated per read", async (t) => {
	const { env, row, load } = await install(t);
	env.EMAIL = { async send() { throw new Error("provider down"); } };
	await assert.rejects(app.sendEmail(env, { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "Will fail", text: "x" }), /provider down/);
	const failed = env.DB.db.prepare("SELECT id FROM messages WHERE status = 'failed'").get();
	assert.ok(failed);
	assert.equal(row(failed.id).raw_r2_key, null);
	const result = await app.resolveCanonicalMessage(env, await load(failed.id));
	assert.equal(result.source, "transient");
	assert.equal(row(failed.id).raw_r2_key, null, "reading a failed send stores nothing");
});

test("a draft's representation follows its content: edits and attachment changes replace it and remove the old object", async (t) => {
	const { database, env, bucket, row, load } = await install(t);
	insertMessage(database, { id: "draft-1", status: "draft", subject: "First", text_body: "v1", to_addr: "bob@elsewhere.test" });
	const first = await app.resolveCanonicalMessage(env, await load("draft-1"));
	assert.equal(first.source, "materialized");
	const firstKey = row("draft-1").raw_r2_key;
	assert.match(firstKey, /^canonical\/draft-1\/[0-9a-f]{32}-/, "draft copies are keyed by a content fingerprint");
	assert.equal((await app.resolveCanonicalMessage(env, await load("draft-1"))).source, "stored", "unchanged drafts are not regenerated");

	// An edit through the web route drops the stored representation immediately.
	const token = await app.createSession(env, "user-a");
	const response = await app.patchDraft(new Request("http://mailflare.local/api/drafts/draft-1", { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "Second", text: "v2" }) }), { params: Promise.resolve({ id: "draft-1" }) });
	assert.equal(response.status, 200);
	assert.equal(row("draft-1").raw_r2_key, null, "the edit invalidated the old representation");
	assert.equal(await bucket.get(firstKey), null, "and removed its object");
	const second = await app.resolveCanonicalMessage(env, await load("draft-1"));
	assert.equal((await app.PostalMime.parse(await bytesOf(second.body))).subject, "Second");

	// A change that bypasses the hooks (here: an attachment added directly) is still noticed by the fingerprint.
	const secondKey = row("draft-1").raw_r2_key;
	await bucket.put("attachments/draft-1/a1", new TextEncoder().encode("new attachment"));
	database.db.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES ('att-1', 'draft-1', 'added.txt', 'text/plain', 14, 'attachment', 'attachments/draft-1/a1', 1)").run();
	const third = await app.resolveCanonicalMessage(env, await load("draft-1"));
	assert.equal(third.source, "materialized");
	assert.notEqual(row("draft-1").raw_r2_key, secondKey);
	assert.equal(await bucket.get(secondKey), null, "the superseded representation is deleted");
	assert.deepEqual((await app.PostalMime.parse(await bytesOf(third.body))).attachments.map((attachment) => attachment.filename), ["added.txt"]);
});

test("legacy sent mail without a copy is materialized once, and maintenance is bounded and idempotent", async (t) => {
	const { database, env, bucket, row, load } = await install(t);
	insertMessage(database, { id: "legacy-1", provider_message_id: "<legacy-1@mail.example.test>", subject: "Old one", text_body: "old", references_header: "root@elsewhere.test" });
	insertMessage(database, { id: "legacy-2", provider_message_id: "<legacy-2@mail.example.test>", subject: "Old two", html_body: "<p>old</p>" });
	insertMessage(database, { id: "queued-1", status: "queued", subject: "Not yet" });

	const read = await app.resolveCanonicalMessage(env, await load("legacy-1"));
	assert.equal(read.source, "materialized", "the first read stores a copy instead of rebuilding it every time");
	const key = row("legacy-1").raw_r2_key;
	const bytes = await bytesOf(read.body);
	const parsed = await app.PostalMime.parse(bytes);
	assert.equal(parsed.messageId, "<legacy-1@mail.example.test>");
	assert.equal(parsed.date, new Date(1790000000 * 1000).toISOString(), "legacy copies are dated when the message was created");

	const summary = await app.runCanonicalMessageMaintenance(env, 10);
	assert.deepEqual(summary, { stored: 1, failed: 0, remaining: 0 }, "only the one still missing is processed; queued mail is skipped");
	assert.ok(row("legacy-2").raw_r2_key);
	assert.equal(row("queued-1").raw_r2_key, null);
	assert.equal(row("legacy-1").raw_r2_key, key, "an existing copy is never replaced");
	assert.deepEqual(await bytesOf((await bucket.get(key)).body), bytes);
	const putsBefore = bucket.counts?.put;
	assert.deepEqual(await app.runCanonicalMessageMaintenance(env, 10), { stored: 0, failed: 0, remaining: 0 }, "a second run has nothing to do");
	if (putsBefore !== undefined) assert.equal(bucket.counts.put, putsBefore);
});

test("attachments sent as download links are not re-attached to a legacy copy", async (t) => {
	const { database, env, bucket, load } = await install(t);
	insertMessage(database, { id: "legacy-link", provider_message_id: "<legacy-link@mail.example.test>", subject: "Linked", html_body: "<p>download: https://example.test/f</p>" });
	for (const [id, name] of [["att-direct", "small.txt"], ["att-linked", "huge.bin"]]) {
		await bucket.put(`attachments/legacy-link/${id}`, new TextEncoder().encode(name));
		database.db.prepare("INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES (?, 'legacy-link', ?, 'application/octet-stream', 9, 'attachment', ?, 1)").run(id, name, `attachments/legacy-link/${id}`);
	}
	database.db.prepare("INSERT INTO shared_attachment_links (id, attachment_id, expires_at, created_at) VALUES ('link-1', 'att-linked', 9999999999, 1)").run();
	const parsed = await app.PostalMime.parse(await bytesOf((await app.resolveCanonicalMessage(env, await load("legacy-link"))).body));
	assert.deepEqual(parsed.attachments.map((attachment) => attachment.filename), ["small.txt"]);
});

test("/original and JMAP readBlob serve the canonical bytes, with access control unchanged", async (t) => {
	const { env, row } = await install(t);
	const { messageId } = await app.sendEmail(env, { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "Read paths", text: "body" });
	const storedBytes = await bytesOf((await env.BUCKET.get(row(messageId).raw_r2_key)).body);

	const owner = await app.createSession(env, "user-a");
	const other = await app.createSession(env, "user-b");
	const call = (token) => app.originalRoute(new Request(`http://mailflare.local/api/messages/${messageId}/original`, { headers: { Authorization: `Bearer ${token}` } }), { params: Promise.resolve({ messageId }) });
	const response = await call(owner);
	assert.equal(response.status, 200);
	assert.deepEqual(new Uint8Array(await response.arrayBuffer()), storedBytes);
	assert.equal((await call(other)).status, 404, "another account still cannot read it");

	const ctx = { env, db: app.getDb(env), auth: { userId: "user-a", user: { id: "user-a", role: "admin" }, mailboxIds: null }, accountId: "user-a", origin: "http://mailflare.local", createdIds: {} };
	const blob = await app.readBlob(ctx, app.messageBlobId(messageId));
	assert.ok(blob, "readBlob found the message");
	assert.equal(blob.type, "message/rfc822");
	assert.deepEqual(await bytesOf(blob.body), storedBytes);
	assert.equal(blob.size, storedBytes.byteLength);
});

test("permanent deletion removes the canonical object, and backup/restore keeps the reference", async (t) => {
	const { env, row } = await install(t);
	const { messageId } = await app.sendEmail(env, { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "Backup me", text: "body" });
	const key = row(messageId).raw_r2_key;

	const backup = await app.exportDatabaseRecords(env.DB);
	await app.restoreDatabaseRecords(env.DB, backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength));
	assert.equal(row(messageId).raw_r2_key, key, "the restored row references the same canonical object");
	assert.ok(await env.BUCKET.get(key), "which is still in the bucket");

	await app.deleteMessageWithObjects(env, app.getDb(env), messageId, key);
	assert.equal(row(messageId), undefined);
	assert.equal(await env.BUCKET.get(key), null, "the canonical object went with the message");
});

test("the Workers-shaped (R2) bucket and the Node file bucket behave the same", async (t) => {
	for (const kind of ["memory", "file"]) {
		const { database, env, bucket, row, load } = await install(t, { bucket: kind });
		insertMessage(database, { id: `legacy-${kind}`, provider_message_id: `<legacy-${kind}@mail.example.test>`, subject: "Parity", text_body: "same" });
		const first = await app.resolveCanonicalMessage(env, await load(`legacy-${kind}`));
		const second = await app.resolveCanonicalMessage(env, await load(`legacy-${kind}`));
		assert.equal(first.source, "materialized", kind);
		assert.equal(second.source, "stored", kind);
		assert.deepEqual(await bytesOf(second.body), await bytesOf(first.body), kind);
		assert.ok(await bucket.get(row(`legacy-${kind}`).raw_r2_key), kind);
		assert.equal(app.classifyMessage({ status: "draft" }), "draft");
		assert.equal(app.classifyMessage({ status: "queued" }), "transient");
		assert.equal(app.classifyMessage({ status: "trash" }), "immutable");
	}
});
