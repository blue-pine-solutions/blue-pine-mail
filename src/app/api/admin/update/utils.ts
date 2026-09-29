import { NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";

/** Signed-in admins only; shared by the version/update and database migration routes. */
export async function authorizeAdminRequest(request: Request) {
	const env = getEnv();
	let user: Awaited<ReturnType<typeof requireUser>>;

	try {
		user = await requireUser(env, request);
	} catch {
		return {
			error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
		};
	}

	try {
		assertAdmin(user);
	} catch {
		return {
			error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
		};
	}

	return { env };
}
