"use client";

import { useEffect, useState } from "react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { List, ListRow } from "@/components/ui/list";
import { Select } from "@/components/ui/select";
import type { MailAppPasswordScope, MailAppPasswordSummary } from "./mail-app-passwords-settings-types";
import { createMailAppPasswordRequest, loadMailAppPasswords, MAIL_APP_PASSWORD_SCOPE_OPTIONS, revokeMailAppPasswordRequest, scopeLabel } from "./mail-app-passwords-settings-utils";

/**
 * Settings > App passwords: per-mailbox passwords for mail apps using IMAP and SMTP.
 * The credential is shown once, in the creation dialog, and is never retrievable again.
 */
export function MailAppPasswordsSettings() {
	const { mailboxes, selectedMailbox } = useSelectedMailbox();
	const [passwords, setPasswords] = useState<MailAppPasswordSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [label, setLabel] = useState("");
	const [mailboxId, setMailboxId] = useState("");
	const [scopes, setScopes] = useState<MailAppPasswordScope[]>(["imap", "smtp"]);
	const [created, setCreated] = useState<{ credential: string; address: string } | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const [revokingId, setRevokingId] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		loadMailAppPasswords()
			.then((items) => { if (!cancelled) setPasswords(items); })
			.catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load mail app passwords"); })
			.finally(() => { if (!cancelled) setLoading(false); });
		return () => { cancelled = true; };
	}, []);

	function openChange(next: boolean) {
		if (busy) return;
		setOpen(next);
		setError(null);
		if (next) {
			setLabel("");
			setScopes(["imap", "smtp"]);
			setMailboxId(selectedMailbox?.id ?? mailboxes[0]?.id ?? "");
		} else {
			// Drop the plaintext as soon as the dialog closes.
			setCreated(null);
			setCopied(null);
		}
	}

	async function create(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const result = await createMailAppPasswordRequest({ label: label.trim(), mailboxId, scopes });
			setCreated({ credential: result.credential, address: result.password.address });
			setPasswords((current) => [result.password, ...current]);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not create the mail app password");
		} finally {
			setBusy(false);
		}
	}

	async function revoke(password: MailAppPasswordSummary) {
		if (!window.confirm(`Revoke “${password.label}”? Mail apps using it will stop signing in.`)) return;
		setRevokingId(password.id);
		setError(null);
		try {
			await revokeMailAppPasswordRequest(password.id);
			setPasswords((current) => current.filter((item) => item.id !== password.id));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not revoke the mail app password");
		} finally {
			setRevokingId(null);
		}
	}

	function copy(name: string, value: string) {
		void navigator.clipboard.writeText(value).then(() => setCopied(name));
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<p className="max-w-xl text-sm text-neutral-500">
					Mail apps that use IMAP and SMTP sign in with the mailbox address and a password made for that mailbox, never your account password. Changing your account password revokes them all. IMAP and SMTP access is not available on this server yet.
				</p>
				<Dialog open={open} onOpenChange={openChange}>
					<DialogTrigger asChild>
						<Button type="button" disabled={mailboxes.length === 0}>
							<Plus className="h-4 w-4" />
							New mail app password
						</Button>
					</DialogTrigger>
					<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
						<DialogHeader>
							<DialogTitle>{created ? "Mail app password created" : "Create mail app password"}</DialogTitle>
							<DialogDescription>{created ? "Copy it now. It will not be shown again." : "Choose the mailbox the mail app will use and what it may do."}</DialogDescription>
						</DialogHeader>
						{created ? (
							<div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50 p-4">
								<CredentialField name="Username" value={created.address} copied={copied} onCopy={copy} />
								<CredentialField name="Password" value={created.credential} copied={copied} onCopy={copy} />
								<Button type="button" size="sm" variant="ghost" onClick={() => openChange(false)}>Done</Button>
							</div>
						) : (
							<form onSubmit={(event) => void create(event)} className="space-y-4">
								<div className="space-y-2">
									<Label htmlFor="mail-app-password-label">Name</Label>
									<Input id="mail-app-password-label" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={64} placeholder="Phone" />
								</div>
								<div className="space-y-2">
									<Label htmlFor="mail-app-password-mailbox">Mailbox</Label>
									<Select id="mail-app-password-mailbox" containerClassName="w-full py-2" value={mailboxId} onChange={(event) => setMailboxId(event.target.value)}>
										{mailboxes.map((mailbox) => (
											<option key={mailbox.id} value={mailbox.id}>
												{mailbox.localPart}@{mailbox.hostname}{mailbox.type === "shared" ? " (shared)" : ""}
											</option>
										))}
									</Select>
								</div>
								<fieldset className="space-y-2">
									<legend className="text-sm font-medium">Allowed for</legend>
									{MAIL_APP_PASSWORD_SCOPE_OPTIONS.map((option) => (
										<label key={option.value} className="flex items-start gap-3 py-1 text-sm">
											<Checkbox checked={scopes.includes(option.value)} onChange={(event) => setScopes((current) => (event.target.checked ? [...current, option.value] : current.filter((scope) => scope !== option.value)))} />
											<span><strong>{option.label}</strong><span className="block text-neutral-500">{option.description}</span></span>
										</label>
									))}
								</fieldset>
								<Button type="submit" disabled={busy || !label.trim() || !mailboxId || scopes.length === 0}>
									<KeyRound className="h-4 w-4" />
									{busy ? "Creating…" : "Create mail app password"}
								</Button>
							</form>
						)}
						{error && open && <p role="alert" className="text-sm text-red-600">{error}</p>}
					</DialogContent>
				</Dialog>
			</div>
			{error && !open && <p role="alert" className="text-sm text-red-600">{error}</p>}
			{loading && <SectionRowSkeleton />}
			{!loading && passwords.length === 0 && <p className="rounded-2xl bg-neutral-50 px-5 py-4 text-sm text-neutral-500">No mail app passwords yet</p>}
			<List>
				{passwords.map((password) => (
					<ListRow key={password.id} className="px-5 py-4">
						<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700"><KeyRound className="h-5 w-5" /></span>
						<span className="min-w-0 flex-1 space-y-1">
							<span className="flex min-w-0 flex-wrap items-center gap-2">
								<strong className="truncate text-sm font-semibold text-neutral-900">{password.label}</strong>
								{password.scopes.map((scope) => <Badge key={scope} variant="outline">{scopeLabel(scope)}</Badge>)}
								{!password.usable && <Badge variant="outline">Unavailable</Badge>}
							</span>
							<span className="block truncate text-sm text-neutral-500">{password.address}</span>
							<span className="block truncate text-xs text-neutral-500">
								{password.hint}… · Created {new Date(password.createdAt).toLocaleDateString()}
								{password.lastUsedAt ? ` · Last used ${new Date(password.lastUsedAt).toLocaleString()}` : " · Never used"}
							</span>
						</span>
						<Button type="button" size="sm" variant="outline" disabled={revokingId === password.id} onClick={() => void revoke(password)}>
							<Trash2 className="h-4 w-4" />
							{revokingId === password.id ? "Revoking…" : "Revoke"}
						</Button>
					</ListRow>
				))}
			</List>
		</div>
	);
}

function CredentialField({ name, value, copied, onCopy }: { name: string; value: string; copied: string | null; onCopy: (name: string, value: string) => void }) {
	return (
		<div className="space-y-1">
			<span className="text-xs font-medium uppercase tracking-wide text-neutral-500">{name}</span>
			<div className="flex items-center gap-2">
				<code className="min-w-0 flex-1 break-all rounded bg-white p-2 font-mono text-xs">{value}</code>
				<Button type="button" size="sm" variant="outline" onClick={() => onCopy(name, value)} aria-label={`Copy ${name.toLowerCase()}`}>
					<Copy className="h-4 w-4" />
					{copied === name ? "Copied" : "Copy"}
				</Button>
			</div>
		</div>
	);
}
