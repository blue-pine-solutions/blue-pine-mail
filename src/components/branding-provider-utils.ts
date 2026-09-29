import type { Branding } from "@/lib/branding/types";
import { DEFAULT_APP_NAME } from "@/lib/branding/utils";

/** The packaged app mark at 2x for the in-app sizes (28-80px); /icon-96.png stays the server fallback and favicon. */
export const DEFAULT_ICON_URL = "/icon-192.png";

/** The full Blue Pine Solutions Mail logo, shown only while default branding is in effect. */
export const DEFAULT_LOGO = { webp: "/brand/blue-pine-mail-logo.webp", png: "/brand/blue-pine-mail-logo.png", width: 500, height: 500 };

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
