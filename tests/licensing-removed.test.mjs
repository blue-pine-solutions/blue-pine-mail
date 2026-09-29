import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

function sourceFiles(directory) {
	const files = [];
	for (const name of readdirSync(join(root, directory))) {
		const path = join(directory, name);
		if (statSync(join(root, path)).isDirectory()) files.push(...sourceFiles(path));
		else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(path);
	}
	return files;
}
const runtimeSources = [...sourceFiles("src"), ...sourceFiles("server"), ...sourceFiles("scripts"), "worker.ts", "worker-utils.ts"];

test("the upstream licensing layer and its UI are gone", () => {
	for (const path of ["src/lib/licenses", "src/app/api/licenses", "src/app/(admin)/licenses", "src/components/license-indicator.tsx", "src/components/license-required-overlay.tsx"]) {
		assert.ok(!existsSync(join(root, path)), `${path} should be removed`);
	}
	for (const file of runtimeSources) {
		const source = read(file);
		assert.doesNotMatch(source, /paymug/i, `${file} must not reference Paymug`);
		assert.doesNotMatch(source, /getLicenseEntitlements|@\/lib\/licenses|\/api\/licenses|LicenseIndicator/, `${file} must not use the removed licensing layer`);
		assert.doesNotMatch(source, /href:\s*"\/licenses"|"\/licenses"/, `${file} must not link to the removed Licenses page`);
	}
});

test("license_settings is kept for schema and backup compatibility only", () => {
	assert.match(read("src/db/schema/index.ts"), /export const licenseSettings = sqliteTable\("license_settings"/);
	assert.ok(existsSync(join(root, "drizzle/migrations/0013_add_license_settings.sql")));
	const exportSource = read("src/lib/backups/export.ts");
	assert.match(exportSource.match(/const BACKUP_TABLES[^;]+;/)[0], /"license_settings"/);
	assert.match(exportSource.match(/const REQUIRED_BACKUP_TABLES[^;]+;/)[0], /"license_settings"/);
	assert.match(read("src/lib/backups/table-groups.ts"), /"license_settings"/);
	// Nothing outside the schema and backup lists reads the table.
	for (const file of runtimeSources.filter((path) => !/src[\\/]db[\\/]schema|src[\\/]lib[\\/]backups/.test(path))) {
		assert.doesNotMatch(read(file), /licenseSettings|license_settings/, `${relative(root, join(root, file))} must not read license_settings`);
	}
});

const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-licensing-bundle-"));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { intakeIncomingMail } from "./src/lib/email/intake.ts";
			export { exportDatabaseRecords, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
			export { getMailboxAccessLevel } from "./src/lib/mailboxes/access.ts";
			export { getDb } from "./src/db/index.ts";
			export { GET as getBranding, PUT as putBranding } from "./src/app/api/branding/route.ts";
			export { GET as listAccounts } from "./src/app/api/accounts/route.ts";
			export { GET as listMailboxes } from "./src/app/api/mailboxes/route.ts";
			export { PATCH as updateForwarding } from "./src/app/api/settings/forwarding/route.ts";
		`,
		resolveDir: root,
		sourcefile: "licensing-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
test.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

const BASE = "http://mailflare.local";
const LEGACY_TEAM = "INSERT INTO license_settings (id, instance_id, instance_url, license_key_hash, plan, state, features, activated_at, validated_at, updated_at) VALUES ('default', 'legacy-instance', 'https://old.example.test', 'legacy-hash', 'team', 'active', '[\"branding\",\"accounts\"]', 1, 1, 1)";
const LEGACY_EXPIRED = "INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'legacy-instance', 'community', 'expired', 1)";

function setDisabledFeatures(t, value) {
	const saved = process.env.BLUEPINE_DISABLED_FEATURES;
	t.after(() => {
		if (saved === undefined) delete process.env.BLUEPINE_DISABLED_FEATURES;
		else process.env.BLUEPINE_DISABLED_FEATURES = saved;
	});
	if (value === undefined) delete process.env.BLUEPINE_DISABLED_FEATURES;
	else process.env.BLUEPINE_DISABLED_FEATURES = value;
}

async function openDatabase(t) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-licensing-"));
	const database = new app.SqliteDatabase(join(directory, "mailflare.sqlite"));
	// Close before removing the directory: Windows cannot delete an open SQLite file.
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await app.applyMigrations(database, join(root, "drizzle", "migrations"));
	return database;
}

/** Admin A with a personal mailbox, a shared inbox delegated to user B, forwarding configured, and the given legacy license row. */
async function install(t, legacyLicenseSql) {
	const database = await openDatabase(t);
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, forwarding_email, created_at) VALUES ('user-a', 'a@example.test', 'hash', 'A', 'admin', 'copy@outside.test', 1);
		INSERT INTO users (id, email, password_hash, name, role, created_by_user_id, created_at) VALUES ('user-b', 'b@example.test', 'hash', 'B', 'user', 'user-a', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-a', 'example.test', 'manual', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mbx-a', 'user-a', 'domain-1', 'a', 'personal', 1), ('mbx-sales', 'user-a', 'domain-1', 'sales', 'shared', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_by_user_id, created_at) VALUES ('mac-1', 'mbx-sales', 'user-b', 'read_only', 'user-a', 1);
		UPDATE app_settings SET app_name = 'Acme Mail' WHERE id = 'default';
		${legacyLicenseSql};
	`);
	return withEnvironment(t, database);
}

