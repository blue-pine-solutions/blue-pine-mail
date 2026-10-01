import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { assertTagged, createClock, install, loadApp, makeCertificate, memoryClient, tlsClient } from "./support/imap-harness.mjs";

/**
 * A5.8: IMAP COPY and UID COPY with UIDPLUS COPYUID, over the real A2 verifier, A3 state and file
 * bucket (SQLite, no Workers), the in-memory transport and the real Node TLS listener.
 *
 * - A copy is an independent message: a new `messages` row copied from the live source row, a new
 *   raw object (`copies/<id>.eml`) with exactly the source UID's octets, new attachment objects and
 *   rows, and a new UID in the destination. The source is only read.
 * - Placement is MOVE's; Sent and Drafts are never destinations, Drafts never a source, outbound
 *   mail never goes to Spam, the source's own folder is allowed. No spam training.
 * - All or nothing: objects first, one at a time under the content-read permit, within 1000
 *   messages and 256 MiB, then one guarded batch; on any failure nothing is committed and every
 *   new object is removed. COPYUID comes in the tagged OK.
 */
const { app, cleanup } = await loadApp("imap-copy");
test.after(cleanup);

const BASE = "http://localhost";
const POLL = 10_000;
const SHARED = { userId: "user-b", mailboxId: "mbx-s", address: "sales@example.test" };
const DELEGATE = { userId: "user-x", mailboxId: "mbx-s", address: "sales@example.test" };
const tick = async (rounds = 20) => {
	for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
};
const one = (context, query, ...params) => context.database.db.prepare(query).get(...params);
const all = (context, query, ...params) => context.database.db.prepare(query).all(...params);
const exec = (context, query) => context.database.db.exec(query);
const texts = (result) => result.untagged.map((unit) => unit.text);
const copyUid = (result) => {
	const match = /\[COPYUID (\d+) ([\d:,]+) ([\d:,]+)\]/.exec(result.tagged ?? "");
	return match ? { uidValidity: Number(match[1]), source: match[2], destination: match[3] } : null;
};
const expand = (set) => set.split(",").flatMap((part) => {
	const [from, to] = part.split(":").map(Number);
	return to === undefined ? [from] : Array.from({ length: to - from + 1 }, (_, index) => from + index);
});

async function setup(t) {
	const context = await install(app, t);
	// user-x is a full_access delegate of the shared mailbox (user-b stays read_only).
	exec(context, "INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('acc-x', 'mbx-s', 'user-x', 'full_access', 1)");
	return context;
}

async function connect(context, account = {}, overrides = {}, options = {}) {
	const { userId = "user-a", mailboxId = "mbx-a", address = "a@example.test" } = account;
	const { client, session, start } = memoryClient(app, context.env, overrides, options);
	await start();
	const { credential, id } = await context.credential(userId, mailboxId);
	assertTagged(await client.login(address, credential), "OK");
	return { client, session, credentialId: id };
}

let counter = 0;
const rawMessage = (subject, body = "body text") => `From: Sender <sender@elsewhere.test>\r\nTo: a@example.test\r\nSubject: ${subject}\r\nDate: Tue, 3 Mar 2026 10:15:00 +0100\r\nMessage-ID: <${subject.replace(/\W/g, "-")}-${++counter}@elsewhere.test>\r\n\r\n${body}\r\n`;

/** Received mail in mbx-a (INBOX unless `values` says otherwise), with `created_at` spaced so INTERNALDATE order is stable. */
async function deliver(context, id, { subject = id, values = {}, attachments = [] } = {}) {
	const bytes = await context.deliver(id, rawMessage(subject), { created_at: 1790000000 + ++counter * 60, provider_message_id: `<${id}@elsewhere.test>`, subject, ...values });
	if (attachments.length) await app.storeMessageAttachments(context.env, id, attachments.map(([filename, content, type = "application/octet-stream"]) => ({ filename, type, content: new TextEncoder().encode(content).buffer, disposition: "attachment", contentId: null })), { validate: false });
	return bytes;
}

/** Every stored object key (the file bucket's files, without metadata), sorted. */
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
	walk(rootDirectory);
	return out.sort();
}

const objectBytes = async (context, key) => Buffer.from(await (await context.env.BUCKET.get(key)).arrayBuffer());
const uidRows = (context) => all(context, "SELECT f.folder_key, u.uid, u.message_id, u.deleted, u.rfc822_key, u.rfc822_size FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id ORDER BY f.folder_key, u.uid");
const messageRows = (context) => all(context, "SELECT * FROM messages ORDER BY id");
const attachmentRows = (context) => all(context, "SELECT * FROM message_attachments ORDER BY id");
const folderState = (context, key, mailboxId = "mbx-a") => one(context, "SELECT * FROM imap_folders WHERE mailbox_id = ? AND folder_key = ?", mailboxId, key);
/** Everything COPY could change: rows, UIDs, attachments, folder state and objects. */
async function snapshot(context) {
	const keys = objects(context);
	const bytes = {};
	for (const key of keys) bytes[key] = (await objectBytes(context, key)).toString("base64");
	return JSON.stringify({ messages: messageRows(context), uids: uidRows(context), attachments: attachmentRows(context), folders: all(context, "SELECT * FROM imap_folders ORDER BY id"), bytes });
}
const copiesOf = (context, sourceId) => {
	const source = one(context, "SELECT * FROM messages WHERE id = ?", sourceId);
	return all(context, "SELECT * FROM messages WHERE provider_message_id = ? AND id != ? ORDER BY rowid", source.provider_message_id, sourceId);
};

function countingPermits() {
	const permits = { held: 0, peak: 0, granted: 0 };
	permits.acquire = async () => {
		permits.granted += 1;
		permits.held += 1;
		permits.peak = Math.max(permits.peak, permits.held);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			permits.held -= 1;
		};
	};
	return permits;
}

/** Wrap the bucket's put; `hook(key, count)` runs before each write (and may throw). Restored after the test. */
function hookPuts(t, context, hook) {
	const bucket = context.env.BUCKET;
	const put = bucket.put.bind(bucket);
	let count = 0;
	bucket.put = async (key, value, options) => {
		count += 1;
		await hook(key, count);
		return put(key, value, options);
	};
	const restore = () => (bucket.put = put);
	t.after(restore);
	return restore;
}

