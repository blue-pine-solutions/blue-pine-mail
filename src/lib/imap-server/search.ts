import PostalMime, { decodeWords } from "postal-mime";
import { binaryToUtf8 } from "./bytes-utils";
import { MessageView } from "./fetch";
import { headerValue } from "./mime";
import { matchSequenceNumbers, resolveUids } from "./sequence-set";
import type { SearchKey, SnapshotEntry } from "./types";

/**
 * SEARCH evaluation (RFC 3501 §6.4.4) over a selected-mailbox snapshot.
 *
 * Sequence numbers, UIDs, flags, INTERNALDATE and known sizes come from the snapshot.
 * Header and body keys are answered from the canonical octets the client would fetch,
 * never from database columns that could differ from them (e.g. `to_addr` of received
 * mail is the envelope recipient, not the To header).
 *
 * Evaluation is three-valued: a candidate is first judged on snapshot data alone, and
 * its octets are read only when the answer still depends on them. Candidates are
 * processed one at a time, in order; each one's octets and decoded text are dropped
 * before the next is read, and cancellation is checked between candidates.
 */

export type SearchCandidate = { seq: number; uid: number; entry: SnapshotEntry };

type Tri = boolean | null;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function utcDay(date: Date): number {
	return Math.floor(date.getTime() / 86_400_000);
}

function compareDay(day: number, op: "before" | "on" | "since", target: number): boolean {
	return op === "before" ? day < target : op === "on" ? day === target : day >= target;
}

/** The calendar date of an RFC 5322 Date header, in its own zone (SENT* disregard time and zone). */
export function sentDay(value: string | null): number | null {
	if (!value) return null;
	const match = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{2,4})/.exec(value);
	if (!match) return null;
	const month = MONTHS.indexOf(match[2].toLowerCase());
	if (month < 0) return null;
	let year = Number(match[3]);
	if (match[3].length === 2) year += year < 50 ? 2000 : 1900;
	else if (match[3].length === 3) year += 1900;
	const time = Date.UTC(year, month, Number(match[1]));
	return Number.isFinite(time) ? Math.floor(time / 86_400_000) : null;
}

function decodeHeader(raw: string): string {
	try {
		return decodeWords(binaryToUtf8(raw));
	} catch {
		return binaryToUtf8(raw);
	}
}

function stripHtml(html: string): string {
	return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"');
}

/** One candidate's content, parsed lazily and only as far as a key needs. */
class CandidateContent {
	private view: MessageView;
	private decodedBody: string | null = null;
	private decodedHeaders: string | null = null;

	constructor(readonly bytes: Uint8Array) {
		this.view = new MessageView(bytes);
	}

	get size(): number {
		return this.bytes.byteLength;
	}

	headerValues(name: string): string[] {
		return this.view.root.headers.filter((field) => field.name === name).map((field) => decodeHeader(field.value));
	}

	sentDay(): number | null {
		return sentDay(headerValue(this.view.root.headers, "date"));
	}

	/** Decoded fields, plus the raw header octets so text in malformed header lines is still found. */
	headers(): string {
		this.decodedHeaders ??= `${this.view.root.headers.map((field) => `${field.name}: ${decodeHeader(field.value)}`).join("\n")}\n${binaryToUtf8(this.view.text.slice(0, this.view.root.headerEnd))}`;
		return this.decodedHeaders;
	}

	async body(): Promise<string> {
		if (this.decodedBody === null) {
			try {
				const email = await PostalMime.parse(this.bytes);
				this.decodedBody = `${email.text ?? ""}\n${email.html ? stripHtml(email.html) : ""}`;
			} catch {
				// Unparseable MIME: fall back to the raw body octets read as UTF-8.
				this.decodedBody = binaryToUtf8(this.view.text.slice(this.view.root.headerEnd));
			}
		}
		return this.decodedBody;
	}
}

