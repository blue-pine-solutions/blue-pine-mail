import packageJson from "../../../package.json";
import type { DistributionEnv, DistributionIdentity } from "./types";

/**
 * Who this distribution is: Blue Pine Solutions Mail, a downstream of Mailflare. This is
 * fixed per build and separate from the admin-editable branding in app_settings.
 */
export const DISTRIBUTION: DistributionIdentity = {
	name: "Blue Pine Solutions Mail",
	vendor: "Blue Pine Solutions",
	version: "0.1.2",
	sourceRepository: "https://github.com/blue-pine-solutions/blue-pine-mail",
	license: "AGPL-3.0-or-later",
	licenseName: "GNU Affero General Public License v3.0 or later",
	licenseUrl: "https://www.gnu.org/licenses/agpl-3.0.html",
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

/** In-app routes for the source offer (redirects to getSourceUrl()) and the About page. */
export const SOURCE_PATH = "/source";
export const ABOUT_PATH = "/about";

/** Where network users can get the Corresponding Source: the exact commit when known, otherwise the repository. */
export function getSourceUrl(commit: string | null = getBuildCommit()): string {
	return commit ? `${DISTRIBUTION.sourceRepository}/tree/${commit}` : DISTRIBUTION.sourceRepository;
}
