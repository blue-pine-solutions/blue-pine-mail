import { DISTRIBUTION } from "@/lib/distribution/identity";

export const DEFAULT_APP_NAME = DISTRIBUTION.name;

/** Upstream migration 0012 seeds app_settings.app_name with this value, so it means "never customized". */
export const UPSTREAM_DEFAULT_APP_NAME = "Mailflare";

/**
 * Earlier default names that also mean "never customized". Blue Pine Mail 0.1.0 and 0.1.1 shipped with this
 * default, and the branding form saves the prefilled name, so installations may have stored it verbatim.
 */
export const LEGACY_DEFAULT_APP_NAMES: readonly string[] = [UPSTREAM_DEFAULT_APP_NAME, "Blue Pine Mail"];

/** The name to show for a stored app_name: the stored value unless it is empty or a former default. */
export function resolveAppName(storedName: string | null | undefined): string {
	return storedName && !LEGACY_DEFAULT_APP_NAMES.includes(storedName) ? storedName : DEFAULT_APP_NAME;
}

/** Whether the installation shows the distribution's own identity rather than an administrator's branding. */
export function isDefaultBranding(branding: { appName: string; hasCustomIcon: boolean }): boolean {
	return !branding.hasCustomIcon && branding.appName === DEFAULT_APP_NAME;
}
