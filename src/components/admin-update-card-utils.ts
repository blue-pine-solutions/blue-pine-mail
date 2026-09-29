import type { ReleaseCheck } from "@/lib/distribution/types";
import type { MigrationStatusResponse, VersionStatusResponse } from "./admin-update-card-types";

export async function getVersionStatus(): Promise<VersionStatusResponse> {
	const response = await fetch("/api/admin/update", { cache: "no-store" });
	const data = (await response.json()) as VersionStatusResponse;

	if (!response.ok) {
		throw new Error(data.error ?? "Could not check the installed version");
	}

	return data;
}

/** One line describing the release channel result; installing a release happens outside the app. */
export function describeRelease(release: ReleaseCheck, productName: string): string {
	switch (release.state) {
		case "update-available":
			return `${productName} ${release.latest} is available. Deploy it with the method used for this installation.`;
		case "up-to-date":
			return `No newer ${productName} release is available.`;
		case "no-releases":
			return `No ${productName} releases have been published yet.`;
		case "unavailable":
			return `Could not check for ${productName} releases: ${release.reason}.`;
	}
}

export async function getMigrationStatus(): Promise<MigrationStatusResponse> {
	const response = await fetch("/api/admin/migrations", { cache: "no-store" });
	const data = (await response.json()) as MigrationStatusResponse;
	if (!response.ok) throw new Error(data.error ?? "Could not check database migrations");
	return data;
}

export async function applyDatabaseMigrations(): Promise<MigrationStatusResponse> {
	const response = await fetch("/api/admin/migrations", { method: "POST" });
	const data = (await response.json()) as MigrationStatusResponse;
	if (!response.ok) throw new Error(data.error ?? "Could not apply database migrations");
	return data;
}
