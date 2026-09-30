import { headerValue, type HeaderField } from "./mime";
import { ResponseBuilder } from "./response";

/**
 * ENVELOPE (RFC 3501 §7.4.2) from a message's own header fields, as written: encoded
 * words stay encoded and nothing is decoded or re-encoded. Addresses are split with an
 * RFC 5322 tokenizer that tolerates malformed input; whatever it cannot place is still
 * emitted as a string value, so it can never break the response framing.
 */

export type EnvelopeAddress = { name: string | null; mailbox: string | null; host: string | null };
/** A group start is `{ group: name }`, a group end `{ group: null }`. */
export type EnvelopeItem = EnvelopeAddress | { group: string | null };

const MAX_ADDRESSES = 1000;

type Token = { kind: "atom" | "quoted" | "comment" | "literal" | "special"; value: string };

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	while (index < input.length && tokens.length < 20_000) {
		const char = input[index];
		if (char === " " || char === "\t" || char === "\r" || char === "\n") {
			index += 1;
		} else if (char === '"') {
			let value = "";
			index += 1;
			while (index < input.length && input[index] !== '"') {
				if (input[index] === "\\" && index + 1 < input.length) index += 1;
				value += input[index];
				index += 1;
			}
			index += 1;
			tokens.push({ kind: "quoted", value });
		} else if (char === "(") {
			let depth = 1;
			let value = "";
			index += 1;
			while (index < input.length && depth > 0) {
				const c = input[index];
				if (c === "\\" && index + 1 < input.length) {
					value += input[index + 1];
					index += 2;
					continue;
				}
				if (c === "(") depth += 1;
				else if (c === ")") depth -= 1;
				if (depth > 0) value += c;
				index += 1;
			}
			tokens.push({ kind: "comment", value: value.trim() });
		} else if (char === "[") {
			const close = input.indexOf("]", index);
			const stop = close < 0 ? input.length : close + 1;
			tokens.push({ kind: "literal", value: input.slice(index, stop) });
			index = stop;
		} else if ("<>@,;:.".includes(char)) {
			tokens.push({ kind: "special", value: char });
			index += 1;
		} else {
			let value = "";
			while (index < input.length && !` \t\r\n"()[<>@,;:.`.includes(input[index])) value += input[index++];
			tokens.push({ kind: "atom", value });
		}
	}
	return tokens;
}

function phrase(tokens: Token[]): string | null {
	const words = tokens.filter((token) => token.kind === "atom" || token.kind === "quoted" || (token.kind === "special" && token.value === "."));
	if (!words.length) return null;
	let out = "";
	for (const [index, token] of words.entries()) {
		if (index > 0 && token.value !== "." && words[index - 1].value !== ".") out += " ";
		out += token.value;
	}
	return out;
}

/** addr-spec tokens to mailbox and host; the local part keeps its quoting. */
function addrSpec(tokens: Token[]): { mailbox: string | null; host: string | null } {
	const spec = tokens.filter((token) => token.kind !== "comment");
	// A source route (`@a,@b:`) before the address is obsolete syntax; drop it.
	const colon = spec.findIndex((token) => token.kind === "special" && token.value === ":");
	const rest = colon >= 0 && spec[0]?.value === "@" ? spec.slice(colon + 1) : spec;
	const at = rest.map((token) => token.value).lastIndexOf("@");
	const text = (list: Token[]) => list.map((token) => (token.kind === "quoted" ? `"${token.value.replace(/["\\]/g, "\\$&")}"` : token.value)).join("");
	if (at < 0) {
		const mailbox = text(rest);
		return { mailbox: mailbox || null, host: mailbox ? "" : null };
	}
	return { mailbox: text(rest.slice(0, at)), host: text(rest.slice(at + 1)) };
}

function mailbox(tokens: Token[]): EnvelopeAddress | null {
	if (!tokens.length) return null;
	const open = tokens.findIndex((token) => token.kind === "special" && token.value === "<");
	if (open >= 0) {
		const close = tokens.findIndex((token, index) => index > open && token.kind === "special" && token.value === ">");
		const inner = tokens.slice(open + 1, close < 0 ? tokens.length : close);
		const { mailbox: local, host } = addrSpec(inner);
		const name = phrase(tokens.slice(0, open));
		if (!local && !name) return null;
		return { name, mailbox: local ?? "", host: host ?? "" };
	}
	const { mailbox: local, host } = addrSpec(tokens);
	if (!local) return null;
	const comment = tokens.find((token) => token.kind === "comment" && token.value);
	return { name: comment ? comment.value : null, mailbox: local, host: host ?? "" };
}

/** An address-list header value as ENVELOPE items. */
export function parseAddressList(input: string): EnvelopeItem[] {
	const tokens = tokenize(input);
	const items: EnvelopeItem[] = [];
	let current: Token[] = [];
	let inGroup = false;
	let angle = 0;
	const flush = () => {
		const address = mailbox(current);
		if (address && items.length < MAX_ADDRESSES) items.push(address);
		current = [];
	};
	for (const token of tokens) {
		if (token.kind === "special") {
			if (token.value === "<") angle += 1;
			else if (token.value === ">") angle = Math.max(0, angle - 1);
			else if (angle === 0 && token.value === ",") {
				flush();
				continue;
			} else if (angle === 0 && token.value === ":" && !inGroup) {
				items.push({ group: phrase(current) ?? "" });
				current = [];
				inGroup = true;
				continue;
			} else if (angle === 0 && token.value === ";" && inGroup) {
				flush();
				items.push({ group: null });
				inGroup = false;
				continue;
			}
		}
		current.push(token);
	}
	flush();
	if (inGroup) items.push({ group: null });
	return items;
}

function addresses(builder: ResponseBuilder, value: string | null): void {
	const items = value === null ? [] : parseAddressList(value);
	if (!items.some((item) => !("group" in item) || item.group !== null)) {
		builder.raw("NIL");
		return;
	}
	builder.raw("(");
	for (const item of items) {
		builder.raw("(");
		if ("group" in item) {
			builder.raw("NIL NIL ").nstring(item.group).raw(" NIL");
		} else {
			builder.nstring(item.name).raw(" NIL ").nstring(item.mailbox).raw(" ").nstring(item.host);
		}
		builder.raw(")");
	}
	builder.raw(")");
}

/** A header's value, or null when absent or empty. */
function present(fields: HeaderField[], name: string): string | null {
	const value = headerValue(fields, name);
	return value === null || value === "" ? null : value;
}

/** Append `(date subject from sender reply-to to cc bcc in-reply-to message-id)`. */
export function writeEnvelope(builder: ResponseBuilder, fields: HeaderField[]): void {
	const from = present(fields, "from");
	builder.raw("(").nstring(present(fields, "date")).raw(" ").nstring(present(fields, "subject")).raw(" ");
	addresses(builder, from);
	builder.raw(" ");
	// Sender and Reply-To default to From when absent or empty (RFC 3501 §7.4.2).
	addresses(builder, present(fields, "sender") ?? from);
	builder.raw(" ");
	addresses(builder, present(fields, "reply-to") ?? from);
	for (const name of ["to", "cc", "bcc"]) {
		builder.raw(" ");
		addresses(builder, present(fields, name));
	}
	builder.raw(" ").nstring(present(fields, "in-reply-to")).raw(" ").nstring(present(fields, "message-id")).raw(")");
}
