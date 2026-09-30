import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { readJsonBody } from "@/lib/http/request";
import { createMailAppPassword, listMailAppPasswords, MailAppPasswordError } from "@/lib/mail-app-passwords/service";
import type { CreateMailAppPasswordInput } from "@/lib/mail-app-passwords/types";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	return NextResponse.json({ passwords: await listMailAppPasswords(env, user) }, { headers: { "Cache-Control": "private, no-store" } });
}

/** Creates a mail app password. The response is the only time the credential is ever returned. */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	let input: CreateMailAppPasswordInput;
	try {
		input = await readJsonBody<CreateMailAppPasswordInput>(request, 16 * 1024);
	} catch {
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}
	try {
		const created = await createMailAppPassword(env, user, input ?? ({} as CreateMailAppPasswordInput));
		return NextResponse.json(created, { status: 201, headers: { "Cache-Control": "no-store" } });
	} catch (cause) {
		if (cause instanceof MailAppPasswordError) return NextResponse.json({ error: cause.message }, { status: cause.status });
		throw cause;
	}
}
