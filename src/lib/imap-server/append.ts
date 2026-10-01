import type { ImapFlagName } from "@/lib/imap/types";
import { LIMITS } from "@/lib/jmap/constants";
import { type CommandReader, ImapSyntaxError } from "./reader";
import { MAX_STORE_FLAGS, readFlag } from "./store-parser";

/**
 * APPEND (A5.7, RFC 3501 §6.3.11): `APPEND SP mailbox [SP flag-list] [SP date-time] SP literal`.
 * The message literal itself never reaches this parser: the framer hands the session the
 * command up to it (an `append` item), and its octets go into a buffer of their own.
 */

/**
 * The largest message APPEND accepts: JMAP's maxSizeUpload, the existing limit for a client
 * turning raw MIME into a draft (Email/import). One value, so the two never diverge.
 */
export const MAX_APPEND_SIZE = LIMITS.maxSizeUpload;

/** How long an accepted APPEND literal may take: a fixed allowance plus a minimum average rate. */
export type AppendTiming = { literalBaseMs: number; literalMinBytesPerSecond: number };

export const DEFAULT_APPEND_TIMING: AppendTiming = { literalBaseMs: 60_000, literalMinBytesPerSecond: 16_384 };

/** The absolute time an accepted literal of `size` octets may take to arrive. */
export function appendLiteralDeadlineMs(size: number, timing: AppendTiming): number {
	return timing.literalBaseMs + Math.ceil((size * 1000) / timing.literalMinBytesPerSecond);
}

export type AppendRequest = {
	mailbox: string;
	/** \Flagged: the draft is starred. */
	flagged: boolean;
	/** \Deleted was named, which APPEND does not set. */
	deleted: boolean;
	/** The optional date-time: INTERNALDATE. */
	internalDate: Date | null;
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * `date-time = DQUOTE date-day-fixed "-" date-month "-" date-year SP time SP zone DQUOTE`,
 * without its quotes: a two-character day (` 7` or `07`), a month name in any case, four
 * digits of year, `hh:mm:ss` and a `±hhmm` zone. Anything else, or a date that does not exist,
 * is a syntax error.
 */
export function parseDateTime(value: string): Date {
	const match = /^( \d|\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value);
	const invalid = () => new ImapSyntaxError("Invalid date-time");
	if (!match) throw invalid();
	const [, dayText, monthText, yearText, hourText, minuteText, secondText, sign, zoneHourText, zoneMinuteText] = match;
	const day = Number(dayText.trim());
	const month = MONTHS.indexOf(monthText.toUpperCase());
	const year = Number(yearText);
	const [hour, minute, second, zoneHour, zoneMinute] = [hourText, minuteText, secondText, zoneHourText, zoneMinuteText].map(Number);
	if (month < 0 || day < 1 || hour > 23 || minute > 59 || second > 59 || zoneMinute > 59) throw invalid();
	const local = new Date(Date.UTC(year, month, day, hour, minute, second));
	// Date.UTC maps years below 100 into the 1900s; setUTCFullYear keeps them literal.
	local.setUTCFullYear(year, month, day);
	if (local.getUTCDate() !== day || local.getUTCMonth() !== month) throw invalid();
	const offsetMinutes = (sign === "-" ? -1 : 1) * (zoneHour * 60 + zoneMinute);
	return new Date(local.getTime() - offsetMinutes * 60_000);
}

/**
 * The APPEND arguments before the message literal, after the command name. The command text
 * ends with the space before the literal, which this consumes; the flags follow STORE's rules
 * (readFlag): \Recent and unknown system flags are BAD, \Answered, \Draft and keywords are
 * accepted and not kept.
 */
export function readAppend(reader: CommandReader): AppendRequest {
	reader.sp();
	const mailbox = reader.astring();
	reader.sp();
	const flags: { flags: ImapFlagName[]; ignored: string[] } = { flags: [], ignored: [] };
	if (reader.maybe("(")) {
		if (!reader.maybe(")")) {
			let count = 0;
			do {
				if (++count > MAX_STORE_FLAGS) throw new ImapSyntaxError("Too many flags");
				readFlag(reader, flags);
			} while (reader.maybe(" "));
			reader.char(")");
		}
		reader.sp();
	}
	let internalDate: Date | null = null;
	if (reader.peek() === '"') {
		internalDate = parseDateTime(reader.quoted());
		reader.sp();
	}
	reader.end();
	return { mailbox, flagged: flags.flags.includes("flagged"), deleted: flags.flags.includes("deleted"), internalDate };
}
