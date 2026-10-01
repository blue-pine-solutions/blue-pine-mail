import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";
import { createSecureContext, createServer, type TLSSocket } from "node:tls";
import { DISTRIBUTION } from "@/lib/distribution/identity";
import { DEFAULT_APPEND_TIMING } from "@/lib/imap-server/append";
import { DEFAULT_IDLE_TIMING, ImapSession } from "@/lib/imap-server/session";
import type { ImapLogEvent, ImapSessionHost } from "@/lib/imap-server/types";
import { clientAddressKey, ConcurrencyCounter, ContentReadLimiter, SlidingWindowCounter } from "./imap-limits";

/**
 * The read-only IMAP listener (A4): implicit TLS only (port 993 by convention), no
 * STARTTLS and no plaintext port. Node/Docker only; Workers cannot accept TCP. The
 * protocol itself lives in src/lib/imap-server/; this file owns sockets, TLS, timers,
 * per-instance abuse limits and shutdown.
 *
 * Enabled by IMAP_PORT (> 0) together with IMAP_TLS_CERT and IMAP_TLS_KEY (PEM file
 * paths). Broken TLS material fails startup; SIGHUP reloads it without dropping sessions.
 */

export type ImapListenerConfig = { port: number; host: string; certPath: string; keyPath: string };
export type TlsMaterial = { key: Buffer; cert: Buffer };

export type ImapLimits = {
	maxConnections: number;
	maxConnectionsPerAddress: number;
	maxSessionsPerUser: number;
	authFailuresPerAddress: number;
	authFailuresPerUsername: number;
	authFailureWindowMs: number;
	/** Added before each attempt for a username past its failure limit (a delay, never a lockout). */
	usernameThrottleDelayMs: number;
	handshakeTimeoutMs: number;
	/** A connection not authenticated this long after its greeting is logged out, whatever it sends (A5.6). */
	loginTimeoutMs: number;
	/**
	 * Autologout: the session ends after this long without a complete command or continuation
	 * line from the client (before and after authentication). Raw octets, partial lines and
	 * literals do not count, nor do the server's own writes (IDLE notifications, keepalives,
	 * continuations); A5.6.
	 */
	unauthenticatedIdleMs: number;
	authenticatedIdleMs: number;
	accessCheckIntervalMs: number;
	/** Message-content permits (FETCH of content, content SEARCH), held until the response is written: in all, and per user (A5.6). */
	maxConcurrentReads: number;
	maxConcurrentReadsPerUser: number;
	/**
	 * APPEND uploads (A5.7), in all and per user: a permit is taken before the continuation and
	 * held through receipt, parsing, storage and commit. Separate from the content-read permits.
	 */
	maxConcurrentAppends: number;
	maxConcurrentAppendsPerUser: number;
	/** An accepted APPEND literal must arrive within this base plus its size at this minimum average rate (absolute). */
	appendLiteralBaseMs: number;
	appendLiteralMinBytesPerSecond: number;
	shutdownGraceMs: number;
	/** IDLE (A5.4): change-signal poll, its ±jitter, unconditional reconciliation, keepalive, fail-closed cutoffs. */
	idlePollMs: number;
	idlePollJitter: number;
	idleReconcileMs: number;
	idleKeepaliveMs: number;
	idleAuthUncertainMs: number;
	idleUnavailableMs: number;
};

