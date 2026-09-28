import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-branding-bundle-"));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { BrandingDisabledError, getBranding, updateBranding } from "./src/lib/branding/service.ts";
			export { resolveAppName } from "./src/lib/branding/utils.ts";
			export { GET as getBrandingRoute, PUT as putBrandingRoute } from "./src/app/api/branding/route.ts";
			export { GET as getBrandingIconRoute } from "./src/app/api/branding/icon/route.ts";
		`,
		resolveDir: root,
		sourcefile: "branding-test-entry.ts",
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
const {
	SqliteDatabase, applyMigrations, createSession, BrandingDisabledError, getBranding, updateBranding, resolveAppName,
	getBrandingRoute, putBrandingRoute, getBrandingIconRoute,
} = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
test.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

const DEFAULT_ICON = new Uint8Array([1, 2, 3]);
const CUSTOM_ICON = new Uint8Array([9, 8, 7, 6]);
const LICENSE_WORDING = /license|\bpro\b|\bteam\b|paymug|upgrade/i;

function setDisabledFeatures(t, value) {
	const saved = process.env.BLUEPINE_DISABLED_FEATURES;
	t.after(() => {
		if (saved === undefined) delete process.env.BLUEPINE_DISABLED_FEATURES;
		else process.env.BLUEPINE_DISABLED_FEATURES = saved;
	});
	if (value === undefined) delete process.env.BLUEPINE_DISABLED_FEATURES;
	else process.env.BLUEPINE_DISABLED_FEATURES = value;
}

/** A migrated install (migration 0012 seeds app_name = 'Mailflare') with an admin session, served as the Node runtime env. */
async function install(t) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-branding-"));
	const database = new SqliteDatabase(join(directory, "mailflare.sqlite"));
	// Close before removing the directory: Windows cannot delete an open SQLite file.
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('admin-1', 'admin@example.com', 'hash', 'Admin', 'admin', 1)");
	const objects = new Map();
	const env = {
		DB: database,
		BUCKET: {
			put: async (key, value, options) => { objects.set(key, { bytes: new Uint8Array(value), contentType: options?.httpMetadata?.contentType }); },
			get: async (key) => {
				const object = objects.get(key);
				return object ? { body: object.bytes, httpMetadata: { contentType: object.contentType } } : null;
			},
			delete: async (key) => { objects.delete(key); },
		},
		ASSETS: { fetch: async () => new Response(DEFAULT_ICON, { headers: { "Content-Type": "image/png" } }) },
	};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const token = await createSession(env, "admin-1");
	const storedName = () => database.db.prepare("SELECT app_name FROM app_settings WHERE id = 'default'").get()?.app_name;
	const storedIconKey = () => database.db.prepare("SELECT icon_key FROM app_settings WHERE id = 'default'").get()?.icon_key;
	return { database, env, token, storedName, storedIconKey };
}

function putBranding(token, appName, icon) {
	const form = new FormData();
	form.set("appName", appName);
	if (icon) form.set("icon", new File([icon], "icon.png", { type: "image/png" }));
	return putBrandingRoute(new Request("http://mailflare.local/api/branding", { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: form }));
}

async function iconBytes() {
	return new Uint8Array(await (await getBrandingIconRoute(new Request("http://mailflare.local/api/branding/icon"))).arrayBuffer());
}

test("an empty or upstream-default stored name resolves to Blue Pine Mail; any other name is kept", () => {
	assert.equal(resolveAppName(undefined), "Blue Pine Mail");
	assert.equal(resolveAppName(null), "Blue Pine Mail");
	assert.equal(resolveAppName(""), "Blue Pine Mail");
	assert.equal(resolveAppName("Mailflare"), "Blue Pine Mail");
	assert.equal(resolveAppName("Acme Mail"), "Acme Mail");
	assert.equal(resolveAppName("mailflare"), "mailflare", "only the exact seeded value counts as uncustomized");
});

test("an installation without a stored name shows Blue Pine Mail", async (t) => {
	setDisabledFeatures(t, undefined);
	const { database, env } = await install(t);
	database.db.exec("DELETE FROM app_settings");
	assert.deepEqual(await getBranding(env), { appName: "Blue Pine Mail", hasCustomIcon: false, canCustomizeBranding: true });
});

test("the upstream seeded 'Mailflare' shows Blue Pine Mail without rewriting the database", async (t) => {
	setDisabledFeatures(t, undefined);
	const { env, storedName } = await install(t);
	assert.equal(storedName(), "Mailflare");
	const response = await getBrandingRoute();
	assert.deepEqual(await response.json(), { appName: "Blue Pine Mail", hasCustomIcon: false, canCustomizeBranding: true });
	assert.equal((await getBranding(env)).appName, "Blue Pine Mail");
	assert.equal(storedName(), "Mailflare");
});

test("with custom branding enabled an admin can set a name and icon without any license", async (t) => {
	setDisabledFeatures(t, undefined);
	const { database, token, storedName, storedIconKey } = await install(t);
	assert.equal(database.db.prepare("SELECT state FROM license_settings").get()?.state ?? "inactive", "inactive");
	const response = await putBranding(token, "Acme Mail", CUSTOM_ICON);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { appName: "Acme Mail", hasCustomIcon: true, canCustomizeBranding: true });
	assert.equal(storedName(), "Acme Mail");
	assert.equal(storedIconKey(), "branding/app-icon");
	assert.deepEqual(await iconBytes(), CUSTOM_ICON);
	assert.deepEqual(await (await getBrandingRoute()).json(), { appName: "Acme Mail", hasCustomIcon: true, canCustomizeBranding: true });
});

test("with custom branding disabled, changes are refused by policy and saved branding is kept", async (t) => {
	setDisabledFeatures(t, undefined);
	const { env, token, storedName, storedIconKey } = await install(t);
	assert.equal((await putBranding(token, "Acme Mail", CUSTOM_ICON)).status, 200);

	process.env.BLUEPINE_DISABLED_FEATURES = "customBranding";
	const response = await putBranding(token, "Other Mail");
	assert.equal(response.status, 403);
	const { error } = await response.json();
	assert.equal(error, "Custom branding is turned off for this deployment");
	assert.doesNotMatch(error, LICENSE_WORDING);
	await assert.rejects(updateBranding(env, { appName: "Other Mail" }), (thrown) => thrown instanceof BrandingDisabledError);

	assert.deepEqual(await (await getBrandingRoute()).json(), { appName: "Blue Pine Mail", hasCustomIcon: false, canCustomizeBranding: false });
	assert.deepEqual(await iconBytes(), DEFAULT_ICON);
	assert.equal(storedName(), "Acme Mail");
	assert.equal(storedIconKey(), "branding/app-icon");

	delete process.env.BLUEPINE_DISABLED_FEATURES;
	assert.deepEqual(await getBranding(env), { appName: "Acme Mail", hasCustomIcon: true, canCustomizeBranding: true });
	assert.deepEqual(await iconBytes(), CUSTOM_ICON);
});

test("disabling other features leaves custom branding on", async (t) => {
	setDisabledFeatures(t, "multipleAccounts,sharedMailboxes,accountForwarding,gravatar");
	const { token } = await install(t);
	assert.equal((await putBranding(token, "Acme Mail")).status, 200);
});
