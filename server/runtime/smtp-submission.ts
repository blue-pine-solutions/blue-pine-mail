import type { AddressInfo, Socket } from "node:net";
import { createServer, type TLSSocket } from "node:tls";
import { SMTPServer } from "smtp-server";
import type { SMTPServerAuthentication, SMTPServerDataStream, SMTPServerSession } from "smtp-server";
import { DISTRIBUTION } from "@/lib/distribution/identity";
import { verifyMailAppPassword } from "@/lib/mail-app-passwords/verify";
import { safeErrorText } from "@/lib/email/send-result-utils";
import { authorizeSubmissionSender, MAX_SUBMISSION_MESSAGE_BYTES, MAX_SUBMISSION_RECIPIENTS, submitMessage } from "@/lib/submission/service";
import type { SubmissionPrincipal, SubmissionResult } from "@/lib/submission/types";
import { normalizeMailboxAddress, submissionLimiterKeys } from "@/lib/submission/utils";
import { loadTlsMaterial, type TlsMaterial, type TlsMaterialNames } from "./imap";
import { clientAddressKey, ConcurrencyCounter, SlidingWindowCounter } from "./imap-limits";
import {
	BUSY_REPLY,
	DELIVERY_UNKNOWN_REPLY,
	MESSAGE_TOO_LARGE_REPLY,
	RATE_LIMITED_REPLY,
	replyForSenderRefusal,
	replyForSubmission,
	TEMPORARY_FAILURE_REPLY,
	TOO_MANY_RECIPIENTS_REPLY,
	type SmtpReply,
} from "./smtp-submission-replies";

/**
 * The authenticated SMTP submission listener (SMTP-2): implicit TLS only (port 465 by
 * convention), AUTH PLAIN and LOGIN with mail app passwords that carry the `smtp` scope,
 * and every message handed to the SMTP-1 adapter (`submitMessage`), which parses it and
 * sends it through `sendEmail`. Node/Docker only, separate from the inbound listener
 * (smtp.ts), which accepts unauthenticated mail for local mailboxes and never relays.
 *
 * Opt-in: nothing listens unless SMTP_SUBMISSION_PORT is set. The host defaults to the
 * loopback interface; a container sets SMTP_SUBMISSION_HOST=0.0.0.0 and publishes the port
 * where it wants it. TLS material comes from SMTP_SUBMISSION_TLS_CERT/KEY, or, when neither
 * is set, from IMAP_TLS_CERT/KEY (the same mail hostname in a typical deployment); unusable
 * material fails startup, and SIGHUP reloads it. There is no plaintext or STARTTLS port.
 *
 * Every limit here is per instance and in memory (like the IMAP listener's): several
 * instances enforce each limit per instance.
 */

const TLS_MIN_VERSION = "TLSv1.2";

export type SubmissionListenerConfig = {
	port: number;
	host: string;
	certPath: string;
	keyPath: string;
	/** Which variables the certificate came from (for messages and logs). */
	tlsSource: "submission" | "imap";
	/** Name given in the greeting and EHLO reply. */
	hostname?: string;
};

export type SubmissionLimits = {
	maxConnections: number;
	maxConnectionsPerAddress: number;
	/** Authenticated connections per account at once. */
	maxConnectionsPerUser: number;
	/** Failed AUTH attempts on one connection before it is closed. */
	authFailuresPerConnection: number;
	authFailuresPerAddress: number;
	authFailuresPerUsername: number;
	authFailureWindowMs: number;
	/** Added before answering each failed AUTH. */
	authFailureDelayMs: number;
	/** Added before each attempt for a username past its failure limit (a delay, never a lockout). */
	usernameThrottleDelayMs: number;
	/** A connection whose TLS handshake has not completed this long after it opened is cut. */
	handshakeTimeoutMs: number;
	/** A connection not authenticated this long after it opened is cut, whatever it sends. */
	loginTimeoutMs: number;
	/** Socket idle timeout (RFC 5321 §4.5.3.2 asks at least five minutes of servers). */
	idleTimeoutMs: number;
	/** Commands before authentication (EHLO, NOOP, ...) before the connection is closed. */
	maxUnauthenticatedCommands: number;
	maxCommandLength: number;
	/** Largest message accepted, never above the adapter's MAX_SUBMISSION_MESSAGE_BYTES. */
	maxMessageBytes: number;
	/** Bytes read and discarded after the limit before the connection is cut instead. */
	dataDiscardAllowanceBytes: number;
	/** DATA must arrive within this grace plus its size at this minimum average rate. */
	dataBaseMs: number;
	dataMinBytesPerSecond: number;
	maxMessagesPerConnection: number;
	maxRecipientsPerMessage: number;
	/** Messages being received or submitted at once: in all, and per account. */
	maxConcurrentSubmissions: number;
	maxConcurrentSubmissionsPerUser: number;
	/** Sending rate, in the window: messages per account and per credential, recipients per account. */
	rateWindowMs: number;
	messagesPerUser: number;
	messagesPerCredential: number;
	recipientsPerUser: number;
	shutdownGraceMs: number;
};

