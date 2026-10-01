import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * Guards the Blue Pine downstream migration policy (UPSTREAM.md, "Downstream migrations"):
 * `bpNNNN_*.sql` files run after every upstream migration in all three runners, apply once
 * on fresh and existing databases, and are not silently undone by upstream table rebuilds.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = join(root, "drizzle", "migrations");
const read = (path) => readFileSync(join(root, path), "utf8");
const files = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql"));
const UPSTREAM_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const DOWNSTREAM_NAME = /^bp(\d{4})_[a-z0-9_]+\.sql$/;
const upstreamFiles = files.filter((name) => UPSTREAM_NAME.test(name));
const downstreamFiles = files.filter((name) => DOWNSTREAM_NAME.test(name)).sort();
/** Upstream tables Blue Pine migrations attach foreign keys or triggers to. */
const ANCHORED_UPSTREAM_TABLES = ["users", "mailboxes", "domains", "mailbox_access", "messages", "message_attachments"];
/**
 * Anchored tables where only the named, certified Blue Pine triggers may attach, and no
 * foreign key may (UPSTREAM.md, "IMAP \Deleted invariant (bp0003)" and "IMAP draft UID
 * invariant (bp0004)"). Anything else on these tables needs its own certification and an
 * entry here first.
 */
const CERTIFIED_ONLY = {
	messages: ["bp_imap_membership_clears_deleted", "bp_imap_draft_content_releases_uid"],
	message_attachments: ["bp_imap_draft_attachment_added_releases_uid", "bp_imap_draft_attachment_removed_releases_uid"],
};
/** The exact certified bp0003 trigger, as SQLite stores it. */
const MEMBERSHIP_TRIGGER_SQL = "CREATE TRIGGER `bp_imap_membership_clears_deleted` AFTER UPDATE OF `mailbox_id`, `status`, `folder_id` ON `messages`\nWHEN OLD.`mailbox_id` IS NOT NEW.`mailbox_id` OR OLD.`status` IS NOT NEW.`status` OR OLD.`folder_id` IS NOT NEW.`folder_id`\nBEGIN\n\tUPDATE `imap_message_uids` SET `deleted` = 0 WHERE `message_id` = NEW.`id` AND `deleted` = 1;\nEND";
/** The exact certified bp0004 triggers, as SQLite stores them. */
const DRAFT_TRIGGERS_SQL = {
	bp_imap_draft_content_releases_uid: "CREATE TRIGGER `bp_imap_draft_content_releases_uid` AFTER UPDATE OF `from_addr`, `to_addr`, `cc_addr`, `bcc_addr`, `subject`, `text_body`, `html_body`, `in_reply_to`, `references_header` ON `messages`\nWHEN OLD.`from_addr` IS NOT NEW.`from_addr` OR OLD.`to_addr` IS NOT NEW.`to_addr` OR OLD.`cc_addr` IS NOT NEW.`cc_addr` OR OLD.`bcc_addr` IS NOT NEW.`bcc_addr` OR OLD.`subject` IS NOT NEW.`subject` OR OLD.`text_body` IS NOT NEW.`text_body` OR OLD.`html_body` IS NOT NEW.`html_body` OR OLD.`in_reply_to` IS NOT NEW.`in_reply_to` OR OLD.`references_header` IS NOT NEW.`references_header`\nBEGIN\n\tDELETE FROM `imap_message_uids` WHERE `message_id` = NEW.`id` AND `imap_folder_id` IN (SELECT `id` FROM `imap_folders` WHERE `folder_key` = 'drafts' AND `mailbox_id` IN (OLD.`mailbox_id`, NEW.`mailbox_id`));\nEND",
	bp_imap_draft_attachment_added_releases_uid: "CREATE TRIGGER `bp_imap_draft_attachment_added_releases_uid` AFTER INSERT ON `message_attachments`\nWHEN EXISTS (SELECT 1 FROM `messages` WHERE `id` = NEW.`message_id` AND `status` = 'draft')\nBEGIN\n\tDELETE FROM `imap_message_uids` WHERE `message_id` = NEW.`message_id` AND `imap_folder_id` IN (SELECT `id` FROM `imap_folders` WHERE `folder_key` = 'drafts' AND `mailbox_id` = (SELECT `mailbox_id` FROM `messages` WHERE `id` = NEW.`message_id`));\nEND",
	bp_imap_draft_attachment_removed_releases_uid: "CREATE TRIGGER `bp_imap_draft_attachment_removed_releases_uid` AFTER DELETE ON `message_attachments`\nWHEN EXISTS (SELECT 1 FROM `messages` WHERE `id` = OLD.`message_id` AND `status` = 'draft')\nBEGIN\n\tDELETE FROM `imap_message_uids` WHERE `message_id` = OLD.`message_id` AND `imap_folder_id` IN (SELECT `id` FROM `imap_folders` WHERE `folder_key` = 'drafts' AND `mailbox_id` = (SELECT `mailbox_id` FROM `messages` WHERE `id` = OLD.`message_id`));\nEND",
};
const downstreamTables = [...read("src/db/schema/bluepine.ts").matchAll(/sqliteTable\(\s*"([^"]+)"/g)].map((match) => match[1]);

const generated = spawnSync(process.execPath, [join(root, "scripts", "generate-migration-bundle.mjs")], { encoding: "utf8" });
if (generated.status !== 0) throw new Error(`generate-migration-bundle failed: ${generated.stderr}`);
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-downstream-bundle-"));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { applyPendingMigrations, getMigrationStatus } from "./src/lib/migrations/service.ts";
			export { assertBackupTablesCoverDatabase } from "./src/lib/backups/export.ts";
		`,
		resolveDir: root,
		sourcefile: "downstream-migrations-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
test.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

function openDatabase(t) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-downstream-"));
	const database = new app.SqliteDatabase(join(directory, "mailflare.sqlite"));
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return database;
}

/** A migrations directory as the released 0.1.2 / A1 builds shipped it: upstream files and journal only. */
function upstreamOnlyDirectory(t) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-upstream-migrations-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	cpSync(migrationsDirectory, directory, { recursive: true });
	for (const name of downstreamFiles) rmSync(join(directory, name));
	return directory;
}

const appliedInOrder = (database) => database.db.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((row) => row.name);

/** Wrangler's ordering (`compareMigrationPaths` in wrangler's d1 migrations helper), for single-level file names. */
function wranglerOrder(names) {
	const leading = (name) => Number.parseInt(name.split("_")[0], 10);
	return [...names].sort((a, b) => {
		const [x, y] = [leading(a), leading(b)];
		if (x !== y) {
			if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
			if (Number.isFinite(x)) return -1;
			if (Number.isFinite(y)) return 1;
		}
		return a < b ? -1 : a > b ? 1 : 0;
	});
}

test("every migration file is either an upstream NNNN_ file or a contiguous Blue Pine bpNNNN_ file outside the journal", () => {
	assert.deepEqual(files.filter((name) => !UPSTREAM_NAME.test(name) && !DOWNSTREAM_NAME.test(name)), [], "unrecognised migration file names");
	assert.ok(downstreamFiles.length >= 1);
	assert.deepEqual(downstreamFiles.map((name) => Number(DOWNSTREAM_NAME.exec(name)[1])), downstreamFiles.map((_, index) => index + 1), "bpNNNN numbers start at 0001 and are contiguous");
	const journal = JSON.parse(read("drizzle/migrations/meta/_journal.json"));
	assert.deepEqual(journal.entries.filter((entry) => entry.tag.startsWith("bp")), [], "Blue Pine migrations are never in the drizzle journal");
	assert.doesNotMatch(read("drizzle.config.ts"), /bluepine/, "drizzle-kit must not read the Blue Pine schema");
	assert.doesNotMatch(read("src/db/schema/index.ts"), /bluepine|mail_app_passwords/, "Blue Pine tables stay out of the upstream schema file");
});

test("Blue Pine migrations only create their own objects and never alter or drop upstream tables", () => {
	for (const name of downstreamFiles) {
		const sql = readFileSync(join(migrationsDirectory, name), "utf8").replace(/--[^\n]*/g, "");
		for (const match of sql.matchAll(/\b(?:ALTER|DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"]?(\w+)/gi)) {
			assert.ok(downstreamTables.includes(match[1]), `${name} alters or drops upstream table ${match[1]}`);
		}
		for (const match of sql.matchAll(/\bCREATE\s+TRIGGER\s+[`"]?(\w+)/gi)) assert.match(match[1], /^bp_/, `${name}: Blue Pine triggers are named bp_*`);
		for (const match of sql.matchAll(/\bCREATE\s+TABLE\s+[`"]?(\w+)/gi)) assert.ok(downstreamTables.includes(match[1]), `${name}: table ${match[1]} must be declared in src/db/schema/bluepine.ts`);
	}
});

test("Blue Pine migrations attach triggers and foreign keys only to the anchored upstream tables", () => {
	// IMAP state (bp0002) reads `messages` and `folders` by join; the only attachments to
	// `messages` and `message_attachments` are bp0003's and bp0004's certified triggers, and
	// nothing attaches to `folders`.
	for (const name of downstreamFiles) {
		const sql = readFileSync(join(migrationsDirectory, name), "utf8").replace(/--[^\n]*/g, "");
		const triggers = [...sql.matchAll(/\bCREATE\s+TRIGGER\s+[`"]?(\w+)[`"]?[^;]*?\bON\s+[`"]?(\w+)/gi)].map((match) => ({ trigger: match[1], table: match[2] }));
		const references = [...sql.matchAll(/\bREFERENCES\s+[`"]?(\w+)/gi)].map((match) => match[1]);
		for (const table of [...triggers.map((item) => item.table), ...references]) assert.ok(downstreamTables.includes(table) || ANCHORED_UPSTREAM_TABLES.includes(table), `${name} attaches to upstream table ${table}; add it to ANCHORED_UPSTREAM_TABLES and UPSTREAM.md first`);
		for (const { trigger, table } of triggers) {
			if (CERTIFIED_ONLY[table]) assert.ok(CERTIFIED_ONLY[table].includes(trigger), `${name}: trigger ${trigger} on ${table} is not a certified Blue Pine attachment`);
		}
		for (const table of references) assert.ok(!CERTIFIED_ONLY[table], `${name}: no Blue Pine foreign key may reference ${table}`);
	}
});

test("bp0003's and bp0004's triggers are exactly the certified invariants, and the only Blue Pine objects on messages and message_attachments", async (t) => {
	const database = openDatabase(t);
	await app.applyMigrations(database, migrationsDirectory);
	const on = (table) => database.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name LIKE 'bp\\_%' ESCAPE '\\' ORDER BY name").all(table);
	assert.deepEqual(on("messages"), [
		{ name: "bp_imap_draft_content_releases_uid", sql: DRAFT_TRIGGERS_SQL.bp_imap_draft_content_releases_uid },
		{ name: "bp_imap_membership_clears_deleted", sql: MEMBERSHIP_TRIGGER_SQL },
	]);
	assert.deepEqual(on("message_attachments"), [
		{ name: "bp_imap_draft_attachment_added_releases_uid", sql: DRAFT_TRIGGERS_SQL.bp_imap_draft_attachment_added_releases_uid },
		{ name: "bp_imap_draft_attachment_removed_releases_uid", sql: DRAFT_TRIGGERS_SQL.bp_imap_draft_attachment_removed_releases_uid },
	]);
	assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list('message_attachments') WHERE \"table\" LIKE 'imap%'").get().n, 0);
	assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list('imap_message_uids') WHERE \"table\" = 'messages'").get().n, 0, "imap_message_uids has no foreign key to messages");
});

