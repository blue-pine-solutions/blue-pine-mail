import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEmailAddress } from "@/lib/email/address";
import { resolveInboundAddress } from "@/lib/email/routing";
import { getFeaturePolicy } from "@/lib/distribution/features";

export const MAILFLARE_FORWARDED_HEADER = "X-Mailflare-Forwarded";

export async function getAccountForwardingDestination(
	env: CloudflareEnv,
	recipient: string,
): Promise<string | null> {
	// With the feature off, stored forwarding addresses are kept but not acted on; local delivery is unaffected.
	if (!getFeaturePolicy().accountForwarding) return null;
	const db = getDb(env);
	const decision = await resolveInboundAddress(db, recipient);
	if (!decision?.mailbox) return null;
	const [account] = await db
		.select({ forwardingEmail: users.forwardingEmail })
		.from(users)
		.where(eq(users.id, decision.mailbox.userId))
		.limit(1);
	const destination = account?.forwardingEmail?.trim() ?? "";
	if (!destination || getEmailAddress(destination).toLowerCase() === getEmailAddress(recipient).toLowerCase()) {
		return null;
	}
	return destination;
}
