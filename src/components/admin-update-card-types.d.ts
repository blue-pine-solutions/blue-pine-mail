import type { VersionStatus } from "@/app/api/admin/update/types";

export interface VersionStatusResponse extends Partial<VersionStatus> {
	error?: string;
}

export interface MigrationStatusResponse {
	applied?: string[];
	error?: string;
	pending: string[];
	ready: boolean;
	unknown: string[];
}
