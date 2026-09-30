import type { MailboxPermission, MailboxType } from "@/lib/mailboxes/types";

/** Mail protocols a credential may be used for. Stored as a JSON array, so adding one needs no migration. */
export type MailAppPasswordScope = "imap" | "smtp";

export type MailAppPasswordSummary = {
	id: string;
	label: string;
	mailboxId: string;
	address: string;
	scopes: MailAppPasswordScope[];
	/** `bpm_<publicId>`: identifies the credential without revealing it. */
	hint: string;
	createdAt: string;
	lastUsedAt: string | null;
	/** False while the bound mailbox is disabled or the account can no longer reach it. */
	usable: boolean;
};

export type CreateMailAppPasswordInput = {
	label: string;
	mailboxId: string;
	scopes: MailAppPasswordScope[];
};

/**
 * What a mail protocol layer learns about a verified credential. Authorization is
 * evaluated at verification time from current account and mailbox state; the
 * permission flags let IMAP (read) and submission (send) decide what to allow.
 */
export type MailAppPrincipal = {
	appPasswordId: string;
	userId: string;
	userEmail: string;
	mailboxId: string;
	/** The mailbox address the client logged in with, lowercased. */
	address: string;
	mailboxType: MailboxType;
	isOwner: boolean;
	permission: MailboxPermission;
	canRead: boolean;
	canSendOnBehalf: boolean;
	canSendAs: boolean;
	canManage: boolean;
	scopes: MailAppPasswordScope[];
};

/**
 * Failure reasons. Anything before the secret matched is `invalid_credentials`, so a
 * caller without a valid credential learns nothing about the account. The others are
 * for logs; protocol listeners should answer every failure the same way.
 */
export type MailAppAuthFailure = "invalid_credentials" | "account_disabled" | "mailbox_unavailable" | "scope_not_granted";

export type MailAppAuthResult = { ok: true; principal: MailAppPrincipal } | { ok: false; reason: MailAppAuthFailure };
