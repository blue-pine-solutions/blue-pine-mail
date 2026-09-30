import { authFetch } from "@/lib/auth/client";
import type { MailAppPasswordScope, MailAppPasswordSummary } from "./mail-app-passwords-settings-types";

export const MAIL_APP_PASSWORD_SCOPE_OPTIONS: { value: MailAppPasswordScope; label: string; description: string }[] = [
	{ value: "imap", label: "IMAP", description: "Read and organize mail." },
	{ value: "smtp", label: "SMTP", description: "Send mail. Shared mailboxes also need send permission." },
];

async function errorOf(response: Response, fallback: string): Promise<Error> {
	const data = (await response.json().catch(() => ({}))) as { error?: unknown };
	return new Error(typeof data.error === "string" ? data.error : fallback);
}

export async function loadMailAppPasswords(): Promise<MailAppPasswordSummary[]> {
	const response = await authFetch("/api/settings/mail-app-passwords");
	if (!response.ok) throw await errorOf(response, "Could not load mail app passwords");
	return ((await response.json()) as { passwords: MailAppPasswordSummary[] }).passwords;
}

/** Returns the plaintext credential. It is not stored anywhere in the browser. */
export async function createMailAppPasswordRequest(input: { label: string; mailboxId: string; scopes: MailAppPasswordScope[] }): Promise<{ credential: string; password: MailAppPasswordSummary }> {
	const response = await authFetch("/api/settings/mail-app-passwords", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
	if (!response.ok) throw await errorOf(response, "Could not create the mail app password");
	return response.json();
}

export async function revokeMailAppPasswordRequest(id: string): Promise<void> {
	const response = await authFetch(`/api/settings/mail-app-passwords/${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!response.ok) throw await errorOf(response, "Could not revoke the mail app password");
}

export function scopeLabel(scope: MailAppPasswordScope): string {
	return MAIL_APP_PASSWORD_SCOPE_OPTIONS.find((option) => option.value === scope)?.label ?? scope;
}
