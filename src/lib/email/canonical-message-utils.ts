import { MIMEMessage, Mailbox } from "mimetext/browser";
import { getEmailAddress } from "@/lib/email/address";
import type { CanonicalAttachment, CanonicalMessageInput, CanonicalMessageKind, CanonicalRow } from "./canonical-message-types";

/**
 * Canonical messages are generated with mimetext's runtime-neutral (browser)
 * build so Workers and Node produce the same structure. mimetext lays out the
 * MIME tree and headers; every part body is handed to it already base64
 * encoded and wrapped at 76 columns, which keeps the output 7-bit, CRLF-only
 * and within RFC 5322 line limits.
 */

const EOL = "\r\n";
/** Longest UTF-8 run per RFC 2047 encoded-word, so each word stays within 75 characters. */
const ENCODED_WORD_BYTES = 45;
const MAX_HEADER_LINE = 998;
/** Headers the builder writes itself; anything else in `headers` is carried over as-is. */
const MANAGED_HEADERS = new Set(["from", "to", "cc", "bcc", "subject", "date", "message-id", "mime-version", "in-reply-to", "references", "reply-to", "sender", "content-type", "content-transfer-encoding", "content-disposition", "content-id"]);
const CANONICAL_PREFIX = "canonical/";

const utf8 = new TextEncoder();

function bytesToBinary(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return binary;
}

/** Base64 wrapped at 76 characters with CRLF, as MIME bodies require. */
export function wrappedBase64(content: ArrayBuffer | Uint8Array | string): string {
	const bytes = typeof content === "string" ? utf8.encode(content) : content instanceof Uint8Array ? content : new Uint8Array(content);
	return btoa(bytesToBinary(bytes)).replace(/.{76}(?=.)/g, `$&${EOL}`);
}

/**
 * RFC 2047 "B" encoding split into whole-character words of at most 45 UTF-8
 * bytes, joined so mimetext's `=?utf-8?B?…?=` wrapper yields folded words.
 */
export function foldedEncodedWordBase64(text: string): string {
	const words: string[] = [];
	let current = "";
	let size = 0;
	for (const character of text) {
		const length = utf8.encode(character).byteLength;
		if (size + length > ENCODED_WORD_BYTES && current) {
			words.push(current);
			current = "";
			size = 0;
		}
		current += character;
		size += length;
	}
	if (current || words.length === 0) words.push(current);
	return words.map((word) => btoa(bytesToBinary(utf8.encode(word)))).join(`?=${EOL} =?utf-8?B?`);
}

