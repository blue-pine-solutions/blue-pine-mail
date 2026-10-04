import { readFileSync } from "node:fs";
import type { Socket } from "node:net";
import { SMTPServer } from "smtp-server";
import type { SMTPServerSession } from "smtp-server";
import { DISTRIBUTION } from "@/lib/distribution/identity";
import { intakeIncomingMail } from "@/lib/email/intake";
import { inboundAttachmentLimitReasonFromRaw } from "@/lib/email/inbound-attachments";
import type { Mailer } from "./mailer";

/**
 * Simultaneous inbound connections. Each in-flight message can hold up to SMTP_MAX_SIZE
 * (36 MiB by default), so this bounds worst-case DATA memory (about 0.9 GiB) in a process that
 * also serves the app, IMAP and submission, while leaving ample room for a self-hosted domain.
 */
export const INBOUND_SMTP_MAX_CLIENTS = 25;

/** Bytes read past the size limit (to answer 552 in protocol) before the connection is dropped. */
export const INBOUND_DISCARD_ALLOWANCE_BYTES = 1024 * 1024;

/**
 * Collects DATA chunks up to `limit` bytes. The first chunk that would take the message past the
 * limit discards everything held and nothing is kept afterwards, so retained memory never exceeds
 * `limit` however much more the peer sends. A message of exactly `limit` bytes is kept whole.
 */
export class BoundedDataBuffer {
	private chunks: Buffer[] = [];
	private kept = 0;
	private seen = 0;
	private over = false;

	constructor(private readonly limit: number) {}

	push(chunk: Buffer) {
		this.seen += chunk.length;
		if (this.over) return;
		if (this.kept + chunk.length > this.limit) {
			this.over = true;
			this.chunks = [];
			this.kept = 0;
			return;
		}
		this.chunks.push(chunk);
		this.kept += chunk.length;
	}

	get oversized() {
		return this.over;
	}

	/** Bytes the peer has sent so far, kept or not. */
	get received() {
		return this.seen;
	}

	/** Bytes currently retained. */
	get retained() {
		return this.kept;
	}

	/** The message, or null when it was oversized. */
	take(): Buffer | null {
		if (this.over) return null;
		const message = Buffer.concat(this.chunks, this.kept);
		this.chunks = [];
		this.kept = 0;
		return message;
	}
}

/**
 * Receive mail directly on port 25 (or wherever SMTP_INBOUND_PORT points).
 * One inbound connection per message; each envelope recipient is handed to
 * the same intake the Cloudflare handler uses. Rejected mail gets a 550
 * during DATA, so the sender sees the routing rule's reason.
 */
export function startSmtpListener(
	env: CloudflareEnv,
	mailer: Mailer,
	options: { port: number; host?: string; maxSize: number; hostname?: string; tls: { keyPath: string; certPath: string } | null },
) {
	// STARTTLS is only offered with a real certificate; smtp-server's built-in
	// one has a public private key, and advertising it would mislead senders.
	// smtp-server does not expose the socket on the session; track them to drop a peer that floods DATA.
	const sockets = new Map<string, Socket>();
	const socketKey = (address: string | undefined, port: number | undefined) => `${(address ?? "").replace(/^::ffff:/, "")}|${port}`;
	const server = new SMTPServer({
		name: options.hostname,
		authOptional: true,
		disabledCommands: options.tls ? ["AUTH"] : ["AUTH", "STARTTLS"],
		...(options.tls ? { key: readFileSync(options.tls.keyPath), cert: readFileSync(options.tls.certPath) } : {}),
		size: options.maxSize,
		maxClients: INBOUND_SMTP_MAX_CLIENTS,
		banner: DISTRIBUTION.name,
		onData(stream, session: SMTPServerSession, callback) {
			// smtp-server keeps emitting data after sizeExceeded, so the bound is enforced here: nothing is
			// retained once the limit is crossed, and a peer that sends far past it is disconnected.
			const data = new BoundedDataBuffer(options.maxSize);
			let aborted = false;
			stream.on("data", (chunk: Buffer) => {
				if (aborted) return;
				data.push(chunk);
				if (data.received - options.maxSize > INBOUND_DISCARD_ALLOWANCE_BYTES) {
					aborted = true;
					sockets.get(socketKey(session.remoteAddress, session.remotePort))?.destroy();
				}
			});
			stream.on("end", async () => {
				if (aborted) return;
				const raw = stream.sizeExceeded ? null : data.take();
				if (!raw) {
					callback(Object.assign(new Error("Message exceeds size limit"), { responseCode: 552 }));
					return;
				}
				let attachmentLimitReason: string | null;
				try {
					attachmentLimitReason = await inboundAttachmentLimitReasonFromRaw(toArrayBuffer(raw));
				} catch (error) {
					console.error("SMTP attachment inspection failed", error);
					callback(Object.assign(new Error("Temporary failure, try again later"), { responseCode: 451 }));
					return;
				}
				if (attachmentLimitReason) {
					callback(Object.assign(new Error(attachmentLimitReason), { responseCode: 552 }));
					return;
				}
				const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
				const headers = parseHeaders(raw);
				let rejectReason: string | null = null;
				for (const recipient of session.envelope.rcptTo) {
					const result = await intakeIncomingMail(
						env,
						{ from, to: recipient.address, raw: toArrayBuffer(raw), headers },
						{
							reject: (reason) => {
								rejectReason = reason;
							},
							// Carry the headers intake asks for (the X-Mailflare-Forwarded loop guard), as the Worker and relay forwarders do.
							forward: async (destination, extra) => mailer.sendRaw(from, destination, withAddedHeaders(raw, extra)),
						},
					).catch((error) => {
						console.error(`SMTP intake failed for ${recipient.address}`, error);
						return null;
					});
					if (!result) {
						callback(Object.assign(new Error("Temporary failure, try again later"), { responseCode: 451 }));
						return;
					}
				}
				if (rejectReason) {
					callback(Object.assign(new Error(rejectReason), { responseCode: 550 }));
					return;
				}
				callback();
			});
		},
	});
	server.server.on("connection", (socket: Socket) => {
		const key = socketKey(socket.remoteAddress, socket.remotePort);
		sockets.set(key, socket);
		socket.once("close", () => {
			if (sockets.get(key) === socket) sockets.delete(key);
		});
	});
	server.on("error", (error) => console.error("SMTP listener error", error));
	server.listen(options.port, options.host ?? "0.0.0.0", () => {
		console.log(`SMTP inbound listening on ${options.host ?? "0.0.0.0"}:${options.port}`);
	});
	return server;
}

