import type { DeliveryState, SendFailureKind } from "@/lib/email/send-result-types";

const TEMPORARY_KINDS = new Set<SendFailureKind>(["transport_temporary", "internal_temporary"]);

/**
 * A send that did not reach the delivery boundary (the transport accepting the message).
 * The message text is the one callers have always shown (the HTTP routes map statuses
 * from it); `kind`, `reason` and `delivery` are the stable classification a protocol layer
 * maps from. Never put credentials or message content into the text.
 */
export class SendError extends Error {
	readonly kind: SendFailureKind;
	/** A short stable code for the specific cause, e.g. `subject_too_long`. */
	readonly reason: string;
	readonly delivery: DeliveryState;

	constructor(kind: SendFailureKind, reason: string, message: string, options?: { cause?: unknown; delivery?: DeliveryState }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "SendError";
		this.kind = kind;
		this.reason = reason;
		this.delivery = options?.delivery ?? "not_attempted";
	}

	/** Whether a later attempt can succeed without the message changing. */
	get temporary(): boolean {
		return TEMPORARY_KINDS.has(this.kind);
	}

	/**
	 * Whether another attempt is free of duplicate risk: true only when the transport
	 * provably did not accept the message. False when the outcome is unknown.
	 */
	get retrySafe(): boolean {
		return this.delivery !== "unknown";
	}
}

const BOUND_PARAMETERS = /\r?\nparams:[\s\S]*$/;

/**
 * An error's text, safe to store, log or show: drizzle puts every bound parameter of a
 * failed query (addresses, subjects, message bodies) into its message, so they are cut
 * off, and the driver's own reason is kept. At most 300 characters.
 */
export function safeErrorText(error: unknown): string {
	try {
		if (!(error instanceof Error)) return typeof error === "string" ? error.replace(BOUND_PARAMETERS, "").slice(0, 300) : "Send failed";
		let text = error.message.replace(BOUND_PARAMETERS, "");
		const cause = error.cause instanceof Error ? error.cause.message.replace(BOUND_PARAMETERS, "") : null;
		if (cause && !text.includes(cause)) text = `${text} (${cause})`;
		return text.slice(0, 300);
	} catch {
		return "unprintable error";
	}
}

export function isSendError(error: unknown): error is SendError {
	return error instanceof SendError;
}

/**
 * Keep a classified error; anything else is a local failure before the transport was
 * called, so it fails closed as a temporary internal failure. Only for code that runs
 * before the transport call: a failure of unknown origin is classified by the caller.
 */
export function toSendError(error: unknown, reason = "internal_error"): SendError {
	if (error instanceof SendError) return error;
	return new SendError("internal_temporary", reason, safeErrorText(error), { cause: error });
}

/** Failures while setting up the connection or credentials, before any message data moved. */
const SETUP_CODES = new Set(["EDNS", "ETLS", "EREQUIRETLS", "EPROXY"]);
const CONFIGURATION_CODES = new Set(["EAUTH", "ENOAUTH", "EOAUTH2", "ECONFIG", "ENOTCONFIGURED"]);
/** Connection-level failures that do not say whether the message was handed over. */
const CONNECTION_CODES = new Set(["ESOCKET", "ECONNECTION", "ETIMEDOUT"]);
const CONNECT_PHASE_MESSAGES = /^(Connection timeout|Greeting never received)/;

/**
 * Classify an error thrown by `env.EMAIL.send`. Only signals the transports actually give
 * are trusted:
 *
 * - nodemailer (Node SMTP relay): a setup or configuration code (DNS, TLS, relay
 *   authentication) or a socket failure while connecting means nothing was sent; an SMTP
 *   reply code is a definitive refusal (5xx permanent, 4xx temporary); a local envelope or
 *   message check means nothing was sent. A connection lost or timed out later may have
 *   happened after the relay received the message, so it is `unknown`.
 * - The Node Cloudflare REST transport: an HTTP status is a definitive answer below 500;
 *   a 5xx or a network failure leaves the outcome `unknown`.
 * - Anything else, including every error of the Workers binding (which carries no
 *   classification), is a temporary failure with an `unknown` outcome: a client keeps the
 *   message rather than lose it, and the duplicate risk is reported, never hidden.
 */
export function classifyTransportError(error: unknown): SendError {
	const message = safeErrorText(error);
	const details = (typeof error === "object" && error !== null ? error : {}) as {
		code?: unknown;
		responseCode?: unknown;
		status?: unknown;
		syscall?: unknown;
	};
	const make = (kind: SendFailureKind, reason: string, delivery: DeliveryState) => new SendError(kind, reason, message, { cause: error, delivery });
	const code = typeof details.code === "string" ? details.code : null;

	if (code && CONFIGURATION_CODES.has(code)) return make("transport_temporary", "transport_configuration", "not_attempted");
	if (code && SETUP_CODES.has(code)) return make("transport_temporary", "transport_unavailable", "not_attempted");
	if (code && CONNECTION_CODES.has(code)) {
		const connecting = details.syscall === "connect" || details.syscall === "getaddrinfo" || CONNECT_PHASE_MESSAGES.test(message);
		return make("transport_temporary", "transport_unavailable", connecting ? "not_attempted" : "unknown");
	}
	if (typeof details.responseCode === "number") {
		if (details.responseCode >= 500 && details.responseCode < 600) return make("delivery_rejected", "transport_rejected", "rejected");
		if (details.responseCode >= 400 && details.responseCode < 500) return make("transport_temporary", "transport_deferred", "rejected");
	}
	// nodemailer's own envelope and message checks run before anything is sent.
	if (code === "EENVELOPE" || code === "EMESSAGE") return make("delivery_rejected", "transport_rejected", "not_attempted");
	if (typeof details.status === "number" && details.status >= 400) {
		const status = details.status;
		if (status === 401 || status === 403) return make("transport_temporary", "transport_configuration", "rejected");
		if (status === 408 || status === 429) return make("transport_temporary", "transport_deferred", "rejected");
		if (status < 500) return make("delivery_rejected", "transport_rejected", "rejected");
		return make("transport_temporary", "transport_unavailable", "unknown");
	}
	return make("transport_temporary", "transport_unknown", "unknown");
}
