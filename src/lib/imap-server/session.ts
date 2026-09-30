import { getDb } from "@/db";
import { authorizeImapAccess } from "@/lib/imap/access";
import { expungeImapFolder, fetchImapMessage, getImapChangeSignal, getImapFolderStatus, listImapMailboxes, moveImapMessages, openImapFolder, storeImapFlags, trainImapSpamFeedback } from "@/lib/imap/service";
import type { ImapFlagName, ImapFlags, ImapFolderSnapshot, ImapMailbox, ImapMoveResult } from "@/lib/imap/types";
import { ambiguousFolderIds, ImapStateError, imapFolderNameVerdict, STORABLE_FLAGS } from "@/lib/imap/utils";
import { verifyMailAppPassword } from "@/lib/mail-app-passwords/verify";
import { createFolder, deleteFolder, renameFolder } from "@/lib/mailboxes/folder-management";
import { binaryToUtf8 } from "./bytes-utils";
import { formatFlags, MessageView, needsContent, writeFetchResponse } from "./fetch";
import { readFetchItems } from "./fetch-parser";
import { CommandFramer } from "./framer";
import { decodeMailboxName, findMailbox, isInboxName, listMatcher, SPECIAL_USE_ATTRIBUTE, wireName } from "./mailbox-names";
import { metadataKey, sharedMetadataCache, type MetadataCache } from "./metadata-cache";
import { CommandReader, ImapSyntaxError } from "./reader";
import { line, ResponseBuilder, responseText } from "./response";
import { runSearch } from "./search";
import { readSearch, SEARCH_CHARSETS } from "./search-parser";
import { isSequenceSetToken, parseSequenceSet, resolveSequenceNumbers, resolveUids } from "./sequence-set";
import { readStore, type StoreRequest } from "./store-parser";
import type { FetchItem, FramedItem, FramerLimits, ImapSessionHost, SelectedMailbox, SequenceSet, SessionPrincipal } from "./types";

/**
 * One IMAP4rev1 connection (RFC 3501) over A3's mailbox state and A2's mail app
 * passwords. Transport-neutral: the host feeds received octets to receive() and
 * carries written octets to the client; this file uses no Node API.
 *
 * Commands run strictly one at a time, in order. At most MAX_QUEUED_COMMANDS wait behind
 * the running one; beyond that the host is asked to stop reading, so buffered input is
 * bounded by the framer's limits.
 *
 * Every mailbox operation goes through A3, which re-authorizes the principal on each
 * call; the host additionally calls checkAccess() periodically so an idle connection
 * whose access was revoked is closed too.
 *
 * Writes happen only in a mailbox opened with SELECT (EXAMINE is read-only):
 * - \Seen and \Flagged, the product's own read and starred state, through A3's
 *   storeImapFlags: STORE, and the implicit \Seen of a non-PEEK body fetch;
 * - \Deleted, through the same STORE, where A3 lists it among the permanent flags
 *   (management access and bp0003 installed; in Drafts also bp0004, and only on the
 *   principal's own drafts);
 * - EXPUNGE and CLOSE through A3's expungeImapFolder: recoverable (A5.2a, \Deleted messages
 *   move to Trash) everywhere but Trash and Drafts, where they delete permanently (A5.2c,
 *   database rows first, stored objects after the commit, best effort);
 * - UID EXPUNGE (A5.3, RFC 4315): the same expunge, narrowed to the UIDs the client names;
 * - MOVE and UID MOVE (A5.2b, RFC 6851): A3's moveImapMessages, under its special-folder
 *   policy, then the spam training a move into or out of Spam stands for; with UIDPLUS (A5.3)
 *   a committed move reports COPYUID from the destination UIDs the database allocated.
 * - CREATE, RENAME and DELETE (A5.5a) through the R-1 folder-management service, with a strict
 *   IMAP naming policy and DELETE moving the folder's messages to Trash; SUBSCRIBE and
 *   UNSUBSCRIBE are compatibility answers over "every visible mailbox is subscribed".
 * COPY and APPEND are refused before any storage call. UIDPLUS's APPENDUID and COPYUID for COPY are owed only by a successful
 * APPEND or COPY, which do not exist yet.
 *
 * IDLE (A5.4, RFC 2177) waits for DONE while polling the database, never a process-local
 * event: A3's getImapChangeSignal (authority, mailbox revision, UIDVALIDITY) at a jittered
 * interval, the existing refresh when the signal moved, and an unconditional refresh at a
 * slower interval for the IMAP-only state the revision does not cover. See idle().
 */

/** Capabilities before authentication. Each is implemented and tested (tests/imap-listener.test.mjs). */
export const PREAUTH_CAPABILITIES = "IMAP4rev1 SASL-IR AUTH=PLAIN ID";
/** Capabilities once authenticated. Like MOVE, UIDPLUS and IDLE only extend commands of the authenticated states. */
export const AUTH_CAPABILITIES = "IMAP4rev1 ID NAMESPACE UNSELECT SPECIAL-USE MOVE UIDPLUS IDLE";

/** IDLE timing (A5.4). The listener passes its ImapLimits values; these are the defaults. */
export type IdleTiming = {
	/** Change-signal poll interval (authority, revision, UIDVALIDITY), jittered by ±pollJitter. */
	pollMs: number;
	pollJitter: number;
	/** Unconditional refresh of the selected mailbox, for state the revision does not cover; jittered the same way. */
	reconcileMs: number;
	/** `* OK Still here` after this long without any write to the client. */
	keepaliveMs: number;
	/** Authority not confirmed for this long (the database failing while authorizing): BYE. */
	authUncertainMs: number;
	/** No successful poll for longer than this, authority confirmed or not: BYE [UNAVAILABLE]. */
	unavailableMs: number;
};

export const DEFAULT_IDLE_TIMING: IdleTiming = {
	pollMs: 10_000,
	pollJitter: 0.2,
	reconcileMs: 300_000,
	keepaliveMs: 120_000,
	authUncertainMs: 60_000,
	unavailableMs: 120_000,
};

export const MAX_QUEUED_COMMANDS = 16;
export const MAX_LINE = 64 * 1024;
export const PREAUTH_MAX_LITERAL = 1024;
export const AUTH_MAX_LITERAL = 64 * 1024;
export const MAX_LITERALS_PER_COMMAND = 16;
export const MAX_AUTH_FAILURES = 3;
export const AUTH_FAILURE_DELAY_MS = 1000;

const SELECTED_FLAGS = "(\\Seen \\Flagged \\Deleted \\Draft)";
const PERMANENT_FLAG_NAMES: Record<ImapFlagName, string> = { seen: "\\Seen", flagged: "\\Flagged", deleted: "\\Deleted" };
/** Commands that would write and are not available; refused before any storage call. */
const UNSUPPORTED_COMMANDS = new Set(["COPY", "APPEND"]);
const STATUS_ITEMS = new Set(["MESSAGES", "RECENT", "UIDNEXT", "UIDVALIDITY", "UNSEEN"]);
const MAX_ID_PAIRS = 30;

type State = "not-authenticated" | "authenticated" | "selected" | "logout";

/** Ends the connection with `* BYE`: revoked access, a vanished or reset mailbox, or a protocol violation. */
class SessionEnd extends Error {}

export type ImapSessionOptions = {
	/** Product name for the greeting and ID. */
	serverName: string;
	cache?: MetadataCache;
	idle?: Partial<IdleTiming>;
	/** Source of IDLE's jitter, in [0, 1). */
	random?: () => number;
};

/** Receives the line answering a continuation, a framing error in its place, or null when the session closes. */
type ContinuationWaiter = (item: FramedItem | null) => void;

export class ImapSession {
	private state: State = "not-authenticated";
	private principal: SessionPrincipal | null = null;
	private selected: SelectedMailbox | null = null;
	private readonly framer: CommandFramer;
	private readonly queue: FramedItem[] = [];
	private running = false;
	private paused = false;
	private closed = false;
	private failures = 0;
	/** Receives the next continuation line (AUTHENTICATE, IDLE), or a framing error, or null on close. */
	private continuationWaiter: ContinuationWaiter | null = null;
	private readonly cache: MetadataCache;
	private readonly host: ImapSessionHost;
	private readonly idleTiming: IdleTiming;
	private idling = false;
	/** When the last write to the client started, and how many are still pending (keepalive). */
	private lastWriteAt = 0;
	private pendingWrites = 0;

