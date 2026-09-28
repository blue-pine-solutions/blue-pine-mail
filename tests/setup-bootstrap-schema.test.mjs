import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = join(root, "drizzle", "migrations");
const committedMigrations = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort();

// The Worker reads the git-ignored src/lib/migrations/bundle.json; regenerate it the way the build scripts do.
const generated = spawnSync(process.execPath, [join(root, "scripts", "generate-migration-bundle.mjs")], { encoding: "utf8" });
assert.equal(generated.status, 0, generated.stderr);

const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-setup-bundle-"));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { migrateCleanDatabase } from "./src/lib/setup/migration.ts";
			export { getMigrationStatus } from "./src/lib/migrations/service.ts";
		`,
		resolveDir: root,
		sourcefile: "setup-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, migrateCleanDatabase, getMigrationStatus } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
test.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

function freshDatabase(t) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-setup-"));
	const database = new SqliteDatabase(join(directory, "mailflare.sqlite"));
	// Close before removing the directory: Windows cannot delete an open SQLite file.
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return database;
}

function appliedMigrations(database) {
	return database.db.prepare("SELECT name FROM d1_migrations").all().map((row) => row.name).sort();
}

function assertRecordsCommittedMigrations(database) {
	const applied = appliedMigrations(database);
	for (const name of [
		"0013_add_license_settings.sql",
		"0021_add_mailbox_signature.sql",
		"0022_add_mailbox_auto_reply.sql",
		"0027_add_domain_sending_intent.sql",
		"0029_add_spam_protection.sql",
	]) {
		assert.ok(applied.includes(name), `d1_migrations is missing ${name}`);
	}
	assert.deepEqual(applied, committedMigrations);
}

function assertAcceptsCurrentInserts(database) {
	const db = database.db;
	db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('u', 'a@b.c', 'x', 'n', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, sending_requested, created_at) VALUES ('d', 'u', 'ex.com', 'z', 1, 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, signature, auto_reply_enabled, auto_reply_subject, auto_reply_body, created_at)
		VALUES ('m', 'u', 'd', 'admin', 'admin', 'sig', 0, 'Out of office', '', 1);
		INSERT INTO license_settings (id, instance_id, updated_at) VALUES ('default', 'inst', 1);
		INSERT INTO auto_reply_deliveries (id, mailbox_id, recipient, sent_at) VALUES ('ar', 'm', 'x@y.z', 1);
	`);
	assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'spam_protection_enabled'").get(), "users.spam_protection_enabled is missing");
	for (const table of ["spam_token_stats", "spam_reputation", "spam_feedback"]) {
		assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `${table} is missing`);
	}
}

test("setup bootstraps a clean database with every committed migration, so later deploys have nothing pending", async (t) => {
	const database = freshDatabase(t);
	assert.equal(await migrateCleanDatabase(database), true);
	assertRecordsCommittedMigrations(database);
	assert.deepEqual(await getMigrationStatus(database), { ready: true, pending: [], unknown: [] });
	assertAcceptsCurrentInserts(database);
});

test("the self-hosted runner records the same migrations and a second run applies nothing", async (t) => {
	const database = freshDatabase(t);
	await applyMigrations(database, migrationsDirectory);
	assertRecordsCommittedMigrations(database);
	assert.deepEqual(await applyMigrations(database, migrationsDirectory), []);
	assertAcceptsCurrentInserts(database);
});
