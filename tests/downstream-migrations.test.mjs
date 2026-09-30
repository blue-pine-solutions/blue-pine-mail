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
const ANCHORED_UPSTREAM_TABLES = ["users", "mailboxes", "domains", "mailbox_access", "messages"];
/**
 * Anchored tables where only the named, certified Blue Pine triggers may attach, and no
 * foreign key may (UPSTREAM.md, "IMAP \Deleted invariant (bp0003)"). Anything else on these
 * tables needs its own certification and an entry here first.
 */
const CERTIFIED_ONLY = { messages: ["bp_imap_membership_clears_deleted"] };
/** The exact certified bp0003 trigger, as SQLite stores it. */
const MEMBERSHIP_TRIGGER_SQL = "CREATE TRIGGER `bp_imap_membership_clears_deleted` AFTER UPDATE OF `mailbox_id`, `status`, `folder_id` ON `messages`\nWHEN OLD.`mailbox_id` IS NOT NEW.`mailbox_id` OR OLD.`status` IS NOT NEW.`status` OR OLD.`folder_id` IS NOT NEW.`folder_id`\nBEGIN\n\tUPDATE `imap_message_uids` SET `deleted` = 0 WHERE `message_id` = NEW.`id` AND `deleted` = 1;\nEND";
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
	// IMAP state (bp0002) reads `messages` and `folders` by join; the only attachment to
	// `messages` is bp0003's certified \Deleted invariant, and nothing attaches to `folders`.
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

test("bp0003's trigger on messages is exactly the certified \\Deleted invariant, and it is the only Blue Pine object on messages", async (t) => {
	const database = openDatabase(t);
	await app.applyMigrations(database, migrationsDirectory);
	const onMessages = database.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'messages' AND name LIKE 'bp\\_%' ESCAPE '\\'").all();
	assert.deepEqual(onMessages, [{ name: "bp_imap_membership_clears_deleted", sql: MEMBERSHIP_TRIGGER_SQL }]);
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
		"bp_imap_folders_monotonic",
		"bp_imap_membership_clears_deleted",
		"bp_imap_message_uids_advance_uid_next",
		"bp_imap_message_uids_immutable",
		"bp_mail_app_passwords_revoke_on_access_removal",
		"bp_mail_app_passwords_revoke_on_password_change",
	]);
	for (const index of ["mail_app_passwords_public_id_idx", "imap_folders_mailbox_key_idx", "imap_message_uids_folder_message_idx", "imap_message_uids_message_idx"]) assert.ok(names("index").includes(index), index);
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
