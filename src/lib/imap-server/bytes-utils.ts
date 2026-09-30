/**
 * Byte helpers for the protocol layer. A "byte string" is a JS string holding one octet
 * per character (0–255): the protocol is octet-oriented, and this keeps slicing, searching
 * and literal lengths exact without assuming any character encoding. TextDecoder's
 * "latin1" label is windows-1252 in the Encoding Standard, so it is not used here.
 */

const CHUNK = 0x8000;

export function bytesToBinary(bytes: Uint8Array, start = 0, end = bytes.length): string {
	let out = "";
	for (let index = start; index < end; index += CHUNK) {
		out += String.fromCharCode.apply(null, bytes.subarray(index, Math.min(end, index + CHUNK)) as unknown as number[]);
	}
	return out;
}

export function binaryToBytes(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length);
	for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 0xff;
	return bytes;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** A Unicode string as a byte string of its UTF-8 octets. */
export function utf8ToBinary(value: string): string {
	return bytesToBinary(encoder.encode(value));
}

/** A byte string's octets read as UTF-8 (malformed sequences become U+FFFD). */
export function binaryToUtf8(value: string): string {
	return decoder.decode(binaryToBytes(value));
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
	let length = 0;
	for (const chunk of chunks) length += chunk.byteLength;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export function asciiBytes(value: string): Uint8Array {
	return binaryToBytes(value);
}
