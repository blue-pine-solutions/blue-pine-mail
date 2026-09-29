import { and, eq } from "drizzle-orm";
import { messageAttachments, messages } from "@/db/schema";
import { resolveCanonicalMessage } from "@/lib/email/canonical-message";
import { newId } from "@/lib/ids";
import { LIMITS } from "./constants";
import { decodeBlobId, uploadBlobId } from "./ids";
import { listAccessibleMailboxIdSet } from "./access";
import type { JmapContext } from "./types";

const UPLOAD_PREFIX = "jmap-uploads";

/** Uploads are namespaced by user, so only the account that stored one can read it. */
function uploadKey(ctx: JmapContext, uploadId: string): string {
	return `${UPLOAD_PREFIX}/${ctx.auth.userId}/${uploadId}`;
}

/** Client uploads live in R2 under the user until a draft claims them. */
export async function storeUpload(ctx: JmapContext, body: ArrayBuffer, type: string, name: string | null) {
	if (body.byteLength > LIMITS.maxSizeUpload) return null;
	const id = newId("upl");
	await ctx.env.BUCKET.put(uploadKey(ctx, id), body, {
		httpMetadata: { contentType: type },
		customMetadata: { userId: ctx.auth.userId, ...(name ? { name } : {}) },
	});
	return { accountId: ctx.accountId, blobId: uploadBlobId(id), type, size: body.byteLength };
}

export async function readUpload(ctx: JmapContext, uploadId: string) {
	const object = await ctx.env.BUCKET.get(uploadKey(ctx, uploadId));
	if (!object) return null;
	return { content: await object.arrayBuffer(), type: object.httpMetadata?.contentType ?? "application/octet-stream", name: object.customMetadata?.name ?? null };
}

/** Drop an upload once a message owns its bytes. */
export async function deleteUpload(ctx: JmapContext, uploadId: string): Promise<void> {
	await ctx.env.BUCKET.delete(uploadKey(ctx, uploadId));
}

/**
 * Keep the exact MIME an imported message arrived as, mirroring the `inbound/`
 * copy the mail pipeline stores, so `readBlob` serves the client its own bytes
 * back instead of the rebuilt minimal message.
 */
export async function storeRawDraftMime(ctx: JmapContext, messageId: string, raw: ArrayBuffer): Promise<string> {
	const key = `drafts/${messageId}.eml`;
	await ctx.env.BUCKET.put(key, raw, {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: { userId: ctx.auth.userId, messageId },
	});
	return key;
}

/**
 * Resolve a blob id to bytes the account may read: an attachment on one of
 * its messages, the raw MIME of one of its messages, or its own upload.
 */
export async function readBlob(ctx: JmapContext, blobId: string): Promise<{ body: ReadableStream | ArrayBuffer; type: string; name: string | null; size: number } | null> {
	const decoded = decodeBlobId(blobId);
	if (!decoded) return null;
	const accessible = await listAccessibleMailboxIdSet(ctx);

	if (decoded.kind === "up") {
		const upload = await readUpload(ctx, decoded.id);
		return upload ? { body: upload.content, type: upload.type, name: upload.name, size: upload.content.byteLength } : null;
	}
	if (decoded.kind === "att") {
		const [row] = await ctx.db
			.select({ r2Key: messageAttachments.r2Key, filename: messageAttachments.filename, type: messageAttachments.contentType, size: messageAttachments.size, mailboxId: messages.mailboxId })
			.from(messageAttachments)
			.innerJoin(messages, eq(messageAttachments.messageId, messages.id))
			.where(eq(messageAttachments.id, decoded.id))
			.limit(1);
		if (!row || !row.mailboxId || !accessible.has(row.mailboxId)) return null;
		const object = await ctx.env.BUCKET.get(row.r2Key);
		return object ? { body: object.body, type: row.type, name: row.filename, size: row.size } : null;
	}
	const [row] = await ctx.db.select().from(messages).where(and(eq(messages.id, decoded.id))).limit(1);
	if (!row || !row.mailboxId || !accessible.has(row.mailboxId)) return null;
	// The message's canonical representation: the original bytes, or the stored copy Blue Pine generated.
	const source = await resolveCanonicalMessage(ctx.env, row).catch(() => null);
	return source ? { body: source.body, type: "message/rfc822", name: `${row.id}.eml`, size: source.size } : null;
}
