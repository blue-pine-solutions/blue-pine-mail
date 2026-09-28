import { getFeaturePolicy } from "@/lib/distribution/features";

/**
 * Whether this deployment offers shared mailboxes at all. This is feature
 * availability only: access to a shared mailbox still requires that user's own
 * mailbox_access row. Turning the feature off hides delegated access without
 * deleting any sharing records.
 */
export function isMailboxSharingEnabled(): boolean {
	return getFeaturePolicy().sharedMailboxes;
}