	constructor(
		private readonly env: CloudflareEnv,
		host: ImapSessionHost,
		private readonly options: ImapSessionOptions,
	) {
		// Every write goes through here, so IDLE knows when the client last heard from us and
		// whether a write is still in flight.
		this.host = {
			...host,
			write: (bytes) => {
				this.lastWriteAt = host.now();
				this.pendingWrites += 1;
				return host.write(bytes).finally(() => {
					this.pendingWrites -= 1;
				});
			},
		};
		this.idleTiming = { ...DEFAULT_IDLE_TIMING, ...options.idle };
		this.cache = options.cache ?? sharedMetadataCache;
		this.framer = new CommandFramer(
			() => this.limits(),
			() => void this.host.write(line("+ Ready for literal data")),
		);
	}

	get isAuthenticated(): boolean {
		return this.state === "authenticated" || this.state === "selected";
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** Whether an IDLE command is running. */
	get isIdling(): boolean {
		return this.idling;
	}

	private limits(): FramerLimits {
		return { maxLine: MAX_LINE, maxLiteral: this.isAuthenticated ? AUTH_MAX_LITERAL : PREAUTH_MAX_LITERAL, maxLiterals: MAX_LITERALS_PER_COMMAND };
	}

	async start(): Promise<void> {
		await this.send(`* OK [CAPABILITY ${PREAUTH_CAPABILITIES}] ${responseText(this.options.serverName)} IMAP4rev1 ready`);
	}

	/** Octets from the client. */
	receive(chunk: Uint8Array): void {
		if (this.closed) return;
		this.framer.feed(chunk);
		this.fill();
		void this.pump();
	}

	/** The transport went away: stop all work. */
	transportClosed(): void {
		this.markClosed();
	}

	/**
	 * End the session with `* BYE` (server shutdown, timeouts). The transport is asked to close
	 * right after the BYE is queued, not after it was written: a client that stopped reading
	 * would otherwise keep the session open forever. Closing still delivers queued output first.
	 */
	async end(message: string): Promise<void> {
		if (this.closed) return;
		const bye = this.host.write(line(`* BYE ${responseText(message)}`));
		this.markClosed();
		this.host.close();
		await bye.catch(() => undefined);
	}

	/**
	 * Re-check the authenticated principal against current state (A2/A3 rules: account,
	 * credential, scope, mailbox access). Closes the session when access is gone.
	 */
	async checkAccess(): Promise<boolean> {
		if (!this.principal || this.closed) return true;
		let access;
		try {
			access = await authorizeImapAccess(getDb(this.env), this.principal);
		} catch (error) {
			this.host.log({ event: "access-check.error", error: error instanceof Error ? error.message : String(error) });
			return true;
		}
		if (access) return true;
		this.host.log({ event: "access.revoked" });
		await this.end("Access revoked");
		return false;
	}

	private markClosed(): void {
		this.closed = true;
		this.queue.length = 0;
		const waiter = this.continuationWaiter;
		this.continuationWaiter = null;
		waiter?.(null);
	}

	private fill(): void {
		while (!this.closed && this.queue.length < MAX_QUEUED_COMMANDS) {
			const item = this.framer.next();
			if (!item) break;
			// A command waiting for a continuation line gets it, or the framing error that
			// replaced it (which it hands back to the queue), and nothing else.
			if (this.continuationWaiter && (item.kind === "continuation" || item.kind === "error")) {
				const waiter = this.continuationWaiter;
				this.continuationWaiter = null;
				waiter(item);
				continue;
			}
			this.queue.push(item);
		}
		const full = this.queue.length >= MAX_QUEUED_COMMANDS;
		if (full && !this.paused) {
			this.paused = true;
			this.host.pause();
		} else if (!full && this.paused) {
			this.paused = false;
			this.host.resume();
		}
	}

	private async pump(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			while (!this.closed && this.queue.length) {
				const item = this.queue.shift()!;
				this.fill();
				await this.handle(item);
			}
		} finally {
			this.running = false;
		}
	}

	private async send(text: string): Promise<void> {
		if (!this.closed) await this.host.write(line(text));
	}

	private async handle(item: FramedItem): Promise<void> {
		if (item.kind === "error") {
			if (item.fatal) {
				this.host.log({ event: "protocol.violation", reason: item.message });
				await this.end(item.message);
			} else await this.send(`${item.tag ?? "*"} BAD ${item.message}`);
			return;
		}
		if (item.kind === "continuation") {
			await this.send("* BAD Unexpected continuation");
			return;
		}
		const reader = new CommandReader(item.parts);
		let tag: string;
		try {
			tag = reader.atom("]");
			if (tag.includes("+")) throw new ImapSyntaxError("Invalid tag");
		} catch {
			await this.send("* BAD Invalid tag");
			return;
		}
		let command = "";
		try {
			reader.sp();
			command = reader.keyword();
			if (command === "UID") {
				reader.sp();
				command = `UID ${reader.keyword()}`;
			}
			await this.dispatch(tag, command, reader);
		} catch (error) {
			await this.fail(tag, command, error);
		}
	}

	private async fail(tag: string, command: string, error: unknown): Promise<void> {
		if (error instanceof ImapSyntaxError) {
			await this.send(`${tag} BAD ${responseText(error.message)}`);
		} else if (error instanceof SessionEnd) {
			this.host.log({ event: "session.end", reason: error.message });
			await this.end(error.message);
		} else if (error instanceof ImapStateError && error.code === "forbidden") {
			this.host.log({ event: "access.revoked" });
			await this.end("Access revoked");
		} else if (error instanceof ImapStateError && (error.code === "nonexistent" || error.code === "nonexistent-destination")) {
			await this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
		} else if (error instanceof ImapStateError && error.code === "denied") {
			// A permission this access lacks; the access itself is intact, so the session goes on.
			await this.send(`${tag} NO [NOPERM] ${responseText(error.message)}`);
		} else if (error instanceof ImapStateError && error.code === "unsupported") {
			await this.send(`${tag} NO [CANNOT] ${responseText(error.message)}`);
		} else {
			this.host.log({ event: "command.error", command, error: error instanceof Error ? error.message : String(error) });
			await this.send(`${tag} NO [UNAVAILABLE] Temporary failure, try again later`);
		}
	}

	private async wrongState(tag: string): Promise<void> {
		await this.send(`${tag} BAD Command not valid in this state`);
	}