test("no upstream migration drops or renames a table Blue Pine attaches foreign keys or triggers to", () => {
	// When this fails during an upstream integration, follow UPSTREAM.md "Table rebuilds":
	// check what the rebuild does to Blue Pine rows and add a bpNNNN repair migration.
	for (const name of upstreamFiles) {
		const sql = readFileSync(join(migrationsDirectory, name), "utf8");
		for (const table of ANCHORED_UPSTREAM_TABLES) {
			assert.doesNotMatch(sql, new RegExp(`DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?[\`"]?${table}[\`"]?\\s*;`, "i"), `${name} drops ${table}`);
			assert.doesNotMatch(sql, new RegExp(`ALTER\\s+TABLE\\s+[\`"]?${table}[\`"]?\\s+RENAME\\s+TO`, "i"), `${name} renames ${table}`);
			assert.doesNotMatch(sql, new RegExp(`RENAME\\s+TO\\s+[\`"]?${table}[\`"]?`, "i"), `${name} rebuilds ${table}`);
		}
	}
});

test("all three runners order Blue Pine migrations after every upstream migration, in bpNNNN order", async (t) => {
	const tail = (list) => list.slice(-downstreamFiles.length);
	const head = (list) => list.slice(0, -downstreamFiles.length);
	const wrangler = wranglerOrder(files);
	assert.deepEqual(tail(wrangler), downstreamFiles, "wrangler d1 migrations apply");
	assert.ok(head(wrangler).every((name) => UPSTREAM_NAME.test(name)));

	const bundle = JSON.parse(read("src/lib/migrations/bundle.json")).migrations.map((migration) => migration.name);
	assert.equal(bundle.length, files.length);
	assert.deepEqual(tail(bundle), downstreamFiles, "Workers bundle runner");

	const database = openDatabase(t);
	const ran = await app.applyMigrations(database, migrationsDirectory);
	assert.equal(ran.length, files.length);
	assert.deepEqual(tail(ran), downstreamFiles, "Node runner");
	assert.deepEqual(appliedInOrder(database), ran);
	// The Node runner and the bundle may order upstream's journal-less files differently
	// (0021_add_api_keys_prefix_index); Blue Pine files are last in both, which is what the policy relies on.
	assert.deepEqual(new Set(head(ran)), new Set(head(bundle)));
});

