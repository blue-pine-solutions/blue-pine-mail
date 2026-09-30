import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { revokeMailAppPassword } from "@/lib/mail-app-passwords/service";
import type { MailAppPasswordRouteParams } from "./types";

export async function DELETE(request: Request, { params }: MailAppPasswordRouteParams) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	if (!(await revokeMailAppPassword(env, user, id))) return NextResponse.json({ error: "App password not found" }, { status: 404 });
	return NextResponse.json({ ok: true });
}
