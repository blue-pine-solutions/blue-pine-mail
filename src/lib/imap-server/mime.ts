/**
 * An offset-based reading of a canonical RFC 5322 message: where each entity's header
 * and body lie in the exact octets A3 serves. Nothing is decoded or rebuilt, so every
 * section, size and line count derived from it describes those octets.
 *
 * Input is a byte string (one character per octet). CRLF and bare LF line endings are
 * both accepted, as are messages without a header/body separator. Depth and entity count
 * are bounded; past a bound an entity is described as a leaf of its declared type rather
 * than parsed further.
 */

export const MAX_MIME_DEPTH = 32;
export const MAX_MIME_ENTITIES = 2000;
export const MAX_HEADER_FIELDS = 2000;

export type HeaderField = {
	/** Lowercased field name. */
	name: string;
	/** The field's octets, continuation lines and line ending included. */
	raw: string;
	/** The field body, unfolded (line breaks before whitespace removed), not decoded. */
	value: string;
};

export type MimeEntity = {
	/** Header octets are [start, headerEnd), including the separating empty line when present. */
	start: number;
	headerEnd: number;
	/** Body octets are [headerEnd, end). */
	end: number;
	headers: HeaderField[];
	type: string;
	subtype: string;
	params: Array<[string, string]>;
	/** True when Content-Type was absent or unusable and the default applies. */
	defaultType: boolean;
	children: MimeEntity[];
	/** The encapsulated message of a message/rfc822 entity. */
	message: MimeEntity | null;
};

type Budget = { entities: number };

/** Where the header block of [start, end) ends: just past the first empty line, or `end`. */
function findHeaderEnd(text: string, start: number, end: number): number {
	if (text.startsWith("\r\n", start) && start + 2 <= end) return start + 2;
	if (text[start] === "\n" && start < end) return start + 1;
	let position = start;
	for (;;) {
		const newline = text.indexOf("\n", position);
		if (newline < 0 || newline >= end) return end;
		const next = newline + 1;
		if (next < end && text[next] === "\n") return next + 1;
		if (next + 1 < end && text[next] === "\r" && text[next + 1] === "\n") return next + 2;
		if (next >= end) return end;
		position = next;
	}
}

export function unfold(value: string): string {
	return value.replace(/\r?\n(?=[ \t])/g, "").replace(/\r?\n$/, "");
}

export function parseHeaderFields(text: string, start: number, end: number): HeaderField[] {
	const fields: HeaderField[] = [];
	const block = text.slice(start, end);
	const lines = block.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	let current: { raw: string } | null = null;
	const flush = () => {
		if (!current || fields.length >= MAX_HEADER_FIELDS) return;
		const colon = current.raw.indexOf(":");
		const name = current.raw.slice(0, colon).trim();
		if (colon > 0 && /^[\x21-\x39\x3b-\x7e]+$/.test(name)) {
			fields.push({ name: name.toLowerCase(), raw: current.raw, value: unfold(current.raw.slice(colon + 1)).trim() });
		}
	};
	for (const line of lines) {
		if (line === "\r\n" || line === "\n") break;
		if ((line[0] === " " || line[0] === "\t") && current) current.raw += line;
		else {
			flush();
			current = { raw: line };
		}
	}
	flush();
	return fields;
}

export function headerValue(fields: HeaderField[], name: string): string | null {
	return fields.find((field) => field.name === name)?.value ?? null;
}

/** Remove RFC 5322 comments, keeping quoted strings intact. */
function stripComments(value: string): string {
	let out = "";
	let depth = 0;
	let quoted = false;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (quoted) {
			out += char;
			if (char === "\\" && index + 1 < value.length) out += value[++index];
			else if (char === '"') quoted = false;
		} else if (depth > 0) {
			if (char === "\\") index += 1;
			else if (char === "(") depth += 1;
			else if (char === ")") depth -= 1;
		} else if (char === "(") depth = 1;
		else {
			if (char === '"') quoted = true;
			out += char;
		}
	}
	return out;
}

/**
 * A structured header value such as Content-Type or Content-Disposition: the leading
 * value and its `;`-separated parameters. Parameter names are lowercased; values are
 * unquoted but otherwise as written (RFC 2231 names and encodings are passed through).
 */
export function parseStructuredValue(input: string): { value: string; params: Array<[string, string]> } {
	const text = stripComments(input);
	const params: Array<[string, string]> = [];
	let index = text.indexOf(";");
	const value = (index < 0 ? text : text.slice(0, index)).trim();
	while (index >= 0 && index < text.length && params.length < 100) {
		index += 1;
		const equals = text.indexOf("=", index);
		const nextSemicolon = text.indexOf(";", index);
		if (equals < 0 || (nextSemicolon >= 0 && nextSemicolon < equals)) {
			index = nextSemicolon;
			continue;
		}
		const name = text.slice(index, equals).trim().toLowerCase();
		let position = equals + 1;
		while (text[position] === " " || text[position] === "\t") position += 1;
		let parameter = "";
		if (text[position] === '"') {
			position += 1;
			while (position < text.length && text[position] !== '"') {
				if (text[position] === "\\" && position + 1 < text.length) position += 1;
				parameter += text[position];
				position += 1;
			}
			index = text.indexOf(";", position);
		} else {
			const stop = text.indexOf(";", position);
			parameter = (stop < 0 ? text.slice(position) : text.slice(position, stop)).trim();
			index = stop;
		}
		if (name && /^[\x21-\x7e]+$/.test(name)) params.push([name, parameter]);
	}
	return { value, params };
}