// ---- A. Basic -------------------------------------------------------------------------------------

test("a5.8 A: COPY and UID COPY of one message and of ranges; COPYUID in the tagged answer", async (t) => {
	const context = await setup(t);
	for (const id of ["m-1", "m-2", "m-3", "m-4"]) await deliver(context, id);
	const { client } = await connect(context);
	assertTagged(await client.command("SELECT INBOX"), "OK");
	const one1 = await client.command("COPY 1 Archive");
	assertTagged(one1, "OK", /^t\d+ OK \[COPYUID \d+ 1 1\] COPY completed$/);
	assert.deepEqual(texts(one1), [], "nothing untagged: the source mailbox did not change");
	const range = await client.command("COPY 2:3 Work");
	assertTagged(range, "OK", /\[COPYUID \d+ 2:3 1:2\] COPY completed/);
	const uidOne = await client.command("UID COPY 4 Archive");
	assertTagged(uidOne, "OK", /\[COPYUID \d+ 4 2\] UID COPY completed/);
	const uidRange = await client.command("UID COPY 1:3 Trash");
	assertTagged(uidRange, "OK", /\[COPYUID \d+ 1:3 1:3\] UID COPY completed/);
	assert.equal(copyUid(uidRange).uidValidity, folderState(context, "trash").uid_validity);
	// Nothing matched: OK without COPYUID.
	assertTagged(await client.command("UID COPY 900:950 Archive"), "OK", /^t\d+ OK UID COPY completed$/);
	assert.equal(messageRows(context).length, 4 + 1 + 2 + 1 + 3);
	assertTagged(await client.command("STATUS Archive (MESSAGES UIDNEXT)"), "OK");
});

test("a5.8 A: malformed, out of range, wrong state and unknown destinations change nothing", async (t) => {
	const context = await setup(t);
	await deliver(context, "m-1");
	const { client } = await connect(context);
	assertTagged(await client.command("COPY 1 Archive"), "BAD", /not valid in this state/, "no mailbox selected");
	assertTagged(await client.command("SELECT INBOX"), "OK");
	const before = await snapshot(context);
	for (const command of ["COPY", "COPY 1", "COPY x Archive", "COPY 1 Archive extra", "COPY 1,,2 Archive", "UID COPY", "UID COPY ** Archive", "COPY 1 (Archive)"]) {
		assertTagged(await client.command(command), "BAD", undefined, command);
	}
	assertTagged(await client.command("COPY 2 Archive"), "BAD", /Invalid message sequence number/);
	assertTagged(await client.command("COPY 1 Nowhere"), "NO", /^\S+ NO \[NONEXISTENT\] No such mailbox$/);
	assertTagged(await client.command("COPY 1 archive"), "NO", /\[NONEXISTENT\]/, "names are exact (only INBOX is case-insensitive)");
	assert.equal(await snapshot(context), before);
});

// ---- B. Source preservation; C. destination ------------------------------------------------------

test("a5.8 B+C: the source is untouched; the copy is a new message with the same octets, flags, date and thread", async (t) => {
	const context = await setup(t);
	await deliver(context, "m-1", { subject: "with files", values: { read: 1, starred: 1, thread_id: "thr-1", snoozed_until: 1890000000, spam_score: 7, spam_verdict: "suspicious" }, attachments: [["report.pdf", "%PDF-1.4 report", "application/pdf"], ["notes.txt", "some notes", "text/plain"]] });
	const { client } = await connect(context);
	assertTagged(await client.command("SELECT INBOX"), "OK");
	// The source carries an IMAP \Deleted mark, which a copy must not inherit.
	assertTagged(await client.command("STORE 1 +FLAGS.SILENT (\\Deleted)"), "OK");
	const sourceFetch = await client.command("FETCH 1 (FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])");
	const before = await snapshot(context);
	const source = one(context, "SELECT * FROM messages WHERE id = 'm-1'");
	const sourceAttachments = all(context, "SELECT * FROM message_attachments WHERE message_id = 'm-1' ORDER BY filename");
	const inboxBefore = folderState(context, "inbox");

	const result = await client.command("COPY 1 Work");
	assertTagged(result, "OK", /COPYUID/);
	// B: the source row, UID, \Deleted mark, attachments and objects are byte-for-byte what they were.
	const after = JSON.parse(await snapshot(context));
	const previous = JSON.parse(before);
	assert.deepEqual(after.messages.filter((row) => row.id === "m-1"), previous.messages.filter((row) => row.id === "m-1"));
	assert.deepEqual(after.uids.filter((row) => row.message_id === "m-1"), previous.uids.filter((row) => row.message_id === "m-1"));
	assert.deepEqual(after.attachments.filter((row) => row.message_id === "m-1"), previous.attachments.filter((row) => row.message_id === "m-1"));
	for (const [key, value] of Object.entries(previous.bytes)) assert.equal(after.bytes[key], value, key);
	assert.deepEqual(folderState(context, "inbox"), inboxBefore, "source UIDVALIDITY and UIDNEXT unchanged");
	assert.match(texts(await client.command("FETCH 1 FLAGS"))[0], /\\Deleted/, "the source keeps its \\Deleted mark");

	// C: one new row, copied from the source except what COPY sets.
	const [copy] = copiesOf(context, "m-1");
	assert.ok(copy && copy.id !== "m-1");
	for (const column of app.imapState.COPY_COPIED_COLUMNS) assert.deepEqual(copy[column], source[column], column);
	assert.equal(copy.status, "received");
	assert.equal(copy.folder_id, "fld-work");
	assert.equal(copy.snoozed_until, null, "a copy is not snoozed");
	assert.equal(copy.raw_r2_key, `copies/${copy.id}.eml`);
	assert.equal(copy.thread_id, "thr-1");
	const copyAttachments = all(context, "SELECT * FROM message_attachments WHERE message_id = ? ORDER BY filename", copy.id);
	assert.equal(copyAttachments.length, 2);
	for (const [index, attachment] of copyAttachments.entries()) {
		const original = sourceAttachments[index];
		assert.notEqual(attachment.id, original.id);
		assert.notEqual(attachment.r2_key, original.r2_key);
		assert.match(attachment.r2_key, new RegExp(`^attachments/${copy.id}/${attachment.id}/`));
		for (const column of ["filename", "content_type", "size", "disposition", "content_id"]) assert.equal(attachment[column], original[column], column);
		assert.deepEqual(await objectBytes(context, attachment.r2_key), await objectBytes(context, original.r2_key));
	}
	// The copy over IMAP: same octets, size, INTERNALDATE and flags, no \Deleted, a fresh UID.
	const work = folderState(context, "f:fld-work");
	assert.equal(work.uid_next, 2);
	const uid = uidRows(context).find((row) => row.message_id === copy.id);
	assert.deepEqual({ uid: uid.uid, deleted: uid.deleted, key: uid.rfc822_key, size: uid.rfc822_size }, { uid: 1, deleted: 0, key: copy.raw_r2_key, size: sourceFetch.literals[0].length });
	assertTagged(await client.command("SELECT Work"), "OK");
	const copyFetch = await client.command("FETCH 1 (FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])");
	assert.deepEqual(copyFetch.literals[0], sourceFetch.literals[0], "byte-identical");
	const strip = (text) => text.replace(/\\Deleted ?/, "").replace(/ \)/, ")").replace(/BODY\[\][\s\S]*$/, "");
	assert.equal(strip(copyFetch.untagged[0].text), strip(sourceFetch.untagged[0].text), "same flags (minus \\Deleted), INTERNALDATE and size");
	assert.doesNotMatch(copyFetch.untagged[0].text, /\\Deleted/);
	for (const section of ["BODY.PEEK[HEADER]", "BODY.PEEK[TEXT]", "BODY.PEEK[1]"]) {
		assertTagged(await client.command("SELECT INBOX"), "OK");
		const a = (await client.command(`FETCH 1 ${section}`)).literals[0];
		assertTagged(await client.command("SELECT Work"), "OK");
		assert.deepEqual((await client.command(`FETCH 1 ${section}`)).literals[0], a, section);
	}
});

