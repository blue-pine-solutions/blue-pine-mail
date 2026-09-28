import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const BLUE_PINE_REPOSITORY = "https://github.com/bofa-ds/mailflare";
const UPSTREAM_REPOSITORY = "https://github.com/hieunc229/mailflare";

test("LICENSE keeps the upstream Mailflare copyright notice", () => {
	assert.ok(existsSync(join(root, "LICENSE")), "LICENSE must exist");
	const license = read("LICENSE");
	assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/);
	assert.match(license, /Mailflare - Email for professionals and teams/);
	assert.match(license, /Copyright \(C\) 2026 Hieu Nguyen/);
});

test("NOTICE identifies Blue Pine Mail as a modified downstream version", () => {
	assert.ok(existsSync(join(root, "NOTICE")), "NOTICE must exist");
	const notice = read("NOTICE");
	assert.match(notice, /Blue Pine Mail is a modified, downstream version of Mailflare/);
	assert.ok(notice.includes(UPSTREAM_REPOSITORY), "NOTICE must name the upstream project");
	assert.match(notice, /Hieu Nguyen/, "NOTICE must keep the upstream copyright");
	assert.match(notice, /Blue Pine Solutions/);
	assert.match(notice, /Affero General Public License, version 3 or \(at your option\) any later/);
	assert.ok(notice.includes(BLUE_PINE_REPOSITORY), "NOTICE must point to the Corresponding Source");
});

test("UPSTREAM.md records both repositories and the compatibility boundary", () => {
	assert.ok(existsSync(join(root, "UPSTREAM.md")), "UPSTREAM.md must exist");
	const upstream = read("UPSTREAM.md");
	assert.ok(upstream.includes(UPSTREAM_REPOSITORY), "UPSTREAM.md must record the upstream repository");
	assert.ok(upstream.includes(BLUE_PINE_REPOSITORY), "UPSTREAM.md must record the Blue Pine repository");
	assert.match(upstream, /### Preserve \/ follow upstream/);
	assert.match(upstream, /### Blue Pine owns/);
	assert.match(upstream, /## Never rename/);
	for (const identifier of ["X-Mailflare-Forwarded", "data-mailflare-quote", "mailflare-database-backup", "mailflare.sqlite", "MAILFLARE_RUNTIME", "__mailflareNodeEnv"]) {
		assert.ok(upstream.includes(identifier), `UPSTREAM.md must list ${identifier} as compatibility-sensitive`);
	}
	assert.match(upstream, /verbatim and in order/, "UPSTREAM.md must require upstream migrations verbatim and in order");
});

test("the distribution layer exists and stays independent of upstream licensing", () => {
	for (const path of ["src/lib/distribution/identity.ts", "src/lib/distribution/features.ts", "src/lib/distribution/types.d.ts"]) {
		assert.ok(existsSync(join(root, path)), `${path} must exist`);
	}
	for (const name of readdirSync(join(root, "src/lib/distribution"))) {
		const source = read(`src/lib/distribution/${name}`);
		assert.doesNotMatch(source, /@\/lib\/licenses|lib\/licenses\//, `${name} must not import the upstream license module`);
		assert.doesNotMatch(source, /paymug/i, `${name} must not reference Paymug`);
	}
});

test("branding follows Blue Pine policy, not upstream license entitlements", () => {
	for (const path of [
		"src/lib/branding/service.ts",
		"src/lib/branding/utils.ts",
		"src/app/api/branding/route.ts",
		"src/app/api/branding/icon/route.ts",
		"src/components/branding-provider.tsx",
		"src/components/branding-provider-utils.ts",
		"src/app/(admin)/branding/page.tsx",
	]) {
		const source = read(path);
		assert.doesNotMatch(source, /@\/lib\/licenses|getLicenseEntitlements/, `${path} must not use upstream license entitlements`);
		assert.doesNotMatch(source, /paymug|Pro or Team/i, `${path} must not carry upstream commercial wording`);
	}
	assert.match(read("src/lib/branding/service.ts"), /getFeaturePolicy\(\)\.customBranding/);
	assert.match(read("src/app/api/branding/icon/route.ts"), /getFeaturePolicy\(\)\.customBranding/);
});

test("account management and shared mailboxes follow Blue Pine policy, not upstream Team status", () => {
	const paths = [
		"src/lib/mailboxes/access-utils.ts",
		"src/lib/mailboxes/access.ts",
		"src/lib/realtime/utils.ts",
		"src/lib/api/admin-auth.ts",
		"src/app/api/accounts/utils.ts",
		"src/app/api/mailboxes/route.ts",
		"src/app/api/mailboxes/[id]/access/route.ts",
		"src/app/api/v1/accounts/utils.ts",
		"src/app/api/v1/mailboxes/utils.ts",
		"src/app/(admin)/accounts/page.tsx",
	];
	for (const path of paths) {
		const source = read(path);
		assert.doesNotMatch(source, /canManageAccounts|isTeamMailboxSharingEnabled|licenseSettings|license_settings|Team license/, `${path} must not use upstream Team entitlements`);
	}
	assert.match(read("src/lib/mailboxes/access-utils.ts"), /getFeaturePolicy\(\)\.sharedMailboxes/);
	assert.match(read("src/app/api/accounts/utils.ts"), /assertAdmin\(user\);\s+if \(!getFeaturePolicy\(\)\[feature\]\)/, "the admin check must run before the feature check");
	assert.match(read("src/lib/mailboxes/access.ts"), /if \(isOwner\) return buildAccess[\s\S]*mailbox\.type !== "shared" \|\| !isMailboxSharingEnabled\(\)[\s\S]*eq\(mailboxAccess\.userId, user\.id\)/, "shared access must still require the user's own mailbox_access row");
});
