/**
 * Why a send did not complete. Protocol-neutral: a protocol layer (SMTP submission,
 * JMAP, HTTP) maps these to its own replies; no protocol codes live here.
 *
 * - `invalid_message`: the message or request cannot be sent as given (permanent).
 * - `unsupported_message`: well-formed, but the structured send path cannot carry it
 *   faithfully (signed or encrypted MIME, a Bcc-only message, several Reply-To
 *   addresses); permanent.
 * - `unauthorized_sender`: the principal may not send, or not from this address (permanent).
 * - `delivery_rejected`: the transport refused the message or its recipients (permanent).
 * - `transport_temporary`: the transport was unreachable, deferred the message, or failed
 *   in a way that may clear (temporary).
 * - `internal_temporary`: a local failure (database, storage) or an unclassified error
 *   (temporary; anything unrecognised fails closed into this kind).
 */
export type SendFailureKind =
	| "invalid_message"
	| "unsupported_message"
	| "unauthorized_sender"
	| "delivery_rejected"
	| "transport_temporary"
	| "internal_temporary";

/**
 * How far a failed attempt got with the transport. This, not the kind, decides whether
 * a retry can deliver the message twice.
 *
 * - `not_attempted`: the transport never received the message (it failed before the
 *   transport was called, or before a connection could carry the message).
 * - `rejected`: the transport answered definitively that it did not accept it.
 * - `unknown`: the transport call failed without a definitive answer (a connection lost
 *   or timed out while the message may already have been handed over). The provider may
 *   have accepted it, so a retry can duplicate it.
 */
export type DeliveryState = "not_attempted" | "rejected" | "unknown";

/** Local bookkeeping that failed after the transport accepted the message. */
export type PostAcceptanceIssue = "job_state" | "canonical_copy" | "message_state" | "webhooks" | "audit_log" | "internal";

/**
 * What becomes of a failed immediate attempt's message row.
 *
 * - `retain` (web, JMAP, API, everything existing): the row stays with status `failed`,
 *   as before.
 * - `discard` (SMTP submission, whose client keeps the message and retries): the row and
 *   its attachment objects are removed, so retries never pile up failed copies. The
 *   `outbound_jobs` row stays as the record of the attempt, with a redacted payload.
 */
export type FailedAttemptPolicy = "retain" | "discard";

export type SendOptions = {
	failedAttempt?: FailedAttemptPolicy;
};

/**
 * A send that did not throw. `accepted`: the transport took the message; it must never be
 * retried, even when `degraded` lists local bookkeeping that failed afterwards (the
 * message is still delivered; the issues are logged and recorded for reconciliation).
 */
export type SendOutcome =
	| { status: "accepted"; messageId: string; providerMessageId: string; degraded: PostAcceptanceIssue[] }
	| { status: "scheduled"; messageId: string };
