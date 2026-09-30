import type { ImapFlags, ImapFolderKey, ImapMessageEntry, ImapPrincipal } from "@/lib/imap/types";

/** One piece of a framed command: a line fragment (bytes as latin1 text) or a literal's octets. */
export type CommandPart = { kind: "text"; text: string } | { kind: "literal"; bytes: Uint8Array };

/** What the framer hands the session: a complete command, a SASL continuation line, or a framing error. */
export type FramedItem =
	| { kind: "command"; parts: CommandPart[] }
	| { kind: "sasl"; line: string }
	| { kind: "error"; tag: string | null; message: string; fatal: boolean };

export type FramerLimits = {
	/** Longest line (excluding literals), in octets. */
	maxLine: number;
	/** Largest total literal octets per command. */
	maxLiteral: number;
	/** Most literals in one command. */
	maxLiterals: number;
};

/** A range of message numbers (sequence numbers or UIDs); `null` stands for `*`. */
export type SequenceRange = { from: number | null; to: number | null };
export type SequenceSet = SequenceRange[];

/** A header list for `HEADER.FIELDS`, uppercased as received. */
export type SectionText =
	| { kind: "header" }
	| { kind: "header.fields"; not: boolean; fields: string[] }
	| { kind: "text" }
	| { kind: "mime" };

export type BodySection = { part: number[]; text: SectionText | null };

export type FetchItem =
	| { kind: "flags" }
	| { kind: "internaldate" }
	| { kind: "rfc822.size" }
	| { kind: "uid" }
	| { kind: "envelope" }
	| { kind: "body" }
	| { kind: "bodystructure" }
	| { kind: "rfc822" }
	| { kind: "rfc822.header" }
	| { kind: "rfc822.text" }
	| { kind: "section"; peek: boolean; section: BodySection; partial: { origin: number; length: number } | null; label: string };

export type SearchKey =
	| { kind: "all" }
	| { kind: "flag"; flag: "seen" | "flagged" | "deleted" | "draft"; value: boolean }
	/** Keys whose answer is fixed because A3 keeps no such state (\Answered, \Recent, keywords). */
	| { kind: "constant"; value: boolean }
	| { kind: "sequence"; set: SequenceSet }
	| { kind: "uid"; set: SequenceSet }
	| { kind: "internaldate"; op: "before" | "on" | "since"; day: number }
	| { kind: "sentdate"; op: "before" | "on" | "since"; day: number }
	| { kind: "size"; op: "larger" | "smaller"; value: number }
	| { kind: "header"; field: string; value: string }
	| { kind: "body"; value: string }
	| { kind: "text"; value: string }
	| { kind: "not"; key: SearchKey }
	| { kind: "or"; left: SearchKey; right: SearchKey }
	| { kind: "and"; keys: SearchKey[] };

/** A message as the selected session knows it. */
export type SnapshotEntry = ImapMessageEntry;

export type SessionPrincipal = Required<Pick<ImapPrincipal, "userId" | "mailboxId" | "appPasswordId">>;

export type SelectedMailbox = {
	key: ImapFolderKey;
	name: string;
	uidValidity: number;
	uidNext: number;
	/** UIDs by sequence number (index + 1). */
	uids: number[];
	/** The highest UID this session has seen; anything above it is new. */
	highestUid: number;
	entries: Map<number, SnapshotEntry>;
	/** UIDs no longer in the folder whose EXPUNGE has not been sent yet. */
	vanished: Set<number>;
};

export type ImapLogEvent = { event: string } & Record<string, string | number | boolean | null | undefined>;

/** What the host (the Node listener, or a future gateway) provides to a session. */
export type ImapSessionHost = {
	/** Queue bytes for the client; resolves once the transport accepted them. */
	write(bytes: Uint8Array): Promise<void>;
	/** Close the connection after pending writes. */
	close(): void;
	/** Stop or resume reading from the client (backpressure). */
	pause(): void;
	resume(): void;
	/** Resolves after `ms`, or early when the session closes. */
	delay(ms: number): Promise<void>;
	log(event: ImapLogEvent): void;
	/** Rate-limit decisions before an authentication attempt; `delayMs` is added before answering. */
	beforeAuthenticate(username: string): { allowed: boolean; delayMs: number };
	/** Record the outcome of an attempt that reached the verifier. */
	afterAuthenticate(username: string, ok: boolean): void;
	/** Claim a per-user session slot once authenticated; false when the user is at the limit. */
	claimUserSlot(userId: string): boolean;
	/** Bound concurrent canonical-object reads across sessions. */
	acquireRead(): Promise<() => void>;
	/** The session has just authenticated (e.g. to switch idle timeouts). */
	onAuthenticated(): void;
};

export type ImapFlagsView = ImapFlags;
