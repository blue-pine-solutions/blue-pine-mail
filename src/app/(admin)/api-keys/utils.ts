import type { AdminApiKeyScope } from "@/lib/api/scopes-types";

export const ADMIN_KEY_PERMISSIONS: { value: AdminApiKeyScope; label: string; description: string }[] = [
	{ value: "domains", label: "Manage domains", description: "Add and remove domains, and manage their DNS setup." },
	{ value: "accounts", label: "Manage accounts", description: "Create and update accounts." },
	{ value: "mailboxes", label: "Manage mailboxes", description: "Create, update, and remove mailboxes." },
];

export function parseApiKeyScopes(scopes: string): string[] {
	try {
		const parsed = JSON.parse(scopes);
		return Array.isArray(parsed) ? parsed.filter((scope) => typeof scope === "string") : [];
	} catch {
		return [];
	}
}