export const DEFAULT_SUBMISSION_LIMITS: SubmissionLimits = {
	maxConnections: 100,
	maxConnectionsPerAddress: 10,
	maxConnectionsPerUser: 10,
	authFailuresPerConnection: 3,
	authFailuresPerAddress: 10,
	authFailuresPerUsername: 20,
	authFailureWindowMs: 15 * 60_000,
	authFailureDelayMs: 1_000,
	usernameThrottleDelayMs: 5_000,
	handshakeTimeoutMs: 10_000,
	loginTimeoutMs: 60_000,
	idleTimeoutMs: 5 * 60_000,
	maxUnauthenticatedCommands: 10,
	maxCommandLength: 4096,
	maxMessageBytes: MAX_SUBMISSION_MESSAGE_BYTES,
	dataDiscardAllowanceBytes: 1024 * 1024,
	dataBaseMs: 60_000,
	dataMinBytesPerSecond: 16 * 1024,
	maxMessagesPerConnection: 50,
	maxRecipientsPerMessage: MAX_SUBMISSION_RECIPIENTS,
	maxConcurrentSubmissions: 4,
	maxConcurrentSubmissionsPerUser: 1,
	rateWindowMs: 60 * 60_000,
	messagesPerUser: 100,
	messagesPerCredential: 50,
	recipientsPerUser: 500,
	shutdownGraceMs: 2_000,
};

const SUBMISSION_TLS_NAMES: TlsMaterialNames = { cert: "SMTP_SUBMISSION_TLS_CERT", key: "SMTP_SUBMISSION_TLS_KEY", label: "SMTP submission" };
const IMAP_FALLBACK_TLS_NAMES: TlsMaterialNames = { cert: "IMAP_TLS_CERT (used by SMTP submission)", key: "IMAP_TLS_KEY (used by SMTP submission)", label: "SMTP submission" };

/**
 * The listener's configuration from the environment; null when submission is disabled
 * (SMTP_SUBMISSION_PORT unset, empty or 0). Throws on an invalid configuration.
 */
export function readSubmissionConfig(env: Record<string, string | undefined> = process.env): SubmissionListenerConfig | null {
	const rawPort = env.SMTP_SUBMISSION_PORT?.trim() ?? "";
	if (rawPort === "" || rawPort === "0") return null;
	const port = Number(rawPort);
	if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`SMTP_SUBMISSION_PORT must be a TCP port number (got "${rawPort}")`);
	}
	const certPath = env.SMTP_SUBMISSION_TLS_CERT?.trim();
	const keyPath = env.SMTP_SUBMISSION_TLS_KEY?.trim();
	let tls: Pick<SubmissionListenerConfig, "certPath" | "keyPath" | "tlsSource">;
	if (certPath || keyPath) {
		if (!certPath || !keyPath) throw new Error("SMTP_SUBMISSION_TLS_CERT and SMTP_SUBMISSION_TLS_KEY must be set together");
		tls = { certPath, keyPath, tlsSource: "submission" };
	} else {
		const imapCert = env.IMAP_TLS_CERT?.trim();
		const imapKey = env.IMAP_TLS_KEY?.trim();
		if (!imapCert || !imapKey) {
			throw new Error("SMTP_SUBMISSION_PORT is set but no certificate is: set SMTP_SUBMISSION_TLS_CERT and SMTP_SUBMISSION_TLS_KEY (or IMAP_TLS_CERT and IMAP_TLS_KEY); submission only serves implicit TLS");
		}
		tls = { certPath: imapCert, keyPath: imapKey, tlsSource: "imap" };
	}
	const hostname = env.MAIL_HOSTNAME?.trim() || undefined;
	return { port, host: env.SMTP_SUBMISSION_HOST?.trim() || "127.0.0.1", ...tls, ...(hostname ? { hostname } : {}) };
}