	private async dispatch(tag: string, command: string, reader: CommandReader): Promise<void> {
		switch (command) {
			case "CAPABILITY":
				reader.end();
				await this.send(`* CAPABILITY ${this.isAuthenticated ? AUTH_CAPABILITIES : PREAUTH_CAPABILITIES}`);
				return this.send(`${tag} OK CAPABILITY completed`);
			case "NOOP":
				reader.end();
				if (this.state === "selected") await this.refresh(true);
				return this.send(`${tag} OK NOOP completed`);
			case "LOGOUT":
				reader.end();
				await this.send("* BYE Logging out");
				await this.send(`${tag} OK LOGOUT completed`);
				this.state = "logout";
				this.markClosed();
				this.host.close();
				return;
			case "ID":
				return this.id(tag, reader);
		}
		if (this.state === "not-authenticated") {
			if (command === "LOGIN") return this.login(tag, reader);
			if (command === "AUTHENTICATE") return this.authenticate(tag, reader);
			return command === "STARTTLS" || !this.isKnown(command) ? this.send(`${tag} BAD Unknown command`) : this.wrongState(tag);
		}
		switch (command) {
			case "LIST":
			case "LSUB":
				return this.list(tag, reader, command === "LSUB");
			case "STATUS":
				return this.status(tag, reader);
			case "SELECT":
			case "EXAMINE":
				return this.select(tag, reader, command);
			case "NAMESPACE":
				reader.end();
				await this.send('* NAMESPACE (("" NIL)) NIL NIL');
				return this.send(`${tag} OK NAMESPACE completed`);
			case "IDLE":
				reader.end();
				return this.idle(tag);
			case "CREATE":
				return this.create(tag, reader);
			case "RENAME":
				return this.rename(tag, reader);
			case "DELETE":
				return this.delete(tag, reader);
			case "SUBSCRIBE":
			case "UNSUBSCRIBE":
				return this.subscribe(tag, reader, command === "SUBSCRIBE");
			case "LOGIN":
			case "AUTHENTICATE":
				return this.wrongState(tag);
		}
		if (UNSUPPORTED_COMMANDS.has(command) || command === "UID COPY") {
			// Refused before any storage call, so nothing A3 holds is touched.
			if (/COPY/.test(command) && this.state !== "selected") return this.wrongState(tag);
			return this.send(`${tag} NO [CANNOT] ${command} is not available on this server`);
		}
		if (this.state !== "selected") return this.isKnown(command) ? this.wrongState(tag) : this.send(`${tag} BAD Unknown command`);
		switch (command) {
			case "CHECK":
				reader.end();
				await this.refresh(true);
				return this.send(`${tag} OK CHECK completed`);
			case "CLOSE":
				reader.end();
				return this.close(tag);
			case "UNSELECT":
				// RFC 3691: like CLOSE, but never expunges.
				reader.end();
				this.selected = null;
				this.state = "authenticated";
				return this.send(`${tag} OK UNSELECT completed`);
			case "EXPUNGE":
				reader.end();
				return this.expunge(tag, null);
			case "UID EXPUNGE":
				return this.uidExpunge(tag, reader);
			case "FETCH":
			case "UID FETCH":
				return this.fetch(tag, reader, command === "UID FETCH");
			case "SEARCH":
			case "UID SEARCH":
				return this.search(tag, reader, command === "UID SEARCH");
			case "STORE":
			case "UID STORE":
				return this.store(tag, reader, command === "UID STORE");
			case "MOVE":
			case "UID MOVE":
				return this.move(tag, reader, command === "UID MOVE");
		}
		return this.send(`${tag} BAD Unknown command`);
	}

	private isKnown(command: string): boolean {
		return ["LIST", "LSUB", "STATUS", "SELECT", "EXAMINE", "NAMESPACE", "CHECK", "CLOSE", "UNSELECT", "FETCH", "UID FETCH", "SEARCH", "UID SEARCH", "LOGIN", "AUTHENTICATE", "STORE", "UID STORE", "COPY", "UID COPY", "MOVE", "UID MOVE", "EXPUNGE", "UID EXPUNGE", "IDLE", "CREATE", "RENAME", "DELETE", "SUBSCRIBE", "UNSUBSCRIBE", ...UNSUPPORTED_COMMANDS].includes(command);
	}

	// ---- any state --------------------------------------------------------------

	private async id(tag: string, reader: CommandReader): Promise<void> {
		reader.sp();
		if (reader.maybe("(")) {
			let pairs = 0;
			if (!reader.maybe(")")) {
				do {
					reader.string();
					reader.sp();
					reader.nstringOrNil();
					if (++pairs > MAX_ID_PAIRS) throw new ImapSyntaxError("Too many ID fields");
				} while (reader.maybe(" "));
				reader.char(")");
			}
		} else if (reader.keyword() !== "NIL") throw new ImapSyntaxError("Expected ID parameters or NIL");
		reader.end();
		await this.host.write(new ResponseBuilder().raw('* ID ("name" ').unicode(this.options.serverName).raw(")\r\n").bytes());
		await this.send(`${tag} OK ID completed`);
	}

	// ---- authentication ---------------------------------------------------------

	private async login(tag: string, reader: CommandReader): Promise<void> {
		reader.sp();
		const username = reader.astring();
		reader.sp();
		const password = reader.astring();
		reader.end();
		await this.tryCredentials(tag, binaryToUtf8(username), binaryToUtf8(password));
	}

	/**
	 * Switch the framer to take the next line raw and wait for it (or a framing error, or null
	 * when the session closes). Call before sending the `+` continuation, so a reply that
	 * arrives while the continuation is still being written cannot be queued as a command.
	 */
	private waitForContinuation(): Promise<FramedItem | null> {
		this.framer.expectContinuationLine();
		return new Promise((resolve) => {
			if (this.closed) return resolve(null);
			this.continuationWaiter = resolve;
			this.fill();
		});
	}

	private async authenticate(tag: string, reader: CommandReader): Promise<void> {
		reader.sp();
		const mechanism = reader.keyword();
		let response: string | null = null;
		if (reader.maybe(" ")) response = reader.atom();
		reader.end();
		if (mechanism !== "PLAIN") {
			await this.send(`${tag} NO Unsupported authentication mechanism`);
			return;
		}
		if (response === null) {
			const reply = this.waitForContinuation();
			await this.send("+ ");
			const item = await reply;
			if (item === null) return;
			if (item.kind !== "continuation") {
				// A framing error instead of the response: handle it as the next item, as usual.
				this.queue.unshift(item);
				return;
			}
			response = item.line;
			if (response === "*") {
				await this.send(`${tag} BAD Authentication cancelled`);
				return;
			}
		}
		let decoded: string;
		if (response === "=") decoded = "";
		else {
			if (!/^[A-Za-z0-9+/]*={0,2}$/.test(response) || response.length % 4 !== 0) {
				await this.send(`${tag} BAD Invalid base64 in authentication response`);
				return;
			}
			decoded = atob(response);
		}
		const fields = decoded.split("\0");
		const [authorization, identity, password] = fields.length === 3 ? fields : ["", "", ""];
		// An authorization identity may only name the authenticating mailbox itself.
		const acceptable = fields.length === 3 && (authorization === "" || authorization.toLowerCase() === identity.toLowerCase());
		await this.tryCredentials(tag, binaryToUtf8(identity), acceptable ? binaryToUtf8(password) : "");
	}

