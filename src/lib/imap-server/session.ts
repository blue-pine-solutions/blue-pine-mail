import { getDb } from "@/db";
import { authorizeImapAccess } from "@/lib/imap/access";
import { fetchImapMessage, getImapFolderStatus, listImapMailboxes, openImapFolder } from "@/lib/imap/service";
import type { ImapFolderSnapshot, ImapMailbox } from "@/lib/imap/types";
import { ImapStateError } from "@/lib/imap/utils";
import { verifyMailAppPassword } from "@/lib/mail-app-passwords/verify";
import { binaryToUtf8 } from "./bytes-utils";
import { formatFlags, MessageView, needsContent, writeFetchResponse } from "./fetch";
import { readFetchItems } from "./fetch-parser";
import { CommandFramer } from "./framer";
import { findMailbox, listMatcher, SPECIAL_USE_ATTRIBUTE, wireName } from "./mailbox-names";
import { metadataKey, sharedMetadataCache, type MetadataCache } from "./metadata-cache";
import { CommandReader, ImapSyntaxError } from "./reader";
import { line, ResponseBuilder, responseText } from "./response";
import { runSearch } from "./search";
import { readSearch, SEARCH_CHARSETS } from "./search-parser";
import { isSequenceSetToken, parseSequenceSet, resolveSequenceNumbers, resolveUids } from "./sequence-set";
import type { FetchItem, FramedItem, FramerLimits, ImapSessionHost, SelectedMailbox, SequenceSet, SessionPrincipal } from "./types";

/**
 * One IMAP4rev1 connection (RFC 3501), read-only, over A3's mailbox state and A2's mail
 * app passwords. Transport-neutral: the host feeds received octets to receive() and
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
 * Nothing here changes user-visible state: SELECT and EXAMINE both open the mailbox
 * read-only, BODY[] and RFC822 fetches do not set \Seen, and commands that would write
 * are refused before any storage call.
 */

/** Capabilities before authentication. Each is implemented and tested (tests/imap-listener.test.mjs). */
export const PREAUTH_CAPABILITIES = "IMAP4rev1 SASL-IR AUTH=PLAIN ID";
/** Capabilities once authenticated. */
export const AUTH_CAPABILITIES = "IMAP4rev1 ID NAMESPACE UNSELECT SPECIAL-USE";

export const MAX_QUEUED_COMMANDS = 16;
export const MAX_LINE = 64 * 1024;
export const PREAUTH_MAX_LITERAL = 1024;
export const AUTH_MAX_LITERAL = 64 * 1024;
export const MAX_LITERALS_PER_COMMAND = 16;
export const MAX_AUTH_FAILURES = 3;
export const AUTH_FAILURE_DELAY_MS = 1000;

const SELECTED_FLAGS = "(\\Seen \\Flagged \\Deleted \\Draft)";
const READ_ONLY_COMMANDS = new Set(["STORE", "COPY", "EXPUNGE", "APPEND", "CREATE", "DELETE", "RENAME", "SUBSCRIBE", "UNSUBSCRIBE"]);
const STATUS_ITEMS = new Set(["MESSAGES", "RECENT", "UIDNEXT", "UIDVALIDITY", "UNSEEN"]);
const MAX_ID_PAIRS = 30;

type State = "not-authenticated" | "authenticated" | "selected" | "logout";

/** Ends the connection with `* BYE`: revoked access, a vanished or reset mailbox, or a protocol violation. */
class SessionEnd extends Error {}

