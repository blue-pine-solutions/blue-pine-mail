import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages, sharedAttachmentLinks } from "@/db/schema";
import { splitEmailAddressList } from "@/lib/email/address";
import type { CanonicalAttachment, CanonicalMessage, CanonicalMessageInput, CanonicalRow, CanonicalSource } from "./canonical-message-types";
import {
	angleMessageId,
	buildCanonicalMime,
	canonicalKey,
	classifyMessage,
	draftFingerprint,
	fingerprintFromKey,
	isCanonicalKey,
	localMessageId,
} from "./canonical-message-utils";

/**
 * Every persisted message has one canonical RFC 5322 representation, referenced
 * by `messages.raw_r2_key`:
 *
 * - Received and imported mail: the original bytes, stored on arrival. Never rebuilt.
 * - Mail Blue Pine sent: a representation built from exactly what was handed to
 *   the transport, stored once the transport accepted it, under the Message-ID the
 *   transport reported. The transport may re-encode what it delivers, so this is the
 *   sender's authoritative copy, not a capture of the delivered bytes.
 * - Drafts: the representation of their current content, replaced after an edit.
 * - Queued and failed sends: generated on each read and never stored, since they are
 *   not final.
 *
 * Messages that predate this (legacy sent mail) get theirs the first time they are
 * read or when the scheduled maintenance reaches them, and it never changes after that.
 */

type Env = CloudflareEnv;

async function putCanonical(env: Env, key: string, raw: string): Promise<number> {
	const bytes = new TextEncoder().encode(raw);
	await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "message/rfc822" } });
	return bytes.byteLength;
}

/**
 * Store the canonical copy of a message the transport has just accepted. Returns the
 * object key, or null when it could not be stored; the send itself has already
 * succeeded, so a failure here is logged and left to maintenance.
 */
export async function storeSentCanonicalMessage(
	env: Env,
	input: Omit<CanonicalMessageInput, "date"> & { rowId: string },
): Promise<string | null> {
	const key = canonicalKey(input.rowId);
	try {
		await putCanonical(env, key, buildCanonicalMime({ ...input, date: new Date() }));
		return key;
	} catch (error) {
		console.error(`Canonical copy of sent message ${input.rowId} not stored`, error instanceof Error ? error.message : error);
		await env.BUCKET.delete(key).catch(() => undefined);
		return null;
	}
}

async function loadAttachments(env: Env, row: CanonicalRow, excludeLinked: boolean) {
	const db = getDb(env);
	const rows = await db.select().from(messageAttachments).where(eq(messageAttachments.messageId, row.id));
	let linked = new Set<string>();
	if (excludeLinked && rows.length) {
		// Attachments sent as download links are already represented by the link in the body.
		const links = await db.select({ attachmentId: sharedAttachmentLinks.attachmentId }).from(sharedAttachmentLinks).where(inArray(sharedAttachmentLinks.attachmentId, rows.map((attachment) => attachment.id)));
		linked = new Set(links.map((link) => link.attachmentId));
	}
	return rows.filter((attachment) => !linked.has(attachment.id));
}

async function generate(env: Env, row: CanonicalRow, attachmentRows: Awaited<ReturnType<typeof loadAttachments>>): Promise<string> {
	const attachments: CanonicalAttachment[] = [];
	for (const attachment of attachmentRows) {
		const object = await env.BUCKET.get(attachment.r2Key);
		if (!object) throw new Error(`Attachment ${attachment.id} of message ${row.id} is missing from storage`);
		attachments.push({
			filename: attachment.filename,
			type: attachment.contentType,
			content: await object.arrayBuffer(),
			disposition: attachment.disposition as "attachment" | "inline",
			contentId: attachment.contentId,
		});
	}
	return buildCanonicalMime({
		from: row.fromAddr,
		to: splitEmailAddressList(row.toAddr),
		cc: splitEmailAddressList(row.ccAddr),
		bcc: splitEmailAddressList(row.bccAddr),
		subject: row.subject ?? "",
		date: row.createdAt,
		messageId: row.providerMessageId ? angleMessageId(row.providerMessageId) : localMessageId(row.id, row.fromAddr),
		inReplyTo: row.inReplyTo,
		references: (row.references ?? "").split(/\s+/).filter(Boolean),
		text: row.textBody,
		html: row.htmlBody,
		attachments,
	});
}

const asResult = (raw: string, source: CanonicalSource, key: string | null): CanonicalMessage => {
	const bytes = new TextEncoder().encode(raw);
	return { body: bytes.buffer as ArrayBuffer, size: bytes.byteLength, source, key };
};

/**
 * Point the row at `key` only if it still references `expected`. Returns the key
 * the row ends up referencing, so a writer that lost a race can use the winner's.
 */
