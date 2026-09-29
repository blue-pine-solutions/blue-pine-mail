import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-consistency-bundle-"));
await build({
	stdin: {
		contents: `
			export { brandedTitle, DEFAULT_BRANDING, fetchBranding } from "./src/components/branding-provider-utils.ts";
			export { resolveAppName } from "./src/lib/branding/utils.ts";
			export { showBrowserNewMessageNotification } from "./src/hooks/message-realtime-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "consistency-test-entry.ts",
		loader: "ts",
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
const app = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
test.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

const DEFAULT = "Blue Pine Solutions Mail";

test("the application-level title follows the resolved app name; route-specific titles are left alone", () => {
	assert.equal(app.brandedTitle(DEFAULT, DEFAULT), DEFAULT, "default branding keeps the default title");
	assert.equal(app.brandedTitle(DEFAULT, "Acme Mail"), "Acme Mail", "custom branding replaces the default title");
	assert.equal(app.brandedTitle(DEFAULT, app.resolveAppName("Blue Pine Mail")), DEFAULT, "the 0.1.x stored default still reads as default");
	for (const routeTitle of ["About Blue Pine Solutions Mail", "Inbox (45)", "Drafts", "Acme Mail"]) {
		assert.equal(app.brandedTitle(routeTitle, "Acme Mail"), routeTitle, routeTitle);
	}
});

test("when branding cannot be read, the default identity (and so the default title) is used", async (t) => {
	const realFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = realFetch; });
	globalThis.fetch = async () => new Response("unavailable", { status: 503 });
	const branding = await app.fetchBranding();
	assert.deepEqual(branding, app.DEFAULT_BRANDING);
	assert.equal(app.brandedTitle(DEFAULT, branding.appName), DEFAULT);
});

test("the branding provider keeps re-applying the configured name when the default title comes back", () => {
	const provider = read("src/components/branding-provider.tsx");
	assert.match(provider, /if \(!loaded \|\| branding\.appName === DEFAULT_BRANDING\.appName\) return;/, "only a loaded, customized name is applied");
	assert.match(provider, /brandedTitle\(document\.title, branding\.appName\)/);
	assert.match(provider, /new MutationObserver\(apply\)[\s\S]*observe\(document\.head, \{ subtree: true, childList: true, characterData: true \}\)[\s\S]*observer\.disconnect\(\)/, "client navigation that restores the default title is caught, and the observer is cleaned up");
	assert.match(read("src/app/about/page.tsx"), /title: `About \$\{DISTRIBUTION\.name\}`/, "About keeps its distribution title");
});

test("browser notifications use the branding-aware icon route, and nothing else about them changes", (t) => {
	const created = [];
	const saved = { Notification: globalThis.Notification, document: globalThis.document, window: globalThis.window };
	t.after(() => Object.assign(globalThis, saved));
	globalThis.Notification = class { static permission = "granted"; constructor(title, options) { created.push({ title, options }); } close() {} };
	globalThis.document = { visibilityState: "hidden" };
	globalThis.window = { localStorage: { getItem: () => null }, focus() {}, location: { assign() {} } };
	app.showBrowserNewMessageNotification({ messageId: "msg-1", subject: "Hello", from: "a@example.test", fromName: "Ann" });
	assert.equal(created.length, 1);
	assert.deepEqual(created[0], { title: "Hello", options: { body: "From Ann", icon: "/api/branding/icon", tag: "msg-1" } });

	const sources = [];
	const visit = (path) => statSync(join(root, path)).isDirectory() ? readdirSync(join(root, path)).forEach((name) => visit(`${path}/${name}`)) : /\.(ts|tsx)$/.test(path) && sources.push(path);
	visit("src");
	for (const path of sources) {
		const source = read(path);
		for (const match of source.matchAll(/new Notification\([\s\S]*?\}\)/g)) assert.doesNotMatch(match[0], /icon-96\.png|icon-192\.png/, `${path} hard-codes a packaged icon for a notification`);
	}
});

test("the favicon is declared once, through the branding-aware metadata route", () => {
	const layout = read("src/app/layout.tsx");
	assert.match(layout, /icons: \{ icon: "\/api\/branding\/icon" \}/);
	assert.doesNotMatch(layout, /<link rel="icon"/, "no second hand-written favicon link");
	assert.match(read("src/app/api/branding/icon/route.ts"), /env\.ASSETS\.fetch\("https:\/\/mailflare\.local\/icon-96\.png"\)/, "the route still falls back to the packaged app mark");
});
