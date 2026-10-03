import { and, eq } from "drizzle-orm";
import PostalMime from "postal-mime";
import type { Email } from "postal-mime";
import { getDb } from "@/db";
import { mailAppPasswords } from "@/db/schema/bluepine";
import { parseStoredScopes } from "@/lib/mail-app-passwords/utils";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { MAX_RECIPIENTS, sendEmailWithOutcome } from "@/lib/email/send";
import type { SendEmailInput } from "@/lib/email/send";
import { SendError, isSendError, toSendError } from "@/lib/email/send-result-utils";
import { normalizeAttachmentContent } from "@/lib/email/attachments";
import type { AttachmentContent } from "@/lib/email/attachment-types";
import { findParentThreadId, parseMessageIdList } from "@/lib/email/threading";
import { formatEmailAddress } from "@/lib/email/address";
import type { SubmissionFailure, SubmissionPrincipal, SubmissionRequest, SubmissionResult, SubmissionSenderCheck } from "./types";
import {
	MAX_SUBMISSION_MESSAGE_BYTES,
	SUBMISSION_PARSER_LIMITS,
	cleanHeaderText,
	containsNul,
	headerMailboxes,
	headerValues,
	isSignedOrEncrypted,
	normalizeMailboxAddress,
	parseSingleMailbox,
	reconcileRecipients,
	safeContentId,
	safeMessageId,
	startsWithHeaderField,
} from "./utils";

/**
 * The SMTP submission adapter (SMTP-1): the boundary between an authenticated submission
 * listener and the one user send path, `sendEmail`. No socket, port or protocol state
 * lives here; the listener (SMTP-2) owns TLS, AUTH, limits and reading DATA, and maps
 * the semantic results below to SMTP replies.
 *
 * The message is parsed and rebuilt through the structured send path, never relayed raw:
 * sender authorization, the server-owned Sent copy, attachment storage, limits, webhooks
 * and the audit log all apply exactly as for a web or JMAP send.
 */

const MAX_SUBMISSION_RECIPIENTS = MAX_RECIPIENTS;
export { MAX_SUBMISSION_MESSAGE_BYTES, MAX_SUBMISSION_RECIPIENTS };

const invalid = (reason: string, message: string) => new SendError("invalid_message", reason, message);
const unauthorized = (reason: string, message: string) => new SendError("unauthorized_sender", reason, message);

function toFailure(error: SendError): SubmissionFailure {
	return { kind: error.kind, reason: error.reason, delivery: error.delivery, temporary: error.temporary, retrySafe: error.retrySafe };
}

/**
 * The credential must still exist, still carry the `smtp` scope, and still belong to this
 * user and mailbox; a revoked or narrowed credential cannot submit another message. The
 * account and the mailbox permission are checked by `getAuthorizedSenderAddress`.
 */
async function authorizeCredential(env: CloudflareEnv, principal: SubmissionPrincipal): Promise<void> {
	let credential: { scopes: string } | undefined;
	try {
		[credential] = await getDb(env)
			.select({ scopes: mailAppPasswords.scopes })
			.from(mailAppPasswords)
			.where(and(eq(mailAppPasswords.id, principal.appPasswordId), eq(mailAppPasswords.userId, principal.userId), eq(mailAppPasswords.mailboxId, principal.mailboxId)))
			.limit(1);
	} catch (error) {
		throw toSendError(error, "authorization_unavailable");
	}
	if (!credential || !parseStoredScopes(credential.scopes).includes("smtp")) {
		throw unauthorized("credential_unavailable", "The credential no longer allows submission");
	}
}

/**
 * The reverse-path, validated and authorized for the principal with the existing sender
 * rule (`canSendOnBehalf` on the mailbox; the address one of the mailbox's addresses).
 * Returns the lowercased address.
 */