const mimeEnvironment = {
	toBase64: foldedEncodedWordBase64,
	toBase64WebSafe: (text: string) => foldedEncodedWordBase64(text).replace(/\+/g, "-").replace(/\//g, "_"),
	eol: EOL,
	validateContentType: (type: string) => (type.length > 0 ? type : false),
};

const clean = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

/** `Name <addr>` or a bare address, split into what mimetext expects. */
export function toMailbox(entry: string): { name?: string; addr: string } {
	const addr = getEmailAddress(entry);
	const name = clean(entry.replace(/<[^>]*>\s*$/, "")).replace(/^(["'])(.*)\1$/, "$2").replace(/\\(["\\])/g, "$1");
	return name && name.toLowerCase() !== addr.toLowerCase() ? { name, addr } : { addr };
}

/** A Message-ID with angle brackets, whatever form it was stored in. */
export function angleMessageId(id: string): string {
	const bare = clean(id).replace(/^<|>$/g, "");
	return `<${bare}>`;
}

/** The stable Message-ID for a message that no transport ever assigned one to (drafts, failed sends). */
export function localMessageId(rowId: string, fromAddr: string): string {
	const domain = getEmailAddress(fromAddr).split("@")[1] || "localhost";
	return `<${rowId}@${domain}>`;
}

/** Fold a header value at spaces so no line exceeds RFC 5322's limit; null when that is impossible. */
export function foldHeaderValue(value: string): string | null {
	const tokens = clean(value).split(/\s+/);
	const lines: string[] = [];
	let line = "";
	for (const token of tokens) {
		if (token.length > MAX_HEADER_LINE - 2) return null;
		if (line && line.length + 1 + token.length > 76) {
			lines.push(line);
			line = token;
		} else {
			line = line ? `${line} ${token}` : token;
		}
	}
	lines.push(line);
	return lines.join(`${EOL} `);
}

function safeContentType(type: string): string {
	const trimmed = clean(type).split(";")[0].trim().toLowerCase();
	return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(trimmed) ? trimmed : "application/octet-stream";
}

/** Plain ASCII names stay readable; anything else becomes an RFC 2047 encoded-word. */
function safeFilename(filename: string): string {
	const name = clean(filename) || "attachment";
	return /^[\x20-\x7e]+$/.test(name) && !/["\\]/.test(name) ? name : `=?utf-8?B?${btoa(bytesToBinary(utf8.encode(name)))}?=`;
}

/** Build the canonical RFC 5322 representation. The output is stored once and then only ever read. */
export function buildCanonicalMime(input: CanonicalMessageInput): string {
	const message = new MIMEMessage(mimeEnvironment);
	message.setSender(toMailbox(input.from));
	const recipients = (list: string[]) => list.map(toMailbox);
	if (input.to.length) message.setTo(recipients(input.to));
	if (input.cc.length) message.setCc(recipients(input.cc));
	// The sender's own copy keeps Bcc, as Sent items conventionally do; it was never part of what recipients received.
	if (input.bcc.length) message.setBcc(recipients(input.bcc));
	// mimetext only takes Reply-To as a mailbox; as a plain header it would refuse the message.
	if (input.replyTo) message.setHeader("Reply-To", new Mailbox(toMailbox(input.replyTo)));
	message.setSubject(input.subject);
	message.setHeader("Date", input.date.toUTCString().replace(/GMT|UTC/i, "+0000"));
	message.setHeader("Message-ID", angleMessageId(input.messageId));
	if (input.inReplyTo) message.setHeader("In-Reply-To", angleMessageId(input.inReplyTo));
	const references = (input.references ?? []).filter(Boolean).map(angleMessageId);
	if (references.length) {
		const folded = foldHeaderValue(references.join(" "));
		if (folded) message.setHeader("References", folded);
	}
	for (const [name, value] of Object.entries(input.headers ?? {})) {
		const headerName = clean(name);
		if (!/^[!-9;-~]+$/.test(headerName) || MANAGED_HEADERS.has(headerName.toLowerCase())) continue;
		const folded = foldHeaderValue(value);
		if (folded) message.setHeader(headerName, folded);
	}

	const text = input.text ?? null;
	const html = input.html ?? null;
	if (text !== null || html === null) message.addMessage({ contentType: "text/plain", encoding: "base64", data: wrappedBase64(text ?? "") });
	if (html !== null) message.addMessage({ contentType: "text/html", encoding: "base64", data: wrappedBase64(html) });
	for (const attachment of input.attachments) addAttachment(message, attachment);
	return message.asRaw();
}

function addAttachment(message: MIMEMessage, attachment: CanonicalAttachment): void {
	const inline = attachment.disposition === "inline" && !!attachment.contentId;
	const headers: Record<string, string> = {};
	if (attachment.contentId) headers["Content-ID"] = angleMessageId(attachment.contentId);
	message.addAttachment({
		inline,
		filename: safeFilename(attachment.filename),
		contentType: safeContentType(attachment.type),
		data: wrappedBase64(attachment.content),
		headers,
	});
}

/** drafts change, queued/failed sends are not final, and everything else is immutable. */
export function classifyMessage(row: Pick<CanonicalRow, "status">): CanonicalMessageKind {
	if (row.status === "draft") return "draft";
	if (row.status === "queued" || row.status === "failed") return "transient";
	return "immutable";
}

export function isCanonicalKey(key: string | null | undefined): boolean {
	return !!key && key.startsWith(CANONICAL_PREFIX);
}

/** `canonical/<messageId>/[<fingerprint>-]<nonce>.eml`: a fresh key per generation, so racing writers never overwrite each other. */
export function canonicalKey(messageId: string, fingerprint?: string): string {
	const nonce = crypto.randomUUID();
	return `${CANONICAL_PREFIX}${messageId}/${fingerprint ? `${fingerprint}-` : ""}${nonce}.eml`;
}

/** The draft fingerprint a canonical key was generated for, if any. */
export function fingerprintFromKey(key: string): string | null {
	const match = /^canonical\/[^/]+\/([0-9a-f]{32})-[0-9a-f-]{36}\.eml$/.exec(key);
	return match ? match[1] : null;
}

/** A digest of everything that appears in a draft's representation, so an edit made anywhere is noticed. */
export async function draftFingerprint(row: CanonicalRow, attachments: Array<{ id: string; filename: string; contentType: string; size: number; disposition: string; contentId: string | null }>): Promise<string> {
	const material = JSON.stringify([
		row.fromAddr, row.toAddr, row.ccAddr, row.bccAddr, row.subject, row.textBody, row.htmlBody, row.inReplyTo, row.references,
		attachments.map((attachment) => [attachment.id, attachment.filename, attachment.contentType, attachment.size, attachment.disposition, attachment.contentId]).sort(),
	]);
	const digest = await crypto.subtle.digest("SHA-256", utf8.encode(material));
	return [...new Uint8Array(digest).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
