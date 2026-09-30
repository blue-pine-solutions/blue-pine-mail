import type { ImapFlags } from "@/lib/imap/types";
import { writeBodyStructure } from "./body-structure";
import { binaryToBytes, bytesToBinary } from "./bytes-utils";
import { writeEnvelope } from "./envelope";
import type { MessageMetadata } from "./metadata-cache";
import { parseMessage, resolvePart, type MimeEntity } from "./mime";
import { ResponseBuilder } from "./response";
import type { BodySection, FetchItem } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `dd-Mon-yyyy hh:mm:ss +0000` (RFC 3501 date-time), in UTC. */
export function formatInternalDate(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getUTCDate())}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

export function formatFlags(flags: ImapFlags): string {
	const out: string[] = [];
	if (flags.seen) out.push("\\Seen");
	if (flags.flagged) out.push("\\Flagged");
	if (flags.deleted) out.push("\\Deleted");
	if (flags.draft) out.push("\\Draft");
	return `(${out.join(" ")})`;
}

/** Everything the FETCH response for one message can be built from. */
export type FetchSource = {
	seq: number;
	uid: number;
	flags: ImapFlags;
	internalDate: Date;
	/** RFC822.SIZE when known without reading the octets. */
	knownSize: number | null;
	metadata: MessageMetadata | null;
	/** The canonical octets, when they had to be read. */
	bytes: Uint8Array | null;
};

/** Whether answering `items` needs the canonical octets, given what is already known. */
export function needsContent(items: FetchItem[], knownSize: number | null, metadata: MessageMetadata | null): boolean {
	return items.some((item) => {
		switch (item.kind) {
			case "section":
			case "rfc822":
			case "rfc822.header":
			case "rfc822.text":
				return true;
			case "envelope":
			case "body":
			case "bodystructure":
				return !metadata;
			case "rfc822.size":
				return knownSize === null && !metadata;
			default:
				return false;
		}
	});
}

/** A parsed view of the canonical octets, built once per message and dropped after it. */
export class MessageView {
	readonly text: string;
	private tree: MimeEntity | null = null;

	constructor(readonly bytes: Uint8Array) {
		this.text = bytesToBinary(bytes);
	}

	get root(): MimeEntity {
		this.tree ??= parseMessage(this.text);
		return this.tree;
	}

	metadata(): MessageMetadata {
		const envelope = new ResponseBuilder();
		writeEnvelope(envelope, this.root.headers);
		const body = new ResponseBuilder();
		writeBodyStructure(body, this.text, this.root, false);
		const structure = new ResponseBuilder();
		writeBodyStructure(structure, this.text, this.root, true);
		const toBinary = (builder: ResponseBuilder) => bytesToBinary(builder.bytes());
		return { size: this.bytes.byteLength, envelope: toBinary(envelope), body: toBinary(body), bodyStructure: toBinary(structure) };
	}

	private headerFields(entity: MimeEntity, fields: string[], not: boolean): Uint8Array {
		const wanted = new Set(fields.map((field) => field.toLowerCase()));
		let out = "";
		for (const field of entity.headers) {
			if (wanted.has(field.name) === not) continue;
			out += /\n$/.test(field.raw) ? field.raw : `${field.raw}\r\n`;
		}
		return binaryToBytes(`${out}\r\n`);
	}

	/** The octets a BODY[section] names; empty when the section does not exist. */
	section(section: BodySection): Uint8Array {
		const empty = new Uint8Array(0);
		let entity: MimeEntity | null = this.root;
		if (section.part.length) {
			entity = resolvePart(this.root, section.part);
			if (!entity) return empty;
			if (!section.text) return this.bytes.subarray(entity.headerEnd, entity.end);
			if (section.text.kind === "mime") return this.bytes.subarray(entity.start, entity.headerEnd);
			entity = entity.message;
			if (!entity) return empty;
		} else if (!section.text) return this.bytes;
		const text = section.text!;
		if (text.kind === "header") return this.bytes.subarray(entity.start, entity.headerEnd);
		if (text.kind === "text") return this.bytes.subarray(entity.headerEnd, entity.end);
		if (text.kind === "header.fields") return this.headerFields(entity, text.fields, text.not);
		return empty;
	}
}

/**
 * Append `seq FETCH (...)` data for one message (without the leading `* `). FLAGS are
 * `source.flags` exactly; any implicit \Seen has already been applied by the session.
 */
export function writeFetchResponse(builder: ResponseBuilder, items: FetchItem[], source: FetchSource, view: MessageView | null, metadata: MessageMetadata | null): void {
	builder.raw(`${source.seq} FETCH (`);
	items.forEach((item, index) => {
		if (index) builder.raw(" ");
		switch (item.kind) {
			case "uid":
				builder.raw(`UID ${source.uid}`);
				break;
			case "flags":
				builder.raw(`FLAGS ${formatFlags(source.flags)}`);
				break;
			case "internaldate":
				builder.raw(`INTERNALDATE "${formatInternalDate(source.internalDate)}"`);
				break;
			case "rfc822.size":
				builder.raw(`RFC822.SIZE ${view ? view.bytes.byteLength : (source.knownSize ?? metadata!.size)}`);
				break;
			case "envelope":
				builder.raw("ENVELOPE ").raw(metadata!.envelope);
				break;
			case "body":
				builder.raw("BODY ").raw(metadata!.body);
				break;
			case "bodystructure":
				builder.raw("BODYSTRUCTURE ").raw(metadata!.bodyStructure);
				break;
			case "rfc822":
				builder.raw("RFC822 ").literal(view!.bytes);
				break;
			case "rfc822.header":
				builder.raw("RFC822.HEADER ").literal(view!.section({ part: [], text: { kind: "header" } }));
				break;
			case "rfc822.text":
				builder.raw("RFC822.TEXT ").literal(view!.section({ part: [], text: { kind: "text" } }));
				break;
			case "section": {
				let data = view!.section(item.section);
				let label = `BODY[${item.label}]`;
				if (item.partial) {
					const start = Math.min(item.partial.origin, data.byteLength);
					data = data.subarray(start, Math.min(data.byteLength, start + item.partial.length));
					label += `<${item.partial.origin}>`;
				}
				builder.raw(`${label} `).literal(data);
				break;
			}
		}
	});
	builder.raw(")\r\n");
}
