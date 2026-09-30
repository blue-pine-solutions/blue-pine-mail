/** Longest folder name, in UTF-16 code units (the web form's and JMAP's existing limit). */
export const MAX_FOLDER_NAME_LENGTH = 80;

/** C0 controls and DEL. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * A folder name as stored, or null when it is not acceptable: not a string, empty after trimming
 * leading and trailing whitespace, longer than MAX_FOLDER_NAME_LENGTH, or containing a control
 * character. Case, Unicode normalization and names shared with system folders are deliberately
 * not constrained here (A5.5 decides them).
 */
export function normalizeFolderName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = value.trim();
	if (!name || name.length > MAX_FOLDER_NAME_LENGTH || CONTROL_CHARACTERS.test(name)) return null;
	return name;
}
