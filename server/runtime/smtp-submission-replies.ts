import type { SubmissionFailure, SubmissionResult } from "@/lib/submission/types";

/**
 * SMTP replies for the submission listener (SMTP-2): the one place the semantic results of
 * the SMTP-1 adapter become protocol codes. Texts are fixed and safe to show a client; no
 * internal message, provider response or address is ever included.
 *
 * Four outcomes, kept apart:
 * - known provider acceptance (degraded or not): 250;
 * - known failure before acceptance that may succeed later: 451 (TEMPORARY_FAILURE_REPLY);
 * - known permanent rejection: a 5xx by kind;
 * - delivery unknown (`delivery: "unknown"`, `retrySafe: false`: the transport call failed
 *   without a definitive answer, so the relay may or may not have accepted it): 451 with
 *   its own text (DELIVERY_UNKNOWN_REPLY). A 5xx would tell the client delivery definitely
 *   failed, which nobody knows. The cost is explicit: if the relay did accept and only the
 *   confirmation was lost, the client's retry sends a duplicate. RFC 5321 §6.1 prefers a
 *   possible duplicate to a lost message; SMTP-2 does not try to suppress duplicates (an
 *   in-memory record would be lost on restart and be wrong across instances).
 * Retry safety is checked first, so an ambiguous outcome never gets a kind-based reply.
 *
 * ENHANCEDSTATUSCODES is not advertised: smtp-server would attach its generic per-code
 * enhanced status to replies from callbacks (550 → 5.1.1), which would misreport them.
 */

export type SmtpReply = { code: number; message: string };

/**
 * 451 ("local error in processing", RFC 5321 §4.2.3): the client keeps the message and
 * retries. With ENHANCEDSTATUSCODES it would be 4.4.0 (RFC 3463, other network status).
 */
export const DELIVERY_UNKNOWN_REPLY: SmtpReply = {
	code: 451,
	message: "Delivery status unknown: the message may already have been sent; try again later",
};
export const TEMPORARY_FAILURE_REPLY: SmtpReply = { code: 451, message: "Temporary failure, try again later" };
export const RATE_LIMITED_REPLY: SmtpReply = { code: 451, message: "Sending rate limit reached, try again later" };
export const BUSY_REPLY: SmtpReply = { code: 451, message: "Too many submissions in progress, try again later" };
export const TOO_MANY_RECIPIENTS_REPLY: SmtpReply = { code: 452, message: "Too many recipients" };
export const MESSAGE_TOO_LARGE_REPLY: SmtpReply = { code: 552, message: "Message exceeds the maximum size" };

const SIZE_REASONS = new Set(["message_too_large", "attachments_too_large", "message_too_large_for_transport"]);

/** Fixed explanations per adapter reason; anything else gets its kind's generic text. */
const REASON_TEXT: Record<string, string> = {
	// invalid_message
	malformed_message: "Message rejected: it is not a valid RFC 5322 message",
	from_invalid: "Message rejected: the From header must name exactly one valid address",
	header_recipient_invalid: "Message rejected: a To or Cc address is not valid",
	header_recipient_not_in_envelope: "Message rejected: every To and Cc address must also be a recipient (RCPT TO)",
	attachments_invalid: "Message rejected: too many or too large attachments",
	subject_too_long: "Message rejected: the subject is too long",
	headers_too_large: "Message rejected: the headers are too large",
	reply_to_invalid: "Message rejected: Reply-To must be a single valid address",
	too_many_recipients: "Message rejected: too many recipients",
	recipient_invalid: "Message rejected: a recipient address is not valid",
	no_recipients: "Message rejected: no recipients",
	mail_from_invalid: "Message rejected: the sender address is not valid",
	// unsupported_message
	signed_or_encrypted: "Message not supported: signed or encrypted messages cannot be sent through this server",
	no_visible_recipient: "Message not supported: a To recipient is required",
	reply_to_multiple: "Message not supported: only one Reply-To address is supported",
	// unauthorized_sender
	from_mail_from_mismatch: "Sender not authorized: the From address must match MAIL FROM",
	sender_header_mismatch: "Sender not authorized: the Sender header must match From",
	credential_unavailable: "Sender not authorized: this credential can no longer send mail",
	null_sender: "Sender not authorized: a sender address is required",
};

function permanent(failure: SubmissionFailure): SmtpReply {
	switch (failure.kind) {
		case "invalid_message":
			if (SIZE_REASONS.has(failure.reason)) return MESSAGE_TOO_LARGE_REPLY;
			return { code: 554, message: REASON_TEXT[failure.reason] ?? "Message rejected" };
		case "unsupported_message":
			return { code: 554, message: REASON_TEXT[failure.reason] ?? "Message not supported" };
		case "unauthorized_sender":
			return { code: 550, message: REASON_TEXT[failure.reason] ?? "Sender address not authorized" };
		case "delivery_rejected":
			return { code: 554, message: "Delivery rejected by the outbound mail relay" };
		default:
			return { code: 554, message: "Message rejected" };
	}
}

/** The reply for a submission failure: an ambiguous outcome first, then temporary, then permanent. */
export function replyForFailure(failure: SubmissionFailure): SmtpReply {
	if (failure.retrySafe !== true || failure.delivery === "unknown") return DELIVERY_UNKNOWN_REPLY;
	if (failure.temporary) return TEMPORARY_FAILURE_REPLY;
	return permanent(failure);
}

/** The reply for the end of DATA. Accepted, degraded or not, is always success. */
export function replyForSubmission(result: SubmissionResult): SmtpReply {
	if (result.status === "accepted") return { code: 250, message: `OK: queued as ${result.messageId}` };
	return replyForFailure(result.failure);
}

/**
 * The reply for a refused MAIL FROM (nothing is being sent yet, so every failure is
 * retry-safe; an unclassified one is still treated as temporary, never as accepted).
 */
export function replyForSenderRefusal(failure: SubmissionFailure): SmtpReply {
	if (failure.temporary) return TEMPORARY_FAILURE_REPLY;
	if (failure.reason === "mail_from_invalid") return { code: 553, message: "Sender address syntax not accepted" };
	if (failure.kind === "unauthorized_sender") return { code: 550, message: REASON_TEXT[failure.reason] ?? "Sender address not authorized" };
	return { code: 550, message: "Sender address not accepted" };
}
