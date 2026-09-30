import type { CommandReader } from "./reader";
import { ImapSyntaxError } from "./reader";
import type { BodySection, FetchItem, SectionText } from "./types";

const MAX_HEADER_FIELDS = 100;
const MAX_PART_DEPTH = 32;
const MAX_FETCH_ITEMS = 64;

const MACROS: Record<string, FetchItem[]> = {
	ALL: [{ kind: "flags" }, { kind: "internaldate" }, { kind: "rfc822.size" }, { kind: "envelope" }],
	FAST: [{ kind: "flags" }, { kind: "internaldate" }, { kind: "rfc822.size" }],
	FULL: [{ kind: "flags" }, { kind: "internaldate" }, { kind: "rfc822.size" }, { kind: "envelope" }, { kind: "body" }],
};

const SIMPLE: Record<string, FetchItem> = {
	FLAGS: { kind: "flags" },
	INTERNALDATE: { kind: "internaldate" },
	"RFC822.SIZE": { kind: "rfc822.size" },
	UID: { kind: "uid" },
	ENVELOPE: { kind: "envelope" },
	BODYSTRUCTURE: { kind: "bodystructure" },
	RFC822: { kind: "rfc822" },
	"RFC822.HEADER": { kind: "rfc822.header" },
	"RFC822.TEXT": { kind: "rfc822.text" },
};

/** An item name: letters, digits and dots, stopping before `[`. */
function readName(reader: CommandReader): string {
	let name = "";
	while (/^[A-Za-z0-9.]$/.test(reader.peek())) {
		name += reader.peek();
		reader.char(reader.peek());
		if (name.length > 32) throw new ImapSyntaxError("Invalid FETCH attribute");
	}
	if (!name) throw new ImapSyntaxError("Invalid FETCH attribute");
	return name.toUpperCase();
}

function fieldLabel(field: string): string {
	return /^[\x21-\x7e]+$/.test(field) && !/[(){%*"\\\]]/.test(field) ? field : `"${field.replace(/["\\]/g, (char) => `\\${char}`)}"`;
}

function sectionLabel(section: BodySection): string {
	const parts = section.part.map(String);
	if (section.text) {
		const text = section.text;
		if (text.kind === "header.fields") parts.push(`HEADER.FIELDS${text.not ? ".NOT" : ""} (${text.fields.map(fieldLabel).join(" ")})`);
		else parts.push(text.kind.toUpperCase());
	}
	return parts.join(".");
}

/** section = "[" [section-spec] "]" (RFC 3501 §9). */
export function readSection(reader: CommandReader): BodySection {
	reader.char("[");
	const part: number[] = [];
	let text: SectionText | null = null;
	if (!reader.maybe("]")) {
		while (/^[0-9]$/.test(reader.peek())) {
			part.push(reader.nzNumber());
			if (part.length > MAX_PART_DEPTH) throw new ImapSyntaxError("Section too deep");
			if (!reader.maybe(".")) break;
		}
		const name = /^[A-Za-z]$/.test(reader.peek()) ? readName(reader) : "";
		if (name === "HEADER") text = { kind: "header" };
		else if (name === "TEXT") text = { kind: "text" };
		else if (name === "MIME") {
			if (!part.length) throw new ImapSyntaxError("MIME needs a part number");
			text = { kind: "mime" };
		} else if (name === "HEADER.FIELDS" || name === "HEADER.FIELDS.NOT") {
			reader.sp();
			reader.char("(");
			const fields: string[] = [];
			do {
				const field = reader.astring();
				if (!/^[\x21-\x39\x3b-\x7e]+$/.test(field)) throw new ImapSyntaxError("Invalid header field name");
				fields.push(field.toUpperCase());
				if (fields.length > MAX_HEADER_FIELDS) throw new ImapSyntaxError("Too many header fields");
			} while (reader.maybe(" "));
			reader.char(")");
			text = { kind: "header.fields", not: name.endsWith(".NOT"), fields };
		} else if (name !== "" || !part.length) throw new ImapSyntaxError("Invalid section");
		reader.char("]");
	}
	return { part, text };
}

function readPartial(reader: CommandReader): { origin: number; length: number } | null {
	if (!reader.maybe("<")) return null;
	const origin = reader.number();
	reader.char(".");
	const length = reader.nzNumber();
	reader.char(">");
	return { origin, length };
}

function readItem(reader: CommandReader, name = readName(reader)): FetchItem {
	if (name === "BODY" || name === "BODY.PEEK") {
		if (reader.peek() !== "[") {
			if (name === "BODY.PEEK") throw new ImapSyntaxError("BODY.PEEK needs a section");
			return { kind: "body" };
		}
		const section = readSection(reader);
		const partial = readPartial(reader);
		return { kind: "section", peek: name === "BODY.PEEK", section, partial, label: sectionLabel(section) };
	}
	const simple = SIMPLE[name];
	if (!simple) throw new ImapSyntaxError(`Unknown FETCH attribute ${name}`);
	return simple;
}

/** The FETCH attribute list: a macro, one attribute, or a parenthesized list. */
export function readFetchItems(reader: CommandReader): FetchItem[] {
	if (reader.maybe("(")) {
		const items: FetchItem[] = [];
		do {
			items.push(readItem(reader));
			if (items.length > MAX_FETCH_ITEMS) throw new ImapSyntaxError("Too many FETCH attributes");
		} while (reader.maybe(" "));
		reader.char(")");
		return items;
	}
	const name = readName(reader);
	const macro = MACROS[name];
	return macro ? macro.map((item) => ({ ...item })) : [readItem(reader, name)];
}