test("Node runner: fresh database gets everything, an existing upstream-only database gets only the Blue Pine migrations, a restart applies nothing", async (t) => {
	const fresh = openDatabase(t);
	assert.equal((await app.applyMigrations(fresh, migrationsDirectory)).length, upstreamFiles.length + downstreamFiles.length);
	assert.deepEqual(await app.applyMigrations(fresh, migrationsDirectory), []);

	const existing = openDatabase(t);
	assert.equal((await app.applyMigrations(existing, upstreamOnlyDirectory(t))).length, upstreamFiles.length);
	assert.deepEqual(await app.applyMigrations(existing, migrationsDirectory), downstreamFiles);
	assert.deepEqual(await app.applyMigrations(existing, migrationsDirectory), []);

	const schema = (database) => database.db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
	assert.deepEqual(schema(existing), schema(fresh), "upgrade and fresh install end with the same schema");
});

test("Workers runner: an existing upstream-only database applies only the Blue Pine migrations, then reports ready", async (t) => {
	const database = openDatabase(t);
	await app.applyMigrations(database, upstreamOnlyDirectory(t));
	const status = await app.getMigrationStatus(database);
	assert.deepEqual({ pending: status.pending, unknown: status.unknown }, { pending: downstreamFiles, unknown: [] });
	const result = await app.applyPendingMigrations(database);
	assert.deepEqual(result.applied, downstreamFiles);
	assert.equal(result.ready, true);
	assert.deepEqual((await app.applyPendingMigrations(database)).applied, []);
	assert.deepEqual(appliedInOrder(database).slice(-downstreamFiles.length), downstreamFiles);
});