/** Read and validate the listener's PEM certificate and key, naming the variables they came from. */
export function loadSubmissionTlsMaterial(config: SubmissionListenerConfig): TlsMaterial {
	return loadTlsMaterial(config, config.tlsSource === "submission" ? SUBMISSION_TLS_NAMES : IMAP_FALLBACK_TLS_NAMES);
}

export type SubmissionLogEvent = { event: string } & Record<string, string | number | boolean | null | undefined>;
type Logger = (event: SubmissionLogEvent) => void;

function defaultLogger(event: SubmissionLogEvent): void {
	const fields = Object.entries(event)
		.filter(([name, value]) => name !== "event" && value !== undefined && value !== null)
		.map(([name, value]) => `${name}=${typeof value === "string" && /\s/.test(value) ? JSON.stringify(value) : value}`)
		.join(" ");
	console.log(`smtp-submission ${event.event}${fields ? ` ${fields}` : ""}`);
}

export type SubmissionListener = {
	readonly port: number;
	readonly connections: number;
	/** Message bytes held in memory now, and the most ever held at once (all connections). */
	readonly retainedBytes: number;
	readonly peakRetainedBytes: number;
	/** Re-read the certificate files; keeps the current ones if the new ones are invalid. */
	reloadCertificates(): boolean;
	close(): Promise<void>;
};

/** What the listener knows about one connection; created with the TCP socket and released when it closes. */
type Connection = {
	id: string;
	ip: string | undefined;
	addressKey: string;
	opened: number;
	principal: SubmissionPrincipal | null;
	authFailures: number;
	messages: number;
	releases: Array<() => void>;
	timers: Set<ReturnType<typeof setTimeout>>;
	/** The TCP socket until the handshake completes, then the TLS socket (destroying the raw one then would not close it). */
	socket: Socket;
	closed: boolean;
};

class ReplyError extends Error {
	constructor(readonly reply: SmtpReply) {
		super(reply.message);
	}
	get responseCode() {
		return this.reply.code;
	}
}
const fail = (reply: SmtpReply) => new ReplyError(reply);

export type SubmissionListenerOptions = {
	limits?: Partial<SubmissionLimits>;
	log?: Logger;
	/** The adapter, replaceable in tests to produce every result shape. */
	submit?: typeof submitMessage;
	/** Origin for download links of attachments too large to send inline. */
	publicOrigin?: string;
	now?: () => number;
};

