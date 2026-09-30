import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, spamFeedback } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { buildFingerprint, prepareSpamContent, tokenizeMessage } from "./tokenizer";
import { getReputationKeys } from "./analyzers/reputation";
import type { ReputationKey, SpamClassification } from "./types";
import { TOKENIZER_VERSION } from "./weights";

type MessageRow = typeof messages.$inferSelect;
type FeedbackRow = typeof spamFeedback.$inferSelect;

/**
 * The statements that train a mailbox's filter with one message: token and reputation
 * counts for `classification` (undoing `previous`'s, if the message was trained the other
 * way before) and the spam_feedback record. They do not change the message itself, so a
 * caller that moves it does so separately.
 *
 * Every statement is guarded by the spam_feedback record still being what `previous` was
 * read as, so run as one batch, the training applies exactly once: a concurrent or repeated
 * training of the same message that committed first turns this batch into a no-op.
 */
export function spamTrainingStatements(env: CloudflareEnv, message: MessageRow & { mailboxId: string }, previous: FeedbackRow | undefined, actorUserId: string, classification: SpamClassification): D1PreparedStatement[] {
	const parsed = {
		subject: message.subject, text: message.textBody, html: message.htmlBody,
		messageId: message.providerMessageId, fromAddr: message.fromAddr, toAddr: message.toAddr,
		ccAddr: message.ccAddr, bccAddr: message.bccAddr, inReplyTo: message.inReplyTo,
		references: message.references?.split(/\s+/).filter(Boolean) ?? [], date: message.createdAt,
		attachments: [],
	};
	const prepared = prepareSpamContent(parsed);
	const tokens = previous ? JSON.parse(previous.trainingTokens) as string[] : tokenizeMessage(parsed, prepared);
	const keys = previous ? JSON.parse(previous.reputationKeys) as ReputationKey[] : getReputationKeys(parsed, buildFingerprint(parsed, prepared));
	const now = Math.floor(Date.now() / 1000);
	const unchanged = previous
		? { sql: "EXISTS (SELECT 1 FROM spam_feedback WHERE message_id = ? AND classification = ?)", params: [message.id, previous.classification] }
		: { sql: "NOT EXISTS (SELECT 1 FROM spam_feedback WHERE message_id = ?)", params: [message.id] };
	const statements: D1PreparedStatement[] = [];
	const addCounts = (target: SpamClassification, amount: 1 | -1) => {
		for (const token of tokens) statements.push(env.DB.prepare(`INSERT INTO spam_token_stats (mailbox_id, token, spam_count, ham_count, updated_at) SELECT ?, ?, ?, ?, ? WHERE ${unchanged.sql} ON CONFLICT(mailbox_id, token) DO UPDATE SET spam_count = MAX(0, spam_count + excluded.spam_count), ham_count = MAX(0, ham_count + excluded.ham_count), updated_at = excluded.updated_at`).bind(message.mailboxId, token, target === "spam" ? amount : 0, target === "ham" ? amount : 0, now, ...unchanged.params));
		for (const item of keys) statements.push(env.DB.prepare(`INSERT INTO spam_reputation (mailbox_id, type, key, messages_seen, spam_count, ham_count, first_seen_at, last_seen_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${unchanged.sql} ON CONFLICT(mailbox_id, type, key) DO UPDATE SET messages_seen = MAX(messages_seen, excluded.messages_seen), spam_count = MAX(0, spam_count + excluded.spam_count), ham_count = MAX(0, ham_count + excluded.ham_count), last_seen_at = excluded.last_seen_at`).bind(message.mailboxId, item.type, item.key, amount > 0 ? 1 : 0, target === "spam" ? amount : 0, target === "ham" ? amount : 0, now, now, ...unchanged.params));
	};
	if (previous) addCounts(previous.classification, -1);
	addCounts(classification, 1);
	statements.push(env.DB.prepare(`INSERT INTO spam_feedback (message_id, mailbox_id, actor_user_id, classification, training_tokens, reputation_keys, tokenizer_version, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${unchanged.sql} ON CONFLICT(message_id) DO UPDATE SET actor_user_id = excluded.actor_user_id, classification = excluded.classification, updated_at = excluded.updated_at`).bind(message.id, message.mailboxId, actorUserId, classification, JSON.stringify(tokens), JSON.stringify(keys), TOKENIZER_VERSION, now, now, ...unchanged.params));
	return statements;
}

export async function applySpamFeedback(env: CloudflareEnv, user: SessionUser, messageId: string, classification: SpamClassification): Promise<boolean> {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId || message.direction !== "inbound") return false;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canManage) return false;
	const [previous] = await db.select().from(spamFeedback).where(eq(spamFeedback.messageId, messageId)).limit(1);
	const status = classification === "spam" ? "spam" : "received";
	if (previous?.classification === classification) {
		await db.update(messages).set({ status, folderId: null }).where(eq(messages.id, messageId));
		return true;
	}

	const statements = spamTrainingStatements(env, { ...message, mailboxId: message.mailboxId }, previous, user.id, classification);
	statements.push(env.DB.prepare("UPDATE messages SET status = ?, folder_id = NULL WHERE id = ?").bind(status, messageId));
	await env.DB.batch(statements);
	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId: message.mailboxId,
		messageId,
		action: "email.spam_feedback",
		metadata: { classification },
	});
	return true;
}

/**
 * Train the filter with a message that has already been moved (an IMAP MOVE into or out of
 * Spam), without moving it. Only while the message is still inbound, in `mailboxId` and in
 * `status` (where the move put it), and only if it is not already trained as
 * `classification`; returns whether it trained. Authorization is the caller's.
 */
export async function recordSpamTraining(env: CloudflareEnv, input: { messageId: string; mailboxId: string; actorUserId: string; classification: SpamClassification; status: string }): Promise<boolean> {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, input.messageId)).limit(1);
	if (!message?.mailboxId || message.mailboxId !== input.mailboxId || message.direction !== "inbound" || message.status !== input.status) return false;
	const [previous] = await db.select().from(spamFeedback).where(eq(spamFeedback.messageId, input.messageId)).limit(1);
	if (previous?.classification === input.classification) return false;
	const results = await env.DB.batch(spamTrainingStatements(env, { ...message, mailboxId: message.mailboxId }, previous, input.actorUserId, input.classification));
	// The feedback record is the last statement; no change means a concurrent training won.
	if (!Number(results.at(-1)?.meta?.changes ?? 0)) return false;
	await createAuditLog(env, {
		actorUserId: input.actorUserId,
		mailboxId: message.mailboxId,
		messageId: input.messageId,
		action: "email.spam_feedback",
		metadata: { classification: input.classification, via: "imap" },
	});
	return true;
}