function contentType(fields: HeaderField[], digestParent: boolean) {
	const raw = headerValue(fields, "content-type");
	if (raw !== null) {
		const { value, params } = parseStructuredValue(raw);
		const match = /^([!#$%&'*+\-.0-9A-Z^_`a-z{|}~]+)\/([!#$%&'*+\-.0-9A-Z^_`a-z{|}~]+)$/.exec(value);
		if (match) return { type: match[1].toLowerCase(), subtype: match[2].toLowerCase(), params, defaultType: false };
	}
	return digestParent
		? { type: "message", subtype: "rfc822", params: [] as Array<[string, string]>, defaultType: true }
		: { type: "text", subtype: "plain", params: [["charset", "us-ascii"]] as Array<[string, string]>, defaultType: true };
}

/** Line-start offsets of boundary delimiters for `boundary` within [start, end), and whether one closes the multipart. */
function findDelimiters(text: string, boundary: string, start: number, end: number, limit: number) {
	const marker = `--${boundary}`;
	const found: Array<{ lineStart: number; next: number; close: boolean }> = [];
	let position = start;
	while (found.length <= limit) {
		const at = text.indexOf(marker, position);
		if (at < 0 || at >= end) break;
		position = at + marker.length;
		if (at !== start && text[at - 1] !== "\n") continue;
		let cursor = at + marker.length;
		const close = text.startsWith("--", cursor) && cursor + 2 <= end;
		if (close) cursor += 2;
		while (cursor < end && (text[cursor] === " " || text[cursor] === "\t")) cursor += 1;
		let next: number;
		if (cursor >= end) next = end;
		else if (text[cursor] === "\n") next = cursor + 1;
		else if (text[cursor] === "\r" && text[cursor + 1] === "\n" && cursor + 1 < end) next = cursor + 2;
		else continue;
		found.push({ lineStart: at, next, close });
		if (close) break;
	}
	return found;
}

/** The line ending just before `lineStart` belongs to the delimiter (RFC 2046 §5.1.1). */
function contentEndBefore(text: string, lineStart: number, floor: number): number {
	if (lineStart <= floor) return floor;
	let end = lineStart - 1;
	if (end > floor && text[end - 1] === "\r") end -= 1;
	return end;
}

function parseEntity(text: string, start: number, end: number, depth: number, budget: Budget, digestParent: boolean): MimeEntity {
	budget.entities += 1;
	const headerEnd = findHeaderEnd(text, start, end);
	const headers = parseHeaderFields(text, start, headerEnd);
	const type = contentType(headers, digestParent);
	const entity: MimeEntity = { start, headerEnd, end, headers, ...type, children: [], message: null };
	const deeper = depth < MAX_MIME_DEPTH && budget.entities < MAX_MIME_ENTITIES;
	if (!deeper) return entity;

	if (entity.type === "multipart") {
		const boundary = entity.params.find(([name]) => name === "boundary")?.[1];
		if (!boundary) {
			// Unusable multipart: read it as the default type, as RFC 2045 §5.2 does for invalid types.
			Object.assign(entity, contentType([], false));
			return entity;
		}
		const delimiters = findDelimiters(text, boundary, headerEnd, end, MAX_MIME_ENTITIES - budget.entities);
		const digest = entity.subtype === "digest";
		if (delimiters.length === 0) {
			entity.children.push(parseEntity(text, headerEnd, end, depth + 1, budget, digest));
			return entity;
		}
		for (let index = 0; index < delimiters.length; index += 1) {
			const delimiter = delimiters[index];
			if (delimiter.close) break;
			const following = delimiters[index + 1];
			const partEnd = following ? contentEndBefore(text, following.lineStart, delimiter.next) : end;
			if (budget.entities >= MAX_MIME_ENTITIES) break;
			entity.children.push(parseEntity(text, delimiter.next, partEnd, depth + 1, budget, digest));
		}
		if (entity.children.length === 0) entity.children.push(parseEntity(text, headerEnd, headerEnd, depth + 1, budget, digest));
	} else if (entity.type === "message" && entity.subtype === "rfc822") {
		entity.message = parseEntity(text, headerEnd, end, depth + 1, budget, false);
	}
	return entity;
}

/** The structure of a whole message (a byte string). */
export function parseMessage(text: string): MimeEntity {
	return parseEntity(text, 0, text.length, 0, { entities: 0 }, false);
}

/** A part reference: the entity, and whether it is a whole message (root or encapsulated) rather than a body part. */
type PartRef = { entity: MimeEntity; isMessage: boolean };

/**
 * The body part a section part path names (RFC 3501 §6.4.5): parts of a multipart are
 * numbered from 1; a non-multipart message has one part, 1, its body; a message/rfc822
 * part's sub-parts are those of the message it encapsulates. Null when there is no such part.
 */
export function resolvePart(root: MimeEntity, path: number[]): MimeEntity | null {
	let ref: PartRef = { entity: root, isMessage: true };
	for (const number of path) {
		let container = ref.entity;
		let viaMessage = ref.isMessage;
		if (!ref.isMessage && container.message) {
			container = container.message;
			viaMessage = true;
		}
		if (container.children.length) {
			const child = container.children[number - 1];
			if (!child) return null;
			ref = { entity: child, isMessage: false };
		} else if (viaMessage && number === 1) {
			ref = { entity: container, isMessage: false };
		} else return null;
	}
	return ref.entity;
}

export function countLines(text: string, start: number, end: number): number {
	if (end <= start) return 0;
	let lines = 0;
	for (let position = text.indexOf("\n", start); position >= 0 && position < end; position = text.indexOf("\n", position + 1)) lines += 1;
	return text[end - 1] === "\n" ? lines : lines + 1;
}
