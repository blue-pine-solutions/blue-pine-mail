import { NextResponse } from "next/server";
import { eq, or } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { mailboxes, users } from "@/db/schema";
import { authenticateAdminApiKey } from "@/lib/api/admin-auth";
import { FEATURE_DISABLED_MESSAGES, getFeaturePolicy } from "@/lib/distribution/features";
import { hashPassword } from "@/lib/auth/password";
import { newId } from "@/lib/ids";
import { createUserAccountSchema } from "@/lib/validators";
import { ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import { accountListItemFromUser, getDomainForAdmin, getExistingMailbox } from "@/app/api/accounts/utils";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "accounts");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!getFeaturePolicy().multipleAccounts) return NextResponse.json({ error: FEATURE_DISABLED_MESSAGES.multipleAccounts }, { status: 403 });
	const rows = await getDb(env).select().from(users).where(or(eq(users.id, auth.userId), eq(users.createdByUserId, auth.userId)));
	return NextResponse.json({ accounts: rows.map(accountListItemFromUser) });
}

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "accounts");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!getFeaturePolicy().multipleAccounts) return NextResponse.json({ error: FEATURE_DISABLED_MESSAGES.multipleAccounts }, { status: 403 });
	const parsed = createUserAccountSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	const db = getDb(env);
	const domain = await getDomainForAdmin(db, auth.userId, parsed.data.domainId);
	if (!domain) return NextResponse.json({ error: "Domain not found" }, { status: 404 });
	const username = parsed.data.username.toLowerCase().trim();
	const email = `${username}@${domain.hostname}`;
	const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
	if (existing || await getExistingMailbox(db, domain.id, username)) return NextResponse.json({ error: "Email address is already assigned" }, { status: 409 });
	const userId = newId("usr");
	try {
		await ensureEmailRoutingRuleToWorker(env, domain.zoneId, email);
		const [account] = await db.insert(users).values({
			id: userId,
			email,
			passwordHash: hashPassword(parsed.data.password),
			name: username,
			role: parsed.data.role,
			createdByUserId: auth.userId,
		}).returning();
		const mailboxId = newId("mbx");
		await db.insert(mailboxes).values({ id: mailboxId, userId, domainId: domain.id, localPart: username, displayName: username });
		await ensureMailboxDomainRouting(env, db, { id: mailboxId, domainId: domain.id, localPart: username, useAllDomains: true });
		return NextResponse.json({ account: accountListItemFromUser(account) }, { status: 201 });
	} catch (error) {
		await db.delete(users).where(eq(users.id, userId));
		return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to create account mailbox" }, { status: 502 });
	}
}
