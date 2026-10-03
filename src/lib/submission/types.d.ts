import type { MailAppPrincipal } from "@/lib/mail-app-passwords/types";
import type { DeliveryState, PostAcceptanceIssue, SendFailureKind } from "@/lib/email/send-result-types";

/**
 * Who is submitting: a principal from `verifyMailAppPassword` with the `smtp` scope, as
 * the listener authenticated it. Trusted only as a claim of identity: the credential
 * (still existing, still `smtp`-scoped, still for this user and mailbox), the account and
 * the mailbox permission are evaluated again on every call.
 */
export type SubmissionPrincipal = Pick<MailAppPrincipal, "appPasswordId" | "userId" | "mailboxId">;

/** The SMTP envelope. Addresses are given without angle brackets or ESMTP parameters. */
export type SubmissionEnvelope = {
	/** MAIL FROM reverse-path. The null reverse-path (empty) is refused. */
	mailFrom: string;
	/** RCPT TO forward-paths, in the order accepted. The authoritative delivery list. */
	rcptTo: string[];
};

export type SubmissionRequest = {
	principal: SubmissionPrincipal;
	envelope: SubmissionEnvelope;
	/**
	 * The complete message as received in DATA (dot-unstuffed, without the terminating
	 * `.`), at most `MAX_SUBMISSION_MESSAGE_BYTES`. The listener must stop reading DATA at
	 * that limit rather than hand over more; the adapter refuses anything larger unread.
	 */
	message: Uint8Array;
	/** Origin for download links of attachments too large to send inline. */
	publicOrigin?: string;
};

/**
 * Why a submission was not accepted, without any message text: provider responses and
 * internal errors are logged, never handed to a client.
 */
export type SubmissionFailure = {
	kind: SendFailureKind;
	/** A short stable code for the cause, e.g. `from_mail_from_mismatch`. */
	reason: string;
	delivery: DeliveryState;
	/** A later attempt of the same message can succeed. */
	temporary: boolean;
	/** Another attempt cannot deliver the message twice. False when `delivery` is `unknown`. */
	retrySafe: boolean;
};

/**
 * `accepted`: the transport took the message and the server owns its Sent copy. It must be
 * answered as accepted even when `degraded` is not empty: the message is on its way and a
 * retry would deliver it twice.
 */
export type SubmissionResult =
	| { status: "accepted"; messageId: string; providerMessageId: string; recipientCount: number; degraded: PostAcceptanceIssue[] }
	| { status: "failed"; failure: SubmissionFailure };

export type SubmissionSenderCheck = { ok: true } | { ok: false; failure: SubmissionFailure };

/** A recipient as presented in a header: a lowercased address and an optional display name. */
export type HeaderMailbox = { address: string; name: string | null };

export type ReconciledRecipients = {
	/** Formatted header entries, as delivered in To and Cc. */
	to: string[];
	cc: string[];
	/** Bare addresses: envelope recipients named in neither To nor Cc. Never in a header. */
	bcc: string[];
};
