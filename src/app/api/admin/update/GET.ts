import { NextResponse } from "next/server";
import { DISTRIBUTION, getBuildCommit } from "@/lib/distribution/identity";
import { checkForRelease } from "@/lib/distribution/releases";
import type { VersionStatus } from "./types";
import { authorizeAdminRequest } from "./utils";

/**
 * The installed Blue Pine Solutions Mail version and whether a newer approved Blue Pine
 * release has been published. Check only: nothing here installs or deploys.
 */
export async function GET(request: Request) {
	const authorization = await authorizeAdminRequest(request);
	if ("error" in authorization) return authorization.error;

	const status: VersionStatus = {
		installed: {
			name: DISTRIBUTION.name,
			version: DISTRIBUTION.version,
			buildCommit: getBuildCommit(),
			upstream: { name: DISTRIBUTION.upstream.name, version: DISTRIBUTION.upstream.version },
		},
		release: await checkForRelease(),
	};
	return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}