test("a migrated database has the Blue Pine table, indexes and triggers, and every table is covered by backups", async (t) => {
	const database = openDatabase(t);
	await app.applyMigrations(database, migrationsDirectory);
	const names = (type) => database.db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all(type).map((row) => row.name);
	for (const table of downstreamTables) assert.ok(names("table").includes(table), table);
	assert.deepEqual(names("trigger").filter((name) => name.startsWith("bp_")), [
		"bp_imap_draft_attachment_added_releases_uid",
		"bp_imap_draft_attachment_removed_releases_uid",
		"bp_imap_draft_content_releases_uid",
		"bp_imap_folders_monotonic",
		"bp_imap_membership_clears_deleted",
		"bp_imap_message_uids_advance_uid_next",
		"bp_imap_message_uids_immutable",
		"bp_mail_app_passwords_revoke_on_access_removal",
		"bp_mail_app_passwords_revoke_on_password_change",
	]);
	for (const index of ["mail_app_passwords_public_id_idx", "imap_folders_mailbox_key_idx", "imap_message_uids_folder_message_idx", "imap_message_uids_message_idx", "imap_unsubscribed_folders_mailbox_idx"]) assert.ok(names("index").includes(index), index);
	const covered = await app.assertBackupTablesCoverDatabase(database);
	for (const table of downstreamTables) assert.ok(covered.has(table));
	const exportSource = read("src/lib/backups/export.ts");
	for (const table of downstreamTables) {
		assert.match(exportSource.match(/const DOWNSTREAM_BACKUP_TABLES[^;]+;/)[0], new RegExp(`"${table}"`), `${table} is a downstream backup table`);
		assert.doesNotMatch(exportSource.match(/const BACKUP_TABLES[^;]+;/)[0], new RegExp(`"${table}"`), `${table} must not be named in includedTables`);
	}
});

