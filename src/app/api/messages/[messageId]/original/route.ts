import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { resolveCanonicalMessage } from "@/lib/email/canonical-message";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { MessageOriginalRouteParams } from "./types";

export async function GET(request: Request, { params }: MessageOriginalRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return new Response("Unauthorized", { status: 401 });

	const { messageId } = await params;
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId) return new Response("Message not found", { status: 404 });
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return new Response("Message not found", { status: 404 });

	let source;
	try {
		source = await resolveCanonicalMessage(env, message);
	} catch (error) {
		console.error(`Message ${messageId} source unavailable`, error instanceof Error ? error.message : error);
		return new Response("Original source is unavailable.", { status: 404 });
	}
	return new Response(source.body, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
