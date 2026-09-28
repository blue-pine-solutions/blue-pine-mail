import type { Branding } from "@/lib/branding/types";
import { DEFAULT_APP_NAME } from "@/lib/branding/utils";

export const DEFAULT_BRANDING: Branding = {
	appName: DEFAULT_APP_NAME,
	hasCustomIcon: false,
	// Blue Pine enables custom branding by default; /api/branding reports the deployment's actual policy.
	canCustomizeBranding: true,
};

export async function fetchBranding(): Promise<Branding> {
	const response = await fetch("/api/branding", { cache: "no-store" });
	if (!response.ok) return DEFAULT_BRANDING;
	return (await response.json()) as Branding;
}