async function withEnvironment(t, database) {
	const env = { DB: database, BUCKET: { put: async () => {}, get: async () => null }, INBOUND_QUEUE: { send: async () => {} }, ASSETS: { fetch: async () => new Response("") } };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	return { database, env, tokenA: await app.createSession(env, "user-a") };
}

function call(handler, token, path, { method = "GET", body, form } = {}) {
	return handler(new Request(`${BASE}${path}`, {
		method,
		headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
		body: form ?? (body ? JSON.stringify(body) : undefined),
	}));
}

/** What a deployment actually offers, observed through the real routes and mail path. */
async function observedFeatures(context) {
	const branding = await (await call(app.getBranding, null, "/api/branding")).json();
	const form = new FormData();
	form.set("appName", "Renamed Mail");
	const renamed = (await call(app.putBranding, context.tokenA, "/api/branding", { method: "PUT", form })).status === 200;
	const accounts = (await call(app.listAccounts, context.tokenA, "/api/accounts")).status === 200;
	const canCreateShared = (await (await call(app.listMailboxes, context.tokenA, "/api/mailboxes")).json()).canCreateShared;
	const delegated = !!(await app.getMailboxAccessLevel(app.getDb(context.env), { id: "user-b", role: "user" }, "mbx-sales"));
	const forwardingChange = (await call(app.updateForwarding, context.tokenA, "/api/settings/forwarding", { method: "PATCH", body: { forwardingEmail: "copy@outside.test" } })).status === 200;
	const forwards = [];
	await app.intakeIncomingMail(context.env, { from: "x@elsewhere.test", to: "a@example.test", raw: new TextEncoder().encode("Subject: s\r\n\r\nb").buffer, headers: {} }, {
		reject: () => {},
		forward: async (destination) => { forwards.push(destination); return true; },
	});
	return {
		customBranding: branding.canCustomizeBranding && branding.appName !== "Blue Pine Solutions Mail" && renamed,
		multipleAccounts: accounts,
		sharedMailboxes: canCreateShared && delegated,
		accountForwarding: forwardingChange && forwards.length === 1,
	};
}

const ALL_ON = { customBranding: true, multipleAccounts: true, sharedMailboxes: true, accountForwarding: true };
const ALL_OFF = { customBranding: false, multipleAccounts: false, sharedMailboxes: false, accountForwarding: false };
const EVERY_FEATURE = "customBranding,multipleAccounts,sharedMailboxes,accountForwarding";

test("a legacy active Team license cannot turn on features the Blue Pine policy turns off", async (t) => {
	setDisabledFeatures(t, EVERY_FEATURE);
	const context = await install(t, LEGACY_TEAM);
	assert.deepEqual(await observedFeatures(context), ALL_OFF);
	assert.equal(context.database.db.prepare("SELECT plan || '/' || state AS value FROM license_settings").get().value, "team/active", "legacy row is left untouched");
});

test("an expired or community legacy license cannot turn off features the policy turns on", async (t) => {
	setDisabledFeatures(t, undefined);
	const context = await install(t, LEGACY_EXPIRED);
	assert.deepEqual(await observedFeatures(context), ALL_ON);
});

test("features work with no license row at all, and each follows only its own policy key", async (t) => {
	setDisabledFeatures(t, undefined);
	const context = await install(t, "DELETE FROM license_settings");
	assert.deepEqual(await observedFeatures(context), ALL_ON);
	for (const feature of Object.keys(ALL_ON)) {
		process.env.BLUEPINE_DISABLED_FEATURES = feature;
		const context2 = await install(t, LEGACY_TEAM);
		assert.deepEqual(await observedFeatures(context2), { ...ALL_ON, [feature]: false }, feature);
	}
});

test("backups still carry license_settings, restore it, and the restored row has no effect", async (t) => {
	setDisabledFeatures(t, EVERY_FEATURE);
	const source = await install(t, LEGACY_TEAM);
	const backup = await app.exportDatabaseRecords(source.database);
	const document = JSON.parse(new TextDecoder().decode(backup));
	assert.equal(document.format, "mailflare-database-backup");
	assert.ok(document.includedTables.includes("license_settings"));
	assert.deepEqual(document.tables.license_settings.map((row) => [row.plan, row.state]), [["team", "active"]]);

	const target = await openDatabase(t);
	await app.restoreDatabaseRecords(target, backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength));
	assert.equal(target.db.prepare("SELECT plan || '/' || state AS value FROM license_settings").get().value, "team/active");
	const restored = await withEnvironment(t, target);
	assert.deepEqual(await observedFeatures(restored), ALL_OFF, "restored Team data does not enable anything");
	delete process.env.BLUEPINE_DISABLED_FEATURES;
	assert.deepEqual(await observedFeatures(restored), ALL_ON);
});
