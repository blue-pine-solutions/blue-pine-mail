import type { ReleaseCheck } from "@/lib/distribution/types";

export interface VersionStatus {
	installed: {
		name: string;
		version: string;
		buildCommit: string | null;
		upstream: { name: string; version: string };
	};
	release: ReleaseCheck;
}
