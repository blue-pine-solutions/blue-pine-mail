import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages, outboundJobs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { buildSnippet } from "@/lib/email/parse";
import { dispatchWebhooks } from "@/lib/email/webhooks";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { getEmailAddressList, joinEmailAddressList, parseEmailAddressParts, splitEmailAddressList } from "@/lib/email/address";
import { formatMessageIdHeader, normalizeMessageId, parseMessageIdList } from "@/lib/email/threading";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { loadMessageAttachmentContents, storeMessageAttachments, validateAttachments } from "@/lib/email/attachments";
import type { AttachmentContent } from "@/lib/email/attachment-types";
import { getOutboundAttachmentMaxMb } from "@/lib/email/attachment-policy";
import { prepareCloudflareAttachments } from "@/lib/email/cloud-attachment-utils";
import { storeSentCanonicalMessage } from "@/lib/email/canonical-message";
import { SendError, classifyTransportError, safeErrorText, toSendError } from "@/lib/email/send-result-utils";
import type { FailedAttemptPolicy, PostAcceptanceIssue, SendOptions, SendOutcome } from "@/lib/email/send-result-types";

export type SendEmailInput = {
	userId: string;
	from: string;
	/** One header-style list or an array; each entry may carry a display name. */
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	/** One Reply-To address, optionally with a display name (the transports take one). */
	replyTo?: string | null;
	subject: string;
	html?: string;
	text?: string;
	headers?: Record<string, string>;
	/** Message-ID of the message being replied to, with or without angle brackets. */
	inReplyTo?: string | null;
	/** References chain, as a header string or a list of Message-IDs. */
	references?: string | string[] | null;
	/** Conversation to file the sent copy under; defaults to its own Message-ID. */
	threadId?: string | null;
	mailboxId: string;
	attachments?: AttachmentContent[];
	/** Future delivery time. Values at or before the current time send immediately. */
	scheduledAt?: string | Date;
	publicOrigin?: string;
};

export const MAX_RECIPIENTS = 50;
const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;

type PreparedDelivery = {
	input: SendEmailInput;
	messageId: string;
	jobId: string;
	from: string;
	mailboxId: string;
	to: string[];
	cc: string[];
	bcc: string[];
	headers: Record<string, string>;
	attachments: AttachmentContent[];
};

type PreparedContent = Awaited<ReturnType<typeof prepareCloudflareAttachments>>;

function toRecipientList(value: string | string[] | undefined): string[] {
	const entries = Array.isArray(value) ? value : splitEmailAddressList(value);
	const seen = new Set<string>();
	const result: string[] = [];
	for (const entry of entries) {
		const [address] = getEmailAddressList(entry);
		if (!address || seen.has(address)) continue;
		seen.add(address);
		result.push(entry.trim());
	}
	return result;
}

const invalid = (reason: string, message: string) => new SendError("invalid_message", reason, message);

/** One Reply-To mailbox, or nothing. Header-breaking characters are refused, not cleaned. */
function normalizeReplyTo(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const entries = splitEmailAddressList(trimmed);
	const address = entries.length === 1 ? parseEmailAddressParts(entries[0]).address : "";
	if (/[\r\n]/.test(trimmed) || !/^[^\s@<>",;]+@[^\s@<>",;]+$/.test(address)) {
		throw invalid("reply_to_invalid", "Reply-To must be a single valid address");
	}
	return entries[0];
}

/**
 * Send a message for a user, returning only its id. The contract existing callers rely
 * on: it resolves once the transport accepted the message (or it was scheduled) and
 * throws a `SendError` otherwise. A local failure after the transport accepted the
 * message is recorded and logged, never thrown, because the message is already on its way.
 */
export async function sendEmail(
	env: CloudflareEnv,
	input: SendEmailInput,
	options: SendOptions = {},
): Promise<{ messageId: string; scheduled?: boolean }> {
	const outcome = await sendEmailWithOutcome(env, input, options);
	return outcome.status === "scheduled" ? { messageId: outcome.messageId, scheduled: true } : { messageId: outcome.messageId };
}

