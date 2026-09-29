import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

/** Lowest patched version per package for advisories fixed in a Blue Pine release. */
const MINIMUM_PATCHED = {
	// Blue Pine Mail 0.1.1: undici reaches the assistant's runtime through @ai-sdk/provider-utils.
	undici: "7.29.1",
};

const parse = (version) => version.split(/[.+-]/).slice(0, 3).map(Number);
const atLeast = (version, minimum) => {
	const [a, b] = [parse(version), parse(minimum)];
	for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index];
	return true;
};

test("every locked copy of a patched dependency stays at or above its fixed version", () => {
	for (const [name, minimum] of Object.entries(MINIMUM_PATCHED)) {
		const copies = Object.entries(lockfile.packages).filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`));
		assert.ok(copies.length > 0, `${name} is expected in the lockfile`);
		for (const [path, entry] of copies) assert.ok(atLeast(entry.version, minimum), `${path} resolves to ${entry.version}, below the patched ${minimum}`);
	}
});
