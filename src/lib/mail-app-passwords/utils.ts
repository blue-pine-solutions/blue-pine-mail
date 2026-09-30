import type { MailAppPasswordScope } from "./types";

/**
 * Credential format: `bpm_<publicId>_<secret>`, both parts lowercase RFC 4648 base32
 * (a–z, 2–7) so a credential survives being typed on a phone. The 12-character public
 * id (60 bits) finds the row and is safe to display; the 32-character secret carries
 * 160 bits. Only SHA-256 of the whole credential is stored: the secret is random and
 * long, so a slow password hash would add cost without adding strength.
 */
export const CREDENTIAL_PREFIX = "bpm_";
const PUBLIC_ID_LENGTH = 12;
const SECRET_LENGTH = 32;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const CREDENTIAL_PATTERN = new RegExp(`^${CREDENTIAL_PREFIX}([a-z2-7]{${PUBLIC_ID_LENGTH}})_([a-z2-7]{${SECRET_LENGTH}})$`);

export const MAIL_APP_PASSWORD_SCOPES: readonly MailAppPasswordScope[] = ["imap", "smtp"];
export const MAX_MAIL_APP_PASSWORDS_PER_USER = 20;
export const MAX_LABEL_LENGTH = 64;
/** last_used_at is refreshed at most this often, so clients that reconnect constantly do not write on every login. */
export const LAST_USED_RESOLUTION_MS = 60_000;

/** `length` characters, each from one random byte masked to 5 bits (256 is a multiple of 32, so uniform). */
function randomBase32(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = "";
	for (const byte of bytes) out += BASE32[byte & 31];
	return out;
}

export function generateMailAppCredential(): { credential: string; publicId: string } {
	const publicId = randomBase32(PUBLIC_ID_LENGTH);
	return { credential: `${CREDENTIAL_PREFIX}${publicId}_${randomBase32(SECRET_LENGTH)}`, publicId };
}

/** The public id of a well-formed credential, or null. Anything else (a web password, an API key) is rejected here. */
export function parseMailAppCredential(value: string): { publicId: string } | null {
	const match = CREDENTIAL_PATTERN.exec(value);
	return match ? { publicId: match[1] } : null;
}

export function credentialHint(publicId: string): string {
	return `${CREDENTIAL_PREFIX}${publicId}`;
}

export async function hashMailAppCredential(credential: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares two hex digests in time independent of where they differ. */
export function digestsEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return difference === 0;
}

/** A non-empty, de-duplicated, ordered scope list, or null when anything is unknown. */
export function normalizeScopes(value: unknown): MailAppPasswordScope[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	if (!value.every((scope) => typeof scope === "string" && (MAIL_APP_PASSWORD_SCOPES as readonly string[]).includes(scope))) return null;
	return MAIL_APP_PASSWORD_SCOPES.filter((scope) => value.includes(scope));
}

export function parseStoredScopes(json: string): MailAppPasswordScope[] {
	try {
		return normalizeScopes(JSON.parse(json)) ?? [];
	} catch {
		return [];
	}
}

/** Trimmed label of 1–64 characters without control characters, or null. */
export function normalizeLabel(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const label = value.trim();
	if (!label || label.length > MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(label)) return null;
	return label;
}

export function mailboxAddress(localPart: string, hostname: string): string {
	return `${localPart}@${hostname}`.toLowerCase();
}
