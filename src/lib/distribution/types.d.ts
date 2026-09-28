export type DistributionIdentity = {
	name: string;
	vendor: string;
	version: string;
	sourceRepository: string;
	license: string;
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
};