/**
 * The send transaction, in order:
 *
 * 1. Sender authorization and validation. Nothing is written but contacts.
 * 2. Message row (`queued`), attachment objects and rows, `outbound_jobs` row (`queued`).
 * 3. Transport preparation (large attachments become links), then `env.EMAIL.send`.
 * 4. **Delivery boundary:** `env.EMAIL.send` resolved, so the transport has the message.
 * 5. Job `sent`, canonical copy, row `sent`, webhooks, audit log: each best effort.
 *
 * Steps 1–3 throw a classified `SendError`. Its `delivery` says how far the transport got:
 * `not_attempted` and `rejected` are free of duplicate risk; `unknown` (the transport call
 * failed without a definitive answer) is not. Nothing after step 4 throws: failures are
 * returned in `degraded`, logged with the ids needed to reconcile, and noted on the job
 * row. There is no atomicity between the provider and the database, and none is faked.
 */
export async function sendEmailWithOutcome(
	env: CloudflareEnv,
	input: SendEmailInput,
	options: SendOptions = {},
): Promise<SendOutcome> {
	const policy: FailedAttemptPolicy = options.failedAttempt ?? "retain";
	const db = getDb(env);
	let sender: Awaited<ReturnType<typeof getAuthorizedSenderAddress>>;
	try {
		sender = await getAuthorizedSenderAddress(env, input);
	} catch (error) {
		throw toSendError(error, "authorization_unavailable");
	}
	const attachments = input.attachments ?? [];
	try {
		validateAttachments(attachments);
	} catch (error) {
		throw invalid("attachments_invalid", error instanceof Error ? error.message : "Invalid attachments");
	}
	let maxAttachmentMb: number;
	try {
		maxAttachmentMb = await getOutboundAttachmentMaxMb(env);
	} catch (error) {
		throw toSendError(error);
	}
	const maxAttachmentBytes = maxAttachmentMb * 1_000_000;
	if (attachments.some((attachment) => attachment.content.byteLength > maxAttachmentBytes) ||
		attachments.reduce((total, attachment) => total + attachment.content.byteLength, 0) > maxAttachmentBytes) {
		throw invalid("attachments_too_large", `Attachments exceed the administrator's ${maxAttachmentMb} MB outgoing limit`);
	}
	if (input.subject.length > 998) throw invalid("subject_too_long", "Subject exceeds Cloudflare's 998-character limit");

	const to = toRecipientList(input.to);
	const cc = toRecipientList(input.cc);
	const bcc = toRecipientList(input.bcc);
	if (to.length === 0) throw invalid("no_recipients", "At least one recipient is required");
	if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
		throw invalid("too_many_recipients", `A message can have at most ${MAX_RECIPIENTS} recipients`);
	}
	const replyTo = normalizeReplyTo(input.replyTo);

	const inReplyTo = normalizeMessageId(input.inReplyTo);
	const references = Array.isArray(input.references)
		? input.references.map((id) => normalizeMessageId(id)).filter((id): id is string => !!id)
		: parseMessageIdList(input.references);
	const headers: Record<string, string> = { ...input.headers };
	if (inReplyTo) headers["In-Reply-To"] = `<${inReplyTo}>`;
	if (references.length > 0) headers.References = formatMessageIdHeader(references);
	if (new TextEncoder().encode(Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")).byteLength > 16 * 1024) {
		throw invalid("headers_too_large", "Headers exceed Cloudflare's 16 KB limit");
	}

	const requestedSchedule = input.scheduledAt ? new Date(input.scheduledAt) : null;
	const scheduledAt = requestedSchedule && requestedSchedule.getTime() > Date.now()
		? requestedSchedule
		: null;
	// A discarded attempt has no row to retry later from, so it can only send now.
	if (scheduledAt && policy === "discard") {
		throw invalid("schedule_not_supported", "Scheduled delivery cannot discard failed attempts");
	}

	// Contacts are recorded only for a message that passed validation.
	try {
		for (const address of [...to, ...cc, ...bcc]) {
			await upsertContactFromAddress(env, { userId: input.userId, address, source: "outbound" });
		}
	} catch (error) {
		throw toSendError(error);
	}

	const messageId = newId("msg");
	const snippet = buildSnippet(input.text ?? null, input.html ?? null);
	const toAddr = joinEmailAddressList(to);

	try {
		await db.insert(messages).values({
			id: messageId,
			userId: input.userId,
			mailboxId: sender.mailboxId,
			direction: "outbound",
			fromAddr: sender.fromAddr,
			toAddr,
			ccAddr: cc.length ? joinEmailAddressList(cc) : null,
			bccAddr: bcc.length ? joinEmailAddressList(bcc) : null,
			subject: input.subject,
			snippet,
			textBody: input.text ?? null,
			htmlBody: input.html ?? null,
			status: "queued",
			threadId: input.threadId ?? null,
			inReplyTo,
			references: references.length ? references.join(" ") : null,
		});
	} catch (error) {
		throw toSendError(error);
	}
	try {
		const stored = await storeMessageAttachments(env, messageId, attachments);
		stored.forEach((attachment, index) => { attachments[index].storageId = attachment.id; });
	} catch (error) {
		// storeMessageAttachments removed its objects; the row (and any attachment rows,
		// by cascade) goes too, whatever the policy, as it always has.
		await db.delete(messages).where(eq(messages.id, messageId)).catch(() => undefined);
		throw toSendError(error);
	}

	const jobId = newId("job");
	const delivery: PreparedDelivery = {
		input: { ...input, replyTo, attachments: undefined },
		messageId,
		jobId,
		from: sender.fromAddr,
		mailboxId: sender.mailboxId,
		to,
		cc,
		bcc,
		headers,
		attachments,
	};
	try {
		await db.insert(outboundJobs).values({
			id: jobId,
			userId: input.userId,
			messageId,
			status: "queued",
			payload: JSON.stringify({
				...input,
				replyTo,
				from: sender.fromAddr,
				to,
				cc,
				bcc,
				mailboxId: sender.mailboxId,
				attachments: attachments.map(({ content: _content, ...attachment }) => attachment),
			}),
			scheduledAt,
		});
		if (scheduledAt) {
			await enqueueScheduledDelivery(env, delivery, scheduledAt);
			return { status: "scheduled", messageId };
		}
	} catch (error) {
		throw await failAttempt(env, delivery, toSendError(error), policy);
	}

	return deliverEmail(env, delivery, policy);
}

