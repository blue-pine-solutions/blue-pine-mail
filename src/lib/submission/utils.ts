import { addressParser } from "postal-mime";
import type { Address, Email, Header } from "postal-mime";
import { formatEmailAddress } from "@/lib/email/address";
import { SendError } from "@/lib/email/send-result-utils";
import type { HeaderMailbox, ReconciledRecipients, SubmissionPrincipal } from "./types";

/**
 * The largest message the adapter parses: 25 MB of attachments (the outgoing limit)
 * after base64, plus bodies and headers. The parser holds the whole message and its
 * decoded parts in memory at once (several times this size), so the listener must stop
 * reading DATA here and limit concurrent submissions.
 */
export const MAX_SUBMISSION_MESSAGE_BYTES = 36 * 1024 * 1024;

/** Parser bounds: no real client nests this deep or sends this much header. */
export const SUBMISSION_PARSER_LIMITS = { maxNestingDepth: 32, maxHeadersSize: 256 * 1024 } as const;

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * A plain `local@domain` address, lowercased, or null. Dot-atom local parts and DNS host
 * names only: no quoted local parts, address literals, source routes, single-label
 * domains or non-ASCII (SMTPUTF8 is not offered). Used for envelope and header addresses.
 */
export function normalizeMailboxAddress(value: string): string | null {
	const address = value.trim();
	if (address.length > 254) return null;
	const at = address.lastIndexOf("@");
	if (at <= 0 || at === address.length - 1) return null;
	const local = address.slice(0, at);
	const domain = address.slice(at + 1);
	if (local.length > 64 || !LOCAL_PART.test(local)) return null;
	const labels = domain.split(".");
	if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return null;
	return address.toLowerCase();
}

/** Header text with line breaks and other control characters turned into spaces. */
export function cleanHeaderText(value: string | null | undefined): string {
	return (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Keys the submission listener limits by: per account (all mailboxes) and per credential. */
export function submissionLimiterKeys(principal: SubmissionPrincipal): { user: string; credential: string } {
	return { user: `smtp-submission:user:${principal.userId}`, credential: `smtp-submission:credential:${principal.appPasswordId}` };
}

const invalid = (reason: string, message: string) => new SendError("invalid_message", reason, message);

/** The top-level header fields named `key` (lowercase), in order. */
export function headerValues(headers: Header[], key: string): string[] {
	return headers.filter((header) => header.key === key).map((header) => header.value);
}

/**
 * The single mailbox of a From or Sender header, or a classified error: exactly one
 * header field, exactly one mailbox, no group, a valid address.
 */
export function parseSingleMailbox(values: string[], field: string): HeaderMailbox {
	if (values.length !== 1) throw invalid(`${field}_invalid`, `The message must have exactly one ${field} header`);
	const parsed = addressParser(values[0]);
	const [only] = parsed;
	if (parsed.length !== 1 || !only || only.group !== undefined) throw invalid(`${field}_invalid`, `The ${field} header must name exactly one address`);
	const address = normalizeMailboxAddress(only.address ?? "");
	if (!address) throw invalid(`${field}_invalid`, `The ${field} header address is not valid`);
	return { address, name: cleanHeaderText(only.name) || null };
}

/** Every mailbox of a To or Cc header list (group members included), validated. */
export function headerMailboxes(addresses: Address[] | undefined): HeaderMailbox[] {
	const result: HeaderMailbox[] = [];
	for (const entry of addresses ?? []) {
		const members = entry.group !== undefined ? entry.group : [entry];
		for (const member of members) {
			const address = normalizeMailboxAddress(member.address ?? "");
			if (!address) throw invalid("header_recipient_invalid", "A To or Cc address is not valid");
			result.push({ address, name: cleanHeaderText(member.name) || null });
		}
	}
	return result;
}

/**
 * Who receives the message, and how each recipient is presented. The envelope is
 * authoritative: it is exactly who receives the message.
 *
 * - To and Cc keep the client's header entries, deduplicated by address (an address in
 *   both stays in To only); every one of them must be an envelope recipient, because the
 *   transports deliver to every address they are given.
 * - Bcc is every envelope recipient named in neither To nor Cc. It is passed to the
 *   transport as Bcc, so it is delivered without appearing in any delivered header. A
 *   client `Bcc:` header is never used: the envelope already says who is blind-copied.
 * - The structured send needs a To recipient, so a message without one (Bcc only) is
 *   refused as unsupported.
 */
export function reconcileRecipients(input: { to: HeaderMailbox[]; cc: HeaderMailbox[]; envelope: string[] }): ReconciledRecipients {
	const envelope = new Set(input.envelope);
	const seen = new Set<string>();
	const present = (list: HeaderMailbox[]) => {
		const result: string[] = [];
		for (const mailbox of list) {
			if (!envelope.has(mailbox.address)) {
				throw invalid("header_recipient_not_in_envelope", "A To or Cc address is not an envelope recipient");
			}
			if (seen.has(mailbox.address)) continue;
			seen.add(mailbox.address);
			result.push(formatEmailAddress(mailbox.address, mailbox.name));
		}
		return result;
	};
	const to = present(input.to);
	const cc = present(input.cc);
	if (to.length === 0) {
		throw new SendError("unsupported_message", "no_visible_recipient", "A message without a To recipient is not supported");
	}
	return { to, cc, bcc: input.envelope.filter((address) => !seen.has(address)) };
}

const SECURE_TOP_LEVEL = /^(multipart\/(signed|encrypted)|application\/(x-)?pkcs7-(mime|signature)|application\/pgp-(encrypted|signature))$/;
const SECURE_PART = /^application\/((x-)?pkcs7-(mime|signature)|pgp-(encrypted|signature))$/;

/** The media type of a Content-Type value, lowercased, without parameters. */
export function mediaType(value: string | undefined): string {
	return (value ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Whether the message is signed or encrypted at the MIME level (S/MIME or PGP/MIME),
 * anywhere in its structure. Regenerating such a message from its parts would break the
 * signature or deliver the ciphertext as an attachment, so it is refused instead.
 */
export function isSignedOrEncrypted(email: Pick<Email, "headers" | "attachments">): boolean {
	const [contentType] = headerValues(email.headers, "content-type");
	if (SECURE_TOP_LEVEL.test(mediaType(contentType))) return true;
	return email.attachments.some((attachment) => SECURE_PART.test(mediaType(attachment.mimeType)));
}

/** A Message-ID (bare, without angle brackets) safe to carry in a header, or null. */
export function safeMessageId(value: string | null | undefined): string | null {
	const bare = (value ?? "").trim().replace(/^<|>$/g, "");
	return bare.length > 0 && bare.length <= 250 && /^[!-~]+$/.test(bare) && !/[<>]/.test(bare) ? bare : null;
}

/** A content id for an inline part, bare like the web composer's, or null. */
export function safeContentId(value: string | null | undefined): string | null {
	return safeMessageId(value);
}

/** The first line must be a header field: anything else is not an RFC 5322 message. */
export function startsWithHeaderField(bytes: Uint8Array): boolean {
	const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.byteLength, 1000)));
	return /^[!-9;-~]+:/.test(head);
}

/** SMTP without BINARYMIME never carries a NUL octet. */
export function containsNul(bytes: Uint8Array): boolean {
	return bytes.includes(0);
}
