import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { once } from "node:events";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-copy-bundle-"));
await build({
	stdin: {
		contents: `
			export { createCalendarInvitation } from "./src/lib/calendar/utils.ts";
			export { buildMcpAgentPrompt } from "./src/components/settings/mcp-agent-instructions-utils.ts";
			export { BrowserNotificationSettings } from "./src/components/settings/browser-notification-settings.tsx";
			export { startSmtpListener } from "./server/runtime/smtp.ts";
			export { resolveAppName } from "./src/lib/branding/utils.ts";
			export { MAILFLARE_FORWARDED_HEADER } from "./src/lib/email/account-forwarding.ts";
			export { createElement } from "react";
			export { renderToStaticMarkup } from "react-dom/server";
		`,
		resolveDir: root,
		sourcefile: "copy-test-entry.tsx",
		loader: "tsx",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	jsx: "automatic",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
		"next/link": "next/link.js",
		"next/navigation": "next/navigation.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
test.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

/** Strings that described the running product as Mailflare, and what replaced them. */
const REPLACED = [
	["src/app/(admin)/domains/utils.ts", "Routes incoming email to Mailflare", "Routes incoming email to this server"],
	["src/app/(admin)/domains/utils.ts", "Authorizes Mailflare to send email", "Authorizes this server to send email"],
	["src/app/(admin)/domains/DomainDnsDetails.tsx", "Routes incoming email to Mailflare", "Routes incoming email to this server"],
	["src/app/(admin)/domains/page.tsx", "choose whether Mailflare should", "choose whether {appName} should"],
	["src/app/(auth)/register/register-client.tsx", "Mailflare checks its required", "{appName} checks its required"],
	["src/app/(settings)/settings/import/page.tsx", "how Mailflare should receive it", "how {appName} should receive it"],
	["src/app/(settings)/settings/import/page.tsx", "matching new or existing Mailflare folders.", "matching new or existing {appName} folders."],
	["src/components/messages/spam-score-details.tsx", "Why Mailflare gave this score", "Why this message got this score"],
	["src/components/settings/browser-notification-settings.tsx", "while Mailflare is open", "while {appName} is open"],
	["src/components/settings/api-keys-settings.tsx", "confirmation in Mailflare", "confirmation in {appName}"],
	["src/components/settings/api-keys-settings-utils.ts", "confirm in Mailflare", "confirm in the web app"],
	["src/components/shortcuts/command-palette.tsx", "Mailflare Actions", "{appName} Actions"],
	["src/lib/agent/model.ts", "confirm in Mailflare", "confirm in the web app"],
	["src/lib/agent/tools.ts", "Open the draft in Mailflare", "Open the draft in the web app"],
	["src/lib/backups/export.ts", "not a valid Mailflare backup", "not a valid backup"],
	["src/lib/email/cloud-attachment-utils.ts", "Files shared through Mailflare", "Files shared with you"],
	["src/lib/email/webhooks.ts", "Mailflare test delivery", "Webhook test delivery"],
	["src/app/utils.ts", "admin@mailflare.dev", "admin@example.com"],
	["server/runtime/smtp.ts", 'banner: "Mailflare"', "banner: DISTRIBUTION.name"],
	["server/index.ts", "`Mailflare listening", "`${DISTRIBUTION.name} listening"],
	["server/index.ts", '"Mailflare failed to start"', "`${DISTRIBUTION.name} failed to start`"],
];

test("user-facing and runtime copy no longer calls the running product Mailflare", () => {
	for (const [path, before, after] of REPLACED) {
		const source = read(path);
		assert.ok(!source.includes(before), `${path} still says: ${before.trim()}`);
		assert.ok(source.includes(after), `${path} should say: ${after}`);
	}
});

test("customer-branded screens take the configured app name", () => {
	for (const [path] of REPLACED.filter(([, , after]) => after.includes("{appName}"))) {
		const source = read(path);
		assert.match(source, /import \{ useBranding \} from "@\/components\/branding-provider";/, path);
		assert.match(source, /const \{ appName \} = useBranding\(\);/, path);
	}
	// Default installation (no custom name, or upstream's seeded "Mailflare") shows Blue Pine Mail.
	const html = app.renderToStaticMarkup(app.createElement(app.BrowserNotificationSettings));
	assert.ok(html.includes("while Blue Pine Mail is open"));
	assert.equal(app.resolveAppName("Mailflare"), "Blue Pine Mail");
	assert.equal(app.resolveAppName("Acme Mail"), "Acme Mail");
	// A custom name flows into the MCP connection prompt.
	const prompt = app.buildMcpAgentPrompt("", { mode: "mail", apiKey: "k" }, "Acme Mail");
	assert.match(prompt, /^Connect to my Acme Mail MCP server/);
	assert.match(prompt, /confirmation in Acme Mail\./);
	assert.match(prompt, /Server URL: https:\/\/your-mail-domain\/mcp/);
	assert.doesNotMatch(prompt, /mailflare/i);
});

test("calendar invitations say Blue Pine Mail but keep the stable UID suffix", () => {
	const ics = new TextDecoder().decode(app.createCalendarInvitation({ title: "T", description: "", location: "", startsAt: new Date(0), endsAt: new Date(3600_000), uid: "evt-1" }));
	assert.match(ics, /^PRODID:-\/\/Blue Pine Mail\/\/Calendar\/\/EN$/m);
	assert.match(ics, /^UID:evt-1@mailflare$/m, "UID suffix is unchanged so existing invitations still update");
});

test("the Node SMTP greeting names Blue Pine Mail", async (t) => {
	const env = { DB: null, BUCKET: null, INBOUND_QUEUE: null };
	const server = app.startSmtpListener(env, { sendRaw: async () => true }, { port: 0, host: "127.0.0.1", maxSize: 1000, tls: null });
	if (!server.server.listening) await once(server.server, "listening");
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const socket = connect(server.server.address().port, "127.0.0.1");
	const [greeting] = await once(socket, "data");
	socket.end();
	assert.match(greeting.toString(), /^220 .*Blue Pine Mail/);
	assert.doesNotMatch(greeting.toString(), /Mailflare/);
});

test("compatibility identifiers and Phase 6 update copy are deliberately unchanged", () => {
	assert.equal(app.MAILFLARE_FORWARDED_HEADER, "X-Mailflare-Forwarded");
	assert.match(read("src/lib/jmap/handler.ts"), /realm="Mailflare JMAP"/);
	assert.match(read("src/lib/mcp/server.ts"), /name: "mailflare"/);
	assert.match(read("src/lib/backups/export.ts"), /format: "mailflare-database-backup"/);
	assert.match(read("src/lib/backups/utils.ts"), /`mailflare-\$\{/);
	assert.match(read("src/components/compose/rich-text-utils.ts"), /data-mailflare-quote/);
	assert.match(read("src/lib/auth/client.ts"), /"mailflare-session-token"/);
	assert.match(read("src/db/schema/index.ts"), /default\("Mailflare"\)/);
	assert.match(read("src/components/admin-update-card.tsx"), /Update Mailflare/, "update card is left for Phase 6");
	for (const [path] of REPLACED) assert.doesNotMatch(read(path), /paymug|getLicenseEntitlements/i, path);
});
