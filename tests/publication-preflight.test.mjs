import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { verifyPublicSource, readSourceRepository } = await import(pathToFileURL(join(root, "scripts", "verify-public-source.mjs")).href);

const REPOSITORY = "https://github.com/blue-pine-solutions/blue-pine-mail";
const API = "https://api.github.com/repos/blue-pine-solutions/blue-pine-mail";
const SHA = "4fc0950888c7417b0d97cceecf4f34cd1649e860";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A stand-in for the public GitHub API: routes maps a URL to a response factory; anything else is a 404. */
function fakeGitHub(routes) {
	const calls = [];
	const fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		const respond = routes[String(url)];
		return respond ? respond() : json({ message: "Not Found" }, 404);
	};
	return { calls, fetch };
}

const published = (overrides = {}) => ({
	[API]: () => json({ full_name: "blue-pine-solutions/blue-pine-mail", private: false, visibility: "public" }),
	[`${API}/commits/${SHA}`]: () => json({ sha: SHA }),
	[`${API}/compare/${SHA}...main?per_page=1`]: () => json({ status: "ahead", merge_base_commit: { sha: SHA } }),
	...overrides,
});

test("the preflight checks the shipped source repository", () => {
	assert.equal(readSourceRepository(), REPOSITORY);
});

test("a full commit contained in public main is publication-ready, and nothing is sent with a token or a write method", async () => {
	const github = fakeGitHub(published());
	assert.deepEqual(await verifyPublicSource({ commit: SHA, repository: REPOSITORY, fetch: github.fetch }), { ok: true, sourceUrl: `${REPOSITORY}/tree/${SHA}` });
	const identical = fakeGitHub(published({ [`${API}/compare/${SHA}...main?per_page=1`]: () => json({ status: "identical", merge_base_commit: { sha: SHA } }) }));
	assert.equal((await verifyPublicSource({ commit: SHA.toUpperCase(), repository: REPOSITORY, fetch: identical.fetch })).ok, true, "the tip of main itself is published");
	for (const call of github.calls) {
		assert.ok(call.url.startsWith("https://api.github.com/"), call.url);
		assert.equal(call.init?.method ?? "GET", "GET");
		assert.ok(!Object.keys(call.init?.headers ?? {}).some((name) => name.toLowerCase() === "authorization"), "no token is sent");
	}
});

test("malformed commits and repositories are rejected before any request", async () => {
	for (const commit of [undefined, "", "4fc0950", "zz" + SHA.slice(2), `${SHA}0`, "HEAD", "main"]) {
		const github = fakeGitHub(published());
		const result = await verifyPublicSource({ commit, repository: REPOSITORY, fetch: github.fetch });
		assert.equal(result.ok, false, String(commit));
		assert.equal(github.calls.length, 0);
	}
	for (const repository of ["blue-pine-solutions/blue-pine-mail", "https://gitlab.com/a/b", "https://github.com/a", "https://github.com/a/b/c", "https://github.com/a/.."]) {
		assert.equal((await verifyPublicSource({ commit: SHA, repository, fetch: fakeGitHub(published()).fetch })).ok, false, repository);
	}
});

test("a missing commit, a commit outside main, or the wrong repository fails", async () => {
	const missing = await verifyPublicSource({ commit: SHA, repository: REPOSITORY, fetch: fakeGitHub(published({ [`${API}/commits/${SHA}`]: () => json({ message: "No commit found" }, 422) })).fetch });
	assert.equal(missing.ok, false);
	const notFound = await verifyPublicSource({ commit: SHA, repository: REPOSITORY, fetch: fakeGitHub(published({ [`${API}/commits/${SHA}`]: undefined })).fetch });
	assert.equal(notFound.ok, false);
	for (const comparison of [{ status: "diverged", merge_base_commit: { sha: "0".repeat(40) } }, { status: "behind", merge_base_commit: { sha: SHA } }, { status: "ahead", merge_base_commit: { sha: "1".repeat(40) } }, {}]) {
		const result = await verifyPublicSource({ commit: SHA, repository: REPOSITORY, fetch: fakeGitHub(published({ [`${API}/compare/${SHA}...main?per_page=1`]: () => json(comparison) })).fetch });
		assert.equal(result.ok, false, JSON.stringify(comparison));
	}
	const renamed = await verifyPublicSource({ commit: SHA, repository: REPOSITORY, fetch: fakeGitHub(published({ [API]: () => json({ full_name: "someone-else/blue-pine-mail", private: false }) })).fetch });
	assert.equal(renamed.ok, false);
	const privateRepository = await verifyPublicSource({ commit: SHA, repository: REPOSITORY, fetch: fakeGitHub(published({ [API]: () => json({ full_name: "blue-pine-solutions/blue-pine-mail", private: true, visibility: "private" }) })).fetch });
	assert.equal(privateRepository.ok, false);
	const unknownRepository = await verifyPublicSource({ commit: SHA, repository: "https://github.com/blue-pine-solutions/does-not-exist", fetch: fakeGitHub(published()).fetch });
	assert.equal(unknownRepository.ok, false);
});

test("API errors, redirects, rate limits and network failures fail closed", async () => {
	const cases = {
		"rate limit": { [API]: () => json({ message: "API rate limit exceeded" }, 403) },
		"server error": { [`${API}/commits/${SHA}`]: () => json({}, 500) },
		redirect: { [API]: () => new Response(null, { status: 301, headers: { Location: "https://api.github.com/repositories/1" } }) },
		"invalid JSON": { [`${API}/commits/${SHA}`]: () => new Response("<html>", { status: 200 }) },
		"network error": { [API]: () => { throw new TypeError("fetch failed"); } },
	};
	for (const [label, override] of Object.entries(cases)) {
		const result = await verifyPublicSource({ commit: SHA, repository: REPOSITORY, fetch: fakeGitHub(published(override)).fetch });
		assert.equal(result.ok, false, label);
		assert.equal(typeof result.reason, "string", label);
	}
});
