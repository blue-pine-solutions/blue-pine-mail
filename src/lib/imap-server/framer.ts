import { bytesToBinary, concatBytes } from "./bytes-utils";
import type { CommandPart, FramedItem, FramerLimits } from "./types";

const LITERAL_MARKER = /\{(\d{1,10})(\+?)\}$/;
const LF = 0x0a;

/**
 * Splits the client's byte stream into complete commands (RFC 3501 §2.2): lines ending in
 * CRLF, with synchronizing literals (`{n}` CRLF, then n octets after the server's `+`
 * continuation). Everything it holds is bounded by the limits it is asked for: one line,
 * plus the literal octets of the command being assembled.
 *
 * Non-synchronizing literals (`{n+}`, LITERAL+) are not supported and not advertised; a
 * client that sends one anyway is disconnected, since its octets would follow unannounced
 * and could not be told apart from commands.
 *
 * APPEND's message literal (A5.7, when `appendLiterals` is on) is not an ordinary literal and
 * is never subject to the ordinary limits: the framer hands the session an `append` item with
 * the command so far and the announced size, and holds (no continuation, no further framing,
 * nothing consumed) until the session accepts the literal into a buffer of exactly that size
 * (acceptAppend) or refuses it (refuseAppend). Accepted octets go straight into that buffer;
 * the rest of the command line then comes back raw as `append-end`, and framing resumes at the
 * exact next octet. An APPEND's mailbox name may still be an ordinary literal.
 */
export class CommandFramer {
	/** Unconsumed input is `storage[start, end)`; `scanned` octets of it hold no LF. */
	private storage = new Uint8Array(4096);
	private start = 0;
	private end = 0;
	private scanned = 0;
	private parts: CommandPart[] = [];
	private literalRemaining = -1;
	private literalChunks: Uint8Array[] = [];
	private literalTotal = 0;
	private literalCount = 0;
	private continuationPending = false;
	private failed = false;
	/** An `append` item was returned and the session has not decided yet. */
	private held = false;
	/** The accepted APPEND literal's buffer, and how much of it is filled. */
	private sink: Uint8Array | null = null;
	private sinkFilled = 0;
	/** The APPEND literal is complete; the next line is the rest of its command line. */
	private trailerPending = false;

	constructor(
		private readonly limits: () => FramerLimits,
		private readonly onContinuation: () => void,
	) {}

	/**
	 * The next line answers a server continuation (an AUTHENTICATE response, or IDLE's DONE):
	 * it is returned raw, as one `continuation` item, never parsed as a command and never
	 * treated as announcing a literal. The line limit still applies. One line only; framing
	 * is normal again after it.
	 */
	expectContinuationLine(): void {
		this.continuationPending = true;
	}

	/** Whether a command is partly framed (awaiting the rest of a line or a literal's octets). */
	get midCommand(): boolean {
		return this.parts.length > 0 || this.literalRemaining >= 0 || this.held || this.sink !== null || this.trailerPending;
	}

	/** Whether an `append` item awaits the session's decision; nothing is framed meanwhile. */
	get holding(): boolean {
		return this.held;
	}

	/**
	 * Receive the held APPEND's literal into `buffer`, whose length is the announced size. Its
	 * octets are copied there and nowhere else; then the rest of the line becomes `append-end`.
	 */
	acceptAppend(buffer: Uint8Array): void {
		if (!this.held) throw new Error("No APPEND literal is waiting");
		this.held = false;
		this.sink = buffer;
		this.sinkFilled = 0;
		this.completeSink();
	}

	/** Refuse the held APPEND's literal. The client has not been sent a continuation, so it sends no octets for it. */
	refuseAppend(): void {
		if (!this.held) throw new Error("No APPEND literal is waiting");
		this.held = false;
	}

	/** Take received octets. Nothing is interpreted until next() is called, except octets of an accepted APPEND literal. */
	feed(chunk: Uint8Array): void {
		if (this.failed || !chunk.length) return;
		if (this.sink && this.start === this.end) {
			// Nothing is buffered ahead of them, so they go straight into the literal's buffer.
			const take = this.fillSink(chunk);
			if (take < chunk.length) this.append(chunk.subarray(take));
			return;
		}
		this.append(chunk);
	}

	/** Copy as much of `octets` as the APPEND literal still needs; returns how many were taken. */
	private fillSink(octets: Uint8Array): number {
		const sink = this.sink!;
		const take = Math.min(sink.length - this.sinkFilled, octets.length);
		sink.set(octets.subarray(0, take), this.sinkFilled);
		this.sinkFilled += take;
		this.completeSink();
		return take;
	}

	private completeSink(): void {
		if (this.sink && this.sinkFilled === this.sink.length) {
			this.sink = null;
			this.trailerPending = true;
		}
	}

	/** Octets received but not yet framed. */
	get buffered(): number {
		return this.end - this.start;
	}