export const DEFAULT_IMAP_LIMITS: ImapLimits = {
	maxConnections: 500,
	maxConnectionsPerAddress: 20,
	maxSessionsPerUser: 20,
	authFailuresPerAddress: 10,
	authFailuresPerUsername: 20,
	authFailureWindowMs: 15 * 60_000,
	usernameThrottleDelayMs: 5_000,
	handshakeTimeoutMs: 10_000,
	loginTimeoutMs: 60_000,
	unauthenticatedIdleMs: 60_000,
	// RFC 3501 §5.4: an autologout timer must be at least 30 minutes.
	authenticatedIdleMs: 30 * 60_000,
	accessCheckIntervalMs: 60_000,
	maxConcurrentReads: 8,
	maxConcurrentReadsPerUser: 2,
	maxConcurrentAppends: 4,
	maxConcurrentAppendsPerUser: 1,
	appendLiteralBaseMs: DEFAULT_APPEND_TIMING.literalBaseMs,
	appendLiteralMinBytesPerSecond: DEFAULT_APPEND_TIMING.literalMinBytesPerSecond,
	shutdownGraceMs: 2_000,
	idlePollMs: DEFAULT_IDLE_TIMING.pollMs,
	idlePollJitter: DEFAULT_IDLE_TIMING.pollJitter,
	idleReconcileMs: DEFAULT_IDLE_TIMING.reconcileMs,
	idleKeepaliveMs: DEFAULT_IDLE_TIMING.keepaliveMs,
	idleAuthUncertainMs: DEFAULT_IDLE_TIMING.authUncertainMs,
	idleUnavailableMs: DEFAULT_IDLE_TIMING.unavailableMs,
};

const TLS_MIN_VERSION = "TLSv1.2";

/** The listener's configuration from the environment; null when IMAP is disabled. Throws on an invalid configuration. */
export function readImapConfig(env: Record<string, string | undefined> = process.env): ImapListenerConfig | null {
	const rawPort = env.IMAP_PORT?.trim() ?? "";
	if (rawPort === "" || rawPort === "0") return null;
	const port = Number(rawPort);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`IMAP_PORT must be a TCP port number (got "${rawPort}")`);
	const certPath = env.IMAP_TLS_CERT?.trim();
	const keyPath = env.IMAP_TLS_KEY?.trim();
	if (!certPath || !keyPath) throw new Error("IMAP_PORT is set but IMAP_TLS_CERT and IMAP_TLS_KEY are not: the IMAP listener only serves implicit TLS");
	return { port, host: env.IMAP_HOST?.trim() || "0.0.0.0", certPath, keyPath };
}

/** Read and validate the PEM certificate chain and key. Throws a message naming what is wrong. */
export function loadTlsMaterial(config: Pick<ImapListenerConfig, "certPath" | "keyPath">): TlsMaterial {
	let cert: Buffer;
	let key: Buffer;
	try {
		cert = readFileSync(config.certPath);
	} catch (error) {
		throw new Error(`IMAP_TLS_CERT (${config.certPath}) cannot be read: ${(error as Error).message}`);
	}
	try {
		key = readFileSync(config.keyPath);
	} catch (error) {
		throw new Error(`IMAP_TLS_KEY (${config.keyPath}) cannot be read: ${(error as Error).message}`);
	}
	try {
		new X509Certificate(cert);
	} catch (error) {
		throw new Error(`IMAP_TLS_CERT (${config.certPath}) is not a PEM certificate: ${(error as Error).message}`);
	}
	try {
		createSecureContext({ key, cert, minVersion: TLS_MIN_VERSION });
	} catch (error) {
		throw new Error(`IMAP TLS key and certificate are unusable together: ${(error as Error).message}`);
	}
	return { key, cert };
}

export type ImapListener = {
	readonly port: number;
	readonly connections: number;
	/** Re-read the certificate files; keeps the current ones if the new ones are invalid. */
	reloadCertificates(): boolean;
	close(): Promise<void>;
};

type Logger = (event: ImapLogEvent) => void;

function defaultLogger(event: ImapLogEvent): void {
	const fields = Object.entries(event)
		.filter(([name, value]) => name !== "event" && value !== undefined && value !== null)
		.map(([name, value]) => `${name}=${typeof value === "string" && /\s/.test(value) ? JSON.stringify(value) : value}`)
		.join(" ");
	console.log(`imap ${event.event}${fields ? ` ${fields}` : ""}`);
}