// ---- D. COPYUID ----------------------------------------------------------------------------------

test("a5.8 D: COPYUID maps ascending source UIDs to the allocated UIDs: unsorted input, duplicates, missing UIDs, ranges", async (t) => {
	const context = await setup(t);
	for (let index = 1; index <= 8; index += 1) await deliver(context, `m-${index}`);
	const { client } = await connect(context);
	assertTagged(await client.command("SELECT INBOX"), "OK");
	assertTagged(await client.command("UID STORE 2,6 +FLAGS.SILENT (\\Deleted)"), "OK");
	assertTagged(await client.command("UID EXPUNGE 2,6"), "OK");
	// INBOX now holds UIDs 1,3,4,5,7,8.
	const unsorted = await client.command("UID COPY 8,1,4,1,99,3 Archive");
	assert.deepEqual(copyUid(unsorted), { uidValidity: folderState(context, "archive").uid_validity, source: "1,3:4,8", destination: "1:4" });
	const mapping = (result) => {
		const info = copyUid(result);
		const sources = expand(info.source);
		const destinations = expand(info.destination);
		return sources.map((uid, index) => [uid, destinations[index]]);
	};
	// Each mapped destination UID holds the copy of exactly that source.
	for (const [sourceUid, destinationUid] of mapping(unsorted)) {
		const sourceId = uidRows(context).find((row) => row.folder_key === "inbox" && row.uid === sourceUid).message_id;
		const copyId = uidRows(context).find((row) => row.folder_key === "archive" && row.uid === destinationUid).message_id;
		assert.equal(one(context, "SELECT provider_message_id AS p FROM messages WHERE id = ?", copyId).p, one(context, "SELECT provider_message_id AS p FROM messages WHERE id = ?", sourceId).p);
	}
	const sequence = await client.command("COPY 2:4 Archive");
	assert.deepEqual(copyUid(sequence), { uidValidity: folderState(context, "archive").uid_validity, source: "3:5", destination: "5:7" });
	// Trash already holds the two messages the recoverable UID EXPUNGE moved there (UIDs 1 and 2).
	assertTagged(await client.command("UID COPY 1:* Trash"), "OK", /\[COPYUID \d+ 1,3:5,7:8 3:8\] UID COPY completed/);
	// A later SELECT sees exactly those UIDs.
	assertTagged(await client.command("SELECT Archive"), "OK");
	assert.equal(texts(await client.command("UID SEARCH ALL"))[0], "* SEARCH 1 2 3 4 5 6 7");
});

// ---- E. Same mailbox -----------------------------------------------------------------------------

test("a5.8 E: COPY into the selected mailbox makes another message there, reported with EXISTS", async (t) => {
	const context = await setup(t);
	await deliver(context, "m-1");
	await deliver(context, "m-2");
	const { client } = await connect(context);
	assertTagged(await client.command("SELECT INBOX"), "OK");
	const sourceRow = JSON.stringify(one(context, "SELECT * FROM messages WHERE id = 'm-1'"));
	const result = await client.command("COPY 1 INBOX");
	assert.deepEqual(texts(result), ["* 3 EXISTS"]);
	assertTagged(result, "OK", /\[COPYUID \d+ 1 3\] COPY completed/);
	assert.equal(JSON.stringify(one(context, "SELECT * FROM messages WHERE id = 'm-1'")), sourceRow);
	const [copy] = copiesOf(context, "m-1");
	assert.equal(copy.status, "received");
	assert.equal(copy.folder_id, null);
	assert.deepEqual(uidRows(context).filter((row) => row.folder_key === "inbox").map((row) => [row.uid, row.message_id]), [[1, "m-1"], [2, "m-2"], [3, copy.id]]);
	const fetched = await client.command("FETCH 1,3 BODY.PEEK[]");
	assert.deepEqual(fetched.literals[0], fetched.literals[1]);
});

// ---- F. Authorization ----------------------------------------------------------------------------

