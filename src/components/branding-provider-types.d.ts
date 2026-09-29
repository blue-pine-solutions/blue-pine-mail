import type { Branding } from "@/lib/branding/types";

export type BrandingContextValue = Branding & {
	iconUrl: string;
	/** False until /api/branding has answered, so default-only artwork is not shown to a customized installation. */
	loaded: boolean;
	refreshBranding(): Promise<void>;
};