export async function startImapListener(
	env: CloudflareEnv,
	config: ImapListenerConfig,
	tls: TlsMaterial,
	options: { limits?: Partial<ImapLimits>; log?: Logger } = {},
): Promise<ImapListener> {
	const limits = { ...DEFAULT_IMAP_LIMITS, ...options.limits };
	const log = options.log ?? defaultLogger;
	const perAddress = new ConcurrencyCounter(limits.maxConnectionsPerAddress);
	const perUser = new ConcurrencyCounter(limits.maxSessionsPerUser);
	const addressFailures = new SlidingWindowCounter(limits.authFailuresPerAddress, limits.authFailureWindowMs);
	const usernameFailures = new SlidingWindowCounter(limits.authFailuresPerUsername, limits.authFailureWindowMs);
	const reads = new ContentReadLimiter(limits.maxConcurrentReads, limits.maxConcurrentReadsPerUser);
	const appends = new ContentReadLimiter(limits.maxConcurrentAppends, limits.maxConcurrentAppendsPerUser);
	const sessions = new Map<TLSSocket, ImapSession>();
	const sockets = new Set<Socket>();
	const handshakes = new Map<string, ReturnType<typeof setTimeout>>();
	let open = 0;
	let nextId = 1;
	let closing = false;
	let onDrained: (() => void) | null = null;

	const server = createServer({ key: tls.key, cert: tls.cert, minVersion: TLS_MIN_VERSION, handshakeTimeout: limits.handshakeTimeoutMs });

	server.on("connection", (socket: Socket) => {
		const address = clientAddressKey(socket.remoteAddress);
		if (closing || open >= limits.maxConnections || !perAddress.tryAcquire(address)) {
			log({ event: "connection.refused", ip: socket.remoteAddress, reason: closing ? "shutdown" : open >= limits.maxConnections ? "global_limit" : "address_limit" });
			socket.destroy();
			return;
		}
		open += 1;
		sockets.add(socket);
		// Node's handshakeTimeout only runs once a ClientHello arrives; a peer that never
		// starts TLS is cut here instead.
		const pending = `${socket.remoteAddress}\u0000${socket.remotePort}`;
		const handshake = setTimeout(() => {
			log({ event: "tls.handshake-timeout", ip: socket.remoteAddress });
			socket.destroy();
		}, limits.handshakeTimeoutMs);
		handshakes.set(pending, handshake);
		socket.once("close", () => {
			clearTimeout(handshake);
			handshakes.delete(pending);
			open -= 1;
			sockets.delete(socket);
			if (!sockets.size) onDrained?.();
			perAddress.release(address);
		});
	});

	server.on("tlsClientError", (error, socket) => {
		log({ event: "tls.error", ip: socket.remoteAddress, error: error.message });
	});

	server.on("secureConnection", (socket: TLSSocket) => {
		const pending = `${socket.remoteAddress}\u0000${socket.remotePort}`;
		clearTimeout(handshakes.get(pending));
		handshakes.delete(pending);
		const id = `c${nextId++}`;
		const ip = socket.remoteAddress;
		const addressKey = clientAddressKey(ip);
		const timers = new Set<ReturnType<typeof setTimeout>>();
		const delays = new Set<() => void>();
		let claimedUser: string | null = null;
		let socketClosed = false;

		const host: ImapSessionHost = {
			write(bytes) {
				if (socket.destroyed || !socket.writable) return Promise.resolve();
				return new Promise((resolve) => {
					const flushed = socket.write(bytes);
					if (flushed) return resolve();
					const done = () => {
						socket.off("drain", done);
						socket.off("close", done);
						resolve();
					};
					socket.on("drain", done);
					socket.on("close", done);
				});
			},
			close() {
				socket.end();
				const timer = setTimeout(() => socket.destroy(), limits.shutdownGraceMs);
				timer.unref();
			},
			pause: () => socket.pause(),
			resume: () => socket.resume(),
			delay(ms, signal) {
				return new Promise((resolve) => {
					// Nothing to wait for once the connection is gone or the caller gave up.
					if (socketClosed || signal?.aborted) return resolve();
					const finish = () => {
						clearTimeout(timer);
						timers.delete(timer);
						delays.delete(finish);
						signal?.removeEventListener("abort", finish);
						resolve();
					};
					const timer = setTimeout(finish, ms);
					timers.add(timer);
					delays.add(finish);
					signal?.addEventListener("abort", finish, { once: true });
				});
			},
			now: () => Date.now(),
			log: (event) => log({ ...event, connection: id, ip }),
			beforeAuthenticate(username) {
				if (addressFailures.exceeded(addressKey)) return { allowed: false, delayMs: 0 };
				const throttled = usernameFailures.exceeded(username.trim().toLowerCase());
				return { allowed: true, delayMs: throttled ? limits.usernameThrottleDelayMs : 0 };
			},
			afterAuthenticate(username, ok) {
				if (ok) return;
				addressFailures.hit(addressKey);
				usernameFailures.hit(username.trim().toLowerCase());
			},
			claimUserSlot(userId) {
				if (claimedUser) return true;
				if (!perUser.tryAcquire(userId)) return false;
				claimedUser = userId;
				return true;
			},
			acquireRead: (userId) => reads.acquire(userId),
			acquireAppend: (userId) => appends.acquire(userId),
			onAuthenticated() {},
		};

		const session = new ImapSession(env, host, {
			serverName: DISTRIBUTION.name,
			idle: {
				pollMs: limits.idlePollMs,
				pollJitter: limits.idlePollJitter,
				reconcileMs: limits.idleReconcileMs,
				keepaliveMs: limits.idleKeepaliveMs,
				authUncertainMs: limits.idleAuthUncertainMs,
				unavailableMs: limits.idleUnavailableMs,
			},
			// The login deadline and autologout run in the session, on this host's delay and clock.
			timeouts: {
				loginMs: limits.loginTimeoutMs,
				unauthenticatedIdleMs: limits.unauthenticatedIdleMs,
				authenticatedIdleMs: limits.authenticatedIdleMs,
				appendLiteralBaseMs: limits.appendLiteralBaseMs,
				appendLiteralMinBytesPerSecond: limits.appendLiteralMinBytesPerSecond,
			},
		});
		sessions.set(socket, session);
		socket.setNoDelay(true);
		socket.on("data", (chunk: Buffer) => {
			session.receive(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		});
		socket.on("error", (error) => log({ event: "socket.error", connection: id, ip, error: error.message }));
		socket.on("close", () => {
			socketClosed = true;
			session.transportClosed();
			sessions.delete(socket);
			for (const finish of [...delays]) finish();
			for (const timer of timers) clearTimeout(timer);
			if (claimedUser) perUser.release(claimedUser);
			log({ event: "connection.closed", connection: id, ip });
		});
		log({ event: "connection.open", connection: id, ip, protocol: socket.getProtocol() ?? undefined });
		void session.start();
	});

	// Idle connections whose access was revoked are closed at the next check (A3 checks every command anyway).
	const accessCheck = setInterval(() => {
		for (const session of sessions.values()) if (session.isAuthenticated) void session.checkAccess();
	}, limits.accessCheckIntervalMs);
	accessCheck.unref();

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.on("error", (error) => log({ event: "listener.error", error: error.message }));
	const port = (server.address() as AddressInfo).port;
	log({ event: "listening", host: config.host, port, tls: TLS_MIN_VERSION });

	return {
		port,
		get connections() {
			return open;
		},
		reloadCertificates() {
			try {
				const material = loadTlsMaterial(config);
				server.setSecureContext({ key: material.key, cert: material.cert, minVersion: TLS_MIN_VERSION });
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
			clearInterval(accessCheck);
			const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
			await Promise.all([...sessions.values()].map((session) => session.end("Server shutting down")));
			// Sessions got BYE; anything still open after the grace period (including handshakes in progress) is cut.
			const deadline = setTimeout(() => {
				for (const socket of sockets) socket.destroy();
			}, limits.shutdownGraceMs);
			await stopped;
			// server.close() can report before every socket's own close handler ran; wait for those too.
			if (sockets.size) await new Promise<void>((resolve) => (onDrained = resolve));
			clearTimeout(deadline);
		},
	};
}