test("UPSTREAM.md documents the namespace and lists every Blue Pine migration", () => {
	const upstream = read("UPSTREAM.md");
	assert.match(upstream, /## Downstream migrations/);
	assert.match(upstream, /bpNNNN_<snake_case_description>\.sql/);
	for (const name of downstreamFiles) assert.ok(upstream.includes(`\`${name}\``), `UPSTREAM.md lists ${name}`);
});

test("bp0004's content trigger watches exactly the columns draftFingerprint digests, every one of which exists, and attachment rows are never updated in place", async (t) => {
	// The fingerprint's row fields, from src/lib/email/canonical-message-utils.ts, mapped to
	// their `messages` columns through the upstream schema.
	const utilsSource = read("src/lib/email/canonical-message-utils.ts");
	const material = /const material = JSON\.stringify\(\[([\s\S]*?)attachments\.map/.exec(utilsSource)[1];
	const fields = [...material.matchAll(/row\.(\w+)/g)].map((match) => match[1]);
	const schema = read("src/db/schema/index.ts");
	const messagesTable = schema.slice(schema.indexOf("export const messages = sqliteTable("), schema.indexOf("export const", schema.indexOf("export const messages = sqliteTable(") + 1));
	const columns = fields.map((field) => new RegExp(`\\b${field}: text\\("(\\w+)"\\)`).exec(messagesTable)?.[1]);
	assert.ok(columns.every(Boolean), `every fingerprint field is a messages column: ${fields.join(", ")}`);
	const trigger = DRAFT_TRIGGERS_SQL.bp_imap_draft_content_releases_uid;
	const watched = /AFTER UPDATE OF (.*) ON `messages`/.exec(trigger)[1].split(", ").map((column) => column.replace(/`/g, ""));
	const compared = [...trigger.matchAll(/OLD\.`(\w+)` IS NOT NEW\.`\1`/g)].map((match) => match[1]);
	assert.deepEqual(watched, columns, "UPDATE OF lists the fingerprint's columns in order");
	assert.deepEqual(compared, columns, "WHEN compares every one of them");
	const database = openDatabase(t);
	await app.applyMigrations(database, migrationsDirectory);
	const existing = database.db.prepare("SELECT name FROM pragma_table_info('messages')").all().map((row) => row.name);
	// SQLite does not validate an UPDATE OF column list, so a misspelt column would silently never fire.
	for (const column of columns) assert.ok(existing.includes(column), `messages.${column} exists`);
	assert.ok(/draftFingerprint[\s\S]*?attachment\.id, attachment\.filename, attachment\.contentType, attachment\.size, attachment\.disposition, attachment\.contentId/.test(utilsSource), "the fingerprint covers attachments by their immutable row");
	const sources = spawnSync("grep", ["-rlE", "update\\(messageAttachments\\)|UPDATE\\s+`?message_attachments", join(root, "src"), join(root, "server")], { encoding: "utf8" });
	assert.equal(sources.stdout.trim(), "", "no code updates message_attachments rows in place (bp0004 watches INSERT and DELETE only)");
});

test("bp0004 upgrade: a database at bp0003 applies exactly bp0004 (and the Blue Pine migrations after it) on both runners, a restart applies nothing, and it ends with the fresh schema", async (t) => {
	const bp0004 = "bp0004_release_imap_draft_uid_on_content_change.sql";
	assert.ok(downstreamFiles.includes(bp0004));
	const before = mkdtempSync(join(tmpdir(), "mailflare-pre-bp0004-"));
	t.after(() => rmSync(before, { recursive: true, force: true }));
	cpSync(migrationsDirectory, before, { recursive: true });
	for (const name of downstreamFiles.slice(downstreamFiles.indexOf(bp0004))) rmSync(join(before, name));
	const schema = (database) => database.db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
	const fresh = openDatabase(t);
	await app.applyMigrations(fresh, migrationsDirectory);

	const node = openDatabase(t);
	await app.applyMigrations(node, before);
	assert.equal(node.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'bp_imap_draft_%'").get().n, 0);
	// bp0004 and the Blue Pine migrations after it (bp0005 onward), nothing else.
	const fromBp0004 = downstreamFiles.slice(downstreamFiles.indexOf(bp0004));
	assert.deepEqual(await app.applyMigrations(node, migrationsDirectory), fromBp0004, "Node runner: exactly bp0004 and its successors");
	assert.deepEqual(await app.applyMigrations(node, migrationsDirectory), [], "a restart applies nothing");
	assert.deepEqual(schema(node), schema(fresh));

	const workers = openDatabase(t);
	await app.applyMigrations(workers, before);
	assert.deepEqual((await app.getMigrationStatus(workers)).pending, fromBp0004);
	assert.deepEqual((await app.applyPendingMigrations(workers)).applied, fromBp0004, "Workers runner: exactly bp0004 and its successors");
	assert.deepEqual((await app.applyPendingMigrations(workers)).applied, []);
	assert.deepEqual(schema(workers).filter((row) => row.type === "trigger").map((row) => [row.name, row.sql.replace(/\s+/g, " ")]), schema(fresh).filter((row) => row.type === "trigger").map((row) => [row.name, row.sql.replace(/\s+/g, " ")]), "the bundle runner installs the same triggers");
});

test("bp0005 upgrade: a database at bp0004 with data applies exactly bp0005 on both runners, keeps every row, starts with every mailbox subscribed, and ends with the fresh schema", async (t) => {
	const bp0005 = "bp0005_add_imap_subscriptions.sql";
	assert.ok(downstreamFiles.includes(bp0005));
	const before = mkdtempSync(join(tmpdir(), "mailflare-pre-bp0005-"));
	t.after(() => rmSync(before, { recursive: true, force: true }));
	cpSync(migrationsDirectory, before, { recursive: true });
	for (const name of downstreamFiles.slice(downstreamFiles.indexOf(bp0005))) rmSync(join(before, name));
	const schema = (database) => database.db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
	const seed = (database) =>
		database.db.exec(`
			INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('user-a', 'a@example.test', 'h', 'A', 'admin', 1);
			INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-a', 'example.test', 'manual', 'active', 1);
			INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mbx-a', 'user-a', 'domain-1', 'a', 'personal', 1);
			INSERT INTO imap_folders (id, mailbox_id, folder_key, uid_validity, uid_next, created_at) VALUES ('imf-1', 'mbx-a', 'archive', 1790000000, 5, 1);
		`);
	const fresh = openDatabase(t);
	await app.applyMigrations(fresh, migrationsDirectory);

	const node = openDatabase(t);
	await app.applyMigrations(node, before);
	seed(node);
	assert.equal(node.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'imap_unsubscribed_folders'").get().n, 0);
	assert.deepEqual(await app.applyMigrations(node, migrationsDirectory), [bp0005], "Node runner: exactly bp0005");
	assert.deepEqual(await app.applyMigrations(node, migrationsDirectory), [], "a restart applies nothing");
	assert.deepEqual(schema(node), schema(fresh));
	assert.equal(node.db.prepare("SELECT COUNT(*) AS n FROM imap_unsubscribed_folders").get().n, 0, "no row: every existing mailbox stays subscribed");
	assert.deepEqual(node.db.prepare("SELECT folder_key, uid_validity, uid_next FROM imap_folders").all(), [{ folder_key: "archive", uid_validity: 1790000000, uid_next: 5 }], "existing IMAP state is untouched");
	// The table follows its anchors: deleting the mailbox or the user removes their rows.
	node.db.exec("INSERT INTO imap_unsubscribed_folders (user_id, mailbox_id, folder_key, created_at) VALUES ('user-a', 'mbx-a', 'archive', 1)");
	node.db.exec("DELETE FROM mailboxes WHERE id = 'mbx-a'");
	assert.equal(node.db.prepare("SELECT COUNT(*) AS n FROM imap_unsubscribed_folders").get().n, 0, "cascades with the mailbox");

	const workers = openDatabase(t);
	await app.applyMigrations(workers, before);
	assert.deepEqual((await app.getMigrationStatus(workers)).pending, [bp0005]);
	assert.deepEqual((await app.applyPendingMigrations(workers)).applied, [bp0005], "Workers runner: exactly bp0005");
	assert.deepEqual((await app.applyPendingMigrations(workers)).applied, []);
	assert.deepEqual(schema(workers).filter((row) => row.name.startsWith("imap_unsubscribed_folders")).map((row) => [row.type, row.name]), schema(fresh).filter((row) => row.name.startsWith("imap_unsubscribed_folders")).map((row) => [row.type, row.name]), "the bundle runner creates the same table and index");
});
