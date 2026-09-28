import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