test("a5.8 F: owner and full_access delegate copy; send_as, send_on_behalf and read_only are NOPERM", async (t) => {
	const context = await setup(t);
	await deliver(context, "m-1");
	await deliver(context, "s-1", { values: { mailbox_id: "mbx-s" } });
	const owner = await connect(context);
	assertTagged(await owner.client.command("SELECT INBOX"), "OK");
	assertTagged(await owner.client.command("COPY 1 Archive"), "OK", /COPYUID/, "owner");
	const delegate = await connect(context, DELEGATE);
	assertTagged(await delegate.client.command("SELECT INBOX"), "OK");
	assertTagged(await delegate.client.command("COPY 1 Archive"), "OK", /COPYUID/, "full_access delegate");
	const before = await snapshot(context);
	for (const permission of ["send_as", "send_on_behalf", "read_only"]) {
		exec(context, `UPDATE mailbox_access SET permission = '${permission}' WHERE id = 'acc-b'`);
		const { client } = await connect(context, SHARED);
		assertTagged(await client.command("SELECT INBOX"), "OK");
		assertTagged(await client.command("COPY 1 Archive"), "NO", /^\S+ NO \[NOPERM\] This access does not allow copying messages$/, permission);
		assertTagged(await client.command("NOOP"), "OK");
	}
	assert.equal(await snapshot(context), before);
});

const LOSSES = {
	"revoked credential": (context, credentialId) => context.database.db.prepare("DELETE FROM mail_app_passwords WHERE id = ?").run(credentialId),
	"disabled user": (context) => exec(context, "UPDATE users SET disabled = 1 WHERE id IN ('user-a', 'user-x')"),
	"disabled mailbox": (context) => exec(context, "UPDATE mailboxes SET disabled = 1 WHERE id IN ('mbx-a', 'mbx-s')"),
	"sharing disabled": () => (process.env.BLUEPINE_DISABLED_FEATURES = "sharedMailboxes"),
	"downgraded to read_only": (context) => exec(context, "UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-x'"),
};
const DELEGATED = new Set(["sharing disabled", "downgraded to read_only"]);

test("a5.8 F: access lost before the COPY, during duplication or just before the commit: nothing is committed and the new objects are removed", async (t) => {
	for (const [name, lose] of Object.entries(LOSSES)) {
		for (const moment of ["before", "first object write", "last object write"]) {
			const previous = process.env.BLUEPINE_DISABLED_FEATURES;
			try {
				const context = await setup(t);
				const delegated = DELEGATED.has(name);
				const mailboxId = delegated ? "mbx-s" : "mbx-a";
				await deliver(context, "m-1", { values: { mailbox_id: mailboxId }, attachments: [["a.txt", "attachment one"]] });
				await deliver(context, "m-2", { values: { mailbox_id: mailboxId } });
				const { client, credentialId } = await connect(context, delegated ? DELEGATE : undefined);
				assertTagged(await client.command("SELECT INBOX"), "OK");
				// The first read of a UID binds its canonical key and size (A3 bookkeeping, as for FETCH).
				assertTagged(await client.command("FETCH 1:* BODY.PEEK[]"), "OK");
				const before = await snapshot(context);
				const restore = hookPuts(t, context, (key, count) => {
					if ((moment === "first object write" && count === 1) || (moment === "last object write" && count === 3)) lose(context, credentialId);
				});
				if (moment === "before") lose(context, credentialId);
				const result = await client.command("COPY 1:2 Archive");
				restore();
				const answer = result.tagged ?? texts(result).at(-1);
				if (name === "downgraded to read_only") assert.match(answer, /^\S+ NO \[NOPERM\]/, `${name} ${moment}`);
				else assert.equal(texts(result).at(-1), "* BYE Access revoked", `${name} ${moment}`);
				// Nothing is committed and the copies' objects are gone (the losses above only touched access rows).
				const after = JSON.parse(await snapshot(context));
				const was = JSON.parse(before);
				assert.equal(after.messages.length, was.messages.length, `${name} ${moment}: no new rows`);
				assert.equal(after.attachments.length, was.attachments.length);
				assert.deepEqual(after.uids, was.uids);
				assert.deepEqual(Object.keys(after.bytes), Object.keys(was.bytes), `${name} ${moment}: no new objects`);
			} finally {
				if (previous === undefined) delete process.env.BLUEPINE_DISABLED_FEATURES;
				else process.env.BLUEPINE_DISABLED_FEATURES = previous;
			}
		}
	}
});

// ---- G. Folder policy, spam training, Trash ------------------------------------------------------

test("a5.8 G: placement as MOVE's; Sent and Drafts refused as destinations, Drafts as a source, outbound mail as Spam", async (t) => {
	const context = await setup(t);
	await deliver(context, "m-1");
	await deliver(context, "sent-1", { values: { direction: "outbound", status: "sent", from_addr: "a@example.test", to_addr: "x@elsewhere.test" } });
	await deliver(context, "draft-1", { values: { direction: "outbound", status: "draft", from_addr: "a@example.test" } });
	const { client } = await connect(context);
	assertTagged(await client.command("SELECT INBOX"), "OK");
	const placements = { INBOX: ["received", null], Archive: ["archived", null], Trash: ["trash", null], Spam: ["spam", null], Work: ["received", "fld-work"] };
	for (const [name, [status, folderId]] of Object.entries(placements)) {
		assertTagged(await client.command(`COPY 1 ${name}`), "OK", /COPYUID/, name);
		const copy = copiesOf(context, "m-1").at(-1);
		assert.deepEqual([copy.status, copy.folder_id, copy.direction], [status, folderId, "inbound"], name);
	}
	// Product state only: SELECTing Drafts and Sent below creates their IMAP folder state (A3 bookkeeping).
	const product = async () => {
		const { messages, attachments, bytes } = JSON.parse(await snapshot(context));
		return JSON.stringify({ messages, attachments, bytes });
	};
	const before = await product();
	assertTagged(await client.command("COPY 1 Sent"), "NO", /^\S+ NO \[CANNOT\] Messages cannot be copied into Sent$/);
	assertTagged(await client.command("COPY 1 Drafts"), "NO", /^\S+ NO \[CANNOT\] Messages cannot be copied into Drafts$/);
	assertTagged(await client.command("SELECT Drafts"), "OK");
	assertTagged(await client.command("COPY 1 Archive"), "NO", /^\S+ NO \[CANNOT\] Drafts cannot be copied$/);
	assertTagged(await client.command("COPY 1 Drafts"), "NO", /\[CANNOT\]/);
	assertTagged(await client.command("SELECT Sent"), "OK");
	assertTagged(await client.command("COPY 1 Spam"), "NO", /^\S+ NO \[CANNOT\] Sent mail cannot be copied to Spam$/);
	assert.equal(await product(), before);
	// Sent mail may be copied elsewhere (it stays outbound), as MOVE allows.
	assertTagged(await client.command("COPY 1 Archive"), "OK", /COPYUID/);
	assert.deepEqual(copiesOf(context, "sent-1").map((row) => [row.status, row.direction]), [["archived", "outbound"]]);
	// Outbound mail is refused in Spam wherever it comes from (here a sent message filed in Archive).
	assertTagged(await client.command("SELECT Archive"), "OK");
	const archived = (await client.command("UID SEARCH ALL")).untagged[0].text.split(" ").slice(2).map(Number);
	const outboundUid = archived.at(-1);
	assertTagged(await client.command(`UID COPY ${outboundUid} Spam`), "NO", /Sent mail cannot be copied to Spam/);
});

