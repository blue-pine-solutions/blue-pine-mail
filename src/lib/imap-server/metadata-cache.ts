/**
 * Derived, per-message protocol metadata (size, ENVELOPE, BODY, BODYSTRUCTURE), so a
 * client that re-lists a folder does not make every message be read and parsed again.
 *
 * Keyed by (mailbox, folder key, UIDVALIDITY, UID): A3 guarantees the octets behind a UID
 * never change while that UID exists, so an entry can only ever describe those octets.
 * It holds no message bodies and no credentials, and never decides authorization: each
 * command re-reads the folder through A3 before any entry is used.
 */

export type MessageMetadata = {
	size: number;
	/** Pre-formatted response fragments, as byte strings. */
	envelope: string;
	body: string;
	bodyStructure: string;
};

export const METADATA_CACHE_MAX_ENTRIES = 50_000;
export const METADATA_CACHE_MAX_BYTES = 32 * 1024 * 1024;
/** Fragments larger than this are recomputed rather than cached. */
const MAX_ENTRY_BYTES = 256 * 1024;

export function metadataKey(mailboxId: string, folderKey: string, uidValidity: number, uid: number): string {
	return `${mailboxId}\u0000${folderKey}\u0000${uidValidity}\u0000${uid}`;
}

function weight(key: string, value: MessageMetadata): number {
	return key.length + value.envelope.length + value.body.length + value.bodyStructure.length + 64;
}

export class MetadataCache {
	private entries = new Map<string, MessageMetadata>();
	private bytes = 0;

	constructor(
		private readonly maxEntries = METADATA_CACHE_MAX_ENTRIES,
		private readonly maxBytes = METADATA_CACHE_MAX_BYTES,
	) {}

	get size(): number {
		return this.entries.size;
	}

	get weight(): number {
		return this.bytes;
	}

	get(key: string): MessageMetadata | undefined {
		const value = this.entries.get(key);
		if (value) {
			this.entries.delete(key);
			this.entries.set(key, value);
		}
		return value;
	}

	set(key: string, value: MessageMetadata): void {
		const cost = weight(key, value);
		if (cost > MAX_ENTRY_BYTES) return;
		const previous = this.entries.get(key);
		if (previous) {
			this.bytes -= weight(key, previous);
			this.entries.delete(key);
		}
		this.entries.set(key, value);
		this.bytes += cost;
		while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
			const oldest = this.entries.keys().next().value as string;
			this.bytes -= weight(oldest, this.entries.get(oldest)!);
			this.entries.delete(oldest);
		}
	}
}

/** One cache per process (or isolate), shared by all sessions. */
export const sharedMetadataCache = new MetadataCache();
