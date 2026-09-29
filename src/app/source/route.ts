import { NextResponse } from "next/server";
import { getSourceUrl } from "@/lib/distribution/identity";

// Read BLUEPINE_BUILD_COMMIT per request so the link follows the running build, not the machine that built it.
export const dynamic = "force-dynamic";

/** The AGPL Corresponding Source offer: the exact commit of this build when known, otherwise the repository. */
export function GET() {
	return NextResponse.redirect(getSourceUrl(), 302);
}
