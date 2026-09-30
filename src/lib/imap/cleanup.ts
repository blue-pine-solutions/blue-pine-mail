import { inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import type { ImapPermanentDeletion } from "./state";
import { chunk, IN_LIST_CHUNK, isDeletableMessageObjectKey } from "./utils";

/**
 * Object-storage cleanup after a permanent IMAP deletion (A5.2c). Runs only once the database
 * batch that deleted the messages has committed (deleteImapMessagesPermanently), so the
 * database never references bytes this removes. Everything here is best effort: a failure
 * leaves an orphaned object behind, is logged, and never undoes or fails the deletion.
 *
 * A key is deleted only if it has the shape of an object that message owns
 * (isDeletableMessageObjectKey) and, checked now, no live `messages` or `message_attachments`
 * row references it. Keys are unique to their message by construction, so a reference found
 * here is an anomaly: it is logged and the object kept. The check cannot close one window: a
 * redelivered inbound queue message may re-create the same row and key after the check and
 * before the delete (see UPSTREAM.md, "Permanent IMAP expunge (A5.2c)").
 *
 * Logs are one JSON line per event, naming the message id and key, never content:
 * `expunge.cleanup-skipped` (not deletable, or still referenced) and `expunge.cleanup-failed`.
 */

export type ImapCleanupResult = { removed: string[]; skipped: string[]; failed: string[] };

type Candidate = { messageId: string; key: string; kind: "raw" | "attachment" };

function log(level: "warn" | "error", event: string, fields: Record<string, unknown>): void {
	console[level](JSON.stringify({ event, ...fields }));
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function referencedKeys(db: AppDatabase, keys: string[]): Promise<Set<string>> {
	const referenced = new Set<string>();
	for (const keyChunk of chunk(keys, IN_LIST_CHUNK)) {
		for (const row of await db.select({ key: messages.rawR2Key }).from(messages).where(inArray(messages.rawR2Key, keyChunk))) if (row.key) referenced.add(row.key);
		for (const row of await db.select({ key: messageAttachments.r2Key }).from(messageAttachments).where(inArray(messageAttachments.r2Key, keyChunk))) referenced.add(row.key);
	}
	return referenced;
}

export async function cleanupDeletedMessageObjects(env: CloudflareEnv, db: AppDatabase, deleted: ImapPermanentDeletion["deleted"]): Promise<ImapCleanupResult> {
	const result: ImapCleanupResult = { removed: [], skipped: [], failed: [] };
	const candidates: Candidate[] = [];
	for (const message of deleted) {
		const keys: Array<[string | null, Candidate["kind"]]> = [[message.rawKey, "raw"], ...message.attachmentKeys.map((key): [string, Candidate["kind"]] => [key, "attachment"])];
		for (const [key, kind] of keys) {
			if (key === null) continue;
			if (!isDeletableMessageObjectKey(kind, key, message.messageId)) {
				log("warn", "expunge.cleanup-skipped", { messageId: message.messageId, key, kind, reason: "not a key this message owns" });
				result.skipped.push(key);
				continue;
			}
			candidates.push({ messageId: message.messageId, key, kind });
		}
	}
	if (!candidates.length) return result;

	let referenced: Set<string>;
	try {
		referenced = await referencedKeys(db, [...new Set(candidates.map((candidate) => candidate.key))]);
	} catch (error) {
		// Without the reference check nothing may be deleted: the objects are left as orphans.
		for (const candidate of candidates) {
			log("error", "expunge.cleanup-failed", { messageId: candidate.messageId, key: candidate.key, kind: candidate.kind, stage: "reference-check", error: reason(error) });
			result.failed.push(candidate.key);
		}
		return result;
	}

	for (const candidate of candidates) {
		if (referenced.has(candidate.key)) {
			log("warn", "expunge.cleanup-skipped", { messageId: candidate.messageId, key: candidate.key, kind: candidate.kind, reason: "still referenced by a live row" });
			result.skipped.push(candidate.key);
			continue;
		}
		try {
			// Deleting a missing key succeeds on R2 and on the Node file bucket alike.
			await env.BUCKET.delete(candidate.key);
			result.removed.push(candidate.key);
		} catch (error) {
			log("error", "expunge.cleanup-failed", { messageId: candidate.messageId, key: candidate.key, kind: candidate.kind, stage: "delete", error: reason(error) });
			result.failed.push(candidate.key);
		}
	}
	return result;
}
