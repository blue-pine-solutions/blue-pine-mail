export type DistributionIdentity = {
	name: string;
	vendor: string;
	version: string;
	sourceRepository: string;
	license: string;
	licenseName: string;
	licenseUrl: string;
	upstream: {
		name: string;
		repository: string;
		author: string;
		version: string;
	};
};

export type FeaturePolicyKey = "customBranding" | "multipleAccounts" | "sharedMailboxes" | "accountForwarding" | "gravatar";

export type FeaturePolicy = Record<FeaturePolicyKey, boolean>;

/** The deployment variables the distribution layer reads; any env-like object with these optional keys works. */
export type DistributionEnv = {
	BLUEPINE_BUILD_COMMIT?: string;
	BLUEPINE_DISABLED_FEATURES?: string;
	BLUEPINE_RELEASE_REPOSITORY?: string;
};

/** Where approved Blue Pine Mail releases are published (owner/repository on GitHub). */
export type ReleaseSource = { owner: string; repository: string };

export type ReleaseCheck =
	| { state: "update-available"; installed: string; latest: string; tag: string; releaseUrl: string; source: string }
	| { state: "up-to-date"; installed: string; latest: string; tag: string; releaseUrl: string; source: string }
	| { state: "no-releases"; installed: string; source: string }
	| { state: "unavailable"; installed: string; source: string; reason: string };