async function authorizeMailFrom(env: CloudflareEnv, principal: SubmissionPrincipal, mailFrom: string): Promise<string> {
	if (!mailFrom.trim()) throw unauthorized("null_sender", "The null reverse-path cannot submit mail");
	const address = normalizeMailboxAddress(mailFrom);
	if (!address) throw invalid("mail_from_invalid", "The MAIL FROM address is not valid");
	await authorizeCredential(env, principal);
	try {
		await getAuthorizedSenderAddress(env, { userId: principal.userId, mailboxId: principal.mailboxId, from: address });
	} catch (error) {
		throw toSendError(error, "authorization_unavailable");
	}
	return address;
}

/**
 * For the listener at MAIL FROM: whether this principal may submit from this address now.
 * The same checks run again for the message itself, so a credential revoked, or access
 * lost, between MAIL FROM and the end of DATA cannot submit it.
 */
export async function authorizeSubmissionSender(env: CloudflareEnv, principal: SubmissionPrincipal, mailFrom: string): Promise<SubmissionSenderCheck> {
	try {
		await authorizeMailFrom(env, principal, mailFrom);
		return { ok: true };
	} catch (error) {
		return { ok: false, failure: toFailure(toSendError(error)) };
	}
}

/** The envelope recipients, validated, lowercased and deduplicated, within the limit. */
function envelopeRecipients(rcptTo: string[]): string[] {
	const result: string[] = [];
	for (const value of rcptTo) {
		const address = normalizeMailboxAddress(value);
		if (!address) throw invalid("recipient_invalid", "An envelope recipient is not valid");
		if (!result.includes(address)) result.push(address);
	}
	if (result.length === 0) throw invalid("no_recipients", "At least one recipient is required");
	if (result.length > MAX_SUBMISSION_RECIPIENTS) throw invalid("too_many_recipients", `A message can have at most ${MAX_SUBMISSION_RECIPIENTS} recipients`);
	return result;
}

async function parseMessage(bytes: Uint8Array): Promise<Email> {
	if (bytes.byteLength === 0) throw invalid("malformed_message", "The message is empty");
	if (containsNul(bytes) || !startsWithHeaderField(bytes)) throw invalid("malformed_message", "The message is not an RFC 5322 message");
	try {
		// Attached messages stay attachments rather than being merged into the body.
		return await PostalMime.parse(bytes, { ...SUBMISSION_PARSER_LIMITS, forceRfc822Attachments: true, attachmentEncoding: "arraybuffer" });
	} catch {
		throw invalid("malformed_message", "The message could not be parsed");
	}
}

function attachmentsOf(email: Email): AttachmentContent[] {
	return email.attachments.map((attachment, index) => {
		const contentId = safeContentId(attachment.contentId);
		// An image referenced from the HTML part is inline even without a disposition.
		const inline = !!contentId && (attachment.disposition === "inline" || (attachment.disposition === null && attachment.related === true));
		return {
			filename: cleanHeaderText(attachment.filename) || `attachment-${index + 1}`,
			type: attachment.mimeType || "application/octet-stream",
			content: normalizeAttachmentContent(attachment.content, attachment.encoding),
			disposition: inline ? "inline" : "attachment",
			contentId: inline ? contentId : null,
		};
	});
}

/**
 * The structured send for a submitted message. Each step refuses with a classified
 * `SendError`; nothing is written and nothing is sent before all of them passed.
 */
