/**
 * Certification of the A3 IMAP state layer on the Workers runtime: bundles
 * src/lib/imap/ into a Worker, runs it in workerd (Miniflare) with real D1 and R2
 * bindings, and exercises migrations, concurrent first access and delivery, deletion,
 * canonical bytes, batched flag writes (A5.1), bp0003's \Deleted invariant, \Deleted and
 * recoverable EXPUNGE (A5.2a), MOVE and its spam training (A5.2b), bp0004 and permanent
 * EXPUNGE in Trash and Drafts over D1 and R2 (A5.2c), UID EXPUNGE and MOVE's destination UIDs
 * for COPYUID (A5.3), IDLE's change signal (A5.4), the database guards, backup/restore and a
 * restart.
 *
 *   node scripts/imap-state-d1-check.mjs
 *
 * D1 runs statements through its SQL authorizer and serializes writes differently from
 * the Node SQLite wrapper that tests/imap-state.test.mjs uses, so both are checked. No
 * running dev server or Cloudflare account is needed.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const generated = spawnSync(process.execPath, [join(root, "scripts", "generate-migration-bundle.mjs")], { encoding: "utf8" });
if (generated.status !== 0) throw new Error(`generate-migration-bundle failed: ${generated.stderr}`);

const worker = `
import * as imap from "./src/lib/imap/service.ts";
import * as state from "./src/lib/imap/state.ts";
import * as spam from "./src/lib/spam/feedback.ts";
import { cleanupDeletedMessageObjects } from "./src/lib/imap/cleanup.ts";
import * as folderManagement from "./src/lib/mailboxes/folder-management.ts";
import { sql as drizzleSql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { getDb } from "./src/db/index.ts";
import { applyPendingMigrations } from "./src/lib/migrations/service.ts";
import { exportDatabaseRecords, restoreDatabaseRecords } from "./src/lib/backups/export.ts";

async function sha256(bytes) {
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
	async fetch(request, env) {
		const { op, args = [] } = await request.json();
		try {
			if (op === "migrate") return Response.json(await applyPendingMigrations(env.DB));
			if (op === "sql") {
				const results = [];
				for (const [query, ...params] of args) results.push((await env.DB.prepare(query).bind(...params).all()).results);
				return Response.json(results);
			}
			if (op === "deliverAndEnsure") {
				const [id, principal] = args;
				await env.DB.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES (?, 'user-a', 'mbx-a', 'inbound', 's@x', 'a@example.test', 'received', 5000)").bind(id).run();
				return Response.json(await imap.ensureImapUid(env, principal, "inbox", id));
			}
			if (op === "fetch") {
				const result = await imap.fetchImapMessage(env, ...args);
				return Response.json(result && { uid: result.uid, size: result.size, length: result.bytes.byteLength, sha: await sha256(result.bytes), source: result.source });
			}
			if (op === "store") {
				const result = await imap.storeImapFlags(env, ...args);
				return Response.json(Object.fromEntries(result));
			}
			if (op === "relocate") {
				const [mailboxId, sourceKey, destinationKey, target, uids, guards] = args;
				const db = getDb(env);
				const source = await state.findFolderRow(db, mailboxId, sourceKey);
				const destination = await state.ensureFolderRow(db, mailboxId, destinationKey);
				return Response.json(await state.relocateImapMessages(db, mailboxId, { folder: source, key: sourceKey }, { folder: destination, key: destinationKey }, target, uids, guards));
			}
			if (op === "permanent") {
				const [mailboxId, key, uids, maxUid, authority] = args;
				const db = getDb(env);
				const folder = await state.findFolderRow(db, mailboxId, key);
				// Every bound parameter count D1 sees, to certify they stay under its limit of 100.
				const counts = [];
				const client = db.$client;
				const prepare = client.prepare;
				client.prepare = function (query) {
					const statement = prepare.call(client, query);
					const bind = statement.bind;
					statement.bind = function (...values) {
						counts.push(values.length);
						return bind.apply(statement, values);
					};
					return statement;
				};
				try {
					return Response.json({ ...(await state.deleteImapMessagesPermanently(db, { folder, key }, uids, maxUid, authority)), counts });
				} finally {
					client.prepare = prepare;
				}
			}
			if (op === "cleanup") return Response.json(await cleanupDeletedMessageObjects(env, getDb(env), args[0]));
			if (op.startsWith("folders.")) return Response.json(await folderManagement[op.slice("folders.".length)](getDb(env), ...args));
			if (op === "folderGuard") {
				// R-1's in-SQL management authority, evaluated on D1 as the guarded writes embed it.
				const [actor, mailboxId] = args;
				const query = new SQLiteAsyncDialect().sqlToQuery(drizzleSql\`SELECT CASE WHEN \${folderManagement.managementGuard(actor, mailboxId)} THEN 1 ELSE 0 END AS allowed\`);
				return Response.json((await env.DB.prepare(query.sql).bind(...query.params).first()).allowed === 1);
			}
			if (op === "applySpamFeedback") return Response.json(await spam.applySpamFeedback(env, ...args));
			if (op === "recordSpamTraining") return Response.json(await spam.recordSpamTraining(env, ...args));
			if (op === "roundTrip") {
				const document = await exportDatabaseRecords(env.DB);
				await restoreDatabaseRecords(env.DB, document.buffer.slice(document.byteOffset, document.byteOffset + document.byteLength));
				return Response.json(true);
			}
			return Response.json(await imap[op](env, ...args));
		} catch (error) {
			return Response.json({ error: String(error?.cause?.message ?? error?.message ?? error), code: error?.code ?? null }, { status: 500 });
		}
	},
};
`;

const outDirectory = mkdtempSync(join(root, "node_modules", "mailflare-imap-d1-"));
const persist = mkdtempSync(join(tmpdir(), "mailflare-imap-d1-persist-"));
await build({
	stdin: { contents: worker, resolveDir: root, sourcefile: "imap-d1-worker.ts", loader: "ts" },
	outdir: outDirectory,
	bundle: true,
	format: "esm",
	platform: "browser",
	conditions: ["workerd", "worker", "browser"],
	target: "es2022",
	tsconfig: join(root, "tsconfig.json"),
	external: ["node:*", "cloudflare:*"],
	logLevel: "silent",
});
const script = readFileSync(join(outDirectory, readdirSync(outDirectory).find((name) => name.endsWith(".js"))), "utf8");

function start() {
	return new Miniflare({
		resourcePersistencePath: persist,
		workers: [{
			config: {
				name: "imap-d1-check",
				compatibilityDate: "2026-09-01",
				compatibilityFlags: ["nodejs_compat"],
				manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: script } } },
				env: { DB: { type: "d1", id: "imap-db" }, BUCKET: { type: "r2", name: "imap-bucket" } },
			},
		}],
	});
}

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
	if (ok) passed += 1;
	else failed += 1;
	console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

let mf = start();
const op = async (name, ...args) => {
	const response = await mf.dispatchFetch("http://imap.check/", { method: "POST", body: JSON.stringify({ op: name, args }) });
	return response.json();
};
const sql = async (...queries) => op("sql", ...queries);
const owner = { userId: "user-a", mailboxId: "mbx-a" };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
	console.log("Migrations (Workers runner on D1)");
	const migrated = await op("migrate");
	const migrationFiles = readdirSync(join(root, "drizzle", "migrations")).filter((name) => name.endsWith(".sql"));
	check("every migration applies, bp0004 last", migrated.ready && migrated.applied.length === migrationFiles.length && migrated.applied.at(-1) === "bp0004_release_imap_draft_uid_on_content_change.sql", migrated);
	check(`${migrationFiles.length} migrations: ${migrationFiles.filter((name) => /^\d/.test(name)).length} upstream + ${migrationFiles.filter((name) => name.startsWith("bp")).length} Blue Pine`, migrationFiles.length === 52 && migrationFiles.filter((name) => name.startsWith("bp")).length === 4);
	const onMessages = (await sql(["SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'messages' AND name LIKE 'bp%' ORDER BY name"]))[0];
	check("bp0003's and bp0004's triggers are the only Blue Pine triggers on messages", onMessages.length === 2 && onMessages[0].name === "bp_imap_draft_content_releases_uid" && onMessages[1].name === "bp_imap_membership_clears_deleted" && /AFTER UPDATE OF `mailbox_id`, `status`, `folder_id` ON `messages`/.test(onMessages[1].sql) && /`in_reply_to`, `references_header` ON `messages`/.test(onMessages[0].sql), onMessages);
	const onAttachments = (await sql(["SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'message_attachments' AND name LIKE 'bp%' ORDER BY name"]))[0].map((row) => row.name);
	check("bp0004's attachment triggers are installed on message_attachments", same(onAttachments, ["bp_imap_draft_attachment_added_releases_uid", "bp_imap_draft_attachment_removed_releases_uid"]), onAttachments);
	check("a second run applies nothing", (await op("migrate")).applied.length === 0);

	await sql(
		["INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('user-a', 'a@example.test', 'h', 'A', 'admin', 1), ('user-b', 'b@example.test', 'h', 'B', 'user', 1)"],
		["INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-a', 'example.test', 'manual', 'active', 1)"],
		["INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mbx-a', 'user-a', 'domain-1', 'a', 'personal', 1), ('mbx-s', 'user-a', 'domain-1', 'sales', 'shared', 1)"],
		["INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('acc-b', 'mbx-s', 'user-b', 'read_only', 1)"],
		["WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 599) INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) SELECT printf('m-%04d', i), 'user-a', 'mbx-a', 'inbound', 's@x', 'a@example.test', 'received', 1000 + (i % 37) FROM n"],
	);

	console.log("Concurrent first access (600 existing messages, chunked assignment)");
	const expected = (await sql(["SELECT id FROM messages ORDER BY created_at, id"]))[0].map((row) => row.id);
	const firsts = await Promise.all(Array.from({ length: 8 }, () => op("openImapFolder", owner, "inbox")));
	check("eight simultaneous first reads agree", firsts.every((snapshot) => same(snapshot.messages.map((entry) => [entry.uid, entry.messageId]), firsts[0].messages.map((entry) => [entry.uid, entry.messageId]))));
	check("UIDs 1..600 in created_at/id order", same(firsts[0].messages.map((entry) => entry.messageId), expected) && firsts[0].messages.every((entry, index) => entry.uid === index + 1));
	check("UIDNEXT 601, UIDVALIDITY nonzero 32-bit", firsts[0].uidNext === 601 && firsts[0].uidValidity > 0 && firsts[0].uidValidity <= 0xffffffff, firsts[0].uidNext);

	console.log("Concurrent delivery, deletion and enumeration");
	const tasks = [];
	for (let index = 0; index < 40; index += 1) {
		tasks.push(op("deliverAndEnsure", `n-${index}`, owner));
		if (index % 4 === 0) tasks.push(op("openImapFolder", owner, "inbox").then(() => null));
		if (index % 5 === 0) tasks.push(sql(["DELETE FROM messages WHERE id = ?", expected[index]]).then(() => null));
	}
	const uids = (await Promise.all(tasks)).filter((value) => value !== null);
	check("40 deliveries got 40 distinct UIDs above 600", uids.length === 40 && new Set(uids).size === 40 && uids.every((uid) => Number.isInteger(uid) && uid > 600), uids);
	const after = await op("openImapFolder", owner, "inbox");
	const afterUids = after.messages.map((entry) => entry.uid);
	check("UIDNEXT 641 after 40 assignments; deletions never lower it", after.uidNext === 641, after.uidNext);
	check("enumeration strictly ascending, no duplicates", afterUids.every((uid, index) => index === 0 || uid > afterUids[index - 1]));
	check("deleted messages are expunged", after.messages.length === 600 + 40 - 8, after.messages.length);
	const duplicates = (await sql(["SELECT imap_folder_id, uid, COUNT(*) AS n FROM imap_message_uids GROUP BY imap_folder_id, uid HAVING n > 1"]))[0];
	check("no duplicate (folder, uid) rows", duplicates.length === 0);

	console.log("Moves and independent folders");
	await sql(["UPDATE messages SET status = 'trash' WHERE id = 'n-0'"]);
	const trash = await op("openImapFolder", owner, "trash");
	const inboxAfterMove = await op("openImapFolder", owner, "inbox");
	check("moved message gets Trash UID 1 and leaves INBOX", same(trash.messages.map((entry) => [entry.uid, entry.messageId]), [[1, "n-0"]]) && !inboxAfterMove.messages.some((entry) => entry.messageId === "n-0"));
	await sql(["UPDATE messages SET status = 'received' WHERE id = 'n-0'"]);
	check("moving back assigns a new INBOX UID", (await op("ensureImapUid", owner, "inbox", "n-0")) === 641);

	console.log("Canonical bytes over R2");
	const bucket = await mf.getR2Bucket("BUCKET");
	const raw = "From: =?UTF-8?B?w5xtbMOkdXQ=?= <s@x>\r\nSubject: café\r\n\r\nünïcode ✓\r\n";
	const bytes = new TextEncoder().encode(raw);
	await bucket.put("inbound/d1.eml", bytes);
	await sql(["INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, raw_r2_key, created_at) VALUES ('raw-1', 'user-a', 'mbx-a', 'inbound', 's@x', 'a@example.test', 'received', 'inbound/d1.eml', 9000)"]);
	const rawUid = await op("ensureImapUid", owner, "inbox", "raw-1");
	const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
	const fetched = await op("fetch", owner, "inbox", rawUid);
	const again = await op("fetch", owner, "inbox", rawUid);
	check("fetch returns the original bytes", fetched?.sha === digest && fetched.source === "original", fetched);
	check("RFC822.SIZE equals the octet length", fetched?.size === bytes.byteLength && fetched.length === bytes.byteLength && again.sha === fetched.sha);
	check("recorded size matches", (await op("getImapMessageSize", owner, "inbox", rawUid)) === bytes.byteLength);

	console.log("Database guards on D1");
	const guards = await sql(["SELECT id, uid_next FROM imap_folders WHERE folder_key = 'inbox'"]);
	const folderId = guards[0][0].id;
	const lower = await op("sql", ["UPDATE imap_folders SET uid_next = 2 WHERE id = ?", folderId]);
	check("lowering UIDNEXT is rejected", /cannot decrease/.test(lower.error ?? ""), lower);
	const reassign = await op("sql", ["UPDATE imap_message_uids SET uid = 99999 WHERE imap_folder_id = ? AND uid = (SELECT MIN(uid) FROM imap_message_uids WHERE imap_folder_id = ?)", folderId, folderId]);
	check("reassigning a UID is rejected", /cannot be reassigned/.test(reassign.error ?? ""), reassign);

	console.log("Batched flag writes (A5.1)");
	const revision = async () => Number((await sql(["SELECT revision FROM jmap_mailbox_revisions WHERE mailbox_id = 'mbx-a'"]))[0][0]?.revision ?? 0);
	const inboxNow = await op("openImapFolder", owner, "inbox");
	const firstUids = inboxNow.messages.slice(0, 200).map((entry) => entry.uid);
	const beforeStore = await revision();
	const seenAll = await op("store", owner, "inbox", firstUids, { mode: "add", flags: ["seen"] });
	check("+FLAGS \\Seen over 200 UIDs (three chunks) returns every UID seen", firstUids.every((uid) => seenAll[uid]?.seen === true), Object.keys(seenAll).length);
	// The snapshot is in UID order, so these are exactly the UIDs up to the 200th.
	const unread = (await sql(["SELECT COUNT(*) AS n FROM messages m JOIN imap_message_uids u ON u.message_id = m.id JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.mailbox_id = 'mbx-a' AND f.folder_key = 'inbox' AND u.uid <= ? AND m.read = 0", firstUids.at(-1)]))[0][0].n;
	check("messages.read is set for all of them", unread === 0, unread);
	const afterStore = await revision();
	check("the product revision moved", afterStore > beforeStore, [beforeStore, afterStore]);
	await op("store", owner, "inbox", firstUids, { mode: "add", flags: ["seen"] });
	check("a no-op STORE writes nothing", (await revision()) === afterStore);
	const [one] = firstUids;
	const replaced = await op("store", owner, "inbox", [one], { mode: "replace", flags: ["flagged"] });
	check("FLAGS (\\Flagged) replaces: flagged, not seen", replaced[one]?.flagged === true && replaced[one]?.seen === false, replaced);
	const removed = await op("store", owner, "inbox", [one], { mode: "remove", flags: ["flagged"] });
	check("-FLAGS clears", removed[one]?.flagged === false, removed);
	const movedEntry = inboxNow.messages[1];
	await sql(["UPDATE messages SET status = 'archived', starred = 0 WHERE id = ?", movedEntry.messageId]);
	const stale = await op("store", owner, "inbox", [movedEntry.uid], { mode: "add", flags: ["flagged"] });
	const movedRow = (await sql(["SELECT starred FROM messages WHERE id = ?", movedEntry.messageId]))[0][0];
	check("a UID whose message moved away changes nothing and reads null", stale[movedEntry.uid] === null && movedRow.starred === 0, [stale, movedRow]);
	await sql(["INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, read, created_at) VALUES ('out-d1', 'user-a', 'mbx-a', 'outbound', 'a@example.test', 'b@x', 'sent', 1, 9500)"]);
	const sentUid = await op("ensureImapUid", owner, "sent", "out-d1");
	const unseenSent = await op("store", owner, "sent", [sentUid], { mode: "remove", flags: ["seen"] });
	check("clearing \\Seen on outbound mail leaves it seen and unwritten", unseenSent[sentUid]?.seen === true && (await sql(["SELECT read FROM messages WHERE id = 'out-d1'"]))[0][0].read === 1, unseenSent);
	await op("openImapFolder", { userId: "user-b", mailboxId: "mbx-s" }, "inbox");
	check("\\Deleted for a read-only delegate is denied", (await op("store", { userId: "user-b", mailboxId: "mbx-s" }, "inbox", [1], { mode: "add", flags: ["deleted"] })).code === "denied");
	check("\\Seen for a read-only delegate is allowed", typeof (await op("store", { userId: "user-b", mailboxId: "mbx-s" }, "inbox", [1], { mode: "add", flags: ["seen"] })).error === "undefined");

	console.log("bp0003: \\Deleted cleared on membership change (D1)");
	await sql(
		["INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-d1', 'user-a', 'mbx-a', 'D1 folder', 1)"],
		["INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES ('t-1', 'user-a', 'mbx-a', 'inbound', 's@x', 'a@example.test', 'received', 9600)"],
	);
	const tUid = await op("ensureImapUid", owner, "inbox", "t-1");
	const markT = () => op("store", owner, "inbox", [tUid], { mode: "add", flags: ["deleted"] });
	const tDeleted = async () => (await sql(["SELECT u.deleted FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key = 'inbox' AND f.mailbox_id = 'mbx-a' AND u.message_id = 't-1'"]))[0][0]?.deleted;
	check("owner STORE +FLAGS \\Deleted sets it", (await markT())[tUid]?.deleted === true && (await tDeleted()) === 1);
	await sql(["UPDATE messages SET read = 1 WHERE id = 't-1'"]);
	check("a read change leaves \\Deleted", (await tDeleted()) === 1);
	await sql(["UPDATE messages SET starred = 1 WHERE id = 't-1'"]);
	check("a starred change leaves \\Deleted", (await tDeleted()) === 1);
	await sql(["UPDATE messages SET status = 'archived' WHERE id = 't-1'"], ["UPDATE messages SET status = 'received' WHERE id = 't-1'"]);
	check("leaving INBOX and returning before any IMAP sync does not resurrect \\Deleted", (await tDeleted()) === 0 && (await op("resolveImapUid", owner, "inbox", tUid))?.flags?.deleted === false);
	await markT();
	await sql(["UPDATE messages SET status = 'spam' WHERE id = 't-1'"]);
	check("a status change clears \\Deleted", (await tDeleted()) === 0);
	await sql(["UPDATE messages SET status = 'received' WHERE id = 't-1'"]);
	await markT();
	await sql(["UPDATE messages SET folder_id = 'fld-d1' WHERE id = 't-1'"]);
	check("a direct move to a custom folder clears \\Deleted", (await tDeleted()) === 0);
	const fUid = await op("ensureImapUid", owner, "f:fld-d1", "t-1");
	await op("store", owner, "f:fld-d1", [fUid], { mode: "add", flags: ["deleted"] });
	await sql(["DELETE FROM folders WHERE id = 'fld-d1'"]);
	const fDeleted = (await sql(["SELECT u.deleted FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key = 'f:fld-d1' AND u.message_id = 't-1'"]))[0][0]?.deleted;
	check("deleting the custom folder (foreign key sets folder_id NULL) clears \\Deleted", fDeleted === 0 && (await sql(["SELECT folder_id FROM messages WHERE id = 't-1'"]))[0][0].folder_id === null, fDeleted);
	await markT();
	await sql(["UPDATE messages SET mailbox_id = 'mbx-s' WHERE id = 't-1'"], ["UPDATE messages SET mailbox_id = 'mbx-a' WHERE id = 't-1'"]);
	check("a mailbox change clears \\Deleted", (await tDeleted()) === 0);

	console.log("\\Deleted and recoverable EXPUNGE (A5.2a, D1)");
	check("owner may set \\Deleted in every folder, Trash and Drafts included (A5.2c)", (await op("listImapMailboxes", owner)).every((mailbox) => mailbox.permanentFlags.includes("deleted")));
	await op("openImapFolder", owner, "trash");
	check("EXPUNGE for a read-only delegate is denied", (await op("expungeImapFolder", { userId: "user-b", mailboxId: "mbx-s" }, "inbox", 1000)).code === "denied");
	await sql(["UPDATE messages SET read = 1, starred = 1 WHERE id = 'raw-1'"]);
	await op("store", owner, "inbox", [rawUid], { mode: "add", flags: ["deleted"] });
	const trashNextBefore = (await op("openImapFolder", owner, "trash")).uidNext;
	const inboxBefore = await op("openImapFolder", owner, "inbox");
	const moved = await op("expungeImapFolder", owner, "inbox", inboxBefore.uidNext - 1);
	const rawRow = (await sql(["SELECT status, folder_id, read, starred, created_at, raw_r2_key FROM messages WHERE id = 'raw-1'"]))[0][0];
	check("EXPUNGE moves exactly the \\Deleted message to Trash", same(moved, [rawUid]) && rawRow.status === "trash" && rawRow.folder_id === null, [moved, rawRow]);
	check("read, starred, date and stored object are kept", rawRow.read === 1 && rawRow.starred === 1 && rawRow.created_at === 9000 && rawRow.raw_r2_key === "inbound/d1.eml" && !!(await bucket.get("inbound/d1.eml")));
	const trashAfter = await op("openImapFolder", owner, "trash");
	const trashEntry = trashAfter.messages.find((entry) => entry.messageId === "raw-1");
	check("Trash UID from UIDNEXT, without \\Deleted", trashEntry?.uid === trashNextBefore && trashEntry.flags.deleted === false && trashAfter.uidNext === trashNextBefore + 1, trashEntry);
	const trashFetch = await op("fetch", owner, "trash", trashEntry.uid);
	check("canonical bytes and RFC822.SIZE unchanged in Trash", trashFetch?.sha === digest && trashFetch.size === bytes.byteLength, trashFetch);
	check("a repeated EXPUNGE moves nothing", same(await op("expungeImapFolder", owner, "inbox", inboxBefore.uidNext - 1), []));
	const concurrentIds = Array.from({ length: 12 }, (_, index) => `c-${index}`);
	await sql(...concurrentIds.map((id) => [`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES ('${id}', 'user-a', 'mbx-a', 'inbound', 's@x', 'a@example.test', 'received', 9700)`]));
	const concurrentUids = [];
	for (const id of concurrentIds) concurrentUids.push(await op("ensureImapUid", owner, "inbox", id));
	await op("store", owner, "inbox", concurrentUids, { mode: "add", flags: ["deleted"] });
	const maxUid = Math.max(...concurrentUids);
	const racing = await Promise.all([op("expungeImapFolder", owner, "inbox", maxUid), op("expungeImapFolder", owner, "inbox", maxUid)]);
	const trashRows = (await sql(["SELECT u.message_id, COUNT(*) AS n FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.mailbox_id = 'mbx-a' AND f.folder_key = 'trash' AND u.message_id LIKE 'c-%' GROUP BY u.message_id"]))[0];
	check("two concurrent EXPUNGEs move each message exactly once", racing.every(Array.isArray) && trashRows.length === 12 && trashRows.every((row) => row.n === 1) && (await sql(["SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'c-%' AND status = 'trash'"]))[0][0].n === 12, racing);
	// Full chunks: 90 UIDs are two STORE chunks and two relocation batches (80 + 10), each statement within D1's 100 bound parameters.
	await sql(["WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 89) INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) SELECT printf('k-%02d', i), 'user-a', 'mbx-a', 'inbound', 's@x', 'a@example.test', 'received', 9750 FROM n"]);
	const bigInbox = await op("openImapFolder", owner, "inbox");
	const bigUids = bigInbox.messages.filter((entry) => entry.messageId.startsWith("k-")).map((entry) => entry.uid);
	const bigStore = await op("store", owner, "inbox", bigUids, { mode: "add", flags: ["seen", "deleted"] });
	check("STORE +FLAGS (\\Seen \\Deleted) over 90 UIDs (two chunks) on D1", bigUids.length === 90 && bigUids.every((uid) => bigStore[uid]?.deleted === true && bigStore[uid]?.seen === true), bigStore.error ?? bigUids.length);
	const bigTrashBefore = (await op("openImapFolder", owner, "trash")).uidNext;
	const bigMoved = await op("expungeImapFolder", owner, "inbox", Math.max(...bigUids));
	const bigTrash = await op("openImapFolder", owner, "trash");
	const bigTrashUids = bigTrash.messages.filter((entry) => entry.messageId.startsWith("k-")).map((entry) => entry.uid);
	check("EXPUNGE of 90 UIDs (relocation batches of 80 and 10) on D1", same(bigMoved, bigUids) && bigTrashUids.length === 90 && same(bigTrashUids, Array.from({ length: 90 }, (_, index) => bigTrashBefore + index)) && bigTrash.uidNext === bigTrashBefore + 90 && bigTrash.messages.every((entry) => !entry.flags.deleted), bigMoved.error ?? [bigMoved.length, bigTrashUids.length]);
	await sql(["INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES ('x-1', 'user-a', 'mbx-a', 'inbound', 's@x', 'a@example.test', 'received', 9800)"]);
	const xUid = await op("ensureImapUid", owner, "inbox", "x-1");
	await op("store", owner, "inbox", [xUid], { mode: "add", flags: ["deleted"] });
	const trashFolder = (await sql(["SELECT id, uid_next FROM imap_folders WHERE mailbox_id = 'mbx-a' AND folder_key = 'trash'"]))[0][0];
	await sql(["UPDATE imap_folders SET uid_next = 4294967296 WHERE id = ?", trashFolder.id]);
	const exhausted = await op("expungeImapFolder", owner, "inbox", xUid);
	const xState = (await sql(["SELECT m.status, u.deleted FROM messages m JOIN imap_message_uids u ON u.message_id = m.id JOIN imap_folders f ON f.id = u.imap_folder_id WHERE m.id = 'x-1' AND f.folder_key = 'inbox'"]))[0];
	check("an exhausted Trash UIDNEXT rolls the whole relocation back on D1", typeof exhausted.error === "string" && /CHECK constraint failed/.test(exhausted.error) && xState.length === 1 && xState[0].status === "received" && xState[0].deleted === 1, [exhausted, xState]);

	console.log("MOVE (A5.2b, D1)");
	await sql(["INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-m', 'user-a', 'mbx-a', 'Moved', 1)"]);
	const moveRaw = "From: s@x\r\nSubject: move me\r\n\r\nbody ✓\r\n";
	const moveBytes = new TextEncoder().encode(moveRaw);
	await bucket.put("inbound/mv.eml", moveBytes);
	const moveDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", moveBytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
	await sql(["INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, raw_r2_key, read, starred, created_at) VALUES ('mv-1', 'user-a', 'mbx-a', 'inbound', 's@x', 'a@example.test', 'received', 'inbound/mv.eml', 1, 1, 9900), ('mv-2', 'user-a', 'mbx-a', 'inbound', 's@x', 'a@example.test', 'received', NULL, 0, 0, 9901)"]);
	const mv1 = await op("ensureImapUid", owner, "inbox", "mv-1");
	const mv2 = await op("ensureImapUid", owner, "inbox", "mv-2");
	const mv1Before = await op("fetch", owner, "inbox", mv1);
	await op("store", owner, "inbox", [mv2], { mode: "add", flags: ["deleted"] });
	const archiveState = await op("openImapFolder", owner, "archive");
	const archiveNext = archiveState.uidNext;
	const moveResult = await op("moveImapMessages", owner, "inbox", [mv1, mv2], "archive");
	check(
		"MOVE relocates both, reports them in UID order with the destination UIDs and UIDVALIDITY read back on D1 (COPYUID, A5.3), no training for Archive",
		same(moveResult, { moved: [{ uid: mv1, messageId: "mv-1", destinationUid: archiveNext, destinationUidValidity: archiveState.uidValidity }, { uid: mv2, messageId: "mv-2", destinationUid: archiveNext + 1, destinationUidValidity: archiveState.uidValidity }], training: null }),
		moveResult,
	);
	const mvRows = (await sql(["SELECT id, status, folder_id, read, starred, created_at, raw_r2_key FROM messages WHERE id IN ('mv-1', 'mv-2') ORDER BY id"]))[0];
	check("status archived; read, starred, date and object unchanged", mvRows.every((row) => row.status === "archived" && row.folder_id === null) && mvRows[0].read === 1 && mvRows[0].starred === 1 && mvRows[0].created_at === 9900 && mvRows[0].raw_r2_key === "inbound/mv.eml", mvRows);
	const archiveAfter = await op("openImapFolder", owner, "archive");
	const mvEntries = archiveAfter.messages.filter((entry) => entry.messageId.startsWith("mv-"));
	check("fresh destination UIDs from UIDNEXT, UIDNEXT advanced", same(mvEntries.map((entry) => entry.uid), [archiveNext, archiveNext + 1]) && archiveAfter.uidNext === archiveNext + 2, [mvEntries, archiveAfter.uidNext]);
	check("destination deleted = 0, also for the source UID that was \\Deleted", mvEntries.every((entry) => entry.flags.deleted === false));
	check("source UIDs released", (await op("resolveImapUid", owner, "inbox", mv1)) === null && (await op("resolveImapUid", owner, "inbox", mv2)) === null);
	const mvFetched = await op("fetch", owner, "archive", archiveNext);
	check("canonical bytes and RFC822.SIZE unchanged after MOVE", mvFetched?.sha === moveDigest && mv1Before.sha === moveDigest && mvFetched.size === moveBytes.byteLength && mvFetched.source === "original", mvFetched);
	check("a repeated MOVE of the released UIDs moves nothing", same(await op("moveImapMessages", owner, "inbox", [mv1, mv2], "archive"), { moved: [], training: null }));
	check("same-folder MOVE is unsupported", (await op("moveImapMessages", owner, "archive", [archiveNext], "archive")).code === "unsupported");
	check("Sent and Drafts are never destinations", (await op("moveImapMessages", owner, "archive", [archiveNext], "sent")).code === "unsupported" && (await op("moveImapMessages", owner, "archive", [archiveNext], "drafts")).code === "unsupported");
	check("a nonexistent destination is nonexistent-destination", (await op("moveImapMessages", owner, "archive", [archiveNext], "f:nope")).code === "nonexistent-destination");
	check("MOVE for a read-only delegate is denied", (await op("moveImapMessages", { userId: "user-b", mailboxId: "mbx-s" }, "inbox", [1], "trash")).code === "denied");

	// UID relocation in chunks: 90 UIDs into a custom folder are two batches (80 + 10).
	await sql(["WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 89) INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) SELECT printf('u-%02d', i), 'user-a', 'mbx-a', 'inbound', 's@x', 'a@example.test', 'received', 9950 FROM n"]);
	const uInbox = await op("openImapFolder", owner, "inbox");
	const uUids = uInbox.messages.filter((entry) => entry.messageId.startsWith("u-")).map((entry) => entry.uid);
	const customNext = (await op("openImapFolder", owner, "f:fld-m")).uidNext;
	const uMoved = await op("moveImapMessages", owner, "inbox", uUids, "f:fld-m");
	const custom = await op("openImapFolder", owner, "f:fld-m");
	check("MOVE of 90 UIDs (relocation batches of 80 and 10) into a custom folder on D1", uUids.length === 90 && same(uMoved.moved.map((entry) => entry.uid), uUids) && same(custom.messages.map((entry) => entry.uid), Array.from({ length: 90 }, (_, index) => customNext + index)) && custom.uidNext === customNext + 90, uMoved.error ?? [uMoved.moved?.length, custom.messages.length]);
	check("custom folder rows: received with folder_id", (await sql(["SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'u-%' AND status = 'received' AND folder_id = 'fld-m'"]))[0][0].n === 90);
	check(
		"every chunk reports each message's actual destination UID and the folder's UIDVALIDITY (A5.3)",
		same(uMoved.moved.map((entry) => [entry.messageId, entry.destinationUid, entry.destinationUidValidity]), uMoved.moved.map((entry) => [entry.messageId, custom.messages.find((row) => row.messageId === entry.messageId)?.uid, custom.uidValidity])),
		uMoved.moved?.slice(0, 3),
	);

	// Concurrent MOVEs of the same UIDs to different folders: each message moves exactly once.
	const racers = custom.messages.slice(0, 12).map((entry) => entry.uid);
	const [toArchive, toInbox] = await Promise.all([op("moveImapMessages", owner, "f:fld-m", racers, "archive"), op("moveImapMessages", owner, "f:fld-m", racers, "inbox")]);
	const winners = [...toArchive.moved, ...toInbox.moved].map((entry) => entry.uid).sort((a, b) => a - b);
	const racedIds = custom.messages.slice(0, 12).map((entry) => entry.messageId);
	const racedMappings = (await sql([`SELECT u.message_id, COUNT(*) AS n FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id JOIN messages m ON m.id = u.message_id WHERE f.mailbox_id = 'mbx-a' AND u.message_id IN (${racedIds.map(() => "?").join(", ")}) AND ((f.folder_key = 'archive' AND m.status = 'archived') OR (f.folder_key = 'inbox' AND m.status = 'received' AND m.folder_id IS NULL)) GROUP BY u.message_id`, ...racedIds]))[0];
	check("two concurrent MOVEs move each message exactly once, with one live UID", same(winners, racers) && racedMappings.length === 12 && racedMappings.every((row) => row.n === 1), [toArchive.moved?.length, toInbox.moved?.length, racedMappings.length]);

	// Stale source: moved elsewhere first, the MOVE changes nothing and releases the UID.
	const staleUid = custom.messages[20].uid;
	await sql(["UPDATE messages SET status = 'spam', folder_id = NULL WHERE id = ?", custom.messages[20].messageId]);
	const staleMove = await op("moveImapMessages", owner, "f:fld-m", [staleUid], "trash");
	check("a stale source UID moves nothing", same(staleMove.moved, []) && (await sql(["SELECT status FROM messages WHERE id = ?", custom.messages[20].messageId]))[0][0].status === "spam", staleMove);

	// A vanished custom destination: the relocation's own guard keeps the message in place.
	const guardUid = custom.messages[21].uid;
	const guarded = await op("relocate", "mbx-a", "f:fld-m", "f:fld-gone", { status: "received", folderId: "fld-gone" }, [guardUid], {});
	check("a relocation into a custom folder that does not exist moves nothing", same(guarded.moved, []) && (await sql(["SELECT folder_id FROM messages WHERE id = ?", custom.messages[21].messageId]))[0][0].folder_id === "fld-m", guarded);

	// Exhausted destination UIDNEXT: the whole chunk rolls back.
	const exhaustUids = custom.messages.slice(22, 30).map((entry) => entry.uid);
	const beforeExhaust = await sql(["SELECT id, status, folder_id FROM messages WHERE folder_id = 'fld-m' ORDER BY id"], ["SELECT u.uid, u.message_id FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key = 'f:fld-m' ORDER BY u.uid"]);
	await op("openImapFolder", owner, "junk");
	await sql(["UPDATE imap_folders SET uid_next = 4294967296 WHERE mailbox_id = 'mbx-a' AND folder_key = 'junk'"]);
	const exhaustedMove = await op("moveImapMessages", owner, "f:fld-m", exhaustUids, "junk");
	const afterExhaust = await sql(["SELECT id, status, folder_id FROM messages WHERE folder_id = 'fld-m' ORDER BY id"], ["SELECT u.uid, u.message_id FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key = 'f:fld-m' ORDER BY u.uid"]);
	check("an exhausted destination UIDNEXT rolls the whole MOVE chunk back on D1", /CHECK constraint failed/.test(exhaustedMove.error ?? "") && same(beforeExhaust, afterExhaust), exhaustedMove);
	check("no spam training for a MOVE that did not commit", (await sql(["SELECT COUNT(*) AS n FROM spam_feedback"]))[0][0].n === 0);

	console.log("Spam training after MOVE (A5.2b, D1)");
	await sql(["INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES ('sp-1', 'user-a', 'mbx-a', 'inbound', 'promo@spammy.test', 'a@example.test', 'Cheap pills', 'Buy cheap pills now http://spammy.test/offer', 'received', 9990), ('sp-2', 'user-a', 'mbx-s', 'inbound', 'promo@spammy.test', 'sales@example.test', 'Cheap pills', 'Buy cheap pills now http://spammy.test/offer', 'received', 9990)"]);
	// mbx-a's Spam UIDNEXT is exhausted by the rollback check above, so MOVE-then-train runs in mbx-s.
	const shared = { userId: "user-a", mailboxId: "mbx-s" };
	const spShared = await op("ensureImapUid", shared, "inbox", "sp-2");
	await sql(["INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES ('sp-out-s', 'user-a', 'mbx-s', 'outbound', 'sales@example.test', 'b@x', 'received', 9992)"]);
	const outShared = await op("ensureImapUid", shared, "inbox", "sp-out-s");
	check("outbound mail cannot MOVE to Spam", (await op("moveImapMessages", shared, "inbox", [outShared], "junk")).code === "unsupported");
	const spamMove = await op("moveImapMessages", shared, "inbox", [spShared], "junk");
	const sharedJunk = await op("openImapFolder", shared, "junk");
	check("MOVE into Spam reports spam training", same(spamMove, { moved: [{ uid: spShared, messageId: "sp-2", destinationUid: sharedJunk.messages.find((entry) => entry.messageId === "sp-2")?.uid, destinationUidValidity: sharedJunk.uidValidity }], training: "spam" }), spamMove);
	check("training after the committed MOVE succeeds on D1", same(await op("trainImapSpamFeedback", shared, ["sp-2"], "spam"), []));
	const spTotals = async (mailboxId) => (await sql(["SELECT COALESCE(SUM(spam_count), 0) AS spam, COALESCE(SUM(ham_count), 0) AS ham FROM spam_token_stats WHERE mailbox_id = ?", mailboxId]))[0][0];
	const trained = await spTotals("mbx-s");
	check("spam_feedback and token counts recorded", (await sql(["SELECT classification FROM spam_feedback WHERE message_id = 'sp-2'"]))[0][0]?.classification === "spam" && trained.spam > 0 && trained.ham === 0, trained);
	await op("trainImapSpamFeedback", shared, ["sp-2"], "spam");
	const racedTraining = await Promise.all([op("recordSpamTraining", { messageId: "sp-2", mailboxId: "mbx-s", actorUserId: "user-a", classification: "spam", status: "spam" }), op("recordSpamTraining", { messageId: "sp-2", mailboxId: "mbx-s", actorUserId: "user-a", classification: "spam", status: "spam" })]);
	check("retries of a recorded training count nothing more", same(await spTotals("mbx-s"), trained) && racedTraining.every((value) => value === false), racedTraining);
	await sql(["INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES ('sp-3', 'user-a', 'mbx-s', 'inbound', 'promo@spammy.test', 'sales@example.test', 'Cheap pills', 'Buy cheap pills now http://spammy.test/offer', 'spam', 9993)"]);
	const freshRace = await Promise.all(Array.from({ length: 4 }, () => op("recordSpamTraining", { messageId: "sp-3", mailboxId: "mbx-s", actorUserId: "user-a", classification: "spam", status: "spam" })));
	check("four concurrent trainings of an untrained message count exactly once (guarded upserts on D1)", freshRace.filter((value) => value === true).length === 1 && (await spTotals("mbx-s")).spam === trained.spam * 2, [freshRace, await spTotals("mbx-s")]);
	const junkUid = (await op("openImapFolder", shared, "junk")).messages.find((entry) => entry.messageId === "sp-2").uid;
	const hamMove = await op("moveImapMessages", shared, "junk", [junkUid], "inbox");
	check("Spam -> INBOX reports ham training", hamMove.training === "ham" && hamMove.moved.length === 1, hamMove);
	await op("trainImapSpamFeedback", shared, ["sp-2"], "ham");
	const hammed = await spTotals("mbx-s");
	check("ham training reverses the spam counts on D1", hammed.spam === trained.spam && hammed.ham === trained.spam && (await sql(["SELECT classification FROM spam_feedback WHERE message_id = 'sp-2'"]))[0][0].classification === "ham", hammed);
	check("the web app's report-spam still moves and trains on D1", (await op("applySpamFeedback", { id: "user-a", role: "admin" }, "sp-1", "spam")) === true && (await sql(["SELECT status FROM messages WHERE id = 'sp-1'"]))[0][0].status === "spam" && (await spTotals("mbx-a")).spam === trained.spam);
	check("the web app's not-spam still moves and trains ham on D1", (await op("applySpamFeedback", { id: "user-a", role: "admin" }, "sp-1", "ham")) === true && (await sql(["SELECT status FROM messages WHERE id = 'sp-1'"]))[0][0].status === "received" && same(await spTotals("mbx-a"), { spam: 0, ham: trained.spam }));

	console.log("bp0004 and permanent EXPUNGE in Trash and Drafts (A5.2c, D1 + R2)");
	// A fresh mailbox: mbx-a's Trash UIDNEXT was exhausted by the rollback checks above.
	await sql(
		["INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mbx-p', 'user-a', 'domain-1', 'purge', 'personal', 1)"],
		["INSERT INTO mail_app_passwords (id, user_id, mailbox_id, label, public_id, secret_hash, scopes, created_at) VALUES ('map-p', 'user-a', 'mbx-p', 'd1', 'pub-p', 'h', '[\"imap\"]', 1)"],
	);
	const purger = { userId: "user-a", mailboxId: "mbx-p", appPasswordId: "map-p" };
	const authority = { userId: "user-a", mailboxId: "mbx-p", appPasswordId: "map-p", sharedAccess: true };
	let pCounter = 0;
	const putMessage = async (id, status, values = {}) => {
		await bucket.put(`inbound/${id}.eml`, `Subject: ${id}\r\n\r\npurgeable body ${id}\r\n`);
		await sql([`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, raw_r2_key, created_at) VALUES (?, ?, 'mbx-p', ?, 'a@example.test', 'b@x', ?, ?, ?, ?, ?)`, id, values.userId ?? "user-a", status === "draft" ? "outbound" : "inbound", `subject ${id}`, `purgeable body ${id}`, status, status === "draft" ? null : `inbound/${id}.eml`, 20000 + ++pCounter]);
	};
	const putAttachment = async (messageId, attachmentId) => {
		const key = `attachments/${messageId}/${attachmentId}/f.txt`;
		await bucket.put(key, "attached");
		await sql(["INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES (?, ?, 'f.txt', 'text/plain', 8, 'attachment', ?, 1)", attachmentId, messageId, key]);
		return key;
	};
	const draftUid = async (id) => (await op("openImapFolder", purger, "drafts")).messages.find((entry) => entry.messageId === id)?.uid ?? null;
	const inR2 = async (key) => !!(await bucket.get(key));
	const rowExists = async (id) => (await sql(["SELECT COUNT(*) AS n FROM messages WHERE id = ?", id]))[0][0].n === 1;

	await putMessage("pd-1", "draft");
	const firstDraftUid = await draftUid("pd-1");
	await sql(["UPDATE messages SET subject = subject, read = 1 WHERE id = 'pd-1'"]);
	check("bp0004: an identical save and a read change keep the Drafts UID", (await draftUid("pd-1")) === firstDraftUid);
	await sql(["UPDATE messages SET text_body = 'edited on D1' WHERE id = 'pd-1'"]);
	const editedUid = (await sql(["SELECT COUNT(*) AS n FROM imap_message_uids u JOIN imap_folders f ON f.id = u.imap_folder_id WHERE f.folder_key = 'drafts' AND u.message_id = 'pd-1'"]))[0][0].n;
	const secondDraftUid = await draftUid("pd-1");
	check("bp0004: a content edit releases the Drafts UID in the same statement; the draft gets a new UID", editedUid === 0 && secondDraftUid > firstDraftUid, [editedUid, firstDraftUid, secondDraftUid]);
	await putAttachment("pd-1", "pd-att-1");
	const afterAdd = await sql(["SELECT COUNT(*) AS n FROM imap_message_uids WHERE message_id = 'pd-1'"]);
	const thirdDraftUid = await draftUid("pd-1");
	await sql(["DELETE FROM message_attachments WHERE id = 'pd-att-1'"]);
	const afterRemove = await sql(["SELECT COUNT(*) AS n FROM imap_message_uids WHERE message_id = 'pd-1'"]);
	check("bp0004: attachment insert and delete each release the Drafts UID", afterAdd[0][0].n === 0 && afterRemove[0][0].n === 0 && thirdDraftUid > secondDraftUid, [afterAdd, afterRemove]);

	// One Trash message: row, raw bytes, attachment, search index, JMAP revision, stale mapping elsewhere.
	await putMessage("pt-1", "trash");
	await putMessage("pt-keep", "trash");
	const pt1Attachment = await putAttachment("pt-1", "pt-att-1");
	const pTrash = await op("openImapFolder", purger, "trash");
	const pt1Uid = pTrash.messages.find((entry) => entry.messageId === "pt-1").uid;
	await sql(["INSERT INTO imap_folders (id, mailbox_id, folder_key, uid_validity, uid_next, created_at) VALUES ('P-ar', 'mbx-p', 'archive', 5, 2, 1)"], ["INSERT INTO imap_message_uids (imap_folder_id, uid, message_id, created_at) VALUES ('P-ar', 1, 'pt-1', 1)"]);
	const revisionOf = async () => Number((await sql(["SELECT revision FROM jmap_mailbox_revisions WHERE mailbox_id = 'mbx-p'"]))[0][0]?.revision ?? 0);
	const pRevision = await revisionOf();
	check("STORE \\Deleted in Trash is allowed and deletes nothing", (await op("store", purger, "trash", [pt1Uid], { mode: "add", flags: ["deleted"] }))[pt1Uid]?.deleted === true && (await rowExists("pt-1")));
	const purged = await op("expungeImapFolder", purger, "trash", pTrash.uidNext - 1);
	check("permanent EXPUNGE in Trash deletes exactly the marked message", same(purged, [pt1Uid]) && !(await rowExists("pt-1")) && (await rowExists("pt-keep")), purged);
	check("its raw bytes and attachment object are removed from R2 after the commit", !(await inR2("inbound/pt-1.eml")) && !(await inR2(pt1Attachment)) && (await inR2("inbound/pt-keep.eml")));
	check("attachment rows cascade; the stale Archive mapping is removed explicitly", (await sql(["SELECT COUNT(*) AS n FROM message_attachments WHERE message_id = 'pt-1'"]))[0][0].n === 0 && (await sql(["SELECT COUNT(*) AS n FROM imap_message_uids WHERE message_id = 'pt-1'"]))[0][0].n === 0);
	check("FTS no longer finds it; the JMAP revision moved", (await sql(["SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'pt'"]))[0][0].n === (await sql(["SELECT COUNT(*) AS n FROM messages WHERE subject LIKE 'subject pt%'"]))[0][0].n && (await revisionOf()) > pRevision);
	check("a repeated EXPUNGE deletes nothing", same(await op("expungeImapFolder", purger, "trash", pTrash.uidNext - 1), []));

	// UID EXPUNGE (A5.3): the same paths narrowed to the requested UIDs, on D1.
	await putMessage("pu-1", "trash");
	await putMessage("pu-2", "trash");
	await putMessage("pu-3", "trash");
	const uTrash = await op("openImapFolder", purger, "trash");
	const [pu1, pu2, pu3] = ["pu-1", "pu-2", "pu-3"].map((id) => uTrash.messages.find((entry) => entry.messageId === id).uid);
	await op("store", purger, "trash", [pu1, pu2], { mode: "add", flags: ["deleted"] });
	const uPurged = await op("expungeImapFolder", purger, "trash", uTrash.uidNext - 1, [pu2, pu3]);
	check("UID EXPUNGE in Trash deletes only requested \\Deleted UIDs", same(uPurged, [pu2]) && (await rowExists("pu-1")) && !(await rowExists("pu-2")) && (await rowExists("pu-3")) && !(await inR2("inbound/pu-2.eml")) && (await inR2("inbound/pu-1.eml")), uPurged);
	check("the unrequested \\Deleted mark stays", (await sql(["SELECT deleted FROM imap_message_uids WHERE message_id = 'pu-1'"]))[0][0]?.deleted === 1);
	await putMessage("uxr-1", "received");
	await putMessage("uxr-2", "received");
	const uInboxP = await op("openImapFolder", purger, "inbox");
	const [pr1, pr2] = ["uxr-1", "uxr-2"].map((id) => uInboxP.messages.find((entry) => entry.messageId === id).uid);
	await op("store", purger, "inbox", [pr1, pr2], { mode: "add", flags: ["deleted"] });
	const uRelocated = await op("expungeImapFolder", purger, "inbox", uInboxP.uidNext - 1, [pr2]);
	check("UID EXPUNGE in INBOX moves only the requested \\Deleted UID to Trash", same(uRelocated, [pr2]) && (await sql(["SELECT id, status FROM messages WHERE id IN ('uxr-1', 'uxr-2') ORDER BY id"]))[0].map((row) => row.status).join() === "received,trash", uRelocated);
	await op("store", purger, "trash", [pu1], { mode: "remove", flags: ["deleted"] });
	await op("store", purger, "inbox", [pr1], { mode: "remove", flags: ["deleted"] });

	// One Draft: the author's own; another user's draft is refused.
	await putMessage("pd-own", "draft");
	await putMessage("pd-other", "draft", { userId: "user-b" });
	const ownUid = await draftUid("pd-own");
	const otherUid = await draftUid("pd-other");
	check("\\Deleted on another user's draft is denied", (await op("store", purger, "drafts", [otherUid], { mode: "add", flags: ["deleted"] })).code === "denied");
	await op("store", purger, "drafts", [ownUid], { mode: "add", flags: ["deleted"] });
	await sql(["UPDATE imap_message_uids SET deleted = 1 WHERE message_id = 'pd-other'"]);
	const draftPurge = await op("expungeImapFolder", purger, "drafts", 100000);
	check("permanent EXPUNGE in Drafts deletes the author's draft only, even with a foreign mark", same(draftPurge, [ownUid]) && !(await rowExists("pd-own")) && (await rowExists("pd-other")), draftPurge);

	// A full chunk of 25, then 30 (25 + 5), with D1's bound-parameter counts recorded.
	const fullIds = Array.from({ length: 25 }, (_, index) => `pf-${String(index).padStart(2, "0")}`);
	for (const id of fullIds) await putMessage(id, "trash");
	const fullAttachment = await putAttachment("pf-00", "pf-att");
	const fullView = await op("openImapFolder", purger, "trash");
	const fullUids = fullView.messages.filter((entry) => entry.messageId.startsWith("pf-")).map((entry) => entry.uid);
	await op("store", purger, "trash", fullUids, { mode: "add", flags: ["deleted"] });
	const fullResult = await op("permanent", "mbx-p", "trash", fullUids, 1000000, authority);
	check("a full 25-UID chunk deletes 25 in one D1 batch", fullResult.deleted?.length === 25 && same(fullResult.released, fullUids), fullResult.error ?? fullResult.deleted?.length);
	check(`every statement binds under D1's 100 parameters (max ${Math.max(...(fullResult.counts ?? [999]))})`, fullResult.counts?.length === 4 && fullResult.counts.every((count) => count < 100), fullResult.counts);
	check("S1 captured the attachment key before the cascade (RETURNING cannot see it on D1)", same(fullResult.deleted?.find((row) => row.messageId === "pf-00")?.attachmentKeys, [fullAttachment]));
	const cleaned = await op("cleanup", fullResult.deleted);
	check("post-commit cleanup removes the 25 raw objects and the attachment from R2", cleaned.removed?.length === 26 && cleaned.failed.length === 0 && !(await inR2(fullAttachment)) && !(await inR2("inbound/pf-00.eml")), cleaned);
	const moreIds = Array.from({ length: 30 }, (_, index) => `pm-${String(index).padStart(2, "0")}`);
	for (const id of moreIds) await putMessage(id, "trash");
	const moreView = await op("openImapFolder", purger, "trash");
	const moreUids = moreView.messages.filter((entry) => entry.messageId.startsWith("pm-")).map((entry) => entry.uid);
	await op("store", purger, "trash", moreUids, { mode: "add", flags: ["deleted"] });
	const moreResult = await op("expungeImapFolder", purger, "trash", moreView.uidNext - 1);
	check("30 UIDs expunge in two chunks (25 + 5) on D1", same(moreResult, moreUids) && (await sql(["SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'pm-%'"]))[0][0].n === 0, moreResult.error ?? moreResult.length);

	// Compare-and-set misses: a cleared mark, a stale UID, a revoked credential, a foreign authority.
	await putMessage("pc-1", "trash");
	const pcUid = (await op("openImapFolder", purger, "trash")).messages.find((entry) => entry.messageId === "pc-1").uid;
	await op("store", purger, "trash", [pcUid], { mode: "add", flags: ["deleted"] });
	await sql(["UPDATE imap_message_uids SET deleted = 0 WHERE message_id = 'pc-1'"]);
	check("CAS miss: a cleared mark deletes nothing", same((await op("permanent", "mbx-p", "trash", [pcUid], 1000000, authority)).deleted, []) && (await rowExists("pc-1")));
	await sql(["UPDATE imap_message_uids SET deleted = 1 WHERE message_id = 'pc-1'"]);
	check("CAS miss: a UID above the announced range deletes nothing", same((await op("permanent", "mbx-p", "trash", [pcUid], pcUid - 1, authority)).deleted, []) && (await rowExists("pc-1")));
	check("CAS miss: an app password that no longer exists deletes nothing", same((await op("permanent", "mbx-p", "trash", [pcUid], 1000000, { ...authority, appPasswordId: "map-gone" })).deleted, []) && (await rowExists("pc-1")));
	check("CAS miss: a user without ownership or full access deletes nothing", same((await op("permanent", "mbx-p", "trash", [pcUid], 1000000, { ...authority, userId: "user-b", appPasswordId: undefined })).deleted, []) && (await rowExists("pc-1")));

	// Rollback: a statement failing inside the batch undoes the delete, and nothing is cleaned.
	await sql(["CREATE TRIGGER check_injected_failure BEFORE DELETE ON imap_message_uids BEGIN SELECT RAISE(ABORT, 'injected failure'); END"]);
	const rolledBack = await op("expungeImapFolder", purger, "trash", 1000000);
	await sql(["DROP TRIGGER check_injected_failure"]);
	check("a failing statement rolls the whole batch back on D1; bytes untouched", /injected failure/.test(rolledBack.error ?? "") && (await rowExists("pc-1")) && (await inR2("inbound/pc-1.eml")), rolledBack);

	// Concurrency: two EXPUNGEs, EXPUNGE vs MOVE out of Trash, EXPUNGE vs -FLAGS \Deleted.
	const raceIds = Array.from({ length: 12 }, (_, index) => `pr-${String(index).padStart(2, "0")}`);
	for (const id of raceIds) await putMessage(id, "trash");
	const raceView = await op("openImapFolder", purger, "trash");
	const raceUids = raceView.messages.filter((entry) => entry.messageId.startsWith("pr-")).map((entry) => entry.uid);
	await op("store", purger, "trash", raceUids, { mode: "add", flags: ["deleted"] });
	const [raceA, raceB, raceMove, raceClear] = await Promise.all([
		op("expungeImapFolder", purger, "trash", 1000000),
		op("expungeImapFolder", purger, "trash", 1000000),
		op("moveImapMessages", purger, "trash", raceUids.slice(0, 4), "inbox"),
		op("store", purger, "trash", raceUids.slice(4, 8), { mode: "remove", flags: ["deleted"] }),
	]);
	const raceRows = (await sql([`SELECT id, status, raw_r2_key FROM messages WHERE id LIKE 'pr-%' ORDER BY id`]))[0];
	let bytesConsistent = true;
	for (const row of raceRows) if (!(await inR2(row.raw_r2_key))) bytesConsistent = false;
	const survivors = new Set(raceRows.map((row) => row.id));
	let deletedBytesGone = true;
	for (const id of raceIds.filter((id) => !survivors.has(id))) if (await inR2(`inbound/${id}.eml`)) deletedBytesGone = false;
	check("racing EXPUNGEs, MOVE and -\\Deleted: both EXPUNGEs answer, every surviving row keeps its bytes, every deleted one's bytes are gone", Array.isArray(raceA) && Array.isArray(raceB) && bytesConsistent && deletedBytesGone && raceRows.every((row) => row.status === "received" || row.status === "trash"), { raceA, raceB, raceMove, raceClear: raceClear.error ?? "ok", rows: raceRows.length });
	check("a moved-out message is never deleted", raceRows.filter((row) => row.status === "received").length === (raceMove.moved?.length ?? 0), raceMove);

	// Fail closed on D1 (pc-1 was still marked, so the racing EXPUNGEs above removed it: use a fresh one).
	await putMessage("pc-2", "trash");
	const pc2Uid = (await op("openImapFolder", purger, "trash")).messages.find((entry) => entry.messageId === "pc-2").uid;
	await op("store", purger, "trash", [pc2Uid], { mode: "add", flags: ["deleted"] });
	const bp0003Sql = (await sql(["SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'bp_imap_membership_clears_deleted'"]))[0][0].sql;
	await sql(["DROP TRIGGER bp_imap_membership_clears_deleted"]);
	const noBp0003 = [await op("expungeImapFolder", purger, "trash", 1000000), await op("permanent", "mbx-p", "trash", [pc2Uid], 1000000, authority)];
	check("without bp0003: Trash EXPUNGE is unsupported and the primitive deletes nothing", noBp0003[0].code === "unsupported" && same(noBp0003[1].deleted, []) && (await rowExists("pc-2")), noBp0003);
	await sql([bp0003Sql]);
	await putMessage("pd-f", "draft");
	const pdfUid = await draftUid("pd-f");
	await op("store", purger, "drafts", [pdfUid], { mode: "add", flags: ["deleted"] });
	const bp0004Sql = (await sql(["SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'bp_imap_draft_attachment_added_releases_uid'"]))[0][0].sql;
	await sql(["DROP TRIGGER bp_imap_draft_attachment_added_releases_uid"]);
	const noBp0004 = [await op("expungeImapFolder", purger, "drafts", 1000000), await op("permanent", "mbx-p", "drafts", [pdfUid], 1000000, authority), await rowExists("pd-f"), await op("expungeImapFolder", purger, "trash", 1000000), await rowExists("pc-2")];
	check("without one bp0004 trigger: Drafts is unsupported, the primitive deletes nothing, Trash still works", noBp0004[0].code === "unsupported" && same(noBp0004[1].deleted, []) && noBp0004[2] && same(noBp0004[3], [pc2Uid]) && !noBp0004[4], noBp0004);
	await sql([bp0004Sql]);
	check("with bp0004 restored the draft can be purged", same(await op("expungeImapFolder", purger, "drafts", 1000000), [pdfUid]) && !(await rowExists("pd-f")));

	console.log("Fail-closed without bp0003 (D1)");
	const triggerSql = onMessages.find((trigger) => trigger.name === "bp_imap_membership_clears_deleted").sql;
	await sql(["DROP TRIGGER bp_imap_membership_clears_deleted"]);
	check("\\Deleted is not a permanent flag anywhere", (await op("listImapMailboxes", owner)).every((mailbox) => !mailbox.permanentFlags.includes("deleted")));
	check("STORE \\Deleted is unsupported", (await op("store", owner, "inbox", [xUid], { mode: "remove", flags: ["deleted"] })).code === "unsupported");
	check("EXPUNGE is unsupported and moves nothing", (await op("expungeImapFolder", owner, "inbox", xUid)).code === "unsupported" && (await sql(["SELECT status FROM messages WHERE id = 'x-1'"]))[0][0].status === "received");
	check("\\Seen still works", (await op("store", owner, "inbox", [xUid], { mode: "add", flags: ["seen"] }))[xUid]?.seen === true);
	check("MOVE is unsupported and moves nothing", (await op("moveImapMessages", owner, "inbox", [xUid], "archive")).code === "unsupported" && (await sql(["SELECT status FROM messages WHERE id = 'x-1'"]))[0][0].status === "received");
	const unguarded = await op("relocate", "mbx-a", "inbox", "archive", { status: "archived", folderId: null }, [xUid], {});
	check("a relocation without the trigger moves nothing (its own guard)", same(unguarded.moved, []) && (await sql(["SELECT status FROM messages WHERE id = 'x-1'"]))[0][0].status === "received", unguarded);
	await sql([triggerSql]);
	check("the trigger is restored", (await op("listImapMailboxes", owner)).some((mailbox) => mailbox.permanentFlags.includes("deleted")));

	console.log("Shared access and revocation");
	check("read-only delegate can open the shared INBOX", !!(await op("openImapFolder", { userId: "user-b", mailboxId: "mbx-s" }, "inbox")).uidValidity);
	await sql(["DELETE FROM mailbox_access WHERE id = 'acc-b'"]);
	check("revoked delegate is refused on the next call", (await op("openImapFolder", { userId: "user-b", mailboxId: "mbx-s" }, "inbox")).code === "forbidden");
	check("another mailbox's folders are unreachable", (await op("openImapFolder", { userId: "user-b", mailboxId: "mbx-a" }, "inbox")).code === "forbidden");
	check("a revoked delegate's STORE is forbidden, not denied", (await op("store", { userId: "user-b", mailboxId: "mbx-s" }, "inbox", [1], { mode: "add", flags: ["seen"] })).code === "forbidden");

	console.log("IDLE change signal (A5.4, D1)");
	const signalInbox = await op("openImapFolder", owner, "inbox");
	const signalBefore = await op("getImapChangeSignal", owner, "inbox");
	check("the signal reads the mailbox revision and the folder's UIDVALIDITY", Number.isInteger(signalBefore.revision) && signalBefore.revision > 0 && signalBefore.uidValidity === signalInbox.uidValidity, signalBefore);
	await sql(["INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, created_at) VALUES ('sig-1', 'user-a', 'mbx-a', 'inbound', 's@x', 'a@example.test', 'received', 30000)"]);
	const signalAfter = await op("getImapChangeSignal", owner, "inbox");
	check("an inserted message moves the revision; UIDVALIDITY is unchanged", signalAfter.revision > signalBefore.revision && signalAfter.uidValidity === signalBefore.uidValidity, [signalBefore, signalAfter]);
	const flagged = await sql(["SELECT revision FROM jmap_mailbox_revisions WHERE mailbox_id = 'mbx-a'"]);
	check("the signal reads exactly jmap_mailbox_revisions", flagged[0][0].revision === signalAfter.revision, flagged);
	const signalIds = (await op("openImapFolder", owner, "inbox")).messages.filter((entry) => entry.messageId === "sig-1").map((entry) => entry.uid);
	await op("store", owner, "inbox", signalIds, { mode: "add", flags: ["deleted"] });
	check("a \\Deleted mark does not move the revision (the reconciliation covers it)", (await op("getImapChangeSignal", owner, "inbox")).revision === signalAfter.revision);
	await op("store", owner, "inbox", signalIds, { mode: "remove", flags: ["deleted"] });
	check("without a folder only authority and the revision are read", same(await op("getImapChangeSignal", owner, null), { revision: signalAfter.revision, uidValidity: null }));
	check("a principal without access is forbidden", (await op("getImapChangeSignal", { userId: "user-b", mailboxId: "mbx-a" }, "inbox")).code === "forbidden");
	check("a custom folder that does not exist is nonexistent", (await op("getImapChangeSignal", owner, "f:nope")).code === "nonexistent");
	await sql(["UPDATE users SET disabled = 1 WHERE id = 'user-a'"]);
	check("a disabled user is forbidden", (await op("getImapChangeSignal", owner, "inbox")).code === "forbidden");
	await sql(["UPDATE users SET disabled = 0 WHERE id = 'user-a'"]);

	console.log("Folder management (R-1, D1)");
	await sql(
		["INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mbx-r', 'user-a', 'domain-1', 'r1', 'shared', 1)"],
		["INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('acc-r', 'mbx-r', 'user-b', 'read_only', 1)"],
		["INSERT INTO folders (id, user_id, mailbox_id, name, created_at) VALUES ('fld-r', 'user-a', 'mbx-r', 'Kept', 1), ('fld-r2', 'user-a', 'mbx-r', 'Snoozed only', 1)"],
		["INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, folder_id, created_at) VALUES ('r-1', 'user-a', 'mbx-r', 'inbound', 's@x', 'r1@example.test', 'received', 'fld-r', 40000)"],
		["INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, folder_id, snoozed_until, created_at) VALUES ('r-z', 'user-a', 'mbx-r', 'inbound', 's@x', 'r1@example.test', 'received', 'fld-r2', 1999999999, 40001)"],
	);
	const rOwner = { userId: "user-a" };
	const rDelegate = { userId: "user-b" };
	const rCreated = await op("folders.createFolder", rOwner, "mbx-r", "  Made on D1  ");
	check("the owner creates a folder through the guarded insert (trimmed)", rCreated.outcome === "ok" && (await sql(["SELECT name FROM folders WHERE id = ?", rCreated.folderId]))[0][0]?.name === "Made on D1", rCreated);
	check("an exact duplicate is alreadyExists; a control character is invalidName", (await op("folders.createFolder", rOwner, "mbx-r", "Made on D1")).outcome === "alreadyExists" && (await op("folders.createFolder", rOwner, "mbx-r", "A\nB")).outcome === "invalidName");
	check("a read_only delegate may not rename or delete", (await op("folders.renameFolder", rDelegate, "mbx-r", "fld-r", "X")).outcome === "forbidden" && (await op("folders.deleteFolder", rDelegate, "mbx-r", rCreated.folderId, {})).outcome === "forbidden");
	await sql(["UPDATE mailbox_access SET permission = 'full_access' WHERE id = 'acc-r'"]);
	check("a full_access delegate renames through the guarded update", (await op("folders.renameFolder", rDelegate, "mbx-r", "fld-r", "Renamed on D1")).outcome === "ok" && (await sql(["SELECT name FROM folders WHERE id = 'fld-r'"]))[0][0].name === "Renamed on D1");
	check("a folder of another mailbox is notFound and nothing moves", (await op("folders.deleteFolder", rOwner, "mbx-a", "fld-r", { removeMessages: true })).outcome === "notFound" && (await sql(["SELECT status, folder_id FROM messages WHERE id = 'r-1'"]))[0][0].folder_id === "fld-r");
	check("a folder holding only snoozed mail is not empty", (await op("folders.deleteFolder", rOwner, "mbx-r", "fld-r2", {})).outcome === "hasMessages" && (await sql(["SELECT folder_id FROM messages WHERE id = 'r-z'"]))[0][0].folder_id === "fld-r2");
	const rRemoved = await op("folders.deleteFolder", rOwner, "mbx-r", "fld-r", { removeMessages: true });
	const rMessage = (await sql(["SELECT status, folder_id FROM messages WHERE id = 'r-1'"]))[0][0];
	check("removeMessages moves the folder's mail to Trash and deletes it in one D1 batch", same(rRemoved, { outcome: "ok", movedToTrash: 1 }) && rMessage.status === "trash" && rMessage.folder_id === null && (await sql(["SELECT COUNT(*) AS n FROM folders WHERE id = 'fld-r'"]))[0][0].n === 0, [rRemoved, rMessage]);
	check("an empty folder is deleted", same(await op("folders.deleteFolder", rOwner, "mbx-r", rCreated.folderId, {}), { outcome: "ok", movedToTrash: 0 }));
	// The in-SQL guard itself, evaluated by D1 (JSON scope check included).
	await sql(["UPDATE mailbox_access SET permission = 'read_only' WHERE id = 'acc-r'"]);
	check("guard: owner yes, read_only delegate no", (await op("folderGuard", rOwner, "mbx-r")) === true && (await op("folderGuard", rDelegate, "mbx-r")) === false);
	await sql(["UPDATE mailbox_access SET permission = 'full_access' WHERE id = 'acc-r'"]);
	check("guard: full_access delegate yes", (await op("folderGuard", rDelegate, "mbx-r")) === true);
	await sql(["UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-r'"]);
	check("guard: a disabled mailbox no", (await op("folderGuard", rOwner, "mbx-r")) === false);
	await sql(["UPDATE mailboxes SET disabled = 0 WHERE id = 'mbx-r'"], ["UPDATE users SET disabled = 1 WHERE id = 'user-b'"]);
	check("guard: a disabled user no", (await op("folderGuard", rDelegate, "mbx-r")) === false);
	await sql(["UPDATE users SET disabled = 0 WHERE id = 'user-b'"]);
	const rCredential = { userId: "user-a", appPasswordId: "map-p" };
	check("guard: a mail app password with the imap scope yes, for its own mailbox only", (await op("folderGuard", rCredential, "mbx-p")) === true && (await op("folderGuard", rCredential, "mbx-r")) === false);
	await sql(["UPDATE mail_app_passwords SET scopes = '[\"smtp\"]' WHERE id = 'map-p'"]);
	check("guard: without the imap scope no (json_each on D1)", (await op("folderGuard", rCredential, "mbx-p")) === false);
	await sql(["UPDATE mail_app_passwords SET scopes = '[\"imap\"]' WHERE id = 'map-p'"]);
	check("a credential actor creates a folder in its own mailbox", (await op("folders.createFolder", rCredential, "mbx-p", "Via credential")).outcome === "ok");

	console.log("bp0004 upgrade of an existing D1 database (Workers runner)");
	const draftTriggers = (await sql(["SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'bp_imap_draft_%' ORDER BY name"]))[0];
	await sql(...draftTriggers.map((trigger) => [`DROP TRIGGER ${trigger.name}`]), ["DELETE FROM d1_migrations WHERE name = 'bp0004_release_imap_draft_uid_on_content_change.sql'"]);
	const upgraded = await op("migrate");
	check("a database at bp0003 (with data) applies exactly bp0004", upgraded.ready && same(upgraded.applied, ["bp0004_release_imap_draft_uid_on_content_change.sql"]), upgraded);
	check("the upgrade installs the three certified triggers verbatim", same((await sql(["SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'bp_imap_draft_%' ORDER BY name"]))[0], draftTriggers));
	check("a second run applies nothing", (await op("migrate")).applied.length === 0);

	console.log("Backup round trip and restart");
	const beforeBackup = await op("openImapFolder", owner, "inbox");
	check("backup export + restore on D1", (await op("roundTrip")) === true);
	const restored = await op("openImapFolder", owner, "inbox");
	check("UIDVALIDITY, UIDNEXT and UIDs preserved", restored.uidValidity === beforeBackup.uidValidity && restored.uidNext === beforeBackup.uidNext && same(restored.messages, beforeBackup.messages));
	check("the bp0003 and bp0004 triggers survive a backup restore", (await sql(["SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN ('bp_imap_membership_clears_deleted', 'bp_imap_draft_content_releases_uid', 'bp_imap_draft_attachment_added_releases_uid', 'bp_imap_draft_attachment_removed_releases_uid')"]))[0][0].n === 4);
	await mf.dispose();
	mf = start();
	const restarted = await op("openImapFolder", owner, "inbox");
	check("same state after a workerd restart", restarted.uidValidity === beforeBackup.uidValidity && restarted.uidNext === beforeBackup.uidNext && same(restarted.messages, beforeBackup.messages));
	check("migrations after restart apply nothing", (await op("migrate")).applied.length === 0);
} finally {
	await mf.dispose();
	rmSync(outDirectory, { recursive: true, force: true });
	rmSync(persist, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
