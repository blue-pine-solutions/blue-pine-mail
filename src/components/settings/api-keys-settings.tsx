"use client";

import { useEffect, useState } from "react";
import { useBranding } from "@/components/branding-provider";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { List, ListRow } from "@/components/ui/list";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { McpAgentInstructions } from "@/components/settings/mcp-agent-instructions";
import type { ApiKeyScope } from "@/lib/api/scopes";
import type { ManagedApiKey, McpKeyScope } from "./api-keys-settings-types";
import { createManagedApiKey, keyPermissions, loadManagedApiKeys, MCP_KEY_SCOPES, revokeManagedApiKey, STANDARD_KEY_SCOPES } from "./api-keys-settings-utils";

export function ApiKeysSettings() {
	const { appName } = useBranding();
	const { mailboxes, selectedMailbox } = useSelectedMailbox();
	const [keys, setKeys] = useState<ManagedApiKey[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [revokingId, setRevokingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [mcpAllowed, setMcpAllowed] = useState(false);
	const [createdMcpAllowed, setCreatedMcpAllowed] = useState(false);
	const [standardScopes, setStandardScopes] = useState<ApiKeyScope[]>(["read"]);
	const [mcpScopes, setMcpScopes] = useState<McpKeyScope[]>(["mcp:read"]);
	const [mailboxIds, setMailboxIds] = useState<string[]>([]);
	const [newKey, setNewKey] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const refresh = () => void loadManagedApiKeys().then((items) => { if (!cancelled) { setKeys(items); setError(null); } }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load API keys"); }).finally(() => { if (!cancelled) setLoading(false); });
		refresh();
		window.addEventListener("mailflare:api-keys-changed", refresh);
		return () => { cancelled = true; window.removeEventListener("mailflare:api-keys-changed", refresh); };
	}, []);

	async function create(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const secret = await createManagedApiKey({ name: name.trim(), mcpAllowed, scopes: mcpAllowed ? mcpScopes : standardScopes, mailboxIds });
			setNewKey(secret);
			setCreatedMcpAllowed(mcpAllowed);
			setCopied(false);
			setName("");
			setKeys(await loadManagedApiKeys());
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not create API key");
		} finally { setBusy(false); }
	}

	async function revoke(key: ManagedApiKey) {
		if (!window.confirm(`Revoke “${key.name}”? Apps using this key will lose access immediately.`)) return;
		setRevokingId(key.id);
		setError(null);
		try {
			await revokeManagedApiKey(key.id);
			setKeys((current) => current.filter((item) => item.id !== key.id));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not revoke API key");
		} finally { setRevokingId(null); }
	}

	return <div className="space-y-6">
		<div className="flex items-center justify-between gap-4">
			<h1 className="text-3xl font-medium">API keys</h1>
		<Dialog open={createOpen} onOpenChange={(open) => { if (busy) return; setCreateOpen(open); setError(null); if (open && mailboxIds.length === 0) setMailboxIds([selectedMailbox?.id ?? mailboxes[0]?.id].filter((id): id is string => !!id)); if (!open) { setNewKey(null); setCopied(false); } }}>
			<DialogTrigger asChild><Button type="button"><Plus className="h-4 w-4" />New API key</Button></DialogTrigger>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader><DialogTitle>{newKey ? "API key created" : "Create API key"}</DialogTitle><DialogDescription>{newKey ? "Copy this key now. It will only be shown once." : "Name your key and choose the access it needs."}</DialogDescription></DialogHeader>
		{!newKey && <form onSubmit={(event) => void create(event)} className="space-y-4">
			<div className="space-y-2"><Label htmlFor="managed-key-name">Key name</Label><Input id="managed-key-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="My integration" /></div>
			<label className="flex items-start gap-3 text-sm"><Checkbox checked={mcpAllowed} onChange={(event) => setMcpAllowed(event.target.checked)} /><span><strong>Allow MCP access</strong><span className="mt-1 block text-neutral-500">Use this key with an MCP client. Sending still needs your confirmation in {appName}.</span></span></label>
			<label className={`flex items-start gap-3 text-sm ${mcpAllowed ? "opacity-50" : ""}`}><Checkbox checked={!mcpAllowed && standardScopes.includes("jmap")} disabled={mcpAllowed} onChange={(event) => setStandardScopes((current) => event.target.checked ? [...current, "jmap"] : current.filter((scope) => scope !== "jmap"))} /><span><strong>Allow JMAP access</strong><span className="mt-1 block text-neutral-500">{mcpAllowed ? "JMAP access requires a separate standard API key." : "Read and send mail from a JMAP client."}</span></span></label>
			<fieldset className="space-y-2"><legend className="text-sm font-medium">Permissions</legend>{(mcpAllowed ? MCP_KEY_SCOPES : STANDARD_KEY_SCOPES).map((scope) => <label key={scope.value} className="flex items-start gap-3 py-2 text-sm"><Checkbox checked={mcpAllowed ? mcpScopes.includes(scope.value as McpKeyScope) : standardScopes.includes(scope.value as ApiKeyScope)} onChange={(event) => { if (mcpAllowed) setMcpScopes((current) => event.target.checked ? [...current, scope.value as McpKeyScope] : current.filter((item) => item !== scope.value)); else setStandardScopes((current) => event.target.checked ? [...current, scope.value as ApiKeyScope] : current.filter((item) => item !== scope.value)); }} /><span><strong>{scope.label}</strong><span className="block text-neutral-500">{scope.description}</span></span></label>)}</fieldset>
			<fieldset className="space-y-2"><legend className="text-sm font-medium">Allowed mailboxes</legend>{mailboxes.length === 0 ? <p className="text-sm text-neutral-500">No accessible mailboxes.</p> : mailboxes.map((mailbox) => <label key={mailbox.id} className="flex items-center gap-3 text-sm"><Checkbox checked={mailboxIds.includes(mailbox.id)} onChange={(event) => setMailboxIds((current) => event.target.checked ? [...current, mailbox.id] : current.filter((id) => id !== mailbox.id))} />{mailbox.localPart}@{mailbox.hostname}</label>)}<p className="text-xs text-neutral-500">Aliases share their parent mailbox and are included with it.</p></fieldset>
			<Button type="submit" disabled={busy || !name.trim() || !mailboxIds.length || (mcpAllowed ? !mcpScopes.length : !standardScopes.length)}><KeyRound className="h-4 w-4" />{busy ? "Creating…" : "Create API key"}</Button>
		</form>}
		{newKey && <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50 p-4"><code className="block break-all rounded bg-white p-2 text-xs">{newKey}</code>{createdMcpAllowed && <McpAgentInstructions mode="mail" apiKey={newKey} />}<div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(newKey).then(() => setCopied(true))}><Copy className="h-4 w-4" />{copied ? "Copied" : "Copy key"}</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setCreateOpen(false); setNewKey(null); setCopied(false); }}>Done</Button></div></div>}
		{error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}
			</DialogContent>
		</Dialog>
		</div>
		<p className="text-sm text-neutral-500">Create keys for external apps, choose their permissions and mailboxes, and revoke access here.</p>
		{error && !createOpen && <p role="alert" className="text-sm text-red-600">{error}</p>}
		<section className="space-y-3">
			{loading && <SectionRowSkeleton />}
			{!loading && keys.length === 0 && <p className="rounded-2xl bg-white px-5 py-4 text-sm text-neutral-500">No API keys yet</p>}
			<List>
				{keys.map((key) => <ListRow key={key.id} className="px-5 py-4">
					<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700"><KeyRound className="h-5 w-5" /></span>
					<span className="min-w-0 flex-1 space-y-2">
						<span className="flex min-w-0 flex-wrap items-center gap-2"><strong className="truncate text-sm font-semibold text-neutral-900">{key.name}</strong>{key.kind === "mcp" && <Badge variant="outline">MCP</Badge>}</span>
						<span className="block truncate no-font-mono text-sm text-neutral-500">{key.prefix}… · Created {new Date(key.createdAt).toLocaleDateString()}{key.lastUsedAt ? ` · Last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : " · Never used"}</span>
						<span className="flex flex-wrap gap-1">{keyPermissions(key).map((scope) => <Badge key={scope} variant="outline">{scope}</Badge>)}</span>
						<span className="block text-xs text-neutral-500">Mailboxes: {key.mailboxScopeEnabled || key.kind === "mcp" ? key.mailboxIds.map((id) => { const mailbox = mailboxes.find((item) => item.id === id); return mailbox ? `${mailbox.localPart}@${mailbox.hostname}` : id; }).join(", ") || "None" : "All accessible mailboxes (existing key)"}</span>
					</span>
					<Button type="button" size="sm" variant="outline" disabled={revokingId === key.id} onClick={() => void revoke(key)}><Trash2 className="h-4 w-4" />{revokingId === key.id ? "Revoking…" : "Revoke"}</Button>
				</ListRow>)}
			</List>
		</section>
	</div>;
}
