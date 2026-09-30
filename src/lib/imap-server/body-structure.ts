import { writeEnvelope } from "./envelope";
import { countLines, headerValue, parseStructuredValue, type MimeEntity } from "./mime";
import type { ResponseBuilder } from "./response";

/**
 * BODY and BODYSTRUCTURE (RFC 3501 §7.4.2) from the offset-based MIME reading of the
 * canonical octets: every size and line count is measured on exactly the octets a
 * BODY[section] fetch of the same part returns.
 */

function params(builder: ResponseBuilder, list: Array<[string, string]>): void {
	if (!list.length) {
		builder.raw("NIL");
		return;
	}
	builder.raw("(");
	list.forEach(([name, value], index) => {
		if (index) builder.raw(" ");
		builder.string(name).raw(" ").string(value);
	});
	builder.raw(")");
}

function extension(builder: ResponseBuilder, entity: MimeEntity): void {
	const disposition = headerValue(entity.headers, "content-disposition");
	builder.raw(" ");
	if (disposition) {
		const parsed = parseStructuredValue(disposition);
		if (parsed.value) {
			builder.raw("(").string(parsed.value.toLowerCase()).raw(" ");
			params(builder, parsed.params);
			builder.raw(")");
		} else builder.raw("NIL");
	} else builder.raw("NIL");
	builder.raw(" ");
	const language = headerValue(entity.headers, "content-language");
	const languages = language ? language.split(",").map((item) => item.trim()).filter(Boolean) : [];
	if (!languages.length) builder.raw("NIL");
	else if (languages.length === 1) builder.string(languages[0]);
	else {
		builder.raw("(");
		languages.forEach((item, index) => {
			if (index) builder.raw(" ");
			builder.string(item);
		});
		builder.raw(")");
	}
	builder.raw(" ").nstring(headerValue(entity.headers, "content-location") || null);
}

/** Append the body structure of `entity` (a message or a body part). `extensible` selects BODYSTRUCTURE over BODY. */
export function writeBodyStructure(builder: ResponseBuilder, text: string, entity: MimeEntity, extensible: boolean): void {
	builder.raw("(");
	if (entity.children.length) {
		for (const child of entity.children) writeBodyStructure(builder, text, child, extensible);
		builder.raw(" ").string(entity.subtype);
		if (extensible) {
			builder.raw(" ");
			params(builder, entity.params);
			extension(builder, entity);
		}
		builder.raw(")");
		return;
	}
	const size = entity.end - entity.headerEnd;
	builder.string(entity.type).raw(" ").string(entity.subtype).raw(" ");
	params(builder, entity.params);
	builder.raw(" ").nstring(headerValue(entity.headers, "content-id") || null);
	builder.raw(" ").nstring(headerValue(entity.headers, "content-description") || null);
	builder.raw(" ").string((headerValue(entity.headers, "content-transfer-encoding") || "7BIT").toUpperCase());
	builder.raw(` ${size}`);
	if (entity.message) {
		builder.raw(" ");
		writeEnvelope(builder, entity.message.headers);
		builder.raw(" ");
		writeBodyStructure(builder, text, entity.message, extensible);
		builder.raw(` ${countLines(text, entity.headerEnd, entity.end)}`);
	} else if (entity.type === "text") {
		builder.raw(` ${countLines(text, entity.headerEnd, entity.end)}`);
	}
	if (extensible) {
		builder.raw(" ").nstring(headerValue(entity.headers, "content-md5") || null);
		extension(builder, entity);
	}
	builder.raw(")");
}