test("a5.8 G: COPY never trains the spam filter; Trash copies are independent of their originals", async (t) => {
	const context = await setup(t);
	await deliver(context, "m-1", { subject: "cheap watches" });
	await deliver(context, "junk-1", { subject: "lottery winner", values: { status: "spam" } });
	await deliver(context, "trash-1", { subject: "old news", values: { status: "trash" } });
	const training = () => JSON.stringify([all(context, "SELECT * FROM spam_feedback ORDER BY rowid"), all(context, "SELECT * FROM spam_token_stats ORDER BY rowid").length]);
	const trainedBefore = training();
	const { client } = await connect(context);
	assertTagged(await client.command("SELECT INBOX"), "OK");
	assertTagged(await client.command("COPY 1 Spam"), "OK", /COPYUID/);
	assertTagged(await client.command("SELECT Spam"), "OK");
	assertTagged(await client.command("UID COPY 1 INBOX"), "OK", /COPYUID/);
	assert.equal(training(), trainedBefore, "neither spam nor ham was recorded");
	assert.ok(!client.logs.some((event) => /training/.test(event.event)));
	// Out of Trash: the original stays in Trash; into Trash: the source stays where it is.
	assertTagged(await client.command("SELECT Trash"), "OK");
	assertTagged(await client.command("COPY 1 INBOX"), "OK", /COPYUID/);
	assert.equal(one(context, "SELECT status FROM messages WHERE id = 'trash-1'").status, "trash");
	assert.deepEqual(copiesOf(context, "trash-1").map((row) => [row.status, row.folder_id]), [["received", null]]);
	assertTagged(await client.command("SELECT INBOX"), "OK");
	assertTagged(await client.command("COPY 1 Trash"), "OK");
	assert.equal(one(context, "SELECT status FROM messages WHERE id = 'm-1'").status, "received");
});

// ---- H. Atomicity --------------------------------------------------------------------------------

test("a5.8 H: object, database and UID failures commit nothing, remove the new objects and leave the source as it was", async (t) => {
	const context = await setup(t);
	await deliver(context, "m-1", { attachments: [["one.txt", "first"], ["two.txt", "second"]] });
	await deliver(context, "m-2", { attachments: [["three.txt", "third"]] });
	const { client } = await connect(context);
	assertTagged(await client.command("SELECT INBOX"), "OK");
	// The first read of a UID binds its canonical key and size (A3 bookkeeping, as for FETCH).
	assertTagged(await client.command("FETCH 1:* BODY.PEEK[]"), "OK");
	const before = await snapshot(context);
	const archiveBefore = () => folderState(context, "archive");
	await client.command("STATUS Archive (UIDNEXT)");
	const nextBefore = archiveBefore()?.uid_next ?? 1;
	const failures = {
		"raw object write": (key) => key.startsWith("copies/") && key.length > 0 && failures.count++ === 1,
		"attachment object write": (key) => key.endsWith("/three.txt"),
	};
	failures.count = 0;
	for (const [name, fails] of Object.entries(failures).filter(([name]) => name !== "count")) {
		const restore = hookPuts(t, context, (key) => {
			if (fails(key)) throw new Error("disk full");
		});
		assertTagged(await client.command("COPY 1:2 Archive"), "NO", /^\S+ NO \[UNAVAILABLE\] Temporary failure, try again later$/, name);
		restore();
		assert.equal(await snapshot(context).then((s) => JSON.parse(s).messages.length), JSON.parse(before).messages.length, name);
		assert.deepEqual(objects(context), Object.keys(JSON.parse(before).bytes).sort(), `${name}: every new object removed`);
	}
	for (const table of ["messages", "message_attachments", "imap_message_uids"]) {
		exec(context, `CREATE TRIGGER fail_copy BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'database failure'); END`);
		try {
			assertTagged(await client.command("COPY 1:2 Archive"), "NO", /\[UNAVAILABLE\]/, table);
		} finally {
			exec(context, "DROP TRIGGER fail_copy");
		}
		const after = JSON.parse(await snapshot(context));
		const was = JSON.parse(before);
		assert.equal(after.messages.length, was.messages.length, `${table}: no rows`);
		assert.equal(after.attachments.length, was.attachments.length);
		assert.deepEqual(after.uids, was.uids);
		assert.deepEqual(Object.keys(after.bytes), Object.keys(was.bytes), `${table}: objects removed`);
		assert.equal(archiveBefore()?.uid_next ?? 1, nextBefore, `${table}: UIDNEXT unchanged`);
	}
	// UIDNEXT exhausted in the destination: the batch fails as a whole.
	await client.command("STATUS Archive (UIDNEXT)");
	exec(context, "UPDATE imap_folders SET uid_next = 4294967295 WHERE folder_key = 'archive'");
	assertTagged(await client.command("COPY 1:2 Archive"), "NO", /\[UNAVAILABLE\]/, "only one UID left for two copies");
	assert.equal(JSON.parse(await snapshot(context)).messages.length, JSON.parse(before).messages.length);
	assert.deepEqual(objects(context), Object.keys(JSON.parse(before).bytes).sort());
	assertTagged(await client.command("NOOP"), "OK", undefined, "the session goes on");
});

