import { DISTRIBUTION } from "@/lib/distribution/identity";

export const DEFAULT_APP_NAME = DISTRIBUTION.name;

/** Upstream migration 0012 seeds app_settings.app_name with this value, so it means "never customized". */
export const UPSTREAM_DEFAULT_APP_NAME = "Mailflare";

/** The name to show for a stored app_name: the stored value unless it is empty or upstream's seeded default. */
export function resolveAppName(storedName: string | null | undefined): string {
	return storedName && storedName !== UPSTREAM_DEFAULT_APP_NAME ? storedName : DEFAULT_APP_NAME;
}
