import type { ImapMailbox } from "@/lib/imap/types";

/**
 * IMAP names for A3's folders.
 *
 * The namespace is flat and has no hierarchy delimiter (LIST answers `NIL`, RFC 3501
 * §6.3.8). Product folder names may contain any character, `/` and `.` included, so any
 * delimiter would turn some existing names into a hierarchy they do not have; with none,
 * a name is exposed exactly as A3 gives it.
 *
 * On the wire a name is A3's name in modified UTF-7 (RFC 3501 §5.1.3), which is a
 * bijection: printable ASCII other than `&` stands for itself, and everything else
 * (including control characters) is modified base64 of its UTF-16 code units. A3's names
 * are unique within a mailbox (case-insensitively, and never a system name), so wire
 * names are unique too, and a name is resolved by exact lookup in the current listing,
 * never by parsing it back. Only `INBOX` is case-insensitive.
 */

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";

function encodeRun(units: number[]): string {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const unit of units) {
		buffer = (buffer << 16) | unit;
		bits += 16;
		while (bits >= 6) {
			bits -= 6;
			out += BASE64[(buffer >> bits) & 0x3f];
		}
		buffer &= (1 << bits) - 1;
	}
	if (bits > 0) out += BASE64[(buffer << (6 - bits)) & 0x3f];
	return `&${out}-`;
}

export function encodeMailboxName(name: string): string {
	let out = "";
	let run: number[] = [];
	for (let index = 0; index < name.length; index += 1) {
		const code = name.charCodeAt(index);
		if (code >= 0x20 && code <= 0x7e) {
			if (run.length) {
				out += encodeRun(run);
				run = [];
			}
			out += code === 0x26 ? "&-" : name[index];
		} else run.push(code);
	}
	if (run.length) out += encodeRun(run);
	return out;
}

/** The Unicode name a modified UTF-7 name stands for, or null unless it is the canonical encoding of that name. */
export function decodeMailboxName(wire: string): string | null {
	let out = "";
	for (let index = 0; index < wire.length; index += 1) {
		const char = wire[index];
		const code = char.charCodeAt(0);
		if (code < 0x20 || code > 0x7e) return null;
		if (char !== "&") {
			out += char;
			continue;
		}
		const end = wire.indexOf("-", index + 1);
		if (end < 0) return null;
		const run = wire.slice(index + 1, end);
		index = end;
		if (!run) {
			out += "&";
			continue;
		}
		let buffer = 0;
		let bits = 0;
		for (const symbol of run) {
			const value = BASE64.indexOf(symbol);
			if (value < 0) return null;
			buffer = (buffer << 6) | value;
			bits += 6;
			if (bits >= 16) {
				bits -= 16;
				out += String.fromCharCode((buffer >> bits) & 0xffff);
				buffer &= (1 << bits) - 1;
			}
		}
	}
	return encodeMailboxName(out) === wire ? out : null;
}

export function isInboxName(wire: string): boolean {
	return wire.toUpperCase() === "INBOX";
}

/** The folder a client-supplied (wire) name refers to in the current listing. */
export function findMailbox(mailboxes: ImapMailbox[], wire: string): ImapMailbox | null {
	if (isInboxName(wire)) return mailboxes.find((mailbox) => mailbox.role === "inbox") ?? null;
	return mailboxes.find((mailbox) => mailbox.role !== "inbox" && encodeMailboxName(mailbox.name) === wire) ?? null;
}

/** The wire name to send for a folder. */
export function wireName(mailbox: ImapMailbox): string {
	return mailbox.role === "inbox" ? "INBOX" : encodeMailboxName(mailbox.name);
}

/** Longest LIST pattern accepted; longer ones match nothing rather than cost unbounded work. */
export const MAX_LIST_PATTERN = 1024;

/** Wildcard match in O(pattern × name) without backtracking blow-up. */
function globMatch(pattern: string, name: string, fold: boolean): boolean {
	const p = fold ? pattern.toUpperCase() : pattern;
	const n = fold ? name.toUpperCase() : name;
	let pi = 0;
	let ni = 0;
	let star = -1;
	let resume = 0;
	while (ni < n.length) {
		if (pi < p.length && (p[pi] === "*" || p[pi] === "%")) {
			star = pi++;
			resume = ni;
		} else if (pi < p.length && p[pi] === n[ni]) {
			pi += 1;
			ni += 1;
		} else if (star >= 0) {
			pi = star + 1;
			ni = ++resume;
		} else return false;
	}
	while (pi < p.length && (p[pi] === "*" || p[pi] === "%")) pi += 1;
	return pi === p.length;
}

/**
 * A LIST pattern (reference and mailbox concatenated, as a flat namespace does) as a
 * matcher over wire names. With no hierarchy, `%` and `*` both match any run of
 * characters. INBOX matches case-insensitively.
 */
export function listMatcher(pattern: string): (wire: string) => boolean {
	if (pattern.length > MAX_LIST_PATTERN) return () => false;
	return (wire) => globMatch(pattern, wire, isInboxName(wire));
}

export const SPECIAL_USE_ATTRIBUTE: Record<string, string> = {
	Drafts: "\\Drafts",
	Sent: "\\Sent",
	Archive: "\\Archive",
	Junk: "\\Junk",
	Trash: "\\Trash",
};