test("a5.8 H: a source moved or expunged, or the destination deleted, before the commit: no copy at all", async (t) => {
	const cases = {
		"source moved by the web": (context) => exec(context, "UPDATE messages SET status = 'archived' WHERE id = 'm-2'"),
		"source deleted": (context) => exec(context, "DELETE FROM messages WHERE id = 'm-2'"),
		"destination deleted": (context) => exec(context, "DELETE FROM folders WHERE id = 'fld-dest'"),
		"destination renamed": (context) => exec(context, "UPDATE folders SET name = 'Renamed' WHERE id = 'fld-dest'"),
	};
	for (const [name, change] of Object.entries(cases)) {
		const context = await setup(t);
		exec(context, "INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-dest', 'user-a', 'mbx-a', 'Dest', 2)");
		for (const id of ["m-1", "m-2", "m-3"]) await deliver(context, id);
		const { client } = await connect(context);
		assertTagged(await client.command("SELECT INBOX"), "OK");
		const before = JSON.parse(await snapshot(context));
		const restore = hookPuts(t, context, (key, count) => {
			if (count === 3) change(context);
		});
		const result = await client.command("COPY 1:3 Dest");
		restore();
		if (name === "destination renamed") {
			assertTagged(result, "OK", /COPYUID/, "the destination is held by its id");
			assert.equal(all(context, "SELECT * FROM messages WHERE folder_id = 'fld-dest'").length, 3);
			continue;
		}
		assertTagged(result, "NO", name === "destination deleted" ? /^\S+ NO \[NONEXISTENT\]/ : /^\S+ NO Some of the requested messages no longer exist$/, name);
		const copies = all(context, "SELECT * FROM messages WHERE id NOT IN ('m-1', 'm-2', 'm-3')");
		assert.deepEqual(copies, [], `${name}: not even the copies of the sources still there`);
		assert.deepEqual(objects(context).filter((key) => key.startsWith("copies/")), [], `${name}: objects removed`);
		assert.equal(all(context, "SELECT * FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key != 'inbox'").length, 0);
		assert.ok(before);
	}
});

// ---- I. Deletion independence ------------------------------------------------------------------