/** Header map in the shape the Worker handler provides: lower-cased names, folded lines joined. */
export function parseHeaders(raw: Buffer): Record<string, string> {
	const text = new TextDecoder("latin1").decode(raw.subarray(0, Math.min(raw.length, 256 * 1024)));
	const end = text.search(/\r?\n\r?\n/);
	const block = (end >= 0 ? text.slice(0, end) : text).replace(/\r?\n[ \t]+/g, " ");
	const headers: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const index = line.indexOf(":");
		if (index <= 0) continue;
		const name = line.slice(0, index).trim().toLowerCase();
		if (!(name in headers)) headers[name] = line.slice(index + 1).trim();
	}
	return headers;
}

/**
 * The raw message with `headers` added at the top of the header block. An existing
 * field of the same name (with any folded lines) is dropped first so each added
 * header appears once; every other byte, the body included, is kept as it was.
 */
export function withAddedHeaders(raw: Buffer, headers: Record<string, string>): Buffer {
	const entries = Object.entries(headers);
	if (entries.length === 0) return raw;
	for (const [name, value] of entries) {
		if (!/^[!-9;-~]+$/.test(name) || /[\r\n]/.test(value)) throw new Error(`Invalid header: ${name}`);
	}
	// latin1 maps every byte to one character, so decoding and re-encoding is lossless.
	// (The project's Buffer typings omit the encoding argument; mailer.ts works around it the same way.)
	const text = (raw as unknown as { toString(encoding: string): string }).toString("latin1");
	const firstBreak = text.indexOf("\n");
	const newline = firstBreak > 0 && text[firstBreak - 1] === "\r" ? "\r\n" : firstBreak >= 0 ? "\n" : "\r\n";
	const separator = text.search(/\r?\n\r?\n/);
	let block = separator >= 0 ? text.slice(0, separator) : text;
	let rest = separator >= 0 ? text.slice(separator) : "";
	const trailingBreak = block.match(/\r?\n$/)?.[0] ?? "";
	block = block.slice(0, block.length - trailingBreak.length);
	rest = trailingBreak + rest;

	const names = new Set(entries.map(([name]) => name.toLowerCase()));
	const fields: string[] = [];
	for (const line of block.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
		if (/^[ \t]/.test(line) && fields.length > 0) fields[fields.length - 1] += line;
		else fields.push(line);
	}
	const kept = fields
		.filter((field) => !names.has(field.slice(0, Math.max(field.indexOf(":"), 0)).trim().toLowerCase()))
		.join("")
		.replace(/\r?\n$/, "");
	const added = entries.map(([name, value]) => `${name}: ${value}`).join(newline);
	return Buffer.from(added + (kept ? newline + kept : "") + rest, "latin1");
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