export type ImapSessionOptions = {
	/** Product name for the greeting and ID. */
	serverName: string;
	cache?: MetadataCache;
};

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
	private saslWaiter: ((line: string | null) => void) | null = null;
	private readonly cache: MetadataCache;

	constructor(
		private readonly env: CloudflareEnv,
		private readonly host: ImapSessionHost,
		private readonly options: ImapSessionOptions,
	) {
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

	private limits(): FramerLimits {
		return { maxLine: MAX_LINE, maxLiteral: this.isAuthenticated ? AUTH_MAX_LITERAL : PREAUTH_MAX_LITERAL, maxLiterals: MAX_LITERALS_PER_COMMAND };
	}

	async start(): Promise<void> {
		await this.send(`* OK [CAPABILITY ${PREAUTH_CAPABILITIES}] ${responseText(this.options.serverName)} IMAP4rev1 ready (read-only)`);
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

	/** End the session with `* BYE` (server shutdown, timeouts). */
	async end(message: string): Promise<void> {
		if (this.closed) return;
		const bye = this.host.write(line(`* BYE ${responseText(message)}`));
		this.markClosed();
		await bye.catch(() => undefined);
		this.host.close();
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
		const waiter = this.saslWaiter;
		this.saslWaiter = null;
		waiter?.(null);
	}

	private fill(): void {
		while (!this.closed && this.queue.length < MAX_QUEUED_COMMANDS) {
			const item = this.framer.next();
			if (!item) break;
			if (item.kind === "sasl" && this.saslWaiter) {
				const waiter = this.saslWaiter;
				this.saslWaiter = null;
				waiter(item.line);
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
		if (item.kind === "sasl") {
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
		} else if (error instanceof ImapStateError && error.code === "nonexistent") {
			await this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
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
			case "LOGIN":
			case "AUTHENTICATE":
				return this.wrongState(tag);
		}
		if (READ_ONLY_COMMANDS.has(command) || command === "UID STORE" || command === "UID COPY") {
			// Refused before any storage call, so nothing A3 holds is touched.
			if (/STORE|COPY|EXPUNGE/.test(command) && this.state !== "selected") return this.wrongState(tag);
			return this.send(`${tag} NO [CANNOT] ${command} is not available: this server is read-only`);
		}
		if (this.state !== "selected") return this.isKnown(command) ? this.wrongState(tag) : this.send(`${tag} BAD Unknown command`);
		switch (command) {
			case "CHECK":
				reader.end();
				await this.refresh(true);
				return this.send(`${tag} OK CHECK completed`);
			case "CLOSE":
			case "UNSELECT":
				// Read-only: CLOSE never expunges.
				reader.end();
				this.selected = null;
				this.state = "authenticated";
				return this.send(`${tag} OK ${command} completed`);
			case "FETCH":
			case "UID FETCH":
				return this.fetch(tag, reader, command === "UID FETCH");
			case "SEARCH":
			case "UID SEARCH":
				return this.search(tag, reader, command === "UID SEARCH");
		}
		return this.send(`${tag} BAD Unknown command`);
	}

	private isKnown(command: string): boolean {
		return ["LIST", "LSUB", "STATUS", "SELECT", "EXAMINE", "NAMESPACE", "CHECK", "CLOSE", "UNSELECT", "FETCH", "UID FETCH", "SEARCH", "UID SEARCH", "LOGIN", "AUTHENTICATE", "STORE", "UID STORE", "COPY", "UID COPY", "EXPUNGE", ...READ_ONLY_COMMANDS].includes(command);
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

	private waitForSasl(): Promise<string | null> {
		return new Promise((resolve) => {
			this.saslWaiter = resolve;
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
			this.framer.expectSaslLine();
			await this.send("+ ");
			response = await this.waitForSasl();
			if (response === null) return;
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
		await this.send(`${tag} OK [CAPABILITY ${AUTH_CAPABILITIES}] Logged in (read-only)`);
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
		this.selected = {
			key: mailbox.key,
			name: wireName(mailbox),
			uidValidity: snapshot.uidValidity,
			uidNext: snapshot.uidNext,
			uids,
			highestUid: uids.length ? uids[uids.length - 1] : 0,
			entries: new Map(snapshot.messages.map((entry) => [entry.uid, entry])),
			vanished: new Set(),
		};
		this.state = "selected";
		const firstUnseen = snapshot.messages.findIndex((entry) => !entry.flags.seen);
		await this.send(`* FLAGS ${SELECTED_FLAGS}`);
		await this.send("* OK [PERMANENTFLAGS ()] Read-only mailbox");
		await this.send(`* ${uids.length} EXISTS`);
		await this.send("* 0 RECENT");
		if (firstUnseen >= 0) await this.send(`* OK [UNSEEN ${firstUnseen + 1}] First unseen message`);
		await this.send(`* OK [UIDVALIDITY ${snapshot.uidValidity}] UIDs valid`);
		await this.send(`* OK [UIDNEXT ${snapshot.uidNext}] Predicted next UID`);
		await this.send(`${tag} OK [READ-ONLY] ${command} completed`);
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
				const response = new ResponseBuilder().raw("* ");
				writeFetchResponse(response, items, { seq, uid, flags: entry.flags, internalDate: entry.internalDate, knownSize: entry.rfc822Size, metadata, bytes: view?.bytes ?? null }, view, metadata);
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