async function prepareSubmission(env: CloudflareEnv, request: SubmissionRequest): Promise<SendEmailInput> {
	const { principal, envelope } = request;
	const bytes = request.message;
	if (bytes.byteLength > MAX_SUBMISSION_MESSAGE_BYTES) throw invalid("message_too_large", "The message exceeds the submission size limit");
	const rcptTo = envelopeRecipients(envelope.rcptTo);
	const mailFrom = await authorizeMailFrom(env, principal, envelope.mailFrom);

	const email = await parseMessage(bytes);

	// The header From must be the envelope sender; both pass the same sender rule (MAIL FROM
	// above, the From again inside sendEmail). Its display name is replaced by the server's.
	const from = parseSingleMailbox(headerValues(email.headers, "from"), "from");
	if (from.address !== mailFrom) throw unauthorized("from_mail_from_mismatch", "The From address does not match MAIL FROM");
	// Sender is never carried. One naming the From address adds nothing; any other
	// identity is refused rather than silently dropped or trusted.
	const senders = headerValues(email.headers, "sender");
	if (senders.length > 0) {
		let sender;
		try {
			sender = parseSingleMailbox(senders, "sender");
		} catch {
			throw unauthorized("sender_header_mismatch", "The Sender header does not match From");
		}
		if (sender.address !== from.address) throw unauthorized("sender_header_mismatch", "The Sender header does not match From");
	}

	if (isSignedOrEncrypted(email)) {
		throw new SendError("unsupported_message", "signed_or_encrypted", "Signed or encrypted messages cannot be submitted");
	}

	const recipients = reconcileRecipients({ to: headerMailboxes(email.to), cc: headerMailboxes(email.cc), envelope: rcptTo });

	const replyToHeaders = headerValues(email.headers, "reply-to");
	let replyTo: string | null = null;
	if (replyToHeaders.length > 0) {
		const mailboxes = headerMailboxes(email.replyTo);
		if (replyToHeaders.length > 1 || mailboxes.length > 1) throw new SendError("unsupported_message", "reply_to_multiple", "Only one Reply-To address is supported");
		if (mailboxes.length === 1) replyTo = formatEmailAddress(mailboxes[0].address, mailboxes[0].name);
	}

	const inReplyTo = safeMessageId(parseMessageIdList(email.inReplyTo)[0]);
	const references = parseMessageIdList(email.references).map(safeMessageId).filter((id): id is string => !!id);
	let threadId: string | null;
	try {
		threadId = await findParentThreadId(getDb(env), { mailboxId: principal.mailboxId, inReplyTo, references });
	} catch (error) {
		throw toSendError(error);
	}

	const text = email.text ?? undefined;
	const html = email.html ?? undefined;
	return {
		userId: principal.userId,
		mailboxId: principal.mailboxId,
		from: from.address,
		to: recipients.to,
		cc: recipients.cc,
		bcc: recipients.bcc,
		replyTo,
		subject: cleanHeaderText(email.subject),
		// A message with no text part at all still sends an empty text body.
		text: text === undefined && html === undefined ? "" : text,
		html,
		inReplyTo,
		references,
		threadId,
		attachments: attachmentsOf(email),
		publicOrigin: request.publicOrigin,
	};
}

/**
 * Submit one message for an authenticated principal. Never throws.
 *
 * `accepted` means the transport accepted the message and the server stored (or, when
 * `degraded`, is reconciling) its one Sent copy; the listener answers success and the
 * client must not keep its own Sent copy. `failed` carries the semantic classification
 * the listener maps to a reply; a failed attempt leaves no message row behind (the
 * attempt is recorded on an `outbound_jobs` row), so a client retrying it never piles up
 * failed copies. A failure whose `delivery` is `unknown` may have been delivered.
 *
 * Rate limiting is the listener's (see `submissionLimiterKeys`).
 */
export async function submitMessage(env: CloudflareEnv, request: SubmissionRequest): Promise<SubmissionResult> {
	let input: SendEmailInput;
	try {
		input = await prepareSubmission(env, request);
	} catch (error) {
		if (!isSendError(error)) console.error("submission.prepare unexpected failure", error instanceof Error ? error.name : typeof error);
		return { status: "failed", failure: toFailure(toSendError(error)) };
	}
	const recipientCount = (input.to as string[]).length + (input.cc as string[]).length + (input.bcc as string[]).length;
	try {
		const outcome = await sendEmailWithOutcome(env, input, { failedAttempt: "discard" });
		if (outcome.status !== "accepted") throw new Error("Submission was scheduled");
		return { status: "accepted", messageId: outcome.messageId, providerMessageId: outcome.providerMessageId, recipientCount, degraded: outcome.degraded };
	} catch (error) {
		if (isSendError(error)) return { status: "failed", failure: toFailure(error) };
		// Not classified by the send path, so it cannot be shown to have happened before the
		// transport: never report it as safe to retry.
		console.error("submission.send unexpected failure", error instanceof Error ? error.name : typeof error);
		return { status: "failed", failure: toFailure(new SendError("internal_temporary", "internal_error", "Send failed", { delivery: "unknown" })) };
	}
}