export async function startSubmissionListener(
	env: CloudflareEnv,
	config: SubmissionListenerConfig,
	tls: TlsMaterial,
	options: SubmissionListenerOptions = {},
): Promise<SubmissionListener> {
	const limits: SubmissionLimits = { ...DEFAULT_SUBMISSION_LIMITS, ...options.limits };
	// The adapter refuses anything larger; never advertise or buffer more than it accepts.
	limits.maxMessageBytes = Math.min(limits.maxMessageBytes, MAX_SUBMISSION_MESSAGE_BYTES);
	limits.maxRecipientsPerMessage = Math.min(limits.maxRecipientsPerMessage, MAX_SUBMISSION_RECIPIENTS);
	const log = options.log ?? defaultLogger;
	const submit = options.submit ?? submitMessage;
	const now = options.now ?? Date.now;

	const perAddress = new ConcurrencyCounter(limits.maxConnectionsPerAddress);
	const perUser = new ConcurrencyCounter(limits.maxConnectionsPerUser);
	const addressFailures = new SlidingWindowCounter(limits.authFailuresPerAddress, limits.authFailureWindowMs, 100_000, now);
	const usernameFailures = new SlidingWindowCounter(limits.authFailuresPerUsername, limits.authFailureWindowMs, 100_000, now);
	const inFlight = new ConcurrencyCounter(limits.maxConcurrentSubmissions);
	const inFlightPerUser = new ConcurrencyCounter(limits.maxConcurrentSubmissionsPerUser);
	const userMessages = new SlidingWindowCounter(limits.messagesPerUser, limits.rateWindowMs, 100_000, now);
	const credentialMessages = new SlidingWindowCounter(limits.messagesPerCredential, limits.rateWindowMs, 100_000, now);
	const userRecipients = new SlidingWindowCounter(limits.recipientsPerUser, limits.rateWindowMs, 100_000, now);

	const byKey = new Map<string, Connection>();
	const bySocket = new WeakMap<Socket, Connection>();
	const bySession = new WeakMap<SMTPServerSession, Connection>();
	const connections = new Set<Connection>();
	let onDrained: (() => void) | null = null;
	let nextId = 1;
	let closing = false;
	let retained = 0;
	let peakRetained = 0;
	const retain = (bytes: number) => {
		retained += bytes;
		if (retained > peakRetained) peakRetained = retained;
	};

	const socketKey = (socket: { remoteAddress?: string; remotePort?: number }) => `${socket.remoteAddress}\u0000${socket.remotePort}`;
	const connectionOf = (session: SMTPServerSession): Connection | undefined => bySession.get(session);
	const timer = (connection: Connection, ms: number, run: () => void) => {
		const handle = setTimeout(() => {
			connection.timers.delete(handle);
			run();
		}, ms);
		handle.unref?.();
		connection.timers.add(handle);
		return handle;
	};
	const pause = (connection: Connection, ms: number) =>
		ms > 0 && !connection.closed ? new Promise<void>((resolve) => timer(connection, ms, resolve)) : Promise.resolve();

	const rateExhausted = (principal: SubmissionPrincipal, recipients = 0) => {
		const keys = submissionLimiterKeys(principal);
		return (
			userMessages.exceeded(keys.user) ||
			credentialMessages.exceeded(keys.credential) ||
			userRecipients.count(keys.user) + Math.max(recipients, 1) > limits.recipientsPerUser
		);
	};

	// TLS is terminated by Node's own tls.Server (as in the IMAP listener); smtp-server only ever
	// sees sockets whose handshake completed. Its built-in wrapping of raw sockets crashed the
	// process when a socket was destroyed mid-handshake (seen on Windows, Node 22).
	const tlsServer = createServer({ key: tls.key, cert: tls.cert, minVersion: TLS_MIN_VERSION, handshakeTimeout: limits.handshakeTimeoutMs });

	const server = new SMTPServer({
		secure: true,
		secured: true,
		// Never the library's default of os.hostname(), which would reveal the machine's name.
		name: config.hostname ?? "localhost",
		banner: DISTRIBUTION.name,
		logger: false,
		disableReverseLookup: true,
		authMethods: ["PLAIN", "LOGIN"],
		// Everything a submission client needs, and nothing else.
		disabledCommands: ["STARTTLS", "VRFY", "HELP", "XCLIENT", "XFORWARD", "WIZ", "SHELL", "KILL"],
		hideSTARTTLS: true,
		hideSMTPUTF8: true,
		hideENHANCEDSTATUSCODES: true,
		hideDSN: true,
		// Options smtp-server 3.19 has that @types/smtp-server does not list yet.
		...({ hideREQUIRETLS: true, maxAllowedUnauthenticatedCommands: limits.maxUnauthenticatedCommands, maxCommandLength: limits.maxCommandLength, authRequiredMessage: "Authentication required" } as object),
		size: limits.maxMessageBytes,
		// Connections are counted and refused on the TCP socket, before TLS (see "connection" below).
		socketTimeout: limits.idleTimeoutMs,
		onSecure(socket, session, callback) {
			const connection = bySocket.get(socket);
			if (!connection || connection.closed) {
				socket.destroy();
				return;
			}
			bySession.set(session, connection);
			callback();
		},
		onAuth(auth: SMTPServerAuthentication & { authcid?: string; authzid?: string }, session, callback) {
			const connection = connectionOf(session);
			if (!connection) return callback(fail({ code: 421, message: "Service not available" }));
			void authenticate(connection, auth).then(
				(result) => {
					if (result === "ok") return callback(null, { user: connection.principal!.appPasswordId });
					callback(fail(result));
				},
				() => callback(fail({ code: 454, message: "Temporary authentication failure" })),
			);
		},
		onMailFrom(address, session, callback) {
			const connection = connectionOf(session);
			if (!connection?.principal) return callback(fail({ code: 530, message: "Authentication required" }));
			if (connection.messages >= limits.maxMessagesPerConnection) {
				log({ event: "limit.messages-per-connection", connection: connection.id });
				return callback(fail({ code: 421, message: "Too many messages on this connection, reconnect to continue" }));
			}
			// This command's own parameter: smtp-server sets envelope.smtpUtf8 before this hook and keeps it after a refusal.
			const parameters = (address.args || {}) as Record<string, unknown>;
			if (parameters.SMTPUTF8 !== undefined) return callback(fail({ code: 555, message: "SMTPUTF8 is not supported" }));
			if (rateExhausted(connection.principal)) {
				log({ event: "limit.rate", connection: connection.id, stage: "mail" });
				return callback(fail(RATE_LIMITED_REPLY));
			}
			void authorizeSubmissionSender(env, connection.principal, address.address ?? "").then(
				(check) => {
					if (check.ok) return callback();
					log({ event: "submission.rejected", connection: connection.id, stage: "mail", kind: check.failure.kind, reason: check.failure.reason });
					callback(fail(replyForSenderRefusal(check.failure)));
				},
				() => callback(fail(TEMPORARY_FAILURE_REPLY)),
			);
		},
		onRcptTo(address, session, callback) {
			const connection = connectionOf(session);
			if (!connection?.principal) return callback(fail({ code: 530, message: "Authentication required" }));
			const normalized = normalizeMailboxAddress(address.address ?? "");
			if (!normalized) return callback(fail({ code: 553, message: "Recipient address syntax not accepted" }));
			const current = session.envelope.rcptTo.map((entry) => entry.address.toLowerCase());
			// A repeated recipient replaces itself, so it never counts twice.
			if (!current.includes(normalized) && current.length >= limits.maxRecipientsPerMessage) {
				log({ event: "limit.recipients", connection: connection.id });
				return callback(fail(TOO_MANY_RECIPIENTS_REPLY));
			}
			if (rateExhausted(connection.principal, current.length + 1)) {
				log({ event: "limit.rate", connection: connection.id, stage: "rcpt" });
				return callback(fail(RATE_LIMITED_REPLY));
			}
			callback();
		},
		onData(stream, session, callback) {
			const connection = connectionOf(session);
			if (!connection?.principal) {
				stream.resume();
				return callback(fail({ code: 530, message: "Authentication required" }));
			}
			receive(connection, connection.principal, stream, session, callback);
		},
	});

	/** AUTH: a mail app password with the smtp scope, for exactly the mailbox address given. */
	async function authenticate(connection: Connection, auth: SMTPServerAuthentication & { authcid?: string; authzid?: string }): Promise<"ok" | SmtpReply> {
		const username = (auth.username ?? "").trim().toLowerCase();
		const usernameKey = username.slice(0, 320);
		if (addressFailures.exceeded(connection.addressKey)) {
			log({ event: "auth.throttled", connection: connection.id, ip: connection.ip, scope: "address" });
			return { code: 421, message: "Too many failed authentication attempts, try again later" };
		}
		if (usernameFailures.exceeded(usernameKey)) await pause(connection, limits.usernameThrottleDelayMs);
		// RFC 4616: an authorization identity, when given, must be the authentication identity.
		const authzid = (auth.authzid ?? "").trim().toLowerCase();
		const authcid = (auth.authcid ?? "").trim().toLowerCase();
		let ok = false;
		let reason = "invalid_credentials";
		if (auth.method === "PLAIN" || auth.method === "LOGIN") {
			if (auth.method === "PLAIN" && authzid && authcid && authzid !== authcid) {
				reason = "authzid_mismatch";
			} else {
				let result;
				try {
					result = await verifyMailAppPassword(env, { username, password: auth.password ?? "", scope: "smtp" });
				} catch (error) {
					log({ event: "auth.error", connection: connection.id, error: safeErrorText(error) });
					return { code: 454, message: "Temporary authentication failure" };
				}
				if (result.ok) {
					if (connection.closed) return { code: 421, message: "Service not available" };
					if (!perUser.tryAcquire(result.principal.userId)) {
						log({ event: "limit.user-connections", connection: connection.id, user: result.principal.userId });
						return { code: 421, message: "Too many connections for this account, try again later" };
					}
					const userId = result.principal.userId;
					connection.releases.push(() => perUser.release(userId));
					connection.principal = { appPasswordId: result.principal.appPasswordId, userId, mailboxId: result.principal.mailboxId };
					log({ event: "auth.success", connection: connection.id, method: auth.method, user: userId, mailbox: result.principal.mailboxId, credential: result.principal.appPasswordId });
					ok = true;
				} else {
					reason = result.reason;
				}
			}
		}
		if (ok) return "ok";
		addressFailures.hit(connection.addressKey);
		usernameFailures.hit(usernameKey);
		connection.authFailures += 1;
		// The reason class only: never the username, password or AUTH payload.
		log({ event: "auth.failure", connection: connection.id, ip: connection.ip, method: auth.method, reason, attempt: connection.authFailures });
		await pause(connection, limits.authFailureDelayMs);
		if (connection.authFailures >= limits.authFailuresPerConnection) {
			return { code: 421, message: "Too many failed authentication attempts" };
		}
		return { code: 535, message: "Authentication credentials invalid" };
	}

	/**
	 * DATA, bounded: bytes are kept only up to the size limit and dropped after it (the reply
	 * is then 552), and a client that keeps sending well past the limit, or too slowly, is
	 * disconnected. Memory per submission never exceeds the limit plus one chunk, and at most
	 * maxConcurrentSubmissions messages are held at once; a submission over those permits or
	 * over the sending rate is drained without being kept and refused with 451.
	 */
	function receive(connection: Connection, principal: SubmissionPrincipal, stream: SMTPServerDataStream, session: SMTPServerSession, callback: (error?: Error | null, message?: string) => void) {
		const recipients = session.envelope.rcptTo.map((entry) => entry.address);
		const mailFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
		connection.messages += 1;

		// Admission, decided synchronously so concurrent connections of one account cannot both pass.
		let refusal: SmtpReply | null = null;
		const releases: Array<() => void> = [];
		const keys = submissionLimiterKeys(principal);
		if (rateExhausted(principal, recipients.length)) {
			refusal = RATE_LIMITED_REPLY;
			log({ event: "limit.rate", connection: connection.id, stage: "data" });
		} else if (!inFlightPerUser.tryAcquire(principal.userId)) {
			refusal = BUSY_REPLY;
			log({ event: "limit.concurrent-submissions", connection: connection.id, scope: "user" });
		} else if (!inFlight.tryAcquire("all")) {
			inFlightPerUser.release(principal.userId);
			refusal = BUSY_REPLY;
			log({ event: "limit.concurrent-submissions", connection: connection.id, scope: "global" });
		} else {
			releases.push(() => inFlightPerUser.release(principal.userId), () => inFlight.release("all"));
			// Counted when accepted for transfer, whatever the outcome, so failures cannot be replayed for free.
			userMessages.hit(keys.user);
			credentialMessages.hit(keys.credential);
			for (let index = 0; index < recipients.length; index++) userRecipients.hit(keys.user);
		}
		let released = false;
		let delivering = false;
		const release = () => {
			if (released) return;
			released = true;
			for (const run of releases) run();
		};
		// A permit bounds the memory a message holds, so it is kept until the adapter is done with it.
		connection.releases.push(() => {
			if (!delivering) release();
		});

		const chunks: Buffer[] = [];
		let kept = 0;
		let total = 0;
		let oversized = false;
		let aborted = false;
		const started = now();
		const drop = () => {
			retain(-kept);
			chunks.length = 0;
			kept = 0;
		};
		const abort = (reason: string) => {
			if (aborted) return;
			aborted = true;
			drop();
			release();
			log({ event: "data.aborted", connection: connection.id, reason, bytes: total });
			connection.socket.destroy();
		};
		const tooSlow = () => now() - started > limits.dataBaseMs + (total / limits.dataMinBytesPerSecond) * 1000;
		const watchdog = setInterval(() => {
			if (tooSlow()) abort("too_slow");
		}, Math.min(5_000, limits.dataBaseMs));
		watchdog.unref?.();
		const stopWatchdog = () => clearInterval(watchdog);
		const onClose = () => {
			stopWatchdog();
			if (!delivering) drop();
		};
		connection.socket.once("close", onClose);

		stream.on("data", (chunk: Buffer) => {
			if (aborted) return;
			total += chunk.length;
			if (tooSlow()) return abort("too_slow");
			if (refusal) return;
			if (oversized) {
				if (total - limits.maxMessageBytes > limits.dataDiscardAllowanceBytes) abort("oversized");
				return;
			}
			if (kept + chunk.length > limits.maxMessageBytes) {
				// Over the limit: drop everything kept and only count from here on.
				oversized = true;
				drop();
				log({ event: "data.oversized", connection: connection.id, limit: limits.maxMessageBytes });
				if (total - limits.maxMessageBytes > limits.dataDiscardAllowanceBytes) abort("oversized");
				return;
			}
			chunks.push(chunk);
			kept += chunk.length;
			retain(chunk.length);
		});
		stream.on("error", () => abort("stream_error"));
		stream.on("end", () => {
			stopWatchdog();
			connection.socket.off("close", onClose);
			if (aborted) return;
			if (refusal) {
				release();
				return callback(fail(refusal));
			}
			if (oversized || stream.sizeExceeded) {
				drop();
				release();
				return callback(fail(MESSAGE_TOO_LARGE_REPLY));
			}
			const message = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, kept);
			const held = kept;
			chunks.length = 0;
			kept = 0;
			delivering = true;
			void deliver(connection, principal, { mailFrom, recipients, message }, callback).finally(() => {
				retain(-held);
				release();
			});
		});
	}

	/** Hand the message to the adapter and answer from its semantic result. */
	async function deliver(
		connection: Connection,
		principal: SubmissionPrincipal,
		input: { mailFrom: string; recipients: string[]; message: Buffer },
		callback: (error?: Error | null, message?: string) => void,
	) {
		let started = false;
		let reply: SmtpReply;
		let result: SubmissionResult | null = null;
		try {
			const bytes = new Uint8Array(input.message.buffer, input.message.byteOffset, input.message.byteLength);
			started = true;
			result = await submit(env, {
				principal,
				envelope: { mailFrom: input.mailFrom, rcptTo: input.recipients },
				message: bytes,
				publicOrigin: options.publicOrigin,
			});
			reply = replyForSubmission(result);
		} catch (error) {
			// The adapter never throws; if anything does after it was called, the outcome is unknown.
			// Only the error's class is logged: its text could quote anything, the message included.
			log({ event: "submission.error", connection: connection.id, error: error instanceof Error ? error.name : typeof error });
			reply = started ? DELIVERY_UNKNOWN_REPLY : TEMPORARY_FAILURE_REPLY;
		}
		if (result?.status === "accepted") {
			log({
				event: "submission.accepted",
				connection: connection.id,
				user: principal.userId,
				message: result.messageId,
				bytes: input.message.byteLength,
				recipients: result.recipientCount,
				degraded: result.degraded.length ? result.degraded.join(",") : undefined,
			});
		} else {
			const failure = result?.status === "failed" ? result.failure : null;
			log({
				event: "submission.rejected",
				connection: connection.id,
				user: principal.userId,
				stage: "data",
				code: reply.code,
				kind: failure?.kind,
				reason: failure?.reason,
				delivery: failure?.delivery,
				bytes: input.message.byteLength,
			});
		}
		if (reply.code >= 200 && reply.code < 300) callback(null, reply.message);
		else callback(fail(reply));
	}

	tlsServer.on("connection", (socket: Socket) => {
		const addressKey = clientAddressKey(socket.remoteAddress);
		// Counted from the TCP connection, so sockets still in their TLS handshake count too.
		const refused = closing ? "shutdown" : connections.size >= limits.maxConnections ? "global_limit" : !perAddress.tryAcquire(addressKey) ? "address_limit" : null;
		if (refused) {
			log({ event: "connection.refused", ip: socket.remoteAddress, reason: refused });
			socket.destroy();
			return;
		}
		const connection: Connection = {
			id: `s${nextId++}`,
			ip: socket.remoteAddress,
			addressKey,
			opened: now(),
			principal: null,
			authFailures: 0,
			messages: 0,
			releases: [() => perAddress.release(addressKey)],
			timers: new Set(),
			socket,
			closed: false,
		};
		const key = socketKey(socket);
		byKey.set(key, connection);
		connections.add(connection);
		// Node's handshakeTimeout only runs once a ClientHello arrives; a peer that never starts TLS is cut here.
		timer(connection, limits.handshakeTimeoutMs, () => {
			log({ event: "tls.handshake-timeout", connection: connection.id, ip: connection.ip });
			socket.destroy();
		});
		socket.once("close", () => finish(connection, key));
	});

	/** Release everything a connection held; runs once, on whichever of its sockets closes first. */
	function finish(connection: Connection, key: string) {
		if (connection.closed) return;
		connection.closed = true;
		for (const handle of connection.timers) clearTimeout(handle);
		connection.timers.clear();
		for (const run of connection.releases.splice(0)) run();
		byKey.delete(key);
		connections.delete(connection);
		log({ event: "connection.closed", connection: connection.id, ip: connection.ip });
		if (!connections.size) onDrained?.();
	}

	tlsServer.on("tlsClientError", (error, socket) => {
		log({ event: "tls.error", ip: socket.remoteAddress, error: error.message });
	});

	tlsServer.on("secureConnection", (socket: TLSSocket) => {
		const key = socketKey(socket);
		const connection = byKey.get(key);
		if (!connection || connection.closed || closing) {
			socket.destroy();
			return;
		}
		for (const handle of connection.timers) clearTimeout(handle);
		connection.timers.clear();
		connection.socket = socket;
		bySocket.set(socket, connection);
		socket.once("close", () => finish(connection, key));
		// The login deadline is absolute from the moment the connection opened.
		timer(connection, Math.max(0, limits.loginTimeoutMs - (now() - connection.opened)), () => {
			if (connection.principal) return;
			log({ event: "auth.timeout", connection: connection.id, ip: connection.ip });
			socket.destroy();
		});
		log({ event: "connection.open", connection: connection.id, ip: connection.ip, protocol: socket.getProtocol() ?? undefined });
		// Public in smtp-server 3.19 (how a 'secured' server receives sockets); not in @types/smtp-server.
		(server as unknown as { connect(socket: TLSSocket, options: { id: string }): void }).connect(socket, { id: connection.id });
	});

	// smtp-server reports dropped sockets and protocol errors as server errors; nothing secret is in them.
	server.on("error", (error: Error & { code?: string }) => {
		log({ event: error.code === "SocketError" || error.code === "ECONNRESET" ? "socket.error" : "listener.error", error: safeErrorText(error) });
	});

	await new Promise<void>((resolve, reject) => {
		tlsServer.once("error", reject);
		tlsServer.listen(config.port, config.host, () => {
			tlsServer.off("error", reject);
			resolve();
		});
	});
	tlsServer.on("error", (error) => log({ event: "listener.error", error: error.message }));
	const port = (tlsServer.address() as AddressInfo).port;
	log({ event: "listening", host: config.host, port, tls: TLS_MIN_VERSION, certificate: config.tlsSource, maxSize: limits.maxMessageBytes });

	return {
		port,
		get connections() {
			return connections.size;
		},
		get retainedBytes() {
			return retained;
		},
		get peakRetainedBytes() {
			return peakRetained;
		},
		reloadCertificates() {
			try {
				const material = loadSubmissionTlsMaterial({ ...config });
				tlsServer.setSecureContext({ key: material.key, cert: material.cert, minVersion: TLS_MIN_VERSION });
				log({ event: "tls.reloaded" });
				return true;
			} catch (error) {
				log({ event: "tls.reload-failed", error: (error as Error).message });
				return false;
			}
		},
		async close() {
			if (closing) return;
			closing = true;
			const stopped = new Promise<void>((resolve) => tlsServer.close(() => resolve()));
			// Transactions in progress get the grace period to finish; then every session gets 421 and is cut.
			const deadline = setTimeout(() => {
				for (const session of [...server.connections]) {
					session.send(421, "Server shutting down");
					session.close();
				}
				const cut = setTimeout(() => {
					for (const connection of connections) connection.socket.destroy();
				}, 500);
				cut.unref?.();
			}, limits.shutdownGraceMs);
			deadline.unref?.();
			await stopped;
			if (connections.size) await new Promise<void>((resolve) => (onDrained = resolve));
			clearTimeout(deadline);
		},
	};
}
