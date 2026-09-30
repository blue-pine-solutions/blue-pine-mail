/**
 * Certification of the A3 IMAP state layer on the Workers runtime: bundles
 * src/lib/imap/ into a Worker, runs it in workerd (Miniflare) with real D1 and R2
 * bindings, and exercises migrations, concurrent first access and delivery, deletion,
 * canonical bytes, the database guards, backup/restore and a restart.
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
	check("every migration applies, bp0002 last", migrated.ready && migrated.applied.length === migrationFiles.length && migrated.applied.at(-1) === "bp0002_add_imap_mailbox_state.sql", migrated);
	check(`${migrationFiles.length} migrations: ${migrationFiles.filter((name) => /^\d/.test(name)).length} upstream + ${migrationFiles.filter((name) => name.startsWith("bp")).length} Blue Pine`, migrationFiles.length === 50 && migrationFiles.filter((name) => name.startsWith("bp")).length === 2);
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

	console.log("Shared access and revocation");
	check("read-only delegate can open the shared INBOX", !!(await op("openImapFolder", { userId: "user-b", mailboxId: "mbx-s" }, "inbox")).uidValidity);
	await sql(["DELETE FROM mailbox_access WHERE id = 'acc-b'"]);
	check("revoked delegate is refused on the next call", (await op("openImapFolder", { userId: "user-b", mailboxId: "mbx-s" }, "inbox")).code === "forbidden");
	check("another mailbox's folders are unreachable", (await op("openImapFolder", { userId: "user-b", mailboxId: "mbx-a" }, "inbox")).code === "forbidden");

	console.log("Backup round trip and restart");
	const beforeBackup = await op("openImapFolder", owner, "inbox");
	check("backup export + restore on D1", (await op("roundTrip")) === true);
	const restored = await op("openImapFolder", owner, "inbox");
	check("UIDVALIDITY, UIDNEXT and UIDs preserved", restored.uidValidity === beforeBackup.uidValidity && restored.uidNext === beforeBackup.uidNext && same(restored.messages, beforeBackup.messages));
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
