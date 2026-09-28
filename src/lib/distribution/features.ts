import type { DistributionEnv, FeaturePolicy, FeaturePolicyKey } from "./types";

/**
 * Which capabilities this Blue Pine deployment offers. Everything is on by
 * default; a deployment can turn features off with a comma-separated
 * BLUEPINE_DISABLED_FEATURES (for example "accountForwarding,gravatar").
 * Names match case-insensitively and unknown names are ignored.
 */
export const FEATURE_POLICY_KEYS: readonly FeaturePolicyKey[] = [
	"customBranding",
	"multipleAccounts",
	"sharedMailboxes",
	"accountForwarding",
	"gravatar",
];

function processEnv(): DistributionEnv {
	return typeof process === "undefined" ? {} : (process.env as DistributionEnv);
}

/** Synchronous and database-free, so it is cheap enough for per-request access checks. */
export function getFeaturePolicy(env: DistributionEnv = processEnv()): FeaturePolicy {
	const disabled = new Set(
		(env.BLUEPINE_DISABLED_FEATURES ?? "")
			.split(",")
			.map((name) => name.trim().toLowerCase())
			.filter(Boolean),
	);
	const policy = {} as FeaturePolicy;
	for (const key of FEATURE_POLICY_KEYS) policy[key] = !disabled.has(key.toLowerCase());
	return policy;
}