async function jmap(context, methodCalls) {
	const { fullKey, prefix, hash } = app.generateApiKey();
	context.database.db.prepare("INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, created_at) VALUES (?, 'legacy', 'user-a', 'jmap', ?, ?, ?, 1)").run(`key-${++counter}`, prefix, hash, JSON.stringify(["jmap"]));
	const response = await app.handleJmapRequest(new Request(`${BASE}/jmap/api`, { method: "POST", headers: { Authorization: `Bearer ${fullKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls }) }), context.env);
	return (await response.json()).methodResponses;
}

test("a5.8 I: deleting either copy, through JMAP or IMAP, never touches the other's objects; deleting both removes everything", async (t) => {
	const context = await setup(t);
	await deliver(context, "m-1", { attachments: [["keep.pdf", "%PDF keep", "application/pdf"]] });
	const { client } = await connect(context);
	assertTagged(await client.command("SELECT INBOX"), "OK");
	assertTagged(await client.command("COPY 1 Archive"), "OK");
	const [copy] = copiesOf(context, "m-1");
	const sourceObjects = [one(context, "SELECT raw_r2_key AS k FROM messages WHERE id = 'm-1'").k, ...all(context, "SELECT r2_key AS k FROM message_attachments WHERE message_id = 'm-1'").map((row) => row.k)];
	const copyObjects = [copy.raw_r2_key, ...all(context, "SELECT r2_key AS k FROM message_attachments WHERE message_id = ?", copy.id).map((row) => row.k)];
	assert.equal(new Set([...sourceObjects, ...copyObjects]).size, 4, "no key is shared");
	// JMAP destroy (to Trash, then permanently: deleteMessageWithObjects) of the copy.
	await jmap(context, [["Email/set", { accountId: "user-a", destroy: [copy.id] }, "0"]]);
	await jmap(context, [["Email/set", { accountId: "user-a", destroy: [copy.id] }, "0"]]);
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages WHERE id = ?", copy.id).n, 0);
	for (const key of copyObjects) assert.equal(await context.env.BUCKET.get(key), null, `${key} removed with the copy`);
	for (const key of sourceObjects) assert.ok(await context.env.BUCKET.get(key), `${key} kept with the source`);
	const sourceBytes = (await client.command("FETCH 1 BODY.PEEK[]")).literals[0];
	assert.ok(sourceBytes.length > 0, "the source still FETCHes");
	// Another copy, then the source is deleted permanently over IMAP (to Trash, then EXPUNGE there).
	assertTagged(await client.command("COPY 1 Archive"), "OK");
	const [second] = copiesOf(context, "m-1");
	assertTagged(await client.command("MOVE 1 Trash"), "OK");
	assertTagged(await client.command("SELECT Trash"), "OK");
	assertTagged(await client.command("STORE 1 +FLAGS.SILENT (\\Deleted)"), "OK");
	assertTagged(await client.command("EXPUNGE"), "OK");
	await tick();
	for (const key of sourceObjects) assert.equal(await context.env.BUCKET.get(key), null, `${key} removed with the source`);
	assertTagged(await client.command("SELECT Archive"), "OK");
	assert.deepEqual((await client.command("FETCH 1 BODY.PEEK[]")).literals[0], sourceBytes, "the copy still FETCHes the same octets");
	// And the last one goes too: nothing of the message is left.
	await jmap(context, [["Email/set", { accountId: "user-a", destroy: [second.id] }, "0"]]);
	await jmap(context, [["Email/set", { accountId: "user-a", destroy: [second.id] }, "0"]]);
	assert.deepEqual(objects(context).filter((key) => key.startsWith("copies/") || key.startsWith("attachments/") || key.startsWith("inbound/")), []);
});

// ---- J. Cross-surface ----------------------------------------------------------------------------

test("a5.8 J: the copy is its own message for the web, JMAP, search, threads, counts, the revision and IDLE", async (t) => {
	const context = await setup(t);
	await deliver(context, "m-1", { subject: "Quarterly zebrafish report", values: { thread_id: "thr-z", read: 0 } });
	const clock = createClock();
	const { client: idler, session } = await connect(context, undefined, { now: clock.now, delay: clock.delay }, { random: () => 0.5 });
	clock.watch(session);
	assertTagged(await idler.command("SELECT Work"), "OK");
	idler.write("i1 IDLE\r\n");
	assert.equal((await idler.unit(1000)).text, "+ idling");
	await clock.advance(POLL);
	const revision = () => one(context, "SELECT revision FROM jmap_mailbox_revisions WHERE mailbox_id = 'mbx-a'")?.revision ?? 0;
	const revisionBefore = revision();
	const { client } = await connect(context);
	assertTagged(await client.command("SELECT INBOX"), "OK");
	assertTagged(await client.command("COPY 1 Work"), "OK");
	assert.ok(revision() > revisionBefore, "the mailbox revision moved");
	await clock.advance(POLL);
	assert.equal((await idler.unit(2000)).text, "* 1 EXISTS", "an IDLE session on the destination learns of it");
	idler.write("DONE\r\n");
	assertTagged(await idler.collect("i1", 2000), "OK");
	const [copy] = copiesOf(context, "m-1");
	// Web: both are listed, in one thread of two messages, and both count as unread.
	const token = await app.createSession(context.env, "user-a");
	const list = async (query) => (await (await app.messagesListRoute(new Request(`${BASE}/api/messages?mailboxId=mbx-a&${query}`, { headers: { Authorization: `Bearer ${token}` } }))).json());
	const plain = await list("limit=50");
	assert.deepEqual(plain.messages.map((row) => row.id).sort(), [copy.id, "m-1"].sort());
	const threaded = await list("group=thread&limit=50");
	assert.equal(threaded.messages.length, 1, "one conversation");
	assert.deepEqual([...(threaded.messages[0].threadMessageIds ?? [])].sort(), [copy.id, "m-1"].sort());
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = 'mbx-a' AND read = 0").n, 2);
	// JMAP: two Email objects in two mailboxes; search finds both.
	const [[, got]] = await jmap(context, [["Email/get", { accountId: "user-a", ids: ["m-1", copy.id], properties: ["subject", "mailboxIds", "threadId"] }, "0"]]);
	assert.equal(got.list.length, 2);
	assert.deepEqual(got.list.map((email) => Object.keys(email.mailboxIds)[0]).sort(), [app.encodeMailboxRef({ kind: "role", mailboxId: "mbx-a", role: "inbox" }), app.encodeMailboxRef({ kind: "folder", mailboxId: "mbx-a", folderId: "fld-work" })].sort());
	assert.equal(one(context, "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'zebrafish'").n, 2, "both are indexed");
	assert.match(texts(await client.command("STATUS Work (MESSAGES UNSEEN)"))[0], /MESSAGES 1 UNSEEN 1/);
});

// ---- K. Concurrency ------------------------------------------------------------------------------

test("a5.8 K: concurrent COPYs make independent copies; a STORE before the commit is copied live", async (t) => {
	const context = await setup(t);
	await deliver(context, "m-1");
	const a = await connect(context);
	const b = await connect(context);
	for (const { client } of [a, b]) assertTagged(await client.command("SELECT INBOX"), "OK");
	const [first, second, other] = await Promise.all([a.client.command("COPY 1 Archive"), b.client.command("COPY 1 Archive"), a.client.command("COPY 1 Trash")]);
	for (const result of [first, second, other]) assertTagged(result, "OK", /COPYUID/);
	assert.deepEqual([copyUid(first).destination, copyUid(second).destination].sort(), ["1", "2"]);
	assert.equal(copyUid(other).destination, "1");
	assert.equal(copiesOf(context, "m-1").length, 3);
	// A STORE between the object writes and the commit: the copy has the live flags.
	const restore = hookPuts(t, context, () => exec(context, "UPDATE messages SET starred = 1, read = 1 WHERE id = 'm-1'"));
	assertTagged(await a.client.command("COPY 1 Work"), "OK");
	restore();
	const live = copiesOf(context, "m-1").find((row) => row.folder_id === "fld-work");
	assert.deepEqual([live.starred, live.read], [1, 1]);
	// IMAP MOVE and EXPUNGE racing a COPY are covered by the vanished-source cases (H); here, a MOVE from another session.
	const restoreMove = hookPuts(t, context, async () => {
		restoreMove();
		assertTagged(await b.client.command("MOVE 1 Archive"), "OK");
	});
	assertTagged(await a.client.command("COPY 1 Spam"), "NO", /no longer exist/);
	assert.equal(copiesOf(context, "m-1").filter((row) => row.status === "spam").length, 0);
});

// ---- L. Resources --------------------------------------------------------------------------------

test("a5.8 L: 1000 messages in one COPY with a fragmented COPYUID; 1001 refused before any work", async (t) => {
	const context = await setup(t);
	const insert = context.database.db.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, raw_r2_key, created_at, provider_message_id) VALUES (?, 'user-a', 'mbx-a', 'inbound', 'x@elsewhere.test', 'a@example.test', ?, 'received', ?, ?, ?)");
	for (let index = 1; index <= 2001; index += 1) {
		const id = `bulk-${String(index).padStart(4, "0")}`;
		await context.env.BUCKET.put(`inbound/${id}.eml`, new TextEncoder().encode(`Subject: ${index}\r\n\r\nbody ${index}\r\n`));
		insert.run(id, `n${index}`, `inbound/${id}.eml`, 1790000000 + index, `<${id}@elsewhere.test>`);
	}
	const permits = countingPermits();
	const { client } = await connect(context, undefined, { acquireRead: permits.acquire });
	assertTagged(await client.command("SELECT INBOX"), "OK");
	const writes = { count: 0 };
	const restore = hookPuts(t, context, () => {
		writes.count += 1;
	});
	assertTagged(await client.command("UID COPY 1:1001 Archive"), "NO", /^\S+ NO \[LIMIT\] At most 1000 messages can be copied at once$/);
	assert.equal(writes.count, 0, "refused before any object was written");
	assert.equal(permits.granted, 0);
	// 1000 every-other UIDs: a fully fragmented source set, a contiguous destination.
	const uids = Array.from({ length: 1000 }, (_, index) => index * 2 + 1).join(",");
	const started = Date.now();
	const result = await client.command(`UID COPY ${uids} Archive`, { timeoutMs: 120_000 });
	restore();
	assertTagged(result, "OK", /\[COPYUID \d+ [\d,]+ 1:1000\] UID COPY completed/);
	assert.equal(writes.count, 1000);
	assert.equal(copyUid(result).source, uids);
	t.diagnostic(`1000-message COPY: ${Date.now() - started} ms; tagged answer ${result.tagged.length} octets`);
	assert.ok(result.tagged.length < 12_000, "the fragmented COPYUID stays bounded");
	assert.equal(permits.peak, 1, "one message at a time under one content permit");
	assert.equal(permits.held, 0);
	assert.equal(permits.granted, 1000);
	assert.equal(all(context, "SELECT 1 FROM messages WHERE status = 'archived'").length, 1000);
});

test("a5.8 L: the byte cap stops a COPY midway and removes what it wrote; many attachments copy", async (t) => {
	const context = await setup(t);
	const many = Array.from({ length: 10 }, (_, index) => [`file-${index}.txt`, `content ${index}`]);
	await deliver(context, "m-1", { attachments: many });
	await deliver(context, "m-2", { attachments: [["huge.bin", "placeholder"]] });
	const { client } = await connect(context);
	assertTagged(await client.command("SELECT INBOX"), "OK");
	assertTagged(await client.command("COPY 1 Archive"), "OK");
	assert.equal(all(context, "SELECT * FROM message_attachments WHERE message_id = ?", copiesOf(context, "m-1")[0].id).length, 10);
	const before = objects(context);
	// m-2's attachment reads as 257 MiB: the cap is crossed after m-1's objects were written.
	const bucket = context.env.BUCKET;
	const get = bucket.get.bind(bucket);
	const huge = one(context, "SELECT r2_key AS k FROM message_attachments WHERE message_id = 'm-2'").k;
	bucket.get = async (key, options) => (key === huge ? { arrayBuffer: async () => new ArrayBuffer(257 * 1024 * 1024), size: 257 * 1024 * 1024 } : get(key, options));
	t.after(() => (bucket.get = get));
	assertTagged(await client.command("COPY 1:2 Trash"), "NO", /^\S+ NO \[LIMIT\] At most 268435456 octets can be copied at once$/);
	bucket.get = get;
	assert.deepEqual(objects(context), before, "every object written before the cap was removed");
	assert.equal(all(context, "SELECT * FROM messages WHERE status = 'trash'").length, 0);
	assert.equal(app.imapUtils.MAX_COPY_MESSAGES, 1000);
	assert.equal(app.imapUtils.MAX_COPY_BYTES, 256 * 1024 * 1024);
});

test("a5.8 L: a source without stored octets fails the whole COPY; nothing generated is stored", async (t) => {
	const context = await setup(t);
	await deliver(context, "m-1");
	await deliver(context, "m-2");
	const { client } = await connect(context);
	assertTagged(await client.command("SELECT INBOX"), "OK");
	await context.env.BUCKET.delete("inbound/m-2.eml");
	assertTagged(await client.command("COPY 1:2 Archive"), "NO", /\[UNAVAILABLE\]/);
	assert.equal(messageRows(context).length, 2);
	assert.deepEqual(objects(context).filter((key) => key.startsWith("copies/")), []);
});

test("a5.8 L: COPY's column lists cover the messages table exactly", async (t) => {
	const context = await setup(t);
	const columns = all(context, "PRAGMA table_info(messages)").map((row) => row.name).sort();
	assert.deepEqual([...app.imapState.COPY_COPIED_COLUMNS, ...app.imapState.COPY_SET_COLUMNS].sort(), columns, "a new messages column needs a decision: copied or set by COPY");
});

// ---- Real Node TLS listener ------------------------------------------------------------------------

test("a5.8 TLS: COPY, UID COPY, ranges and same-mailbox COPY over TLS; exact octets; EXISTS; IDLE on the destination", async (t) => {
	const context = await setup(t);
	await deliver(context, "m-1", { attachments: [["a.pdf", "%PDF-1.4 x", "application/pdf"]] });
	await deliver(context, "m-2");
	await deliver(context, "m-3");
	const certificate = makeCertificate(t);
	const config = { port: 0, host: "127.0.0.1", certPath: certificate.certPath, keyPath: certificate.keyPath };
	const listener = await app.startImapListener(context.env, config, app.loadTlsMaterial(config), { limits: { accessCheckIntervalMs: 60_000, idlePollMs: 60, idlePollJitter: 0, idleKeepaliveMs: 60_000 }, log: () => {} });
	t.after(() => listener.close());
	const { credential } = await context.credential("user-a", "mbx-a");
	const open = async () => {
		const client = await tlsClient(listener.port);
		await client.unit();
		assertTagged(await client.login("a@example.test", credential), "OK");
		return client;
	};
	const idler = await open();
	assertTagged(await idler.command("SELECT Archive"), "OK");
	idler.write("i1 IDLE\r\n");
	assert.equal((await idler.unit(2000)).text, "+ idling");
	const client = await open();
	assertTagged(await client.command("SELECT INBOX"), "OK");
	const sourceBytes = (await client.command("FETCH 1 BODY.PEEK[]")).literals[0];
	assertTagged(await client.command("COPY 1 Archive"), "OK", /\[COPYUID \d+ 1 1\] COPY completed/);
	assert.equal((await idler.unit(3000)).text, "* 1 EXISTS", "IDLE on the destination sees the copy");
	idler.write("DONE\r\n");
	assertTagged(await idler.collect("i1"), "OK");
	assertTagged(await client.command("UID COPY 2:3 Archive"), "OK", /\[COPYUID \d+ 2:3 2:3\] UID COPY completed/);
	const same = await client.command("COPY 2 INBOX");
	assert.deepEqual(texts(same), ["* 4 EXISTS"]);
	assertTagged(same, "OK", /\[COPYUID \d+ 2 4\] COPY completed/);
	assert.deepEqual((await client.command("FETCH 1 BODY.PEEK[]")).literals[0], sourceBytes, "the source is still there");
	assertTagged(await client.command("SELECT Archive"), "OK");
	assert.deepEqual((await client.command("UID FETCH 1 BODY.PEEK[]")).literals[0], sourceBytes, "the copy is byte-identical");
	assert.equal(texts(await client.command("UID SEARCH ALL"))[0], "* SEARCH 1 2 3");
});
