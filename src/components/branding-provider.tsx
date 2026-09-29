"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { BrandingContextValue } from "./branding-provider-types";
import { DEFAULT_BRANDING, DEFAULT_ICON_URL, fetchBranding } from "./branding-provider-utils";

export const BrandingContext = createContext<BrandingContextValue | null>(null);

export function BrandingProvider({ children }: { children: React.ReactNode }) {
	const [branding, setBranding] = useState(DEFAULT_BRANDING);
	const [iconVersion, setIconVersion] = useState(0);
	const [loaded, setLoaded] = useState(false);

	async function refreshBranding() {
		try {
			const nextBranding = await fetchBranding();
			setBranding(nextBranding);
			setIconVersion(Date.now());
			if (document.title === DEFAULT_BRANDING.appName || document.title === branding.appName) {
				document.title = nextBranding.appName;
			}
		} finally {
			// When branding cannot be read, the default identity is what is shown.
			setLoaded(true);
		}
	}

	useEffect(() => {
		void refreshBranding();
	}, []);

	return (
		<BrandingContext.Provider value={{
			...branding,
			iconUrl: branding.hasCustomIcon ? `/api/branding/icon?v=${iconVersion}` : DEFAULT_ICON_URL,
			loaded,
			refreshBranding,
		}}>
			{children}
		</BrandingContext.Provider>
	);
}

export function useBranding() {
	return useContext(BrandingContext) ?? {
		...DEFAULT_BRANDING,
		iconUrl: DEFAULT_ICON_URL,
		loaded: true,
		refreshBranding: async () => undefined,
	};
}
