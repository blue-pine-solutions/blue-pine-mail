import { binaryToUtf8 } from "./bytes-utils";
import type { CommandReader } from "./reader";
import { ImapSyntaxError } from "./reader";
import { isSequenceSetToken, parseSequenceSet } from "./sequence-set";
import type { SearchKey } from "./types";

/** Charsets whose strings are decoded correctly: US-ASCII is a subset of UTF-8. */
export const SEARCH_CHARSETS = ["US-ASCII", "UTF-8"] as const;

export const MAX_SEARCH_DEPTH = 32;
export const MAX_SEARCH_KEYS = 256;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** A date-text (`d-Mon-yyyy`) as whole days since the Unix epoch. */
export function parseSearchDate(value: string): number {
	const match = /^([0-9]{1,2})-([A-Za-z]{3})-([0-9]{4})$/.exec(value);
	const month = match ? MONTHS.indexOf(match[2].toUpperCase()) : -1;
	if (!match || month < 0) throw new ImapSyntaxError("Invalid date");
	const day = Number(match[1]);
	const time = Date.UTC(Number(match[3]), month, day);
	if (day < 1 || new Date(time).getUTCDate() !== day) throw new ImapSyntaxError("Invalid date");
	return Math.floor(time / 86_400_000);
}

export type ParsedSearch = { charset: string | null; key: SearchKey };

class SearchParser {
	private keys = 0;

	constructor(private readonly reader: CommandReader) {}

	private text(): string {
		// The charset is validated by the caller; both supported charsets decode as UTF-8.
		return binaryToUtf8(this.reader.astring());
	}

	private date(): number {
		const reader = this.reader;
		return parseSearchDate(reader.peek() === '"' ? reader.quoted() : reader.atom());
	}

	private number(): number {
		return this.reader.number();
	}

	list(depth: number, closing: boolean): SearchKey {
		const keys: SearchKey[] = [];
		for (;;) {
			keys.push(this.key(depth));
			if (!this.reader.maybe(" ")) break;
		}
		if (closing) this.reader.char(")");
		return keys.length === 1 ? keys[0] : { kind: "and", keys };
	}

	key(depth: number): SearchKey {
		if (depth > MAX_SEARCH_DEPTH) throw new ImapSyntaxError("Search expression too deep");
		if (++this.keys > MAX_SEARCH_KEYS) throw new ImapSyntaxError("Search expression too long");
		const reader = this.reader;
		if (reader.maybe("(")) return this.list(depth + 1, true);
		const next = reader.peek();
		if (/^[0-9*]$/.test(next)) {
			const token = reader.token();
			if (!isSequenceSetToken(token)) throw new ImapSyntaxError("Invalid sequence set");
			return { kind: "sequence", set: parseSequenceSet(token) };
		}
		const word = reader.keyword();
		switch (word) {
			case "ALL":
				return { kind: "all" };
			case "ANSWERED":
			case "NEW":
			case "RECENT":
				return { kind: "constant", value: false };
			case "UNANSWERED":
			case "OLD":
				return { kind: "constant", value: true };
			case "KEYWORD":
			case "UNKEYWORD":
				reader.sp();
				reader.atom();
				return { kind: "constant", value: word === "UNKEYWORD" };
			case "SEEN":
			case "UNSEEN":
				return { kind: "flag", flag: "seen", value: word === "SEEN" };
			case "FLAGGED":
			case "UNFLAGGED":
				return { kind: "flag", flag: "flagged", value: word === "FLAGGED" };
			case "DELETED":
			case "UNDELETED":
				return { kind: "flag", flag: "deleted", value: word === "DELETED" };
			case "DRAFT":
			case "UNDRAFT":
				return { kind: "flag", flag: "draft", value: word === "DRAFT" };
			case "BEFORE":
			case "ON":
			case "SINCE":
				reader.sp();
				return { kind: "internaldate", op: word.toLowerCase() as "before" | "on" | "since", day: this.date() };
			case "SENTBEFORE":
			case "SENTON":
			case "SENTSINCE":
				reader.sp();
				return { kind: "sentdate", op: word.slice(4).toLowerCase() as "before" | "on" | "since", day: this.date() };
			case "LARGER":
			case "SMALLER":
				reader.sp();
				return { kind: "size", op: word.toLowerCase() as "larger" | "smaller", value: this.number() };
			case "FROM":
			case "TO":
			case "CC":
			case "BCC":
			case "SUBJECT":
				reader.sp();
				return { kind: "header", field: word, value: this.text() };
			case "HEADER": {
				reader.sp();
				const field = reader.astring();
				if (!/^[\x21-\x39\x3b-\x7e]+$/.test(field)) throw new ImapSyntaxError("Invalid header field name");
				reader.sp();
				return { kind: "header", field: field.toUpperCase(), value: this.text() };
			}
			case "BODY":
				reader.sp();
				return { kind: "body", value: this.text() };
			case "TEXT":
				reader.sp();
				return { kind: "text", value: this.text() };
			case "UID": {
				reader.sp();
				const token = reader.token();
				if (!isSequenceSetToken(token)) throw new ImapSyntaxError("Invalid UID set");
				return { kind: "uid", set: parseSequenceSet(token) };
			}
			case "NOT":
				reader.sp();
				return { kind: "not", key: this.key(depth + 1) };
			case "OR": {
				reader.sp();
				const left = this.key(depth + 1);
				reader.sp();
				return { kind: "or", left, right: this.key(depth + 1) };
			}
			default:
				throw new ImapSyntaxError(`Unknown search key ${word}`);
		}
	}
}

/** `[CHARSET astring SP] search-key *(SP search-key)`, after `SEARCH SP`. */
export function readSearch(reader: CommandReader): ParsedSearch {
	// CHARSET is only a keyword in first position.
	const charset = readCharset(reader) ?? null;
	const parser = new SearchParser(reader);
	const key = parser.list(0, false);
	reader.end();
	return { charset, key };
}

function readCharset(reader: CommandReader): string | undefined {
	const snapshot = reader.mark();
	if (/^[A-Za-z]$/.test(reader.peek())) {
		const word = reader.keyword();
		if (word === "CHARSET") {
			reader.sp();
			const charset = reader.astring().toUpperCase();
			reader.sp();
			return charset;
		}
	}
	reader.reset(snapshot);
	return undefined;
}
