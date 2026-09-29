import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { authenticateAdminApiKey } from "@/lib/api/admin-auth";
import { FEATURE_DISABLED_MESSAGES, getFeaturePolicy } from "@/lib/distribution/features";
import { updateManagedAccountSchema } from "@/lib/validators";
import { selectAccountById, updateAccountCredentials } from "@/app/api/accounts/[id]/utils";
import { deleteUserSessions } from "@/lib/auth/session";
import type { AdminAccountRouteParams } from "./types";

export async function GET(request: Request, { params }: AdminAccountRouteParams) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "accounts");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!getFeaturePolicy().multipleAccounts) return NextResponse.json({ error: FEATURE_DISABLED_MESSAGES.multipleAccounts }, { status: 403 });
	const { id } = await params;
	const account = await selectAccountById(getDb(env), id);
	if (!account || (account.id !== auth.userId && account.createdByUserId !== auth.userId)) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	return NextResponse.json({ account: {
		id: account.id, email: account.email, name: account.name, role: account.role,
		disabled: account.disabled, canManageMailboxes: account.canManageMailboxes,
		forwardingEmail: account.forwardingEmail, hasAvatar: !!account.avatarKey,
	} });
}

export async function PATCH(request: Request, { params }: AdminAccountRouteParams) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "accounts");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!getFeaturePolicy().multipleAccounts) return NextResponse.json({ error: FEATURE_DISABLED_MESSAGES.multipleAccounts }, { status: 403 });
	const { id } = await params;
	const db = getDb(env);
	const account = await selectAccountById(db, id);
	if (!account || (account.id !== auth.userId && account.createdByUserId !== auth.userId)) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	const parsed = updateManagedAccountSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	const canForwardEmail = getFeaturePolicy().accountForwarding;
	if (!canForwardEmail && parsed.data.forwardingEmail && parsed.data.forwardingEmail !== account.forwardingEmail) return NextResponse.json({ error: FEATURE_DISABLED_MESSAGES.accountForwarding }, { status: 403 });
	await updateAccountCredentials(db, id, { name: parsed.data.name, password: parsed.data.password ?? null });
	if (parsed.data.password) await deleteUserSessions(env, id);
	await db.update(users).set({
		role: parsed.data.role,
		disabled: parsed.data.disabled,
		canManageMailboxes: parsed.data.canManageMailboxes,
		...(parsed.data.forwardingEmail !== undefined ? { forwardingEmail: parsed.data.forwardingEmail } : {}),
	}).where(eq(users.id, id));
	return NextResponse.json({ ok: true });
}
