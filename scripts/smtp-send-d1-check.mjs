/**
 * Certification of SMTP-1's send transaction and submission adapter on the Workers
 * runtime: bundles src/lib/email/send.ts and src/lib/submission/ into a Worker, runs it in
 * workerd (Miniflare) with real D1 and R2 bindings and a scripted EMAIL binding, and
 * exercises acceptance, the discard policy, ambiguous transport failures, post-acceptance
 * faults injected with D1 triggers, credential re-checks and the MIME refusals.
 *
 *   node scripts/smtp-send-d1-check.mjs
 *
 * The submission listener is Node-only (SMTP-2), but sendEmail runs on Workers too, and
 * D1 differs from the Node SQLite wrapper the tests use, so both are checked. No running
 * dev server or Cloudflare account is needed.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const generated = spawnSync(process.execPath, [join(root, "scripts", "generate-migration-bundle.mjs")], { encoding: "utf8" });
if (generated.status !== 0) throw new Error(`generate-migration-bundle failed: ${generated.stderr}`);

const worker = `
import { sendEmailWithOutcome } from "./src/lib/email/send.ts";
import { submitMessage } from "./src/lib/submission/service.ts";
import * as imap from "./src/lib/imap/service.ts";
import { applyPendingMigrations } from "./src/lib/migrations/service.ts";

// A scripted stand-in for the send_email binding.
const transport = { mode: "ok", sent: [] };
const EMAIL = {
	async send(message) {
		if (transport.mode === "refused") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ESOCKET", syscall: "connect" });
		if (transport.mode === "dropped") throw Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION" });
		if (transport.mode === "opaque") throw new Error("binding error without a classification");
		transport.sent.push(message);
		return { messageId: "<d1-" + transport.sent.length + "@mail.example.test>" };
	},
};

export default {
	async fetch(request, env) {
		const { op, args = [] } = await request.json();
		const app = { ...env, EMAIL, OUTBOUND_QUEUE: { async send() {} } };
		try {
			if (op === "migrate") return Response.json(await applyPendingMigrations(env.DB));
			if (op === "sql") {
				const results = [];
				for (const [query, ...params] of args) results.push((await env.DB.prepare(query).bind(...params).all()).results);
				return Response.json(results);
			}
			if (op === "transport") { transport.mode = args[0]; return Response.json(transport.sent.length); }
			if (op === "sent") return Response.json(transport.sent.map((message) => ({ to: message.to, cc: message.cc ?? [], bcc: message.bcc ?? [], replyTo: message.replyTo ?? null, headers: message.headers ?? null, attachments: (message.attachments ?? []).map((a) => [a.filename, a.disposition, a.contentId ?? null]) })));
			if (op === "send") return Response.json(await sendEmailWithOutcome(app, ...args));
			if (op === "submit") {
				const [request] = args;
				return Response.json(await submitMessage(app, { ...request, message: new TextEncoder().encode(request.message) }));
			}
			if (op === "object") { const object = await env.BUCKET.get(args[0]); return Response.json(object ? await object.text() : null); }
			return Response.json((await imap[op](app, ...args)) ?? null);
		} catch (error) {
			return Response.json({ thrown: true, kind: error?.kind ?? null, delivery: error?.delivery ?? null, error: String(error?.message ?? error) }, { status: 500 });
		}
	},
};
`;

const outDirectory = mkdtempSync(join(root, "node_modules", "mailflare-smtp-d1-"));
const persist = mkdtempSync(join(tmpdir(), "mailflare-smtp-d1-persist-"));
await build({
	stdin: { contents: worker, resolveDir: root, sourcefile: "smtp-d1-worker.ts", loader: "ts" },
	outdir: outDirectory,
	bundle: true,
	format: "esm",
	platform: "browser",
	conditions: ["workerd", "worker", "browser"],
	target: "es2022",
	tsconfig: join(root, "tsconfig.json"),
	external: ["node:*", "cloudflare:*"],
	logLevel: "silent",
});
const script = readFileSync(join(outDirectory, readdirSync(outDirectory).find((name) => name.endsWith(".js"))), "utf8");

const mf = new Miniflare({
	resourcePersistencePath: persist,
	workers: [{
		config: {
			name: "smtp-d1-check",
			compatibilityDate: "2026-09-01",
			compatibilityFlags: ["nodejs_compat"],
			manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: script } } },
			env: { DB: { type: "d1", id: "smtp-db" }, BUCKET: { type: "r2", name: "smtp-bucket" } },
		},
	}],
});

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
	if (ok) passed += 1;
	else failed += 1;
	console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}
const op = async (name, ...args) => (await mf.dispatchFetch("http://smtp.check/", { method: "POST", body: JSON.stringify({ op: name, args }) })).json();
const sql = async (...queries) => op("sql", ...queries);
const count = async (query, ...params) => { const result = await sql([query, ...params]); if (!Array.isArray(result)) throw new Error(JSON.stringify(result)); return result[0][0].n; };
const principal = (appPasswordId = "map-a") => ({ appPasswordId, userId: "user-a", mailboxId: "mbx-a" });
const raw = (headers, body = "Hello") => `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
const plain = raw(["From: ann@example.test", "To: bob@elsewhere.test", "Subject: D1"]);
const submit = (message, { rcpt = ["bob@elsewhere.test"], as = principal() } = {}) => op("submit", { principal: as, envelope: { mailFrom: "ann@example.test", rcptTo: rcpt }, message });
const input = { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "S", text: "t" };

try {
	console.log("Migrations (Workers runner on D1)");
	const migrated = await op("migrate");
	const migrationFiles = readdirSync(join(root, "drizzle", "migrations")).filter((name) => name.endsWith(".sql"));
	check("every migration applies; SMTP-1 adds none (bp0005 last)", migrated.ready && migrated.applied.length === migrationFiles.length && migrated.applied.at(-1) === "bp0005_add_imap_subscriptions.sql", migrated.applied?.at(-1));
	await sql(
		["INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('user-a', 'owner@example.test', 'h', 'Ann', 'admin', 1)"],
		["INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-a', 'example.test', 'manual', 'active', 1)"],
		["INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, type, created_at) VALUES ('mbx-a', 'user-a', 'domain-1', 'ann', 'Ann Example', 'personal', 1)"],
		["INSERT INTO mail_app_passwords (id, user_id, mailbox_id, label, public_id, secret_hash, scopes, created_at) VALUES ('map-a', 'user-a', 'mbx-a', 't', 'p-a', 'h', '[\"smtp\"]', 1), ('map-i', 'user-a', 'mbx-a', 't', 'p-i', 'h', '[\"imap\"]', 1)"],
	);

	console.log("Acceptance");
	const accepted = await submit(raw(["From: ann@example.test", "To: Bob <bob@elsewhere.test>", "Bcc: dave@elsewhere.test", "Reply-To: help@example.test", "In-Reply-To: <p@elsewhere.test>", "Subject: D1"]), { rcpt: ["bob@elsewhere.test", "dave@elsewhere.test"] });
	check("a submission is accepted on D1", accepted.status === "accepted" && accepted.degraded.length === 0, accepted);
	const [delivered] = await op("sent");
	check("To, Bcc from the envelope, Reply-To and threading reach the binding", JSON.stringify([delivered.to, delivered.bcc, delivered.replyTo, delivered.headers]) === JSON.stringify([['"Bob" <bob@elsewhere.test>'], ["dave@elsewhere.test"], "help@example.test", { "In-Reply-To": "<p@elsewhere.test>", References: undefined }].map((value) => JSON.parse(JSON.stringify(value)))), delivered);
	const [row] = (await sql(["SELECT status, raw_r2_key, bcc_addr FROM messages WHERE id = ?", accepted.messageId]))[0];
	check("one sent row with its canonical copy in R2", row.status === "sent" && /^Reply-To: <?help@example.test>?$/m.test((await op("object", row.raw_r2_key)) ?? ""), row);
	const sentView = await op("openImapFolder", { userId: "user-a", mailboxId: "mbx-a" }, "sent");
	check("IMAP Sent lists exactly that message", sentView.messages.length === 1 && sentView.messages[0].messageId === accepted.messageId, sentView.messages);
	check("the job row records the acceptance", (await count("SELECT COUNT(*) AS n FROM outbound_jobs WHERE status = 'sent' AND message_id = ?", accepted.messageId)) === 1);

	console.log("Failures before acceptance (discard policy)");
	await op("transport", "refused");
	const refused = await submit(plain);
	check("a refused connection is temporary and retry-safe", refused.status === "failed" && refused.failure.kind === "transport_temporary" && refused.failure.delivery === "not_attempted" && refused.failure.retrySafe === true, refused);
	await op("transport", "dropped");
	const dropped = await submit(plain);
	check("a connection lost mid-transaction is never retry-safe", dropped.failure?.delivery === "unknown" && dropped.failure.retrySafe === false, dropped);
	await op("transport", "opaque");
	const opaque = await submit(plain);
	check("an unclassified binding error fails closed (unknown)", opaque.failure?.delivery === "unknown" && opaque.failure.retrySafe === false, opaque);
	check("no failed or queued row is left by the three failed attempts", (await count("SELECT COUNT(*) AS n FROM messages WHERE status IN ('failed', 'queued')")) === 0);
	check("each failed attempt is recorded, detached and redacted", (await count("SELECT COUNT(*) AS n FROM outbound_jobs WHERE status = 'failed' AND message_id IS NULL AND payload LIKE '{\"discarded\":true%'")) === 3);
	await op("transport", "ok");
	const retry = await submit(plain);
	check("the retry is accepted once", retry.status === "accepted" && (await count("SELECT COUNT(*) AS n FROM messages WHERE subject = 'D1' AND status = 'sent'")) === 2, retry);
	const retained = await op("send", input);
	check("the default policy (web, JMAP) is unchanged on success", retained.status === "accepted");

	console.log("Failures after acceptance (D1 triggers)");
	await sql(["CREATE TRIGGER t_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'injected'); END"]);
	const audit = await op("send", input, { failedAttempt: "discard" });
	check("an audit failure after acceptance is accepted and degraded", audit.status === "accepted" && JSON.stringify(audit.degraded) === '["audit_log"]', audit);
	await sql(["DROP TRIGGER t_audit"], ["CREATE TRIGGER t_msg BEFORE UPDATE OF status ON messages WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'injected'); END"]);
	const state = await submit(plain);
	check("a Sent-row failure after acceptance is accepted, the row kept for reconciliation", state.status === "accepted" && JSON.stringify(state.degraded) === '["message_state"]' && (await count("SELECT COUNT(*) AS n FROM messages WHERE id = ? AND status = 'queued'", state.messageId)) === 1, state);
	check("the job row says sent, with the provider id", (await count("SELECT COUNT(*) AS n FROM outbound_jobs WHERE message_id = ? AND status = 'sent' AND instr(error, 'accepted as <d1-') = 1 AND instr(error, 'post-acceptance failures: message_state') > 0", state.messageId)) === 1);
	await sql(["DROP TRIGGER t_msg"]);

	console.log("Authorization and refusals");
	const imapOnly = await submit(plain, { as: principal("map-i") });
	check("an IMAP-only credential cannot submit", imapOnly.failure?.reason === "credential_unavailable", imapOnly);
	const spoof = await submit(raw(["From: ceo@bank.test", "To: bob@elsewhere.test"]));
	check("a From that does not match MAIL FROM is refused", spoof.failure?.reason === "from_mail_from_mismatch", spoof);
	const signed = await submit(raw(["From: ann@example.test", "To: bob@elsewhere.test", 'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary=b'], "--b\r\nContent-Type: text/plain\r\n\r\nx\r\n--b\r\nContent-Type: application/pkcs7-signature\r\n\r\nAAAA\r\n--b--"));
	check("signed MIME is unsupported", signed.failure?.kind === "unsupported_message" && signed.failure.reason === "signed_or_encrypted", signed);
	const sentCount = await op("transport", "ok");
	check("nothing refused reached the binding", sentCount === 5, sentCount);
} finally {
	await mf.dispose();
	rmSync(outDirectory, { recursive: true, force: true });
	rmSync(persist, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