async function deliverEmail(env: CloudflareEnv, delivery: PreparedDelivery, policy: FailedAttemptPolicy): Promise<SendOutcome> {
	const { input, messageId, from, to, cc, bcc, headers, attachments } = delivery;
	const db = getDb(env);
	const replyTo = input.replyTo ?? undefined;
	let prepared: PreparedContent;
	let providerMessageId: string;
	try {
		try {
			prepared = await prepareCloudflareAttachments(env, attachments, {
				subject: input.subject,
				html: input.html,
				text: input.text,
				headers,
				publicOrigin: input.publicOrigin,
			});
			if (prepared.text !== input.text || prepared.html !== input.html) {
				await db.update(messages).set({ textBody: prepared.text ?? null, htmlBody: prepared.html ?? null }).where(eq(messages.id, messageId));
			}
		} catch (error) {
			throw toSendError(error);
		}
		try {
			const response = await env.EMAIL.send({
				from,
				to,
				...(cc.length ? { cc } : {}),
				...(bcc.length ? { bcc } : {}),
				...(replyTo ? { replyTo } : {}),
				subject: input.subject,
				headers: Object.keys(headers).length ? headers : undefined,
				html: prepared.html,
				text: prepared.text,
				attachments: prepared.attachments.map((attachment) =>
					attachment.disposition === "inline" && attachment.contentId
						? {
								filename: attachment.filename,
								type: attachment.type,
								content: attachment.content,
								disposition: "inline" as const,
								contentId: attachment.contentId,
							}
						: {
								filename: attachment.filename,
								type: attachment.type,
								content: attachment.content,
								disposition: "attachment" as const,
							},
				),
			});
			providerMessageId = response.messageId;
		} catch (error) {
			throw classifyTransportError(error);
		}
	} catch (error) {
		throw await failAttempt(env, delivery, toSendError(error), policy);
	}

	// Delivery boundary: the transport has the message. Nothing below may throw or mark the
	// send failed, or a caller could retry and deliver it twice.
	try {
		return await recordAcceptedDelivery(env, delivery, prepared, providerMessageId);
	} catch (error) {
		log(`send.post-acceptance internal failure message=${messageId} job=${delivery.jobId}`, safeErrorText(error));
		return { status: "accepted", messageId, providerMessageId, degraded: ["internal"] };
	}
}

/** Logging around the delivery boundary must never itself throw. */
function log(...args: unknown[]): void {
	try {
		console.error(...args);
	} catch {
		// Nothing left to report to.
	}
}

