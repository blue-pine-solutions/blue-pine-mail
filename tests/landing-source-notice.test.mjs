import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-landing-bundle-"));
await build({
	stdin: {
		contents: `
			export { default as HomePage } from "./src/app/page.tsx";
			export { DISTRIBUTION } from "./src/lib/distribution/identity.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { renderToStaticMarkup } from "react-dom/server";
		`,
		resolveDir: root,
		sourcefile: "landing-test-entry.tsx",
		loader: "tsx",
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

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function install(t) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-landing-"));
	const database = new app.SqliteDatabase(join(directory, "mailflare.sqlite"));
	// Close before removing the directory: Windows cannot delete an open SQLite file.
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await app.applyMigrations(database, join(root, "drizzle", "migrations"));
	globalThis.__mailflareNodeEnv = { DB: database };
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	return database;
}

const renderHome = async () => app.renderToStaticMarkup(await app.HomePage());

function assertSourceNotice(html) {
	assert.ok(html.includes('href="/source"'), "the public landing page links /source");
	assert.ok(html.includes('href="/about"'), "the public landing page links /about");
	assert.ok(text(html).includes(`${app.DISTRIBUTION.name} ${app.DISTRIBUTION.version}, based on ${app.DISTRIBUTION.upstream.name}`), "the notice names the distribution");
}

test("the public landing page offers Source and About under the default identity", async (t) => {
	await install(t);
	const html = await renderHome();
	assertSourceNotice(html);
	assert.ok(html.includes('aria-label="Blue Pine Mail home"'), "the uncustomized app name is Blue Pine Mail");
});

test("custom branding renames the landing page but the source notice still names Blue Pine Mail", async (t) => {
	const database = await install(t);
	database.db.prepare("UPDATE app_settings SET app_name = ? WHERE id = 'default'").run("Acme Mail");
	const html = await renderHome();
	assert.ok(html.includes('aria-label="Acme Mail home"'), "the customer's app name is shown");
	assertSourceNotice(html);
});
