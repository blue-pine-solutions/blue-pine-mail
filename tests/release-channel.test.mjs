import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-release-bundle-"));
await build({
	stdin: {
		contents: `
			export { parseReleaseTag, compareVersions, getReleaseSource, selectApprovedReleases, checkForRelease } from "./src/lib/distribution/releases.ts";
			export { DISTRIBUTION, getSourceUrl } from "./src/lib/distribution/identity.ts";
			export { describeRelease } from "./src/components/admin-update-card-utils.ts";
			export * as updateRoute from "./src/app/api/admin/update/route.ts";
			export { GET as migrationStatus } from "./src/app/api/admin/migrations/route.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { MAILFLARE_FORWARDED_HEADER } from "./src/lib/email/account-forwarding.ts";
		`,
		resolveDir: root,
		sourcefile: "release-test-entry.ts",
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

const release = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, html_url: "https://evil.example/phish", ...extra });
const SOURCE = { owner: "blue-pine-solutions", repository: "blue-pine-mail" };

/** A stand-in for GitHub that records what was asked. */
function fakeGitHub(respond) {
	const calls = [];
	const fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return respond(String(url));
	};
	return { calls, fetch };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("only bluepine-vMAJOR.MINOR.PATCH tags count as approved releases", () => {
	assert.equal(app.parseReleaseTag("bluepine-v0.1.1"), "0.1.1");
	assert.equal(app.parseReleaseTag("bluepine-v10.0.3"), "10.0.3");
	for (const tag of ["v0.5.0", "0.5.0", "mailflare-v0.5.0", "bluepine-v0.1", "bluepine-v0.1.1-rc1", "bluepine-v01.2.3", "bluepine-v1.2.3 ", "Bluepine-v1.2.3", "bluepine-v1.2.3/../x", "main", "", 123, null]) {
		assert.equal(app.parseReleaseTag(tag), null, String(tag));
	}
	assert.ok(app.compareVersions("0.2.0", "0.1.9") > 0);
	assert.ok(app.compareVersions("0.1.0", "0.1.0") === 0);
	assert.ok(app.compareVersions("0.9.9", "1.0.0") < 0);
	assert.throws(() => app.compareVersions("0.4", "0.1.0"));
});

test("the release source is the Blue Pine repository, never upstream Mailflare", () => {
	assert.deepEqual(app.getReleaseSource({}), SOURCE);
	assert.deepEqual(app.getReleaseSource({ BLUEPINE_RELEASE_REPOSITORY: "blue-pine/mail" }), { owner: "blue-pine", repository: "mail" });
	for (const bad of ["not-a-repo", "a/b/c", "https://github.com/x/y", "../x", "a/..", "a b/c"]) {
		assert.equal(app.getReleaseSource({ BLUEPINE_RELEASE_REPOSITORY: bad }), null, bad);
	}
	for (const path of ["src/lib/distribution/releases.ts", "src/app/api/admin/update/GET.ts", "src/app/api/admin/update/utils.ts", "src/components/admin-update-card.tsx", "src/components/admin-update-card-utils.ts"]) {
		assert.doesNotMatch(read(path), /hieunc229|UPDATE_SOURCE_REPOSITORY|actions\/workflows|dispatches/, path);
	}
});

test("drafts, prereleases, upstream tags and response-supplied URLs are ignored", () => {
	const approved = app.selectApprovedReleases([
		release("bluepine-v0.1.2"),
		release("bluepine-v0.9.0", { draft: true }),
		release("bluepine-v0.8.0", { prerelease: true }),
		release("v0.5.0"),
		release("bluepine-v0.3.0"),
		{ tag_name: "bluepine-v0.7.0" },
		"junk",
		null,
	], SOURCE);
	assert.deepEqual(approved.map((row) => row.version), ["0.3.0", "0.1.2"]);
	assert.equal(approved[0].releaseUrl, "https://github.com/blue-pine-solutions/blue-pine-mail/releases/tag/bluepine-v0.3.0");
	assert.deepEqual(app.selectApprovedReleases({ message: "not a list" }, SOURCE), []);
});

test("checkForRelease compares Blue Pine versions and asks only the Blue Pine repository", async () => {
	assert.equal(app.DISTRIBUTION.version, "0.1.0");
	const newer = fakeGitHub(() => json([release("bluepine-v0.1.1"), release("v0.5.0")]));
	const result = await app.checkForRelease({ env: {}, fetch: newer.fetch });
	assert.deepEqual(result, { state: "update-available", installed: "0.1.0", latest: "0.1.1", tag: "bluepine-v0.1.1", releaseUrl: "https://github.com/blue-pine-solutions/blue-pine-mail/releases/tag/bluepine-v0.1.1", source: "blue-pine-solutions/blue-pine-mail" });
	assert.equal(newer.calls.length, 1);
	assert.equal(newer.calls[0].url, "https://api.github.com/repos/blue-pine-solutions/blue-pine-mail/releases?per_page=30");
	assert.ok(newer.calls[0].init.signal, "requests carry a timeout");
	assert.equal(newer.calls[0].init.headers.Authorization, undefined, "no credentials are sent");

	assert.equal((await app.checkForRelease({ env: {}, fetch: fakeGitHub(() => json([release("bluepine-v0.1.0")])).fetch })).state, "up-to-date");
	// Upstream's version number (0.4.0 here) is not a Blue Pine release and is never offered.
	const upstreamOnly = await app.checkForRelease({ env: {}, fetch: fakeGitHub(() => json([release("v0.4.0"), release("v0.5.0")])).fetch });
	assert.deepEqual(upstreamOnly, { state: "no-releases", installed: "0.1.0", source: "blue-pine-solutions/blue-pine-mail" });
	assert.equal((await app.checkForRelease({ env: {}, fetch: fakeGitHub(() => json([])).fetch })).state, "no-releases");
});

test("checkForRelease fails gracefully and never throws", async () => {
	const cases = [
		["private or renamed repository", () => json({ message: "Not Found" }, 404)],
		["rate limited", () => json({ message: "API rate limit exceeded" }, 403)],
		["too many requests", () => json({}, 429)],
		["server error", () => json({}, 502)],
		["malformed JSON", () => new Response("{not json", { status: 200 })],
		["oversized body", () => new Response("[" + " ".repeat(1_100_000) + "]", { status: 200 })],
		["network failure", () => { throw new TypeError("fetch failed"); }],
	];
	for (const [label, respond] of cases) {
		const result = await app.checkForRelease({ env: {}, fetch: fakeGitHub(respond).fetch });
		assert.equal(result.state, "unavailable", label);
		assert.equal(result.installed, "0.1.0", label);
		assert.ok(result.reason.length > 0, label);
	}
	assert.equal((await app.checkForRelease({ env: { BLUEPINE_RELEASE_REPOSITORY: "bad value" }, fetch: () => { throw new Error("must not be called"); } })).state, "unavailable");
	assert.match(app.describeRelease({ state: "unavailable", installed: "0.1.0", source: "x", reason: "The release source could not be reached" }, "Blue Pine Mail"), /Could not check for Blue Pine Mail releases/);
	assert.match(app.describeRelease({ state: "update-available", installed: "0.1.0", latest: "0.1.1", tag: "t", releaseUrl: "u", source: "s" }, "Blue Pine Mail"), /^Blue Pine Mail 0\.1\.1 is available\. Deploy it/);
});

test("the update API is admin-only, check-only, and reports Blue Pine and upstream versions separately", async (t) => {
	assert.deepEqual(Object.keys(app.updateRoute).sort(), ["GET"], "no POST: the app cannot trigger a deployment");
	assert.ok(!existsSync(join(root, "src/app/api/admin/update/POST.ts")));
	assert.ok(!existsSync(join(root, ".github/workflows/deploy-update.yml")), "the workflow that replaced the repository with upstream is gone");

	const directory = mkdtempSync(join(tmpdir(), "mailflare-release-"));
	const database = new app.SqliteDatabase(join(directory, "mailflare.sqlite"));
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await app.applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('admin-1', 'admin@example.test', 'hash', 'Admin', 'admin', 1);
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('user-1', 'user@example.test', 'hash', 'User', 'user', 1);
	`);
	const env = { DB: database };
	globalThis.__mailflareNodeEnv = env;
	const realFetch = globalThis.fetch;
	const github = fakeGitHub(() => json([release("bluepine-v0.2.0")]));
	globalThis.fetch = github.fetch;
	t.after(() => {
		globalThis.fetch = realFetch;
		delete globalThis.__mailflareNodeEnv;
	});
	const call = (handler, token) => handler(new Request("http://mailflare.local/api/admin/update", { headers: token ? { Authorization: `Bearer ${token}` } : {} }));

	assert.equal((await call(app.updateRoute.GET)).status, 401);
	assert.equal((await call(app.updateRoute.GET, await app.createSession(env, "user-1"))).status, 403);
	assert.equal((await call(app.migrationStatus, await app.createSession(env, "user-1"))).status, 403);
	assert.equal(github.calls.length, 0, "unauthorized requests never reach the release source");

	const adminToken = await app.createSession(env, "admin-1");
	const response = await call(app.updateRoute.GET, adminToken);
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body.installed, { name: "Blue Pine Mail", version: "0.1.0", buildCommit: null, upstream: { name: "Mailflare", version: JSON.parse(read("package.json")).version } });
	assert.equal(body.release.state, "update-available");
	assert.equal(body.release.latest, "0.2.0");

	const migrations = await call(app.migrationStatus, adminToken);
	assert.equal(migrations.status, 200);
	assert.equal((await migrations.json()).ready, true, "migration status still works");
});

test("the update UI is Blue Pine's, startup never checks releases, and other identities are unchanged", () => {
	const card = read("src/components/admin-update-card.tsx") + read("src/components/admin-update-card-utils.ts");
	for (const phrase of ["Update Mailflare", "Sync the latest Mailflare release", "Mailflare v", "Deploy the matching Mailflare release", "triggerApplicationUpdate"]) {
		assert.ok(!card.includes(phrase), `update UI still contains: ${phrase}`);
	}
	assert.match(card, /Version and updates/);
	assert.match(card, /Update database/, "migration controls remain");
	assert.doesNotMatch(read("src/lib/migrations/service.ts"), /Mailflare release/);
	for (const path of ["server/index.ts", "worker.ts", "src/app/layout.tsx", "src/lib/email/intake.ts"]) {
		assert.doesNotMatch(read(path), /distribution\/releases|checkForRelease/, `${path} must not check releases`);
	}
	assert.equal(app.getSourceUrl(null), "https://github.com/blue-pine-solutions/blue-pine-mail", "/source still serves the running build, not the latest release");
	assert.equal(app.getSourceUrl("abcdef1"), "https://github.com/blue-pine-solutions/blue-pine-mail/tree/abcdef1");
	assert.equal(app.MAILFLARE_FORWARDED_HEADER, "X-Mailflare-Forwarded");
	for (const path of ["src/lib/distribution/releases.ts", "src/app/api/admin/update/GET.ts", "src/components/admin-update-card.tsx"]) {
		assert.doesNotMatch(read(path), /paymug|getLicenseEntitlements/i, path);
	}
});
