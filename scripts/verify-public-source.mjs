// Release preflight: is this exact Blue Pine Mail commit published in the public
// source repository? A build may only be offered to users once it is, because
// /source sends them to <repository>/tree/<commit>.
//
//   npm run release:verify-source -- <full commit sha>
//
// Reads the public GitHub API without a token and never changes anything. Any
// doubt (malformed input, another repository, 404, rate limit, network error,
// unexpected response) is a failure. The app itself never runs this check.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const GITHUB_API = "https://api.github.com";
const TIMEOUT_MS = 10_000;

/** The shipped source repository, read from the distribution identity so it is never duplicated here. */
export function readSourceRepository(root = join(dirname(fileURLToPath(import.meta.url)), "..")) {
	const identity = readFileSync(join(root, "src/lib/distribution/identity.ts"), "utf8");
	const match = /sourceRepository:\s*"([^"]+)"/.exec(identity);
	if (!match) throw new Error("sourceRepository not found in src/lib/distribution/identity.ts");
	return match[1];
}

async function getJson(fetchImpl, url) {
	const response = await fetchImpl(url, {
		headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "blue-pine-mail-release-preflight" },
		redirect: "manual",
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (response.status !== 200) throw new Error(`GitHub answered HTTP ${response.status} for ${url}`);
	return response.json();
}

/**
 * Resolves to { ok: true, sourceUrl } only when `commit` is a full SHA contained
 * in `ref` of the public `repository`; otherwise { ok: false, reason }. Never throws.
 */
export async function verifyPublicSource({ commit, repository, ref = "main", fetch: fetchImpl = globalThis.fetch }) {
	try {
		const sha = typeof commit === "string" ? commit.trim().toLowerCase() : "";
		if (!COMMIT_PATTERN.test(sha)) return { ok: false, reason: "The commit must be a full 40-character SHA." };
		const parsed = typeof repository === "string" ? REPOSITORY_PATTERN.exec(repository) : null;
		if (!parsed || parsed[2] === "." || parsed[2] === "..") return { ok: false, reason: `Not a GitHub repository URL: ${repository}` };
		const [, owner, name] = parsed;
		const base = `${GITHUB_API}/repos/${owner}/${name}`;

		const metadata = await getJson(fetchImpl, base);
		if (typeof metadata?.full_name !== "string" || metadata.full_name.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
			return { ok: false, reason: `GitHub returned a different repository (${metadata?.full_name ?? "none"}) for ${owner}/${name}.` };
		}
		if (metadata.private !== false || (metadata.visibility !== undefined && metadata.visibility !== "public")) {
			return { ok: false, reason: `${owner}/${name} is not public.` };
		}

		const found = await getJson(fetchImpl, `${base}/commits/${sha}`);
		if (found?.sha !== sha) return { ok: false, reason: `Commit ${sha} is not in ${owner}/${name}.` };

		// Contained in the published branch, not merely an object GitHub still holds.
		const comparison = await getJson(fetchImpl, `${base}/compare/${sha}...${encodeURIComponent(ref)}?per_page=1`);
		if (comparison?.merge_base_commit?.sha !== sha || !["identical", "ahead"].includes(comparison?.status)) {
			return { ok: false, reason: `Commit ${sha} is not contained in ${owner}/${name} ${ref}.` };
		}
		return { ok: true, sourceUrl: `${repository}/tree/${sha}` };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const commit = process.argv[2] ?? process.env.BLUEPINE_BUILD_COMMIT;
	const repository = readSourceRepository();
	const result = await verifyPublicSource({ commit, repository });
	if (result.ok) {
		console.log(`Published: ${result.sourceUrl}`);
	} else {
		console.error(`Not publication-ready: ${result.reason}`);
		process.exitCode = 1;
	}
}
