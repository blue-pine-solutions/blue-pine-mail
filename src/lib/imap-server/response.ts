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

	/**
	 * The response as an ordered list of parts to write one after another, without copying large
	 * literals (A5.6): a literal of at least `copyLimit` octets is its own part, the very array it
	 * was given; everything else is joined into parts of protocol text and small values. The
	 * concatenation of the parts is exactly bytes().
	 */
	parts(copyLimit = 64 * 1024): Uint8Array[] {
		this.flush();
		const out: Uint8Array[] = [];
		let pending: Uint8Array[] = [];
		let pendingSize = 0;
		const emit = () => {
			if (pending.length) out.push(pending.length === 1 ? pending[0] : concatBytes(pending));
			pending = [];
			pendingSize = 0;
		};
		for (const chunk of this.chunks) {
			if (chunk.byteLength >= copyLimit) {
				emit();
				out.push(chunk);
				continue;
			}
			if (pendingSize + chunk.byteLength > copyLimit) emit();
			pending.push(chunk);
			pendingSize += chunk.byteLength;
		}
		emit();
		return out;
	}
}

/** Text for response lines (`resp-text`): no CR, LF or NUL. */
export function responseText(value: string): string {
	return value.replace(/[\r\n\0]/g, " ");
}

export function line(text: string): Uint8Array {
	return asciiBytes(`${text}\r\n`);
}
