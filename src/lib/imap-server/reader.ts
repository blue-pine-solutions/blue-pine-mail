import { bytesToBinary } from "./bytes-utils";
import type { CommandPart } from "./types";

/** A command that does not parse. The session answers it with a tagged BAD. */
export class ImapSyntaxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ImapSyntaxError";
	}
}

const ATOM_SPECIALS = new Set(["(", ")", "{", " ", "%", "*", '"', "\\", "]"]);
const MAX_NUMBER = 0xffffffff;

function isCtl(code: number): boolean {
	return code < 0x20 || code === 0x7f;
}

/**
 * Recursive-descent reader over a framed command (RFC 3501 §9 formal syntax). Text is
 * read as byte strings; a literal part stands where its `{n}` marker was. Every read is
 * bounded by the command's length, so a malformed command costs at most one pass.
 */
export class CommandReader {
	private index = 0;
	private position = 0;

	constructor(private readonly parts: CommandPart[]) {}

	private get current(): CommandPart | undefined {
		return this.parts[this.index];
	}

	/** Advance past an exhausted text part, but never past a literal. */
	private settle(): void {
		for (;;) {
			const part = this.current;
			if (!part || part.kind !== "text" || this.position < part.text.length) return;
			if (this.index + 1 >= this.parts.length) return;
			this.index += 1;
			this.position = 0;
		}
	}

	mark(): [number, number] {
		return [this.index, this.position];
	}

	reset([index, position]: [number, number]): void {
		this.index = index;
		this.position = position;
	}

	/** The next character, `"{literal}"` when a literal is next, or "" at the end. */
	peek(): string {
		this.settle();
		const part = this.current;
		if (!part) return "";
		if (part.kind === "literal") return "{literal}";
		return part.text[this.position] ?? "";
	}

	atEnd(): boolean {
		return this.peek() === "";
	}

	end(): void {
		if (!this.atEnd()) throw new ImapSyntaxError("Unexpected extra arguments");
	}

	private take(): string {
		const char = this.peek();
		if (char === "" || char === "{literal}") throw new ImapSyntaxError("Unexpected end of command");
		this.position += 1;
		return char;
	}

	char(expected: string): void {
		if (this.peek() !== expected) throw new ImapSyntaxError(`Expected "${expected}"`);
		this.position += 1;
	}

	/** Consume `expected` if it is next. */
	maybe(expected: string): boolean {
		if (this.peek() !== expected) return false;
		this.position += 1;
		return true;
	}

	sp(): void {
		this.char(" ");
	}

	/** An atom; `extra` names characters allowed beyond ATOM-CHAR (e.g. "]" for astring, "%*" for list-mailbox). */
	atom(extra = ""): string {
		let out = "";
		for (;;) {
			const char = this.peek();
			if (char === "" || char === "{literal}") break;
			const code = char.charCodeAt(0);
			if (isCtl(code) || code > 0x7e || (ATOM_SPECIALS.has(char) && !extra.includes(char))) break;
			out += char;
			this.position += 1;
		}
		if (!out) throw new ImapSyntaxError("Expected an atom");
		return out;
	}

	/** A keyword such as a command or FETCH item name, uppercased. Dots and brackets end it where the grammar needs. */
	keyword(): string {
		return this.atom().toUpperCase();
	}

	quoted(): string {
		this.char('"');
		let out = "";
		for (;;) {
			const char = this.take();
			if (char === '"') return out;
			if (char === "\r" || char === "\n") throw new ImapSyntaxError("Line break in quoted string");
			if (char === "\\") {
				const escaped = this.take();
				if (escaped !== '"' && escaped !== "\\") throw new ImapSyntaxError("Invalid escape in quoted string");
				out += escaped;
				continue;
			}
			if (char === "\0") throw new ImapSyntaxError("NUL in quoted string");
			out += char;
		}
	}

	literal(): string {
		this.settle();
		const part = this.current;
		if (!part || part.kind !== "literal") throw new ImapSyntaxError("Expected a literal");
		this.index += 1;
		this.position = 0;
		return bytesToBinary(part.bytes);
	}

	string(): string {
		const next = this.peek();
		if (next === '"') return this.quoted();
		if (next === "{literal}") return this.literal();
		throw new ImapSyntaxError("Expected a string");
	}

	astring(): string {
		const next = this.peek();
		if (next === '"' || next === "{literal}") return this.string();
		return this.atom("]");
	}

	/** list-mailbox: a string, or atom characters plus the `%` and `*` wildcards. */
	listMailbox(): string {
		const next = this.peek();
		if (next === '"' || next === "{literal}") return this.string();
		return this.atom("%*]");
	}

	nstringOrNil(): string | null {
		const next = this.peek();
		if (next === '"' || next === "{literal}") return this.string();
		if (this.atom().toUpperCase() !== "NIL") throw new ImapSyntaxError("Expected a string or NIL");
		return null;
	}

	number(): number {
		let digits = "";
		while (/^[0-9]$/.test(this.peek())) {
			digits += this.take();
			if (digits.length > 10) throw new ImapSyntaxError("Number too large");
		}
		if (!digits) throw new ImapSyntaxError("Expected a number");
		const value = Number(digits);
		if (value > MAX_NUMBER) throw new ImapSyntaxError("Number too large");
		return value;
	}

	nzNumber(): number {
		const value = this.number();
		if (value === 0) throw new ImapSyntaxError("Expected a non-zero number");
		return value;
	}

	/** Characters up to (not including) the next space or end: the raw sequence-set and similar tokens. */
	token(): string {
		let out = "";
		for (;;) {
			const char = this.peek();
			if (char === "" || char === " " || char === "{literal}" || char === ")" || char === "(") break;
			out += char;
			this.position += 1;
		}
		if (!out) throw new ImapSyntaxError("Expected a token");
		return out;
	}
}
