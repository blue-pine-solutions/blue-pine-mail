import { findZoneByHostname } from "@/lib/cloudflare-api";
import type { DomainPreflightResult } from "@/lib/domains/types";
import { MANUAL_ZONE_ID } from "@/lib/domains/provision";
import { hasCloudflareCredentials } from "@/lib/runtime";

export async function preflightDomain(
	env: CloudflareEnv,
	hostname: string,
): Promise<DomainPreflightResult> {
	const normalized = hostname.toLowerCase().trim();

	if (!hasCloudflareCredentials(env)) {
		return {
			hostname: normalized,
			zone: { id: MANUAL_ZONE_ID, name: normalized },
		};
	}

	const zone = await findZoneByHostname(env, normalized);
	if (!zone) {
		throw new Error(
			`Zone not found for "${normalized}". The domain must use Cloudflare DNS on this account.`,
		);
	}

	return { hostname: normalized, zone };
}
