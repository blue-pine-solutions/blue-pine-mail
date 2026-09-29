import { DISTRIBUTION } from "./identity";
import type { DistributionEnv, ReleaseCheck, ReleaseSource } from "./types";

/**
 * The Blue Pine Mail release channel. It only reports whether an approved
 * release exists; installing one is a deployment step outside the app.
 *
 * An approved release is a published (not draft, not prerelease) GitHub
 * Release in the Blue Pine repository whose tag is bluepine-vMAJOR.MINOR.PATCH.
 * Upstream Mailflare releases, branches and tags are never considered.
 */
export const RELEASE_TAG_PREFIX = "bluepine-v";
const RELEASE_TAG_PATTERN = /^bluepine-v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const VERSION_PATTERN = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const REPOSITORY_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const GITHUB_API = "https://api.github.com";
const MAX_RESPONSE_BYTES = 1_000_000;
const TIMEOUT_MS = 8_000;

function processEnv(): DistributionEnv {
	return typeof process === "undefined" ? {} : (process.env as DistributionEnv);
}

function parseRepository(value: string): ReleaseSource | null {
	const match = REPOSITORY_PATTERN.exec(value.trim());
	return match && match[2] !== "." && match[2] !== ".." ? { owner: match[1], repository: match[2] } : null;
}

/** The repository approved releases come from: BLUEPINE_RELEASE_REPOSITORY when valid, otherwise the distribution's source repository. */
export function getReleaseSource(env: DistributionEnv = processEnv()): ReleaseSource | null {
	const override = env.BLUEPINE_RELEASE_REPOSITORY?.trim();
	if (override) return parseRepository(override);
	const fromIdentity = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(DISTRIBUTION.sourceRepository);
	return fromIdentity ? parseRepository(fromIdentity[1]) : null;
}

/** The version in an approved release tag, or null for anything else (upstream tags, prereleases, malformed tags). */
export function parseReleaseTag(tag: unknown): string | null {
	if (typeof tag !== "string") return null;
	const match = RELEASE_TAG_PATTERN.exec(tag);
	return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** Negative, zero or positive as version a is older than, equal to or newer than b (MAJOR.MINOR.PATCH only). */
export function compareVersions(a: string, b: string): number {
	const left = VERSION_PATTERN.exec(a);
	const right = VERSION_PATTERN.exec(b);
	if (!left || !right) throw new Error("Versions must be MAJOR.MINOR.PATCH");
	for (let index = 1; index <= 3; index += 1) {
		const difference = Number(left[index]) - Number(right[index]);
		if (difference !== 0) return difference;
	}
	return 0;
}

type PublishedRelease = { version: string; tag: string; releaseUrl: string };

/** Keep only approved releases from a GitHub /releases response; anything unexpected is ignored, never trusted. */
export function selectApprovedReleases(payload: unknown, source: ReleaseSource): PublishedRelease[] {
	if (!Array.isArray(payload)) return [];
	const releasePage = `https://github.com/${source.owner}/${source.repository}/releases/tag/`;
	const releases: PublishedRelease[] = [];
	for (const item of payload) {
		if (!item || typeof item !== "object") continue;
		const release = item as Record<string, unknown>;
		if (release.draft !== false || release.prerelease !== false) continue;
		const version = parseReleaseTag(release.tag_name);
		if (!version) continue;
		const tag = release.tag_name as string;
		// Link to the release page we can construct ourselves rather than a URL taken from the response.
		releases.push({ version, tag, releaseUrl: `${releasePage}${encodeURIComponent(tag)}` });
	}
	return releases.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Ask the Blue Pine release source whether a newer approved release exists.
 * Never throws: network errors, rate limits, a private or renamed repository
 * and malformed responses all come back as { state: "unavailable" }.
 */
export async function checkForRelease(options: { env?: DistributionEnv; fetch?: typeof fetch } = {}): Promise<ReleaseCheck> {
	const installed = DISTRIBUTION.version;
	const source = getReleaseSource(options.env ?? processEnv());
	if (!source) return { state: "unavailable", installed, source: "", reason: "The release source is not configured correctly" };
	const sourceName = `${source.owner}/${source.repository}`;
	const doFetch = options.fetch ?? fetch;

	let text: string;
	try {
		const response = await doFetch(`${GITHUB_API}/repos/${source.owner}/${source.repository}/releases?per_page=30`, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": "Blue-Pine-Mail-Release-Check" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (response.status === 404) return { state: "unavailable", installed, source: sourceName, reason: "The release source could not be found or is private" };
		if (response.status === 403 || response.status === 429) return { state: "unavailable", installed, source: sourceName, reason: "The release source is rate limited; try again later" };
		if (!response.ok) return { state: "unavailable", installed, source: sourceName, reason: `The release source answered HTTP ${response.status}` };
		if (Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) return { state: "unavailable", installed, source: sourceName, reason: "The release list was too large" };
		text = await response.text();
	} catch {
		return { state: "unavailable", installed, source: sourceName, reason: "The release source could not be reached" };
	}
	if (text.length > MAX_RESPONSE_BYTES) return { state: "unavailable", installed, source: sourceName, reason: "The release list was too large" };

	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		return { state: "unavailable", installed, source: sourceName, reason: "The release list could not be read" };
	}
	const [latest] = selectApprovedReleases(payload, source);
	if (!latest) return { state: "no-releases", installed, source: sourceName };
	const state = compareVersions(latest.version, installed) > 0 ? "update-available" : "up-to-date";
	return { state, installed, latest: latest.version, tag: latest.tag, releaseUrl: latest.releaseUrl, source: sourceName };
}
