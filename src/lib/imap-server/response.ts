import { asciiBytes, binaryToBytes, concatBytes, utf8ToBinary } from "./bytes-utils";

/**
 * Builds one response as octets. Text goes through `raw` (protocol syntax, 7-bit);
 * values go through `string`/`nstring`, which choose a quoted string when the value is
 * short printable 7-bit text and a literal otherwise, so a value can never break framing.
 */
export class ResponseBuilder {
	private chunks: Uint8Array[] = [];
	private text = "";

	raw(text: string): this {
		this.text += text;
		return this;
	}

	/** A byte-string value as a quoted string or literal. NUL is dropped: IMAP4rev1 strings cannot carry it. */
	string(input: string): this {
		const value = input.includes("\0") ? input.replace(/\0/g, "") : input;
		if (value.length <= 1024 && /^[\x20-\x7e]*$/.test(value)) {
			this.text += `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`;
			return this;
		}
		return this.literal(binaryToBytes(value));
	}

	nstring(value: string | null | undefined): this {
		return value === null || value === undefined ? this.raw("NIL") : this.string(value);
	}

	/** A Unicode value, sent as its UTF-8 octets. */
	unicode(value: string): this {
		return this.string(utf8ToBinary(value));
	}

	literal(bytes: Uint8Array): this {
		this.text += `{${bytes.byteLength}}\r\n`;
		this.flush();
		this.chunks.push(bytes);
		return this;
	}

	private flush(): void {
		if (this.text) {
			this.chunks.push(asciiBytes(this.text));
			this.text = "";
		}
	}

	bytes(): Uint8Array {
		this.flush();
		return this.chunks.length === 1 ? this.chunks[0] : concatBytes(this.chunks);
	}
}

/** Text for response lines (`resp-text`): no CR, LF or NUL. */
export function responseText(value: string): string {
	return value.replace(/[\r\n\0]/g, " ");
}

export function line(text: string): Uint8Array {
	return asciiBytes(`${text}\r\n`);
}
