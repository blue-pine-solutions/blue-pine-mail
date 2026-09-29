import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-distribution-bundle-"));
await build({
	stdin: {
		contents: `
			export { DISTRIBUTION, getBuildCommit, getSourceUrl } from "./src/lib/distribution/identity.ts";
			export { FEATURE_POLICY_KEYS, getFeaturePolicy } from "./src/lib/distribution/features.ts";
		`,
		resolveDir: root,
		sourcefile: "distribution-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { DISTRIBUTION, getBuildCommit, getSourceUrl, FEATURE_POLICY_KEYS, getFeaturePolicy } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
test.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

const REPOSITORY = "https://github.com/blue-pine-solutions/blue-pine-mail";
const ALL_ENABLED = { customBranding: true, multipleAccounts: true, sharedMailboxes: true, accountForwarding: true, gravatar: true };

test("the distribution identity is Blue Pine Mail, derived from Mailflare", () => {
	assert.equal(DISTRIBUTION.name, "Blue Pine Mail");
	assert.equal(DISTRIBUTION.vendor, "Blue Pine Solutions");
	assert.equal(DISTRIBUTION.sourceRepository, REPOSITORY);
	assert.equal(DISTRIBUTION.license, "AGPL-3.0-or-later");
	assert.match(DISTRIBUTION.version, /^\d+\.\d+\.\d+$/);
	assert.deepEqual(DISTRIBUTION.upstream, {
		name: "Mailflare",
		repository: "https://github.com/hieunc229/mailflare",
		author: "Hieu Nguyen",
		version: packageVersion,
	});
});

test("the source URL falls back to the repository without a build commit", () => {
	assert.equal(getBuildCommit({}), null);
	assert.equal(getBuildCommit({ BLUEPINE_BUILD_COMMIT: "  " }), null);
	assert.equal(getSourceUrl(null), REPOSITORY);
	assert.equal(getSourceUrl(getBuildCommit({})), REPOSITORY);
});

test("the source URL points at the exact commit when BLUEPINE_BUILD_COMMIT is supplied", () => {
	const commit = "b1b8b4db1fb89f4b183902bbec39163d50b0ea6e";
	assert.equal(getBuildCommit({ BLUEPINE_BUILD_COMMIT: ` ${commit} ` }), commit);
	assert.equal(getSourceUrl(getBuildCommit({ BLUEPINE_BUILD_COMMIT: commit })), `${REPOSITORY}/tree/${commit}`);
	assert.equal(getSourceUrl(getBuildCommit({ BLUEPINE_BUILD_COMMIT: "B1B8B4D" })), `${REPOSITORY}/tree/b1b8b4d`);
});

test("a build commit that is not a git SHA is ignored rather than put into the URL", () => {
	for (const value of ["main", "v0.1.0", "abc", "b1b8b4d/../../evil", "https://example.com"]) {
		assert.equal(getBuildCommit({ BLUEPINE_BUILD_COMMIT: value }), null, value);
	}
});

test("the defaults read the process environment", (t) => {
	const saved = { commit: process.env.BLUEPINE_BUILD_COMMIT, disabled: process.env.BLUEPINE_DISABLED_FEATURES };
	t.after(() => {
		for (const [name, value] of [["BLUEPINE_BUILD_COMMIT", saved.commit], ["BLUEPINE_DISABLED_FEATURES", saved.disabled]]) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	process.env.BLUEPINE_BUILD_COMMIT = "abcdef1";
	process.env.BLUEPINE_DISABLED_FEATURES = "gravatar";
	assert.equal(getSourceUrl(), `${REPOSITORY}/tree/abcdef1`);
	assert.equal(getFeaturePolicy().gravatar, false);
	delete process.env.BLUEPINE_BUILD_COMMIT;
	delete process.env.BLUEPINE_DISABLED_FEATURES;
	assert.equal(getSourceUrl(), REPOSITORY);
	assert.deepEqual(getFeaturePolicy(), ALL_ENABLED);
});

test("every feature is enabled by default", () => {
	assert.deepEqual([...FEATURE_POLICY_KEYS].sort(), Object.keys(ALL_ENABLED).sort());
	assert.deepEqual(getFeaturePolicy({}), ALL_ENABLED);
	assert.deepEqual(getFeaturePolicy({ BLUEPINE_DISABLED_FEATURES: undefined }), ALL_ENABLED);
	assert.deepEqual(getFeaturePolicy({ BLUEPINE_DISABLED_FEATURES: "" }), ALL_ENABLED);
	assert.deepEqual(getFeaturePolicy({ BLUEPINE_DISABLED_FEATURES: " , ,, " }), ALL_ENABLED);
});

test("one or several features can be disabled", () => {
	assert.deepEqual(getFeaturePolicy({ BLUEPINE_DISABLED_FEATURES: "gravatar" }), { ...ALL_ENABLED, gravatar: false });
	assert.deepEqual(getFeaturePolicy({ BLUEPINE_DISABLED_FEATURES: "accountForwarding,gravatar" }), { ...ALL_ENABLED, accountForwarding: false, gravatar: false });
});

test("whitespace, letter case and duplicates are tolerated", () => {
	const expected = { ...ALL_ENABLED, accountForwarding: false, gravatar: false };
	assert.deepEqual(getFeaturePolicy({ BLUEPINE_DISABLED_FEATURES: "  accountForwarding ,\tgravatar  " }), expected);
	assert.deepEqual(getFeaturePolicy({ BLUEPINE_DISABLED_FEATURES: "ACCOUNTFORWARDING,Gravatar" }), expected);
	assert.deepEqual(getFeaturePolicy({ BLUEPINE_DISABLED_FEATURES: "gravatar,accountForwarding,gravatar,gravatar" }), expected);
});

test("unknown names do not change any known feature", () => {
	assert.deepEqual(getFeaturePolicy({ BLUEPINE_DISABLED_FEATURES: "everything,*,all,accounts,forwarding" }), ALL_ENABLED);
	assert.deepEqual(getFeaturePolicy({ BLUEPINE_DISABLED_FEATURES: "nonsense,gravatar" }), { ...ALL_ENABLED, gravatar: false });
});

test("features are independent: disabling shared mailboxes keeps multiple accounts", () => {
	assert.deepEqual(getFeaturePolicy({ BLUEPINE_DISABLED_FEATURES: "sharedMailboxes" }), { ...ALL_ENABLED, sharedMailboxes: false });
	assert.deepEqual(getFeaturePolicy({ BLUEPINE_DISABLED_FEATURES: "multipleAccounts" }), { ...ALL_ENABLED, multipleAccounts: false });
});

test("each call returns a fresh policy object", () => {
	const first = getFeaturePolicy({});
	first.gravatar = false;
	assert.equal(getFeaturePolicy({}).gravatar, true);
});
