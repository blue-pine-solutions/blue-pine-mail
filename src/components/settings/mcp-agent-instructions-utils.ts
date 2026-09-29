import type { McpAgentInstructionsProps } from "./mcp-agent-instructions-types";

export function buildMcpAgentPrompt(origin: string, { mode, apiKey }: McpAgentInstructionsProps, appName: string): string {
	const serverUrl = `${origin || "https://your-mail-domain"}/mcp`;
	const instructions = mode === "mail"
		? `Call list_mailboxes to find the mailboxes this key can access. Use only the tools and mailbox IDs returned by this server. Sending mail requires a review request and confirmation in ${appName}.`
		: "Use only the admin management tools and permissions exposed by this key. This key cannot read or send mail.";

	return `Connect to my ${appName} MCP server using these settings:\nServer URL: ${serverUrl}\nTransport: Streamable HTTP\nAuthorization header: Bearer ${apiKey}\n\n${instructions}\nDo not print the API key in your replies or logs. If you cannot configure the MCP connection directly, tell me which settings to enter in my client.`;
}
