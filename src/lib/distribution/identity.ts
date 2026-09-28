import packageJson from "../../../package.json";
import type { DistributionEnv, DistributionIdentity } from "./types";

/**
 * Who this distribution is: Blue Pine Mail, a downstream of Mailflare. This is
 * fixed per build and separate from the admin-editable branding in app_settings.
 */
export const DISTRIBUTION: DistributionIdentity = {
	name: "Blue Pine Mail",
	vendor: "Blue Pine Solutions",
	version: "0.1.0",
	sourceRepository: "https://github.com/bofa-ds/mailflare",
	license: "AGPL-3.0-or-later",
	upstream: {
		name: "Mailflare",
		repository: "https://github.com/hieunc229/mailflare",
		author: "Hieu Nguyen",
		// package.json keeps upstream's version, recording which Mailflare release this build is based on.
		version: packageJson.version,
	},
};

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

function processEnv(): DistributionEnv {
	return typeof process === "undefined" ? {} : (process.env as DistributionEnv);
}

/** The Blue Pine commit this build was made from, or null when it was not supplied (local development). */
export function getBuildCommit(env: DistributionEnv = processEnv()): string | null {
	const commit = env.BLUEPINE_BUILD_COMMIT?.trim() ?? "";
	return COMMIT_PATTERN.test(commit) ? commit.toLowerCase() : null;
}

/** Where network users can get the Corresponding Source: the exact commit when known, otherwise the repository. */
export function getSourceUrl(commit: string | null = getBuildCommit()): string {
	return commit ? `${DISTRIBUTION.sourceRepository}/tree/${commit}` : DISTRIBUTION.sourceRepository;
}
