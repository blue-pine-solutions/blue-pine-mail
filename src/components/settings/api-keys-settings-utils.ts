import { authFetch } from "@/lib/auth/client";
import type { ApiKeyScope } from "@/lib/api/scopes";
import type { ManagedApiKey, McpKeyScope } from "./api-keys-settings-types";

export const MCP_KEY_SCOPES: { value: McpKeyScope; label: string; description: string }[] = [
	{ value: "mcp:read", label: "Read mail", description: "List, search, and read messages." },
	{ value: "mcp:draft", label: "Manage drafts", description: "Create, edit, and discard drafts." },
	{ value: "mcp:organize", label: "Organize mail", description: "Mark messages read and move them." },
	{ value: "mcp:request-send", label: "Request send review", description: "Propose a send that you must confirm in the web app." },
];

export const STANDARD_KEY_SCOPES: { value: ApiKeyScope; label: string; description: string }[] = [
	{ value: "read", label: "Read mail", description: "Read messages through the API." },
	{ value: "send", label: "Send mail", description: "Send messages directly through the API." },
];

async function responseData(response: Response): Promise<{ error?: unknown; key?: string; apiKeys?: ManagedApiKey[] }> {
	return response.json().catch(() => ({}));
}

export function keyPermissions(key: ManagedApiKey): string[] {
	try {
		const scopes: unknown = JSON.parse(key.scopes);
		return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [];
	} catch {
		return [];
	}
}

export async function loadManagedApiKeys(): Promise<ManagedApiKey[]> {
	const response = await authFetch("/api/api-keys");
	const data = await responseData(response);
	if (!response.ok || !data.apiKeys) throw new Error(typeof data.error === "string" ? data.error : "Could not load API keys");
	return data.apiKeys;
}

export async function createManagedApiKey(input: { name: string; mcpAllowed: boolean; scopes: ApiKeyScope[] | McpKeyScope[]; mailboxIds: string[] }): Promise<string> {
	const response = await authFetch(input.mcpAllowed ? "/api/agent/mcp-keys" : "/api/api-keys", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: input.name, scopes: input.scopes, mailboxIds: input.mailboxIds }),
	});
	const data = await responseData(response);
	if (!response.ok || !data.key) throw new Error(typeof data.error === "string" ? data.error : "Could not create API key");
	return data.key;
}

export async function revokeManagedApiKey(id: string): Promise<void> {
	const response = await authFetch(`/api/api-keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!response.ok) {
		const data = await responseData(response);
		throw new Error(typeof data.error === "string" ? data.error : "Could not revoke API key");
	}
}