async function claimKey(env: Env, rowId: string, expected: string | null, key: string): Promise<string | null> {
	const db = getDb(env);
	await db
		.update(messages)
		.set({ rawR2Key: key })
		.where(and(eq(messages.id, rowId), expected === null ? isNull(messages.rawR2Key) : eq(messages.rawR2Key, expected)));
	const [current] = await db.select({ rawR2Key: messages.rawR2Key }).from(messages).where(eq(messages.id, rowId)).limit(1);
	return current?.rawR2Key ?? null;
}

/** Store a freshly generated representation for `row`, then serve whatever the row ends up referencing. */
async function materialize(env: Env, row: CanonicalRow, fingerprint: string | undefined, attachmentRows: Awaited<ReturnType<typeof loadAttachments>>): Promise<CanonicalMessage> {
	const raw = await generate(env, row, attachmentRows);
	const key = canonicalKey(row.id, fingerprint);
	await putCanonical(env, key, raw);
	const winner = await claimKey(env, row.id, row.rawR2Key, key);
	if (winner === key) {
		// A replaced draft representation is obsolete; originals are never touched here.
		if (row.rawR2Key && isCanonicalKey(row.rawR2Key)) await env.BUCKET.delete(row.rawR2Key);
		console.info(`Canonical representation stored for message ${row.id}`);
		return asResult(raw, "materialized", key);
	}
	await env.BUCKET.delete(key);
	const object = winner ? await env.BUCKET.get(winner) : null;
	if (object) return { body: object.body, size: object.size, source: "stored", key: winner };
	return asResult(raw, "transient", null);
}

/** The canonical representation of a message, creating and storing it first when that is due. */
export async function resolveCanonicalMessage(env: Env, row: CanonicalRow): Promise<CanonicalMessage> {
	const kind = classifyMessage(row);
	if (kind === "transient") {
		const attachmentRows = await loadAttachments(env, row, false);
		return asResult(await generate(env, row, attachmentRows), "transient", null);
	}

	let fingerprint: string | undefined;
	let attachmentRows: Awaited<ReturnType<typeof loadAttachments>> | undefined;
	if (kind === "draft") {
		attachmentRows = await loadAttachments(env, row, false);
		fingerprint = await draftFingerprint(row, attachmentRows);
	}

	if (row.rawR2Key) {
		const stale = kind === "draft" && isCanonicalKey(row.rawR2Key) && fingerprintFromKey(row.rawR2Key) !== fingerprint;
		if (!stale) {
			const object = await env.BUCKET.get(row.rawR2Key);
			if (object) return { body: object.body, size: object.size, source: isCanonicalKey(row.rawR2Key) ? "stored" : "original", key: row.rawR2Key };
			// Keep the reference: the object may only be temporarily unavailable, and an original is irreplaceable.
			console.warn(`Stored representation of message ${row.id} is missing; serving a generated copy`);
			attachmentRows ??= await loadAttachments(env, row, !!row.providerMessageId);
			return asResult(await generate(env, row, attachmentRows), "transient", null);
		}
	}

	attachmentRows ??= await loadAttachments(env, row, row.direction === "outbound" && !!row.providerMessageId);
	return materialize(env, row, fingerprint, attachmentRows);
}

/**
 * Drop a draft's stored representation after its content changed, so the next read
 * builds the current one. Also covers drafts whose representation was an uploaded
 * original (JMAP Email/import), which the edit has made obsolete.
 */
export async function invalidateDraftRepresentation(env: Env, messageId: string): Promise<void> {
	const db = getDb(env);
	const [row] = await db.select({ rawR2Key: messages.rawR2Key, status: messages.status }).from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!row?.rawR2Key || row.status !== "draft") return;
	await db.update(messages).set({ rawR2Key: null }).where(and(eq(messages.id, messageId), eq(messages.rawR2Key, row.rawR2Key)));
	await env.BUCKET.delete(row.rawR2Key);
}

const PENDING_STATUSES = ["draft", "queued", "failed"];

/**
 * Store canonical representations for a bounded, random batch of final messages that
 * have none (legacy sent mail). Run from the scheduled maintenance on both runtimes;
 * random order keeps a message that keeps failing from blocking the rest.
 */
export async function runCanonicalMessageMaintenance(env: Env, limit = 10): Promise<{ stored: number; failed: number; remaining: number }> {
	const db = getDb(env);
	const missing = and(isNull(messages.rawR2Key), notInArray(messages.status, PENDING_STATUSES));
	const batch = await db.select().from(messages).where(missing).orderBy(sql`random()`).limit(limit);
	let stored = 0;
	let failed = 0;
	for (const row of batch) {
		try {
			const result = await resolveCanonicalMessage(env, row);
			if (result.source === "materialized" || result.source === "stored") stored += 1;
		} catch (error) {
			failed += 1;
			console.error(`Canonical representation of message ${row.id} could not be generated`, error instanceof Error ? error.message : error);
		}
	}
	if (batch.length === 0) return { stored, failed, remaining: 0 };
	const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(messages).where(missing);
	console.info(`Canonical message maintenance: ${stored} stored, ${failed} failed, ${count} remaining`);
	return { stored, failed, remaining: Number(count) };
}
