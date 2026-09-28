import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { getFeaturePolicy } from "@/lib/distribution/features";
import type { Branding } from "./types";
import { DEFAULT_APP_NAME, resolveAppName } from "./utils";

export { DEFAULT_APP_NAME } from "./utils";
export const APP_SETTINGS_ID = "default";
export const BRANDING_ICON_KEY = "branding/app-icon";

export class BrandingDisabledError extends Error {
	constructor() {
		super("Custom branding is turned off for this deployment");
	}
}

export async function getBranding(env: CloudflareEnv): Promise<Branding> {
	// When the deployment turns custom branding off, stored branding is kept but not shown.
	if (!getFeaturePolicy().customBranding) {
		return { appName: DEFAULT_APP_NAME, hasCustomIcon: false, canCustomizeBranding: false };
	}

	try {
		const [settings] = await getDb(env)
			.select()
			.from(appSettings)
			.where(eq(appSettings.id, APP_SETTINGS_ID))
			.limit(1);
		return {
			appName: resolveAppName(settings?.appName),
			hasCustomIcon: !!settings?.iconKey,
			canCustomizeBranding: true,
		};
	} catch {
		return { appName: DEFAULT_APP_NAME, hasCustomIcon: false, canCustomizeBranding: true };
	}
}

export async function updateBranding(
	env: CloudflareEnv,
	input: { appName: string; icon?: File | null },
): Promise<Branding> {
	if (!getFeaturePolicy().customBranding) throw new BrandingDisabledError();
	let iconKey: string | undefined;
	if (input.icon) {
		iconKey = BRANDING_ICON_KEY;
		await env.BUCKET.put(iconKey, await input.icon.arrayBuffer(), {
			httpMetadata: { contentType: input.icon.type },
		});
	}

	await getDb(env)
		.insert(appSettings)
		.values({
			id: APP_SETTINGS_ID,
			appName: input.appName,
			iconKey: iconKey ?? null,
		})
		.onConflictDoUpdate({
			target: appSettings.id,
			set: {
				appName: input.appName,
				...(iconKey ? { iconKey } : {}),
				updatedAt: new Date(),
			},
		});
	return getBranding(env);
}
