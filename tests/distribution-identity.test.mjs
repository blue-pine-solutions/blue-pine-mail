import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-identity-bundle-"));
await build({
	stdin: {
		contents: `
			export { DISTRIBUTION, getSourceUrl, getBuildCommit, SOURCE_PATH, ABOUT_PATH } from "./src/lib/distribution/identity.ts";
			export { GET as sourceRoute } from "./src/app/source/route.ts";
			export { default as AboutPage } from "./src/app/about/page.tsx";
			export { SourceNotice } from "./src/components/distribution/source-notice.tsx";
			export { resolveAppName } from "./src/lib/branding/utils.ts";
			export { MAILFLARE_FORWARDED_HEADER } from "./src/lib/email/account-forwarding.ts";
			export { createElement } from "react";
			export { renderToStaticMarkup } from "react-dom/server";
		`,
		resolveDir: root,
		sourcefile: "identity-test-entry.tsx",
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
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
test.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

const DOWNSTREAM = "https://github.com/blue-pine-solutions/blue-pine-mail";
const UPSTREAM = "https://github.com/hieunc229/mailflare";
const SHA = "d9f0b2fb15c27f41c79e1bb1983d27724de57626";

function withBuildCommit(t, value) {
	const saved = process.env.BLUEPINE_BUILD_COMMIT;
	t.after(() => {
		if (saved === undefined) delete process.env.BLUEPINE_BUILD_COMMIT;
		else process.env.BLUEPINE_BUILD_COMMIT = saved;
	});
	if (value === undefined) delete process.env.BLUEPINE_BUILD_COMMIT;
	else process.env.BLUEPINE_BUILD_COMMIT = value;
}

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("the distribution identity is Blue Pine Solutions Mail by Blue Pine Solutions, based on Mailflare, under the AGPL", () => {
	assert.equal(app.DISTRIBUTION.name, "Blue Pine Solutions Mail");
	assert.equal(app.DISTRIBUTION.vendor, "Blue Pine Solutions");
	assert.equal(app.DISTRIBUTION.sourceRepository, DOWNSTREAM);
	assert.equal(app.DISTRIBUTION.license, "AGPL-3.0-or-later");
	assert.match(app.DISTRIBUTION.licenseName, /GNU Affero General Public License v3\.0 or later/);
	assert.equal(app.DISTRIBUTION.licenseUrl, "https://www.gnu.org/licenses/agpl-3.0.html");
	assert.deepEqual(
		{ name: app.DISTRIBUTION.upstream.name, author: app.DISTRIBUTION.upstream.author, repository: app.DISTRIBUTION.upstream.repository },
		{ name: "Mailflare", author: "Hieu Nguyen", repository: UPSTREAM },
	);
	assert.equal(app.DISTRIBUTION.upstream.version, JSON.parse(read("package.json")).version, "upstream version is package.json's");
	assert.notEqual(app.DISTRIBUTION.version, app.DISTRIBUTION.upstream.version, "the Blue Pine version is its own");
});

test("/source redirects to the exact build when BLUEPINE_BUILD_COMMIT is valid, otherwise to the repository", async (t) => {
	withBuildCommit(t, SHA);
	let response = app.sourceRoute();
	assert.equal(response.status, 302);
	assert.equal(response.headers.get("location"), `${DOWNSTREAM}/tree/${SHA}`);
	for (const value of [undefined, "", "not-a-sha", "main", `${SHA}/../x`]) {
		withBuildCommit(t, value);
		response = app.sourceRoute();
		assert.equal(response.headers.get("location"), DOWNSTREAM, String(value));
	}
});

test("the About page states the identity, attribution, license and exact-build source", async (t) => {
	withBuildCommit(t, SHA);
	const html = app.renderToStaticMarkup(app.createElement(app.AboutPage));
	const visible = text(html);
	for (const phrase of ["About Blue Pine Solutions Mail", "Distributed by Blue Pine Solutions", `Mailflare ${app.DISTRIBUTION.upstream.version} by Hieu Nguyen`, SHA, "independent downstream distribution of Mailflare", "not affiliated with or endorsed by the Mailflare project or its author", "Mailflare is copyright Hieu Nguyen", "GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)", "without any warranty", "Corresponding Source"]) {
		assert.ok(visible.includes(phrase), `About page should say: ${phrase}`);
	}
	assert.ok(html.includes(`href="${DOWNSTREAM}/tree/${SHA}"`), "links the exact build");
	assert.ok(html.includes(`href="${UPSTREAM}"`), "links upstream Mailflare");
	assert.ok(html.includes('href="https://www.gnu.org/licenses/agpl-3.0.html"'));

	withBuildCommit(t, undefined);
	const fallback = app.renderToStaticMarkup(app.createElement(app.AboutPage));
	assert.ok(text(fallback).includes("Not recorded for this build"));
	assert.ok(fallback.includes(`href="${DOWNSTREAM}"`), "falls back to the repository");
});

test("the persistent source notice links Source and About and names the distribution", () => {
	const full = app.renderToStaticMarkup(app.createElement(app.SourceNotice));
	assert.ok(full.includes('href="/source"') && full.includes('href="/about"'));
	assert.ok(text(full).includes(`Blue Pine Solutions Mail ${app.DISTRIBUTION.version}, based on Mailflare`));
	const compact = app.renderToStaticMarkup(app.createElement(app.SourceNotice, { compact: true }));
	assert.ok(compact.includes('href="/source"') && compact.includes('href="/about"'));
	// It is shown in the app sidebar (dashboard, settings, admin) and on the sign-in and setup screens.
	assert.match(read("src/components/sidebar-footer.tsx"), /<SourceNotice compact[\s\S]*<SourceNotice className/);
	assert.match(read("src/components/auth/auth-shell.tsx"), /<SourceNotice /);
	assert.doesNotMatch(read("src/components/sidebar-footer.tsx"), /mailflare\.co|Powered by/);
});

test("branding and compatibility identifiers are unchanged", () => {
	assert.equal(app.resolveAppName("Mailflare"), "Blue Pine Solutions Mail", "upstream seeded default still reads as uncustomized");
	assert.equal(app.resolveAppName("Acme Mail"), "Acme Mail", "a real custom name is kept");
	assert.equal(app.MAILFLARE_FORWARDED_HEADER, "X-Mailflare-Forwarded");
	for (const path of ["src/lib/distribution/identity.ts", "src/app/about/page.tsx", "src/app/source/route.ts", "src/components/distribution/source-notice.tsx"]) {
		assert.doesNotMatch(read(path), /paymug|@\/lib\/licenses|getLicenseEntitlements/i, path);
	}
});
