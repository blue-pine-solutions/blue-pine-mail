import { ImapSyntaxError } from "./reader";
import type { SequenceRange, SequenceSet } from "./types";

/** Most ranges in one set; a 64 KiB line cannot legitimately need more. */
export const MAX_SEQUENCE_RANGES = 20_000;
const MAX_NUMBER = 0xffffffff;

function seqNumber(value: string): number | null {
	if (value === "*") return null;
	if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new ImapSyntaxError("Invalid sequence set");
	const number = Number(value);
	if (number > MAX_NUMBER) throw new ImapSyntaxError("Invalid sequence set");
	return number;
}

/** RFC 3501 sequence-set: comma-separated numbers and ranges, `*` for the largest. */
export function parseSequenceSet(token: string): SequenceSet {
	const ranges: SequenceRange[] = [];
	for (const item of token.split(",")) {
		if (ranges.length >= MAX_SEQUENCE_RANGES) throw new ImapSyntaxError("Sequence set too long");
		const bounds = item.split(":");
		if (bounds.length > 2) throw new ImapSyntaxError("Invalid sequence set");
		const from = seqNumber(bounds[0]);
		const to = bounds.length === 2 ? seqNumber(bounds[1]) : from;
		ranges.push({ from, to });
	}
	return ranges;
}

export function isSequenceSetToken(token: string): boolean {
	return /^[0-9*][0-9*:,]*$/.test(token);
}

/** Ranges as sorted, merged [low, high] pairs, `*` read as `star`. */
function normalize(set: SequenceSet, star: number): Array<[number, number]> {
	const pairs = set
		.map(({ from, to }): [number, number] => {
			const a = from ?? star;
			const b = to ?? star;
			return a <= b ? [a, b] : [b, a];
		})
		.sort((x, y) => x[0] - y[0]);
	const merged: Array<[number, number]> = [];
	for (const pair of pairs) {
		const last = merged[merged.length - 1];
		if (last && pair[0] <= last[1] + 1) last[1] = Math.max(last[1], pair[1]);
		else merged.push([pair[0], pair[1]]);
	}
	return merged;
}

/**
 * Message sequence numbers named by a set in a mailbox of `count` messages, ascending.
 * Null when the set names a number that does not exist (the command is then a BAD).
 */
export function resolveSequenceNumbers(set: SequenceSet, count: number): number[] | null {
	if (count === 0) return null;
	const out: number[] = [];
	for (const [low, high] of normalize(set, count)) {
		if (low < 1 || high > count) return null;
		for (let number = low; number <= high; number += 1) out.push(number);
	}
	return out;
}

/** Sequence numbers named by a set, ignoring numbers beyond the mailbox (SEARCH semantics). */
export function matchSequenceNumbers(set: SequenceSet, count: number): Set<number> {
	const out = new Set<number>();
	if (count === 0) return out;
	for (const [low, high] of normalize(set, count)) {
		for (let number = Math.max(1, low); number <= Math.min(high, count); number += 1) out.add(number);
	}
	return out;
}

/**
 * UIDs from `uids` (ascending) that a UID set names, ascending. `*` is the largest UID in
 * use, so `n:*` always includes the last message even when n is beyond it (RFC 3501 §6.4.8).
 * UIDs that do not exist are ignored.
 */
export function resolveUids(set: SequenceSet, uids: readonly number[]): number[] {
	if (uids.length === 0) return [];
	const ranges = normalize(set, uids[uids.length - 1]);
	const out: number[] = [];
	let range = 0;
	for (const uid of uids) {
		while (range < ranges.length && ranges[range][1] < uid) range += 1;
		if (range >= ranges.length) break;
		if (uid >= ranges[range][0]) out.push(uid);
	}
	return out;
}