	/**
	 * The next complete item from the buffered octets, or null when more input is needed.
	 * Pulling one item at a time lets the session stop framing (and stop reading) while
	 * its command queue is full.
	 */
	next(): FramedItem | null {
		while (!this.failed && this.end > this.start) {
			if (this.held) break;
			if (this.sink) {
				this.start += this.fillSink(this.storage.subarray(this.start, this.end));
				continue;
			}
			if (this.literalRemaining >= 0) {
				const take = Math.min(this.literalRemaining, this.end - this.start);
				this.literalChunks.push(this.storage.slice(this.start, this.start + take));
				this.start += take;
				this.literalRemaining -= take;
				if (this.literalRemaining > 0) break;
				this.parts.push({ kind: "literal", bytes: concatBytes(this.literalChunks) });
				this.literalChunks = [];
				this.literalRemaining = -1;
				continue;
			}
			const limits = this.limits();
			const found = this.storage.subarray(this.start + this.scanned, this.end).indexOf(LF);
			if (found < 0) {
				this.scanned = this.end - this.start;
				// A line of exactly maxLine octets may still be waiting for the LF after its CR.
				const pendingCr = this.storage[this.end - 1] === 0x0d ? 1 : 0;
				if (this.scanned - pendingCr > limits.maxLine) return this.fail("Command line too long");
				break;
			}
			const newline = this.start + this.scanned + found;
			const lineEnd = newline > this.start && this.storage[newline - 1] === 0x0d ? newline - 1 : newline;
			if (lineEnd - this.start > limits.maxLine) return this.fail("Command line too long");
			const line = bytesToBinary(this.storage, this.start, lineEnd);
			this.start = newline + 1;
			this.scanned = 0;
			if (this.trailerPending) {
				// Raw: a `{n}` here would be a second message (MULTIAPPEND), which is not supported.
				this.trailerPending = false;
				return { kind: "append-end", trailing: line };
			}
			if (this.continuationPending && this.parts.length === 0) {
				this.continuationPending = false;
				return { kind: "continuation", line };
			}
			const item = this.acceptLine(line, limits);
			if (item) return item;
		}
		if (this.start === this.end) {
			this.start = 0;
			this.end = 0;
		}
		return null;
	}

	/** Convenience for tests and simple hosts: feed, then drain every complete item. */
	push(chunk: Uint8Array): FramedItem[] {
		this.feed(chunk);
		const items: FramedItem[] = [];
		for (let item = this.next(); item; item = this.next()) items.push(item);
		return items;
	}

	/** Append without re-copying what is buffered more than amortized-once. */
	private append(chunk: Uint8Array): void {
		const length = this.end - this.start;
		if (this.end + chunk.length > this.storage.length) {
			const capacity = Math.max(this.storage.length, (length + chunk.length) * 2);
			const next = capacity > this.storage.length ? new Uint8Array(capacity) : this.storage;
			if (next === this.storage) this.storage.copyWithin(0, this.start, this.end);
			else next.set(this.storage.subarray(this.start, this.end));
			this.storage = next;
			this.start = 0;
			this.end = length;
		}
		this.storage.set(chunk, this.end);
		this.end += chunk.length;
	}

	private acceptLine(line: string, limits: FramerLimits): FramedItem | null {
		const marker = LITERAL_MARKER.exec(line);
		if (!marker) {
			this.parts.push({ kind: "text", text: line });
			return this.complete();
		}
		if (marker[2] === "+") return this.fail("Non-synchronizing literals are not supported");
		const size = Number(marker[1]);
		this.parts.push({ kind: "text", text: line.slice(0, marker.index) });
		if (limits.appendLiterals && this.isAppendMessageLiteral()) {
			const parts = this.parts;
			this.reset();
			this.held = true;
			return { kind: "append", parts, size };
		}
		if (this.literalCount + 1 > limits.maxLiterals || this.literalTotal + size > limits.maxLiteral) {
			// The client waits for our continuation before sending the octets, so refusing
			// the command here leaves the stream in sync.
			const tag = this.tag();
			this.reset();
			return { kind: "error", tag, message: "Literal too large", fatal: false };
		}
		this.literalCount += 1;
		this.literalTotal += size;
		this.literalRemaining = size;
		this.onContinuation();
		return null;
	}

	/**
	 * Whether the literal just announced is an APPEND's message: the command is APPEND and its
	 * mailbox name is already there (an earlier literal, or text after the command name).
	 * Otherwise it is the mailbox name itself, an ordinary literal.
	 */
	private isAppendMessageLiteral(): boolean {
		const first = this.parts[0];
		if (first?.kind !== "text") return false;
		const command = /^[^ ]+ APPEND (.*)$/is.exec(first.text);
		return !!command && (this.parts.length > 1 || command[1].trim() !== "");
	}

	private complete(): FramedItem {
		const parts = this.parts;
		this.reset();
		return { kind: "command", parts };
	}

	private tag(): string | null {
		const first = this.parts[0];
		if (!first || first.kind !== "text") return null;
		const tag = first.text.split(" ", 1)[0];
		return /^[\x21-\x7e]+$/.test(tag) && !/[(){%*"\\+]/.test(tag) ? tag : null;
	}

	private reset(): void {
		this.parts = [];
		this.literalChunks = [];
		this.literalRemaining = -1;
		this.literalTotal = 0;
		this.literalCount = 0;
	}

	private fail(message: string): FramedItem {
		this.failed = true;
		this.storage = new Uint8Array(0);
		this.start = this.end = this.scanned = 0;
		const tag = this.tag();
		this.reset();
		return { kind: "error", tag, message, fatal: true };
	}
}