async function recordAcceptedDelivery(
	env: CloudflareEnv,
	delivery: PreparedDelivery,
	prepared: PreparedContent,
	providerMessageId: string,
): Promise<SendOutcome> {
	const { input, messageId, jobId, from, mailboxId, to, cc, bcc, headers } = delivery;
	const db = getDb(env);
	const degraded: PostAcceptanceIssue[] = [];
	const step = async (issue: PostAcceptanceIssue, run: () => Promise<unknown>) => {
		try {
			await run();
		} catch (error) {
			degraded.push(issue);
			log(`send.post-acceptance ${issue} failed message=${messageId} job=${jobId}`, safeErrorText(error));
		}
	};
	const toAddr = joinEmailAddressList(to);

	// The job row is the attempt's durable record and a scheduled send's only guard
	// against a redelivered queue message, so the acceptance is recorded there first.
	await step("job_state", () =>
		db.update(outboundJobs).set({ status: "sent", error: null, updatedAt: new Date() }).where(eq(outboundJobs.id, jobId)),
	);

	// The canonical copy is built from exactly what the transport accepted, under the
	// Message-ID it assigned; a queued or failed send never gets one.
	let canonicalKey: string | null = null;
	await step("canonical_copy", async () => {
		canonicalKey = await storeSentCanonicalMessage(env, {
			rowId: messageId,
			from,
			to,
			cc,
			bcc,
			subject: input.subject,
			messageId: providerMessageId,
			inReplyTo: headers["In-Reply-To"] ?? null,
			references: (headers.References ?? "").split(/\s+/).filter(Boolean),
			text: prepared.text ?? null,
			html: prepared.html ?? null,
			replyTo: input.replyTo ?? null,
			headers,
			attachments: prepared.attachments.map((attachment) => ({
				filename: attachment.filename,
				type: attachment.type,
				content: attachment.content,
				disposition: attachment.disposition === "inline" && attachment.contentId ? "inline" : "attachment",
				contentId: attachment.contentId ?? null,
			})),
		});
		// Stored best effort and logged by the helper; maintenance materializes it later.
		if (!canonicalKey) throw new Error("canonical copy not stored");
	});

	// A fresh message starts its own conversation; Cloudflare's Message-ID is what
	// any reply will name in In-Reply-To, so key the thread by it.
	await step("message_state", () =>
		db
			.update(messages)
			.set({
				status: "sent",
				providerMessageId,
				threadId: input.threadId ?? normalizeMessageId(providerMessageId) ?? messageId,
				...(canonicalKey ? { rawR2Key: canonicalKey } : {}),
			})
			.where(eq(messages.id, messageId)),
	);
	await step("webhooks", () =>
		dispatchWebhooks(env, input.userId, "message.outbound", {
			messageId,
			providerMessageId,
			to: toAddr,
			cc: cc.length ? joinEmailAddressList(cc) : undefined,
		}),
	);
	await step("audit_log", () =>
		createAuditLog(env, {
			actorUserId: input.userId,
			mailboxId,
			messageId,
			action: "email.send",
			metadata: { to: toAddr, cc: cc.length ? joinEmailAddressList(cc) : undefined, subject: input.subject },
		}),
	);
	if (degraded.length) {
		// What reconciliation needs: the provider's id for the message and what is missing.
		const note = `accepted as ${providerMessageId}; post-acceptance failures: ${degraded.join(", ")}`;
		await db.update(outboundJobs).set({ status: "sent", error: note.slice(0, 1000), updatedAt: new Date() }).where(eq(outboundJobs.id, jobId))
			.catch((error) => log(`send.post-acceptance note failed message=${messageId} job=${jobId}`, safeErrorText(error)));
		log(`send.post-acceptance degraded message=${messageId} job=${jobId} provider=${providerMessageId} issues=${degraded.join(",")}`);
	}
	return { status: "accepted", messageId, providerMessageId, degraded };
}

/**
 * Record a failure before the delivery boundary and return the error to throw. The
 * classification is never replaced by a failure of this bookkeeping.
 */
