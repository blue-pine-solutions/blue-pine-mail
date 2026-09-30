import type { ImapFlagName } from "@/lib/imap/types";
import type { CommandReader } from "./reader";
import { ImapSyntaxError } from "./reader";
import { isSequenceSetToken, parseSequenceSet } from "./sequence-set";
import type { SequenceSet } from "./types";

/** Most flags one STORE may name; RFC 3501 defines five system flags, so this only bounds keyword lists. */
export const MAX_STORE_FLAGS = 64;

export type StoreRequest = {
	set: SequenceSet;
	mode: "replace" | "add" | "remove";
	silent: boolean;
	/** The flags A3 keeps (\Seen, \Flagged, \Deleted), deduplicated. */
	flags: ImapFlagName[];
	/** Flags named that are not kept (\Answered, \Draft, keywords): accepted and not stored. */
	ignored: string[];
};

const STORED: Record<string, ImapFlagName> = { SEEN: "seen", FLAGGED: "flagged", DELETED: "deleted" };
/** System flags a client may name but this server does not keep (\Draft is derived from the Drafts folder). */
const NOT_STORED = new Set(["ANSWERED", "DRAFT"]);

/** flag = "\" atom (a system flag or flag-extension) / atom (a keyword). */
function readFlag(reader: CommandReader, request: StoreRequest): void {
	if (reader.maybe("\\")) {
		const name = reader.atom().toUpperCase();
		if (name === "RECENT") throw new ImapSyntaxError("\\Recent cannot be changed");
		const stored = STORED[name];
		if (stored) {
			if (!request.flags.includes(stored)) request.flags.push(stored);
		} else if (NOT_STORED.has(name)) request.ignored.push(`\\${name}`);
		else throw new ImapSyntaxError(`Unknown system flag \\${name}`);
		return;
	}
	request.ignored.push(reader.atom());
}

/**
 * `store = "STORE" SP sequence-set SP store-att-flags`, after the command name (RFC 3501 §9):
 * `store-att-flags = (["+" / "-"] "FLAGS" [".SILENT"]) SP (flag-list / (flag *(SP flag)))`.
 */
export function readStore(reader: CommandReader): StoreRequest {
	reader.sp();
	const token = reader.token();
	if (!isSequenceSetToken(token)) throw new ImapSyntaxError("Invalid sequence set");
	const set = parseSequenceSet(token);
	reader.sp();
	const item = /^([+-]?)FLAGS(\.SILENT)?$/.exec(reader.keyword());
	if (!item) throw new ImapSyntaxError("Expected FLAGS, +FLAGS or -FLAGS");
	const request: StoreRequest = { set, mode: item[1] === "+" ? "add" : item[1] === "-" ? "remove" : "replace", silent: !!item[2], flags: [], ignored: [] };
	reader.sp();
	let count = 0;
	const next = () => {
		if (++count > MAX_STORE_FLAGS) throw new ImapSyntaxError("Too many flags");
		readFlag(reader, request);
	};
	if (reader.maybe("(")) {
		if (!reader.maybe(")")) {
			do next();
			while (reader.maybe(" "));
			reader.char(")");
		}
	} else {
		do next();
		while (reader.maybe(" "));
	}
	reader.end();
	return request;
}