function contains(haystack: string, needle: string): boolean {
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

const HEADER_KEYS: Record<string, string> = { FROM: "from", TO: "to", CC: "cc", BCC: "bcc", SUBJECT: "subject" };

type Context = {
	count: number;
	uids: readonly number[];
	sequenceSets: Map<SearchKey, Set<number>>;
	uidSets: Map<SearchKey, Set<number>>;
};

function cheap(key: SearchKey, candidate: SearchCandidate, context: Context): Tri {
	switch (key.kind) {
		case "all":
			return true;
		case "constant":
			return key.value;
		case "flag":
			return candidate.entry.flags[key.flag] === key.value;
		case "sequence": {
			let set = context.sequenceSets.get(key);
			if (!set) context.sequenceSets.set(key, (set = matchSequenceNumbers(key.set, context.count)));
			return set.has(candidate.seq);
		}
		case "uid": {
			let set = context.uidSets.get(key);
			if (!set) context.uidSets.set(key, (set = new Set(resolveUids(key.set, context.uids))));
			return set.has(candidate.uid);
		}
		case "internaldate":
			return compareDay(utcDay(candidate.entry.internalDate), key.op, key.day);
		case "size": {
			const size = candidate.entry.rfc822Size;
			if (size === null) return null;
			return key.op === "larger" ? size > key.value : size < key.value;
		}
		case "sentdate":
		case "header":
		case "body":
		case "text":
			return null;
		case "not": {
			const value = cheap(key.key, candidate, context);
			return value === null ? null : !value;
		}
		case "or": {
			const left = cheap(key.left, candidate, context);
			if (left === true) return true;
			const right = cheap(key.right, candidate, context);
			if (right === true) return true;
			return left === false && right === false ? false : null;
		}
		case "and": {
			let unknown = false;
			for (const item of key.keys) {
				const value = cheap(item, candidate, context);
				if (value === false) return false;
				if (value === null) unknown = true;
			}
			return unknown ? null : true;
		}
	}
}

async function full(key: SearchKey, candidate: SearchCandidate, content: CandidateContent, context: Context): Promise<boolean> {
	switch (key.kind) {
		case "size":
			return key.op === "larger" ? content.size > key.value : content.size < key.value;
		case "sentdate": {
			const day = content.sentDay();
			return day !== null && compareDay(day, key.op, key.day);
		}
		case "header": {
			const values = content.headerValues(HEADER_KEYS[key.field] ?? key.field.toLowerCase());
			return key.value === "" ? values.length > 0 : values.some((value) => contains(value, key.value));
		}
		case "body":
			return contains(await content.body(), key.value);
		case "text":
			return contains(content.headers(), key.value) || contains(await content.body(), key.value);
		case "not":
			return !(await full(key.key, candidate, content, context));
		case "or":
			return (await full(key.left, candidate, content, context)) || (await full(key.right, candidate, content, context));
		case "and":
			for (const item of key.keys) if (!(await full(item, candidate, content, context))) return false;
			return true;
		default:
			return cheap(key, candidate, context) === true;
	}
}

/**
 * The candidates matching `key`, in the order given. `load` returns a candidate's
 * canonical octets (null when it has left the folder, which excludes it); it is called
 * for at most one candidate at a time. Stops early, returning null, once `cancelled()`.
 */
export async function runSearch(
	key: SearchKey,
	candidates: SearchCandidate[],
	/** Messages in the mailbox and their UIDs, for `*` in sequence and UID sets. */
	mailbox: { count: number; uids: readonly number[] },
	load: (uid: number) => Promise<Uint8Array | null>,
	cancelled: () => boolean,
): Promise<SearchCandidate[] | null> {
	const context: Context = { count: mailbox.count, uids: mailbox.uids, sequenceSets: new Map(), uidSets: new Map() };
	const matches: SearchCandidate[] = [];
	for (const candidate of candidates) {
		if (cancelled()) return null;
		const quick = cheap(key, candidate, context);
		if (quick !== null) {
			if (quick) matches.push(candidate);
			continue;
		}
		const bytes = await load(candidate.uid);
		if (cancelled()) return null;
		if (!bytes) continue;
		if (await full(key, candidate, new CandidateContent(bytes), context)) matches.push(candidate);
	}
	return matches;
}