	/**
	 * A2 verification with the `imap` scope, then A3's current-access check. Every failure,
	 * whatever its cause, gets the same answer after the same delay; the cause is logged
	 * without the username, which is often a mistyped password.
	 */
	private async tryCredentials(tag: string, username: string, password: string): Promise<void> {
		const gate = this.host.beforeAuthenticate(username);
		let principal: SessionPrincipal | null = null;
		let reason: string;
		if (gate.delayMs) await this.host.delay(gate.delayMs);
		if (this.closed) return;
		if (gate.allowed) {
			const result = await verifyMailAppPassword(this.env, { username, password, scope: "imap" });
			if (result.ok) {
				const candidate = { userId: result.principal.userId, mailboxId: result.principal.mailboxId, appPasswordId: result.principal.appPasswordId };
				const access = await authorizeImapAccess(getDb(this.env), candidate);
				if (access) principal = candidate;
				reason = access ? "ok" : "mailbox_unreadable";
			} else reason = result.reason;
			this.host.afterAuthenticate(username, principal !== null);
		} else reason = "rate_limited";
		if (this.closed) return;
		if (!principal) {
			this.failures += 1;
			this.host.log({ event: "auth.failure", reason, attempt: this.failures });
			await this.host.delay(AUTH_FAILURE_DELAY_MS);
			if (this.closed) return;
			await this.send(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed`);
			if (this.failures >= MAX_AUTH_FAILURES) await this.end("Too many authentication failures");
			return;
		}
		if (!this.host.claimUserSlot(principal.userId)) {
			this.host.log({ event: "auth.limit", userId: principal.userId });
			await this.send(`${tag} NO [LIMIT] Too many connections for this account`);
			return;
		}
		this.principal = principal;
		this.state = "authenticated";
		this.host.onAuthenticated();
		this.host.log({ event: "auth.success", userId: principal.userId, mailboxId: principal.mailboxId, appPasswordId: principal.appPasswordId });
		await this.send(`${tag} OK [CAPABILITY ${AUTH_CAPABILITIES}] Logged in`);
	}

	// ---- mailboxes --------------------------------------------------------------

	private mailboxes(): Promise<ImapMailbox[]> {
		return listImapMailboxes(this.env, this.principal!);
	}

	private async list(tag: string, reader: CommandReader, subscribed: boolean): Promise<void> {
		reader.sp();
		const reference = reader.astring();
		reader.sp();
		const pattern = reader.listMailbox();
		reader.end();
		const name = subscribed ? "LSUB" : "LIST";
		if (pattern === "" && !subscribed) {
			// The hierarchy delimiter query: this namespace is flat.
			await this.send('* LIST (\\Noselect) NIL ""');
			return this.send(`${tag} OK LIST completed`);
		}
		const matches = listMatcher(reference + pattern);
		for (const mailbox of await this.mailboxes()) {
			const wire = wireName(mailbox);
			if (!matches(wire)) continue;
			const attributes = ["\\Noinferiors"];
			if (!subscribed && mailbox.specialUse) attributes.push(SPECIAL_USE_ATTRIBUTE[mailbox.specialUse]);
			await this.host.write(new ResponseBuilder().raw(`* ${name} (${attributes.join(" ")}) NIL `).string(wire).raw("\r\n").bytes());
		}
		await this.send(`${tag} OK ${name} completed`);
	}

	private async status(tag: string, reader: CommandReader): Promise<void> {
		reader.sp();
		const requested = reader.astring();
		reader.sp();
		reader.char("(");
		const items: string[] = [];
		do {
			const item = reader.keyword();
			if (!STATUS_ITEMS.has(item)) throw new ImapSyntaxError(`Unknown STATUS item ${item}`);
			items.push(item);
			if (items.length > 16) throw new ImapSyntaxError("Too many STATUS items");
		} while (reader.maybe(" "));
		reader.char(")");
		reader.end();
		const mailbox = findMailbox(await this.mailboxes(), requested);
		if (!mailbox) return this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
		const status = await getImapFolderStatus(this.env, this.principal!, mailbox.key);
		const values: Record<string, number> = { MESSAGES: status.messages, RECENT: 0, UIDNEXT: status.uidNext, UIDVALIDITY: status.uidValidity, UNSEEN: status.unseen };
		await this.host.write(new ResponseBuilder().raw("* STATUS ").string(wireName(mailbox)).raw(` (${items.map((item) => `${item} ${values[item]}`).join(" ")})\r\n`).bytes());
		await this.send(`${tag} OK STATUS completed`);
	}

	// ---- mailbox management (A5.5a) ---------------------------------------------

	/**
	 * CREATE, RENAME and DELETE change custom folders through the R-1 folder-management service,
	 * which decides authority (owner, or full_access delegate while sharing is enabled; the mail
	 * app password must still exist with the `imap` scope) and repeats it inside the write. This
	 * layer only resolves names and maps outcomes:
	 *
	 * - New names are decoded from modified UTF-7 and must pass the strict IMAP policy
	 *   (imapFolderNameVerdict): an existing name, a system folder's or INBOX is ALREADYEXISTS; a
	 *   case- or NFC-variant of one, a `<base> (<n>)` shape whose base collides, `*`, `%` or an
	 *   invalid name is CANNOT. The service's strict mode repeats the ASCII case check in SQL.
	 * - A folder to rename or delete is resolved to its id from the current listing, and refused
	 *   (CANNOT) when it is a system folder or its listed name could shift to another folder
	 *   (ambiguousFolderIds): nothing is ever changed through an unstable name.
	 * - DELETE moves the folder's messages to Trash (snoozed ones included) and deletes it, in
	 *   one guarded batch; the folder this session has selected is INUSE.
	 */
	private manager() {
		const principal = this.principal!;
		return { db: getDb(this.env), actor: { userId: principal.userId, appPasswordId: principal.appPasswordId }, mailboxId: principal.mailboxId };
	}

	private static customFolders(mailboxes: ImapMailbox[]): Array<{ id: string; name: string }> {
		return mailboxes.filter((mailbox) => mailbox.folderId !== null).map((mailbox) => ({ id: mailbox.folderId!, name: mailbox.storedName! }));
	}

	/** The refusal for a name that may not become a folder's (or null when it may), excluding folder `except`. */
	private static nameRefusal(name: string, mailboxes: ImapMailbox[], except?: string): string | null {
		const verdict = imapFolderNameVerdict(name, ImapSession.customFolders(mailboxes).filter((folder) => folder.id !== except));
		if (verdict === "invalid") return "NO [CANNOT] Invalid mailbox name";
		if (verdict === "exists") return "NO [ALREADYEXISTS] Mailbox already exists";
		if (verdict === "collides") return "NO [CANNOT] Mailbox name is too similar to an existing mailbox's";
		return null;
	}

	/** Why a listed mailbox may not be renamed or deleted over IMAP, or null when it may. */
	private static unmanageable(mailboxes: ImapMailbox[], mailbox: ImapMailbox, action: string): string | null {
		if (mailbox.folderId === null) return `NO [CANNOT] System mailboxes cannot be ${action}`;
		if (ambiguousFolderIds(ImapSession.customFolders(mailboxes)).has(mailbox.folderId)) return `NO [CANNOT] This folder's name collides with another mailbox's; it cannot be ${action} over IMAP until that is resolved`;
		return null;
	}

	/**
	 * The service answered notFound: the folder went away, or the principal's own access did
	 * (credential or scope revoked, access removed, user or mailbox disabled, sharing off). The
	 * latter ends the session, as lost access does everywhere.
	 */
	private async nonexistentUnlessAccessLost(tag: string): Promise<void> {
		if (!(await authorizeImapAccess(getDb(this.env), this.principal!))) throw new ImapStateError("forbidden", "Mailbox access denied");
		return this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
	}

	/** The service found the name taken at write time: exactly (ALREADYEXISTS) or by a case variant (CANNOT). */
	private async takenAnswer(tag: string, name: string, except?: string): Promise<void> {
		return this.send(`${tag} ${ImapSession.nameRefusal(name, await this.mailboxes(), except) ?? "NO [CANNOT] Mailbox name is too similar to an existing mailbox's"}`);
	}

	private async create(tag: string, reader: CommandReader): Promise<void> {
		reader.sp();
		const requested = reader.astring();
		reader.end();
		if (isInboxName(requested)) return this.send(`${tag} NO [ALREADYEXISTS] Mailbox already exists`);
		const name = decodeMailboxName(requested);
		if (name === null) return this.send(`${tag} NO [CANNOT] Invalid mailbox name`);
		const refusal = ImapSession.nameRefusal(name, await this.mailboxes());
		if (refusal) return this.send(`${tag} ${refusal}`);
		const { db, actor, mailboxId } = this.manager();
		const result = await createFolder(db, actor, mailboxId, name, { strictNames: true });
		switch (result.outcome) {
			case "ok":
				return this.send(`${tag} OK CREATE completed`);
			case "forbidden":
				return this.send(`${tag} NO [NOPERM] This access does not allow managing folders`);
			case "invalidName":
				return this.send(`${tag} NO [CANNOT] Invalid mailbox name`);
			case "alreadyExists":
				return this.takenAnswer(tag, name);
			case "notFound":
				return this.nonexistentUnlessAccessLost(tag);
		}
	}

	private async rename(tag: string, reader: CommandReader): Promise<void> {
		reader.sp();
		const from = reader.astring();
		reader.sp();
		const to = reader.astring();
		reader.end();
		const mailboxes = await this.mailboxes();
		const source = findMailbox(mailboxes, from);
		if (!source) return this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
		const blocked = ImapSession.unmanageable(mailboxes, source, "renamed");
		if (blocked) return this.send(`${tag} ${blocked}`);
		if (isInboxName(to)) return this.send(`${tag} NO [ALREADYEXISTS] Mailbox already exists`);
		const name = decodeMailboxName(to);
		if (name === null) return this.send(`${tag} NO [CANNOT] Invalid mailbox name`);
		if (name === source.storedName) return this.send(`${tag} NO [ALREADYEXISTS] Mailbox already exists`);
		const refusal = ImapSession.nameRefusal(name, mailboxes, source.folderId!);
		if (refusal) return this.send(`${tag} ${refusal}`);
		const { db, actor, mailboxId } = this.manager();
		const result = await renameFolder(db, actor, mailboxId, source.folderId!, name, { strictNames: true });
		switch (result.outcome) {
			case "ok":
				// A selected folder stays selected: the selection is keyed by folder id, not name.
				return this.send(`${tag} OK RENAME completed`);
			case "unchanged":
				return this.send(`${tag} NO [ALREADYEXISTS] Mailbox already exists`);
			case "forbidden":
				return this.send(`${tag} NO [NOPERM] This access does not allow managing folders`);
			case "invalidName":
				return this.send(`${tag} NO [CANNOT] Invalid mailbox name`);
			case "alreadyExists":
				return this.takenAnswer(tag, name, source.folderId!);
			case "notFound":
				return this.nonexistentUnlessAccessLost(tag);
		}
	}

	private async delete(tag: string, reader: CommandReader): Promise<void> {
		reader.sp();
		const requested = reader.astring();
		reader.end();
		const mailboxes = await this.mailboxes();
		const target = findMailbox(mailboxes, requested);
		if (!target) return this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
		const blocked = ImapSession.unmanageable(mailboxes, target, "deleted");
		if (blocked) return this.send(`${tag} ${blocked}`);
		if (this.selected?.key === target.key) return this.send(`${tag} NO [INUSE] The mailbox is selected in this session`);
		const { db, actor, mailboxId } = this.manager();
		const result = await deleteFolder(db, actor, mailboxId, target.folderId!, { removeMessages: true });
		switch (result.outcome) {
			case "ok":
				return this.send(`${tag} OK DELETE completed`);
			case "forbidden":
				return this.send(`${tag} NO [NOPERM] This access does not allow managing folders`);
			case "hasMessages":
				// Only possible through messages of another mailbox still filed there (R-1 refuses to touch those).
				return this.send(`${tag} NO [CANNOT] The mailbox cannot be deleted right now`);
			case "notFound":
				return this.nonexistentUnlessAccessLost(tag);
		}
	}

	/**
	 * SUBSCRIBE and UNSUBSCRIBE (A5.5a compatibility): there is no stored subscription state and
	 * every visible mailbox is subscribed (LSUB lists them all). SUBSCRIBE of a visible mailbox is
	 * therefore true and OK; UNSUBSCRIBE cannot take effect and says so. Reading the mailbox is
	 * enough (a preference, not a change to the mailbox); nothing is written.
	 */
	private async subscribe(tag: string, reader: CommandReader, subscribe: boolean): Promise<void> {
		reader.sp();
		const requested = reader.astring();
		reader.end();
		if (!findMailbox(await this.mailboxes(), requested)) return this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
		if (subscribe) return this.send(`${tag} OK SUBSCRIBE completed`);
		return this.send(`${tag} NO [CANNOT] All mailboxes are always subscribed`);
	}

	private async select(tag: string, reader: CommandReader, command: string): Promise<void> {
		reader.sp();
		const requested = reader.astring();
		reader.end();
		// A failed SELECT leaves no mailbox selected (RFC 3501 §6.3.1).
		this.selected = null;
		this.state = "authenticated";
		const mailbox = findMailbox(await this.mailboxes(), requested);
		if (!mailbox) return this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
		let snapshot: ImapFolderSnapshot;
		try {
			snapshot = await openImapFolder(this.env, this.principal!, mailbox.key);
		} catch (error) {
			if (error instanceof ImapStateError && error.code === "nonexistent") return this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
			throw error;
		}
		const uids = snapshot.messages.map((entry) => entry.uid);
		// What STORE may change here: A3's permanent flags for this access and folder (\Deleted
		// only for managers with bp0003 installed, in Drafts also bp0004). EXAMINE changes nothing.
		const permanent = command === "SELECT" ? STORABLE_FLAGS.filter((flag) => snapshot.mailbox.permanentFlags.includes(flag)) : [];
		const readOnly = permanent.length === 0;
		this.selected = {
			key: mailbox.key,
			name: wireName(mailbox),
			readOnly,
			permanentFlags: permanent,
			uidValidity: snapshot.uidValidity,
			uidNext: snapshot.uidNext,
			uids,
			highestUid: uids.length ? uids[uids.length - 1] : 0,
			entries: new Map(snapshot.messages.map((entry) => [entry.uid, entry])),
			vanished: new Set(),
			idleSignal: null,
			reconcileAt: null,
		};
		this.state = "selected";
		const firstUnseen = snapshot.messages.findIndex((entry) => !entry.flags.seen);
		await this.send(`* FLAGS ${SELECTED_FLAGS}`);
		if (readOnly) await this.send("* OK [PERMANENTFLAGS ()] Read-only mailbox");
		else await this.send(`* OK [PERMANENTFLAGS (${permanent.map((flag) => PERMANENT_FLAG_NAMES[flag]).join(" ")})] Flags permitted`);
		await this.send(`* ${uids.length} EXISTS`);
		await this.send("* 0 RECENT");
		if (firstUnseen >= 0) await this.send(`* OK [UNSEEN ${firstUnseen + 1}] First unseen message`);
		await this.send(`* OK [UIDVALIDITY ${snapshot.uidValidity}] UIDs valid`);
		await this.send(`* OK [UIDNEXT ${snapshot.uidNext}] Predicted next UID`);
		await this.send(`${tag} OK [${readOnly ? "READ-ONLY" : "READ-WRITE"}] ${command} completed`);
	}

	// ---- selected-mailbox snapshot ----------------------------------------------

	/** A3 calls made on behalf of the selected mailbox; its disappearance or lost access ends the session. */
	private async selectedCall<T>(call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (error) {
			if (error instanceof ImapStateError && error.code === "nonexistent") throw new SessionEnd("Selected mailbox no longer exists");
			throw error;
		}
	}

	/**
	 * Bring the session's view of the selected mailbox up to date with A3 and report the
	 * differences: EXPUNGE for messages that left (only when `allowExpunge`, since RFC 3501
	 * §7.4.1 forbids it during FETCH, STORE and SEARCH), EXISTS for new ones, and FLAGS
	 * for changed ones. Sequence numbers only ever exist here.
	 */
	private async refresh(allowExpunge: boolean): Promise<void> {
		const selected = this.selected!;
		const snapshot = await this.selectedCall(() => openImapFolder(this.env, this.principal!, selected.key));
		if (snapshot.uidValidity !== selected.uidValidity) throw new SessionEnd("Mailbox UIDVALIDITY changed, select it again");
		const current = new Map(snapshot.messages.map((entry) => [entry.uid, entry]));
		const out: string[] = [];
		for (const uid of selected.uids) if (!current.has(uid)) selected.vanished.add(uid);
		if (allowExpunge && selected.vanished.size) {
			const kept: number[] = [];
			const expunged: number[] = [];
			selected.uids.forEach((uid, index) => (selected.vanished.has(uid) ? expunged.push(index + 1) : kept.push(uid)));
			// Highest first, so each number is still valid when the client applies it.
			for (let index = expunged.length - 1; index >= 0; index -= 1) out.push(`* ${expunged[index]} EXPUNGE`);
			for (const uid of selected.vanished) selected.entries.delete(uid);
			selected.uids = kept;
			selected.vanished.clear();
		}
		selected.uids.forEach((uid, index) => {
			const next = current.get(uid);
			const previous = selected.entries.get(uid);
			if (!next || !previous) return;
			if (formatFlags(next.flags) !== formatFlags(previous.flags)) out.push(`* ${index + 1} FETCH (FLAGS ${formatFlags(next.flags)})`);
			selected.entries.set(uid, { ...next, rfc822Size: next.rfc822Size ?? previous.rfc822Size });
		});
		let added = false;
		for (const entry of snapshot.messages) {
			if (entry.uid > selected.highestUid) {
				selected.uids.push(entry.uid);
				selected.entries.set(entry.uid, entry);
				selected.highestUid = entry.uid;
				added = true;
			} else if (!selected.entries.has(entry.uid)) {
				// A3 never assigns a UID below one already seen; if it appears to, the view cannot be trusted.
				throw new SessionEnd("Mailbox state changed unexpectedly, select it again");
			}
		}
		if (added) out.push(`* ${selected.uids.length} EXISTS`);
		selected.uidNext = snapshot.uidNext;
		for (const text of out) await this.send(text);
	}

	/** A message's canonical octets through A3; null when the UID is no longer valid. Throws `unavailable`. */
	private async load(uid: number): Promise<Uint8Array | null> {
		const selected = this.selected!;
		const release = await this.host.acquireRead();
		try {
			const content = await this.selectedCall(() => fetchImapMessage(this.env, this.principal!, selected.key, uid));
			if (content) {
				const entry = selected.entries.get(uid);
				if (entry) entry.rfc822Size = content.size;
			}
			return content?.bytes ?? null;
		} finally {
			release();
		}
	}

	private targets(sequenceSet: SequenceSet, uidMode: boolean): Array<{ seq: number; uid: number }> | null {
		const selected = this.selected!;
		if (uidMode) {
			const sequence = new Map(selected.uids.map((uid, index) => [uid, index + 1]));
			return resolveUids(sequenceSet, selected.uids).map((uid) => ({ seq: sequence.get(uid)!, uid }));
		}
		const numbers = resolveSequenceNumbers(sequenceSet, selected.uids.length);
		return numbers && numbers.map((seq) => ({ seq, uid: selected.uids[seq - 1] }));
	}

	private async fetch(tag: string, reader: CommandReader, uidMode: boolean): Promise<void> {
		reader.sp();
		const token = reader.token();
		if (!isSequenceSetToken(token)) throw new ImapSyntaxError("Invalid sequence set");
		const set = parseSequenceSet(token);
		reader.sp();
		let items: FetchItem[] = readFetchItems(reader);
		reader.end();
		if (uidMode && !items.some((item) => item.kind === "uid")) items = [{ kind: "uid" }, ...items];
		await this.refresh(uidMode);
		const selected = this.selected!;
		const targets = this.targets(set, uidMode);
		if (!targets) return this.send(`${tag} BAD Invalid message sequence number`);
		const wantsMetadata = items.some((item) => item.kind === "envelope" || item.kind === "body" || item.kind === "bodystructure");
		const marksSeen = !selected.readOnly && items.some(setsSeen);
		let missing = false;
		let unavailable = false;
		for (const { seq, uid } of targets) {
			if (this.closed) return;
			if (selected.vanished.has(uid)) {
				missing = true;
				continue;
			}
			const entry = selected.entries.get(uid)!;
			const key = metadataKey(this.principal!.mailboxId, selected.key, selected.uidValidity, uid);
			let metadata = this.cache.get(key) ?? null;
			let view: MessageView | null = null;
			try {
				if (needsContent(items, entry.rfc822Size, metadata)) {
					const bytes = await this.load(uid);
					if (this.closed) return;
					if (!bytes) {
						missing = true;
						continue;
					}
					view = new MessageView(bytes);
					if (!metadata && wantsMetadata) {
						metadata = view.metadata();
						this.cache.set(key, metadata);
					}
				}
				let answer = items;
				if (marksSeen && view && !entry.flags.seen) {
					// RFC 3501 §6.4.5: the body was read, so the message is now \Seen, through the
					// same write as STORE. The response carries the resulting FLAGS.
					const flags = (await this.selectedCall(() => storeImapFlags(this.env, this.principal!, selected.key, [uid], { mode: "add", flags: ["seen"] }))).get(uid);
					if (this.closed) return;
					if (!flags) {
						missing = true;
						continue;
					}
					const changed = formatFlags(flags) !== formatFlags(entry.flags);
					entry.flags = flags;
					if (changed && !items.some((item) => item.kind === "flags")) answer = [...items, { kind: "flags" }];
				}
				const response = new ResponseBuilder().raw("* ");
				writeFetchResponse(response, answer, { seq, uid, flags: entry.flags, internalDate: entry.internalDate, knownSize: entry.rfc822Size, metadata, bytes: view?.bytes ?? null }, view, metadata);
				await this.host.write(response.bytes());
			} catch (error) {
				if (error instanceof SessionEnd || (error instanceof ImapStateError && error.code !== "unavailable")) throw error;
				unavailable = true;
				this.host.log({ event: "fetch.message-error", uid, error: error instanceof Error ? error.message : String(error) });
			}
		}
		if (unavailable) return this.send(`${tag} NO [UNAVAILABLE] Some messages could not be read`);
		if (missing) return this.send(`${tag} NO Some of the requested messages no longer exist`);
		await this.send(`${tag} OK ${uidMode ? "UID FETCH" : "FETCH"} completed`);
	}

	/**
	 * STORE and UID STORE (RFC 3501 §6.4.6) over the session's snapshot: sequence numbers
	 * are resolved to UIDs here and A3 changes only messages those UIDs still name in this
	 * folder. Every message changed is answered with its resulting FLAGS unless .SILENT was
	 * asked for; with .SILENT, a message whose resulting flags are not what this STORE alone
	 * would have produced (a concurrent change, or a flag that cannot change) is still reported.
	 */
	private async store(tag: string, reader: CommandReader, uidMode: boolean): Promise<void> {
		const request = readStore(reader);
		const selected = this.selected!;
		if (selected.readOnly) return this.send(`${tag} NO Mailbox is read-only`);
		await this.refresh(uidMode);
		const targets = this.targets(request.set, uidMode);
		if (!targets) return this.send(`${tag} BAD Invalid message sequence number`);
		const live = targets.filter((target) => !selected.vanished.has(target.uid));
		let missing = live.length < targets.length;
		const results = await this.selectedCall(() => storeImapFlags(this.env, this.principal!, selected.key, live.map((target) => target.uid), { mode: request.mode, flags: request.flags }));
		for (const { seq, uid } of live) {
			if (this.closed) return;
			const flags = results.get(uid);
			const entry = selected.entries.get(uid);
			if (!flags || !entry) {
				missing = true;
				continue;
			}
			const expected = formatFlags(applyStore(entry.flags, request, selected.permanentFlags));
			entry.flags = flags;
			if (request.silent && formatFlags(flags) === expected) continue;
			await this.send(`* ${seq} FETCH (${uidMode ? `UID ${uid} ` : ""}FLAGS ${formatFlags(flags)})`);
		}
		if (missing) return this.send(`${tag} NO Some of the requested messages no longer exist`);
		await this.send(`${tag} OK ${uidMode ? "UID STORE" : "STORE"} completed`);
	}

	/**
	 * EXPUNGE (RFC 3501 §6.4.3): A3 moves the messages marked \Deleted to Trash (A5.2a), or in
	 * Trash and Drafts deletes them permanently (A5.2c). The view is refreshed without EXPUNGE
	 * first, so only UIDs this session has announced are candidates, then every message that
	 * has left the folder, by this command or otherwise, is reported with EXPUNGE, highest
	 * sequence number first. A refusal (NOPERM without management access, CANNOT without
	 * bp0003, or in Drafts without bp0004) changes nothing; a chunk refused after earlier
	 * chunks committed still reports what they removed. Object-storage cleanup after a
	 * permanent deletion never affects the answer.
	 *
	 * With `only` (UID EXPUNGE) A3 acts on those UIDs alone; the answer reports, as EXPUNGE
	 * always does, every message that has left the folder.
	 */
	private async expunge(tag: string, only: { uids: number[] } | null): Promise<void> {
		const selected = this.selected!;
		if (selected.readOnly) return this.send(`${tag} NO Mailbox is read-only`);
		await this.refresh(false);
		try {
			await this.selectedCall(() => expungeImapFolder(this.env, this.principal!, selected.key, selected.highestUid, only?.uids));
		} catch (error) {
			// Report whatever earlier chunks moved before answering; a lost session is simply ended.
			if (!(error instanceof SessionEnd || (error instanceof ImapStateError && error.code === "forbidden"))) await this.refresh(true).catch(() => undefined);
			throw error;
		}
		await this.refresh(true);
		await this.send(`${tag} OK ${only ? "UID EXPUNGE" : "EXPUNGE"} completed`);
	}

	/**
	 * UID EXPUNGE (RFC 4315 §2.1), A5.3: EXPUNGE restricted to the messages the UID set names.
	 * The set is resolved against the UIDs this session has announced (a UID it has never
	 * reported, including one above its highest, is never a candidate), after a refresh without
	 * EXPUNGE, so it costs at most one pass over the mailbox whatever range the client sends.
	 * Of those, A3 removes only the ones still marked \Deleted, by the same recoverable or
	 * permanent path as EXPUNGE and with every one of its guards.
	 */
	private async uidExpunge(tag: string, reader: CommandReader): Promise<void> {
		reader.sp();
		const token = reader.token();
		if (!isSequenceSetToken(token)) throw new ImapSyntaxError("Invalid UID set");
		const set = parseSequenceSet(token);
		reader.end();
		const selected = this.selected!;
		if (selected.readOnly) return this.send(`${tag} NO Mailbox is read-only`);
		await this.refresh(false);
		const uids = resolveUids(set, selected.uids).filter((uid) => !selected.vanished.has(uid));
		return this.expunge(tag, { uids });
	}

	/**
	 * CLOSE (RFC 3501 §6.4.2): under SELECT, the same expunge as EXPUNGE (recoverable, or
	 * permanent in Trash and Drafts), without any untagged response, then back to the
	 * authenticated state. Nothing is expunged under EXAMINE, without bp0003 (in Drafts,
	 * bp0004), or for a principal that no longer has management access; those simply close.
	 * If the expunge fails, the mailbox stays selected, the answer is NO and the \Deleted
	 * marks that were not acted on are kept. Lost access ends the session, as everywhere.
	 */
	private async close(tag: string): Promise<void> {
		const selected = this.selected!;
		if (!selected.readOnly) {
			try {
				await this.selectedCall(() => expungeImapFolder(this.env, this.principal!, selected.key, selected.highestUid));
			} catch (error) {
				if (error instanceof SessionEnd || (error instanceof ImapStateError && error.code === "forbidden")) throw error;
				// Not allowed to expunge here (any more): nothing moves and the mailbox simply closes.
				if (!(error instanceof ImapStateError && (error.code === "denied" || error.code === "unsupported"))) {
					this.host.log({ event: "close.expunge-error", error: error instanceof Error ? error.message : String(error) });
					return this.send(`${tag} NO [UNAVAILABLE] Could not expunge, mailbox remains selected`);
				}
			}
		}
		this.selected = null;
		this.state = "authenticated";
		await this.send(`${tag} OK CLOSE completed`);
	}

	/**
	 * MOVE and UID MOVE (RFC 6851), A5.2b. The view is refreshed without EXPUNGE first, so the
	 * set is resolved against exactly the sequence numbers (or UIDs) the client knows; A3 then
	 * moves those messages under its authorization and special-folder policy, one atomic batch
	 * per chunk, and the view is refreshed with EXPUNGE, which reports every message that left
	 * (by this MOVE or otherwise) in the client's sequence space, highest number first, before
	 * the tagged answer. Before those EXPUNGEs, `* OK [COPYUID …]` (A5.3, RFC 4315 and RFC 6851
	 * §4.3) maps each moved source UID to the destination UID the committing batch read back,
	 * in ascending source order; it is sent only for messages that did move, and not at all
	 * when nothing moved or any mapping is unknown (see copyUidData).
	 *
	 * A refusal moves nothing: NOPERM without management access (or for another user's
	 * draft), CANNOT for a destination the policy refuses, NONEXISTENT for an unknown one. A
	 * message that vanished before it could move makes the answer NO, after whatever did
	 * move is reported. Spam training runs only after the move committed; its failure is
	 * logged and does not change the answer.
	 */
	private async move(tag: string, reader: CommandReader, uidMode: boolean): Promise<void> {
		reader.sp();
		const token = reader.token();
		if (!isSequenceSetToken(token)) throw new ImapSyntaxError("Invalid sequence set");
		const set = parseSequenceSet(token);
		reader.sp();
		const requested = reader.astring();
		reader.end();
		const selected = this.selected!;
		if (selected.readOnly) return this.send(`${tag} NO Mailbox is read-only`);
		await this.refresh(false);
		const targets = this.targets(set, uidMode);
		if (!targets) return this.send(`${tag} BAD Invalid message sequence number`);
		const destination = findMailbox(await this.mailboxes(), requested);
		if (!destination) return this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
		const live = targets.filter((target) => !selected.vanished.has(target.uid));
		let result: ImapMoveResult;
		try {
			result = await this.selectedCall(() => moveImapMessages(this.env, this.principal!, selected.key, live.map((target) => target.uid), destination.key));
		} catch (error) {
			// Report whatever earlier chunks moved before answering; a lost session is simply ended.
			if (!(error instanceof SessionEnd || (error instanceof ImapStateError && error.code === "forbidden"))) await this.refresh(true).catch(() => undefined);
			throw error;
		}
		if (result.training && result.moved.length) await this.train(result.moved.map((entry) => entry.messageId), result.training);
		// RFC 6851 §4.3: with UIDPLUS, COPYUID comes in an untagged OK before the EXPUNGEs.
		const copyUid = copyUidData(result.moved);
		if (copyUid) await this.send(`* OK [COPYUID ${copyUid}] Moved`);
		await this.refresh(true);
		if (result.moved.length < targets.length) {
			const stillHere = live.some((target) => !result.moved.some((entry) => entry.uid === target.uid) && selected.entries.has(target.uid));
			return this.send(`${tag} NO ${stillHere ? "Some of the requested messages could not be moved" : "Some of the requested messages no longer exist"}`);
		}
		await this.send(`${tag} OK ${uidMode ? "UID MOVE" : "MOVE"} completed`);
	}

	/** Post-MOVE spam training. The move has committed: a failure here is logged, never answered. */
	private async train(messageIds: string[], classification: "spam" | "ham"): Promise<void> {
		try {
			const failed = await trainImapSpamFeedback(this.env, this.principal!, messageIds, classification);
			for (const { messageId, error } of failed) this.host.log({ event: "move.spam-training-error", messageId, error: error instanceof Error ? error.message : String(error) });
		} catch (error) {
			if (error instanceof ImapStateError && error.code === "forbidden") throw error;
			this.host.log({ event: "move.spam-training-error", error: error instanceof Error ? error.message : String(error) });
		}
	}

	// ---- IDLE -------------------------------------------------------------------

	/**
	 * IDLE (RFC 2177), A5.4, in the authenticated and selected states (EXAMINE included). After
	 * `+ idling` the next line is taken raw by the framer (never parsed as a command):
	 *
	 * - `DONE` (exactly, case-insensitive) ends it with a tagged OK; input after that line is
	 *   framed as usual.
	 * - Any other line ends it with `BAD Expected DONE` and is then run as the next command,
	 *   unless it announces a literal whose octets would follow unannounced: that ends the
	 *   session with BYE, since the stream could not be kept in sync.
	 * - Input the client sent before our `+` (it must wait for it) is accepted only as a
	 *   leading DONE; anything else ends IDLE at once with BAD and is run as usual.
	 *
	 * While idling nothing but the database decides what the client is told (idleLoop). The
	 * server never ends IDLE itself with a tagged answer (a DONE could be on its way): it ends
	 * the session with BYE, as everywhere, for lost access, a vanished or reset mailbox, or
	 * prolonged database failure.
	 */
	private async idle(tag: string): Promise<void> {
		if (this.queue.length || this.framer.midCommand) {
			if (isDone(this.queue[0])) {
				this.queue.shift();
				await this.send("+ idling");
				return this.send(`${tag} OK IDLE completed`);
			}
			return this.send(`${tag} BAD Expected DONE`);
		}
		const reply = this.waitForContinuation();
		const stop = new AbortController();
		let item: FramedItem | null = null;
		void reply.then((value) => {
			item = value;
			stop.abort();
		});
		this.idling = true;
		try {
			await this.send("+ idling");
			await this.idleLoop(stop.signal);
		} finally {
			this.idling = false;
			stop.abort();
		}
		const answer = item as FramedItem | null;
		if (this.closed || answer === null) return;
		if (answer.kind !== "continuation") {
			// A framing error (an overlong line) instead of DONE: handled next, as usual.
			this.queue.unshift(answer);
			return;
		}
		if (/^DONE$/i.test(answer.line)) return this.send(`${tag} OK IDLE completed`);
		await this.send(`${tag} BAD Expected DONE`);
		if (/\{\d+\+?\}$/.test(answer.line)) throw new SessionEnd("Protocol violation: a literal where DONE was expected");
		this.queue.unshift({ kind: "command", parts: [{ kind: "text", text: answer.line }] });
	}

	/**
	 * Until `stop` (DONE arrived) or the session closes: poll the change signal at a jittered
	 * interval, starting at once; send `* OK Still here` when nothing was written for the
	 * keepalive interval and no write is pending. Every wait is a host.delay that `stop` or the
	 * session's close cancels, so nothing keeps running after IDLE ends. Writes are awaited, so
	 * a client that stops reading stalls the loop instead of queueing output.
	 */
	private async idleLoop(stop: AbortSignal): Promise<void> {
		const timing = this.idleTiming;
		const selected = this.selected;
		const health = { authConfirmedAt: this.host.now(), healthyAt: this.host.now() };
		if (selected && selected.reconcileAt === null) selected.reconcileAt = this.host.now() + this.jittered(timing.reconcileMs);
		let nextPoll = this.host.now();
		while (!this.closed && !stop.aborted) {
			const now = this.host.now();
			if (now >= nextPoll) {
				await this.idlePoll(selected, health);
				nextPoll = this.host.now() + this.jittered(timing.pollMs);
				continue;
			}
			const keepaliveAt = this.lastWriteAt + timing.keepaliveMs;
			if (this.pendingWrites === 0 && now >= keepaliveAt) {
				await this.send("* OK Still here");
				continue;
			}
			const wakeAt = this.pendingWrites === 0 ? Math.min(nextPoll, keepaliveAt) : nextPoll;
			await this.host.delay(Math.max(1, wakeAt - now), stop);
		}
	}

	/**
	 * One IDLE poll. A3's getImapChangeSignal re-establishes authority and reads the mailbox
	 * revision and the selected folder's UIDVALIDITY (indexed lookups only). A changed
	 * UIDVALIDITY ends the session; a changed revision, or a due reconciliation, runs the
	 * existing refresh, which reports EXPUNGE, FETCH FLAGS and EXISTS against the session's
	 * snapshot. The signal is read before refreshing and remembered only once the refresh
	 * succeeded, so a change that lands during it is seen by the next poll.
	 *
	 * Failures: lost access (`forbidden`) ends the session with BYE, as does a vanished folder.
	 * Anything else is logged and retried at the next poll, until authority has not been
	 * confirmed for authUncertainMs (BYE: fail closed) or no poll has succeeded for
	 * unavailableMs (BYE [UNAVAILABLE]).
	 */
	private async idlePoll(selected: SelectedMailbox | null, health: { authConfirmedAt: number; healthyAt: number }): Promise<void> {
		const timing = this.idleTiming;
		const now = this.host.now();
		try {
			const signal = await getImapChangeSignal(this.env, this.principal!, selected?.key ?? null);
			health.authConfirmedAt = now;
			if (selected) {
				if (signal.uidValidity !== selected.uidValidity) throw new SessionEnd("Mailbox UIDVALIDITY changed, select it again");
				const previous = selected.idleSignal;
				const reconcile = now >= selected.reconcileAt!;
				if (reconcile || !previous || previous.revision !== signal.revision) {
					await this.refresh(true);
					selected.idleSignal = signal;
					if (reconcile) selected.reconcileAt = this.host.now() + this.jittered(timing.reconcileMs);
				}
			}
			health.healthyAt = now;
		} catch (error) {
			if (error instanceof SessionEnd || (error instanceof ImapStateError && error.code === "forbidden")) throw error;
			if (error instanceof ImapStateError && error.code === "nonexistent") throw new SessionEnd("Selected mailbox no longer exists");
			const unconfirmed = error instanceof ImapStateError && error.code === "unconfirmed";
			// Only a failure while authorizing leaves authority unconfirmed; any later failure came after it was confirmed.
			if (!unconfirmed) health.authConfirmedAt = now;
			this.host.log({ event: "idle.poll-error", unconfirmed, error: error instanceof Error ? error.message : String(error) });
			if (now - health.authConfirmedAt >= timing.authUncertainMs) throw new SessionEnd("Access could not be confirmed");
			if (now - health.healthyAt > timing.unavailableMs) throw new SessionEnd("[UNAVAILABLE] Mailbox state is unavailable");
		}
	}

	/** `ms` scattered by ±pollJitter, so sessions started together do not poll together. */
	private jittered(ms: number): number {
		const random = this.options.random ?? Math.random;
		return Math.max(1, Math.round(ms * (1 + (random() * 2 - 1) * this.idleTiming.pollJitter)));
	}

	private async search(tag: string, reader: CommandReader, uidMode: boolean): Promise<void> {
		reader.sp();
		const parsed = readSearch(reader);
		if (parsed.charset !== null && !(SEARCH_CHARSETS as readonly string[]).includes(parsed.charset)) {
			return this.send(`${tag} NO [BADCHARSET (${SEARCH_CHARSETS.join(" ")})] Unsupported charset`);
		}
		await this.refresh(uidMode);
		const selected = this.selected!;
		const candidates = selected.uids
			.map((uid, index) => ({ seq: index + 1, uid, entry: selected.entries.get(uid)! }))
			.filter((candidate) => !selected.vanished.has(candidate.uid));
		let unavailable = false;
		const matches = await runSearch(
			parsed.key,
			candidates,
			{ count: selected.uids.length, uids: selected.uids },
			async (uid) => {
				try {
					return await this.load(uid);
				} catch (error) {
					if (error instanceof ImapStateError && error.code === "unavailable") {
						unavailable = true;
						return null;
					}
					throw error;
				}
			},
			() => this.closed,
		);
		if (!matches) return;
		await this.send(`* SEARCH${matches.map((match) => ` ${uidMode ? match.uid : match.seq}`).join("")}`);
		if (unavailable) return this.send(`${tag} NO [UNAVAILABLE] Some messages could not be searched`);
		await this.send(`${tag} OK ${uidMode ? "UID SEARCH" : "SEARCH"} completed`);
	}
}

/**
 * `uidvalidity SP source-uids SP destination-uids` for COPYUID (RFC 4315 §3), or null when
 * there is nothing to report or it could not be reported exactly: no message moved, a
 * destination UID the database did not return, or chunks that saw different destination
 * UIDVALIDITY values. `moved` is in ascending source UID order and the two sets correspond
 * position by position. Only ascending runs are written as ranges, so each set expands to
 * exactly the order of the other.
 */
export function copyUidData(moved: ImapMoveResult["moved"]): string | null {
	if (!moved.length) return null;
	const validity = moved[0].destinationUidValidity;
	if (validity === null || moved.some((entry) => entry.destinationUid === null || entry.destinationUidValidity !== validity)) return null;
	return `${validity} ${uidRuns(moved.map((entry) => entry.uid))} ${uidRuns(moved.map((entry) => entry.destinationUid!))}`;
}

/** A UID list as a uid-set, keeping its order: consecutive ascending UIDs become `a:b`. */
function uidRuns(uids: number[]): string {
	const out: string[] = [];
	for (let index = 0; index < uids.length; ) {
		let end = index;
		while (end + 1 < uids.length && uids[end + 1] === uids[end] + 1) end += 1;
		out.push(end > index ? `${uids[index]}:${uids[end]}` : String(uids[index]));
		index = end + 1;
	}
	return out.join(",");
}

/** A framed `DONE` line (IDLE's end), as the framer frames it outside continuation mode. */
function isDone(item: FramedItem | undefined): boolean {
	return item?.kind === "command" && item.parts.length === 1 && item.parts[0].kind === "text" && /^DONE$/i.test(item.parts[0].text);
}

/** FETCH items that set \Seen when fetched (RFC 3501 §6.4.5): BODY[…] without .PEEK, RFC822 and RFC822.TEXT, not RFC822.HEADER. */
function setsSeen(item: FetchItem): boolean {
	return item.kind === "rfc822" || item.kind === "rfc822.text" || (item.kind === "section" && !item.peek);
}

/** The flags a STORE would leave on a message if nothing else changed them; `permanent` are the flags it may change. */
function applyStore(flags: ImapFlags, request: StoreRequest, permanent: readonly ImapFlagName[]): ImapFlags {
	const next = { ...flags };
	for (const flag of permanent) {
		const named = request.flags.includes(flag);
		if (request.mode === "replace") next[flag] = named;
		else if (named) next[flag] = request.mode === "add";
	}
	return next;
}