async function failAttempt(
	env: CloudflareEnv,
	delivery: PreparedDelivery,
	error: SendError,
	policy: FailedAttemptPolicy,
): Promise<SendError> {
	const { input, messageId, jobId } = delivery;
	const db = getDb(env);
	const quietly = async (label: string, run: () => Promise<unknown>) => {
		try {
			await run();
			return true;
		} catch (cause) {
			log(`send.failure-bookkeeping ${label} failed message=${messageId} job=${jobId}`, safeErrorText(cause));
			return false;
		}
	};
	const summary = `${error.kind}/${error.reason} delivery=${error.delivery}: ${error.message}`.slice(0, 1000);
	if (policy === "discard") {
		// The client keeps the message and retries, so a failed copy would only pile up. The
		// job row stays as the record of the attempt (message_id is set null by the
		// cascade), without the message content the client still holds.
		await quietly("job", () =>
			db
				.update(outboundJobs)
				.set({
					status: "failed",
					error: summary,
					payload: JSON.stringify({ discarded: true, delivery: error.delivery, mailboxId: delivery.mailboxId, from: delivery.from, to: delivery.to, cc: delivery.cc, bcc: delivery.bcc, subject: input.subject }),
					updatedAt: new Date(),
				})
				.where(eq(outboundJobs.id, jobId)),
		);
		// Row first, objects after its delete committed: a row never names a missing object.
		let keys: string[] = [];
		const removed = await quietly("discard", async () => {
			keys = (await db.select({ key: messageAttachments.r2Key }).from(messageAttachments).where(eq(messageAttachments.messageId, messageId))).map((row) => row.key);
			await db.delete(messages).where(eq(messages.id, messageId));
		});
		if (removed) {
			for (const key of keys) await quietly("discard-object", () => env.BUCKET.delete(key));
		} else {
			// Could not remove it: at least never leave it looking queued.
			await quietly("message", () => db.update(messages).set({ status: "failed" }).where(eq(messages.id, messageId)));
		}
	} else {
		await quietly("job", () =>
			db.update(outboundJobs).set({ status: "failed", error: summary, updatedAt: new Date() }).where(eq(outboundJobs.id, jobId)),
		);
		await quietly("message", () => db.update(messages).set({ status: "failed" }).where(eq(messages.id, messageId)));
	}
	await quietly("webhooks", () =>
		dispatchWebhooks(env, input.userId, "message.failed", {
			messageId,
			error: error.message,
			...(policy === "discard" ? { retained: false } : {}),
		}),
	);
	return error;
}

export type OutboundQueueMessage = {
	kind: "email.scheduled";
	jobId: string;
	messageId: string;
	scheduledAt: string;
};

async function enqueueScheduledDelivery(
	env: CloudflareEnv,
	delivery: PreparedDelivery,
	scheduledAt: Date,
): Promise<void> {
	const delaySeconds = Math.min(
		MAX_QUEUE_DELAY_SECONDS,
		Math.max(1, Math.ceil((scheduledAt.getTime() - Date.now()) / 1000)),
	);
	await env.OUTBOUND_QUEUE.send(
		{
			kind: "email.scheduled",
			jobId: delivery.jobId,
			messageId: delivery.messageId,
			scheduledAt: scheduledAt.toISOString(),
		},
		{ delaySeconds },
	);
}

export async function processOutboundQueue(
	env: CloudflareEnv,
	payload: OutboundQueueMessage,
): Promise<void> {
	const db = getDb(env);
	const [job] = await db
		.select({ status: outboundJobs.status, payload: outboundJobs.payload })
		.from(outboundJobs)
		.where(eq(outboundJobs.id, payload.jobId))
		.limit(1);
	if (!job || job.status !== "queued") return;
	const scheduledAt = new Date(payload.scheduledAt);
	const input = JSON.parse(job.payload) as SendEmailInput;
	const to = toRecipientList(input.to);
	const cc = toRecipientList(input.cc);
	const bcc = toRecipientList(input.bcc);
	const inReplyTo = normalizeMessageId(input.inReplyTo);
	const references = Array.isArray(input.references)
		? input.references.map((id) => normalizeMessageId(id)).filter((id): id is string => !!id)
		: parseMessageIdList(input.references);
	const headers: Record<string, string> = { ...input.headers };
	if (inReplyTo) headers["In-Reply-To"] = `<${inReplyTo}>`;
	if (references.length > 0) headers.References = formatMessageIdHeader(references);
	const delivery: PreparedDelivery = {
		input,
		messageId: payload.messageId,
		jobId: payload.jobId,
		from: input.from,
		mailboxId: input.mailboxId,
		to,
		cc,
		bcc,
		headers,
		attachments: [],
	};
	if (scheduledAt.getTime() > Date.now()) {
		await enqueueScheduledDelivery(env, delivery, scheduledAt);
		return;
	}
	delivery.attachments = await loadMessageAttachmentContents(env, payload.messageId);
	await deliverEmail(env, delivery, "retain");
}
