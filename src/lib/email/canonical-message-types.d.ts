import type { messages } from "@/db/schema";

export type CanonicalAttachment = {
	filename: string;
	type: string;
	content: ArrayBuffer | Uint8Array;
	disposition: "attachment" | "inline";
	contentId?: string | null;
};

export type CanonicalMessageInput = {
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	date: Date;
	messageId: string;
	inReplyTo?: string | null;
	references?: string[];
	/** One Reply-To address, optionally with a display name. */
	replyTo?: string | null;
	text?: string | null;
	html?: string | null;
	headers?: Record<string, string>;
	attachments: CanonicalAttachment[];
};

/** How a message's representation behaves: stored once, replaced on edit, or generated per read. */
export type CanonicalMessageKind = "immutable" | "draft" | "transient";

export type CanonicalRow = typeof messages.$inferSelect;

/** Where the bytes served for a message came from. */
export type CanonicalSource =
	/** Bytes as received or imported (inbound, import, JMAP Email/import). */
	| "original"
	/** A representation Blue Pine generated and stored earlier. */
	| "stored"
	/** Generated and stored during this read (first read of a legacy message or a changed draft). */
	| "materialized"
	/** Generated for this read only: a queued/failed send, or a stored object that is missing. */
	| "transient";

export type CanonicalMessage = {
	body: ReadableStream | ArrayBuffer;
	size: number;
	source: CanonicalSource;
	key: string | null;
};
