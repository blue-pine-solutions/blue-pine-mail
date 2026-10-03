import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import nodemailer from "nodemailer";
import { SMTPServer } from "smtp-server";

/**
 * SMTP-1: the send transaction (delivery boundary, typed results, failed-attempt policy,
 * post-acceptance fault injection) and the SMTP submission adapter (envelope and header
 * reconciliation, sender authorization, MIME policy, authoritative Sent copy). No
 * submission listener exists; the loopback relay below is a test fixture standing in
 * for the operator's outbound SMTP relay (Mailpit locally).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-smtp1-bundle-"));
await build({
	stdin: {
		contents: `
			export { sendEmail, sendEmailWithOutcome, processOutboundQueue, MAX_RECIPIENTS } from "./src/lib/email/send.ts";
			export { SendError, classifyTransportError, safeErrorText, toSendError } from "./src/lib/email/send-result-utils.ts";
			export { submitMessage, authorizeSubmissionSender, MAX_SUBMISSION_MESSAGE_BYTES, MAX_SUBMISSION_RECIPIENTS } from "./src/lib/submission/service.ts";
			export * as submissionUtils from "./src/lib/submission/utils.ts";
			export { Mailer } from "./server/runtime/mailer.ts";
			export * as imap from "./src/lib/imap/service.ts";
			export { handleJmapRequest } from "./src/lib/jmap/handler.ts";
			export { generateApiKey } from "./src/lib/api-keys.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { POST as sendRoute } from "./src/app/api/send/route.ts";
			export { POST as apiV1SendRoute } from "./src/app/api/v1/send/route.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { default as PostalMime } from "postal-mime";
		`,
		resolveDir: root,
		sourcefile: "smtp1-test-entry.ts",
		loader: "ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
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

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An R2-shaped in-memory bucket with fault injection on put. */
function memoryBucket() {
	const objects = new Map();
	const bucket = {
		objects,
		failPut: null,
		failDelete: false,
		async put(key, value) {
			if (bucket.failPut?.(key)) throw new Error(`injected put failure for ${key}`);
			const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value instanceof ArrayBuffer ? value.slice(0) : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
			objects.set(key, bytes);
			return { key, size: bytes.byteLength };
		},
		async get(key) {
			const stored = objects.get(key);
			return stored ? { key, size: stored.byteLength, body: new Blob([stored]).stream(), arrayBuffer: async () => stored.slice().buffer, text: async () => decoder.decode(stored), httpMetadata: {} } : null;
		},
		async head(key) { return objects.has(key) ? { key, size: objects.get(key).byteLength } : null; },
		async delete(key) { if (bucket.failDelete) throw new Error("injected delete failure"); for (const item of [key].flat()) objects.delete(item); },
	};
	return bucket;
}

/**
 * A (user-a) owns personal mailbox ann@ (alias annie@; all-domains on, the default), a second mailbox
 * ops@, and shared mailbox sales@ where B is send_as, C is send_on_behalf and R is
 * read_only. X owns xavier@. A second domain other.test belongs to A.
 */
async function install(t, { transport } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-smtp1-"));
	const database = new app.SqliteDatabase(join(directory, "mailflare.sqlite"));
	t.after(() => { try { database.db.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
	await app.applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
			('user-a', 'owner@example.test', 'h', 'Ann', 'admin', 1),
			('user-b', 'b@example.test', 'h', 'Bea', 'user', 1),
			('user-c', 'c@example.test', 'h', 'Cal', 'user', 1),
			('user-r', 'r@example.test', 'h', 'Rex', 'user', 1),
			('user-x', 'x@example.test', 'h', 'Xavier', 'user', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES
			('domain-1', 'user-a', 'example.test', 'manual', 'active', 1),
			('domain-2', 'user-a', 'other.test', 'manual', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, type, created_at) VALUES
			('mbx-a', 'user-a', 'domain-1', 'ann', 'Ann Example', 'personal', 1),
			('mbx-o', 'user-a', 'domain-1', 'ops', 'Ops', 'personal', 1),
			('mbx-s', 'user-a', 'domain-1', 'sales', 'Sales', 'shared', 1),
			('mbx-x', 'user-x', 'domain-1', 'xavier', NULL, 'personal', 1);
		INSERT INTO mailbox_aliases (id, mailbox_id, domain_id, local_part, created_at) VALUES ('al-1', 'mbx-a', 'domain-1', 'annie', 1);
		INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES
			('acc-b', 'mbx-s', 'user-b', 'send_as', 1),
			('acc-c', 'mbx-s', 'user-c', 'send_on_behalf', 1),
			('acc-r', 'mbx-s', 'user-r', 'read_only', 1);
		INSERT INTO mail_app_passwords (id, user_id, mailbox_id, label, public_id, secret_hash, scopes, created_at) VALUES
			('map-a', 'user-a', 'mbx-a', 't', 'p-a', 'h', '["smtp"]', 1),
			('map-a-imap', 'user-a', 'mbx-a', 't', 'p-ai', 'h', '["imap"]', 1),
			('map-a-both', 'user-a', 'mbx-a', 't', 'p-ab', 'h', '["imap","smtp"]', 1),
			('map-o', 'user-a', 'mbx-o', 't', 'p-o', 'h', '["smtp"]', 1),
			('map-b', 'user-b', 'mbx-s', 't', 'p-b', 'h', '["smtp"]', 1),
			('map-c', 'user-c', 'mbx-s', 't', 'p-c', 'h', '["smtp"]', 1),
			('map-r', 'user-r', 'mbx-s', 't', 'p-r', 'h', '["smtp"]', 1),
			('map-x', 'user-x', 'mbx-x', 't', 'p-x', 'h', '["smtp"]', 1);
	`);
	const sent = [];
	const fake = {
		behavior: null,
		async send(message) {
			if (fake.behavior) {
				const result = await fake.behavior(message, sent.length);
				if (result) { sent.push(message); return result; }
			}
			sent.push(message);
			return { messageId: `<provider-${sent.length}@mail.example.test>` };
		},
	};
	const bucket = memoryBucket();
	const queued = [];
	const env = {
		DB: database,
		BUCKET: bucket,
		EMAIL: transport ?? fake,
		OUTBOUND_QUEUE: { async send(message, options) { queued.push({ message, options }); } },
	};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const all = (sql, ...args) => database.db.prepare(sql).all(...args);
	const one = (sql, ...args) => database.db.prepare(sql).get(...args);
	return {
		database, env, bucket, sent, fake, queued, all, one,
		exec: (sql) => database.db.exec(sql),
		outbound: (mailboxId = "mbx-a") => all("SELECT * FROM messages WHERE mailbox_id = ? AND direction = 'outbound' ORDER BY created_at, id", mailboxId),
		jobs: () => all("SELECT * FROM outbound_jobs ORDER BY created_at, id"),
	};
}

const principal = (id = "map-a", userId = "user-a", mailboxId = "mbx-a") => ({ appPasswordId: id, userId, mailboxId });

/** RFC 5322 bytes as a mail client composes them (nodemailer's composer, Bcc header kept). */
async function compose(options) {
	const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
	const info = await transport.sendMail({ keepBcc: true, ...options });
	return new Uint8Array(info.message);
}
const rawBytes = (text) => encoder.encode(text.replace(/\r?\n/g, "\r\n"));

async function submit(context, { from = "ann@example.test", rcpt = ["bob@elsewhere.test"], message, as = principal() } = {}) {
	return app.submitMessage(context.env, { principal: as, envelope: { mailFrom: from, rcptTo: rcpt }, message, publicOrigin: "http://localhost" });
}
const simple = (headers = {}, body = "Hello") => rawBytes(`${Object.entries({ From: "ann@example.test", To: "bob@elsewhere.test", Subject: "Hi", ...headers }).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${body}\n`);

const failure = (result) => { assert.equal(result.status, "failed", JSON.stringify(result)); return result.failure; };
const accepted = (result) => { assert.equal(result.status, "accepted", JSON.stringify(result)); return result; };

/** Nothing reached the transport and nothing was stored for this attempt. */
function assertNothingStored(context, mailboxId = "mbx-a") {
	assert.equal(context.sent.length, 0, "the transport was not called");
	assert.equal(context.outbound(mailboxId).length, 0, "no message row");
	assert.equal(context.one("SELECT COUNT(*) AS n FROM message_attachments").n, 0, "no attachment rows");
	assert.equal([...context.bucket.objects.keys()].filter((key) => key.startsWith("attachments/") || key.startsWith("canonical/")).length, 0, "no objects");
}

// ---- A. Result vocabulary and transport classification -------------------------------------

test("smtp-1 A: transport errors are classified by the signals the transports actually give", () => {
	const classify = (props, message = "x") => {
		const error = app.classifyTransportError(Object.assign(new Error(message), props));
		return [error.kind, error.delivery, error.retrySafe, error.temporary];
	};
	// nodemailer: setup and configuration failures happen before any message data moves.
	assert.deepEqual(classify({ code: "EDNS" }), ["transport_temporary", "not_attempted", true, true]);
	assert.deepEqual(classify({ code: "ETLS" }), ["transport_temporary", "not_attempted", true, true]);
	assert.deepEqual(classify({ code: "EAUTH", responseCode: 535 }), ["transport_temporary", "not_attempted", true, true], "relay credentials are the operator's problem, never a permanent rejection");
	assert.deepEqual(classify({ code: "ENOTCONFIGURED" }), ["transport_temporary", "not_attempted", true, true]);
	assert.deepEqual(classify({ code: "ESOCKET", syscall: "connect" }), ["transport_temporary", "not_attempted", true, true]);
	assert.deepEqual(classify({ code: "ETIMEDOUT" }, "Connection timeout"), ["transport_temporary", "not_attempted", true, true]);
	assert.deepEqual(classify({ code: "ETIMEDOUT" }, "Greeting never received"), ["transport_temporary", "not_attempted", true, true]);
	// A connection lost later may have been lost after the relay took the message.
	assert.deepEqual(classify({ code: "ETIMEDOUT" }, "Timeout"), ["transport_temporary", "unknown", false, true]);
	assert.deepEqual(classify({ code: "ECONNECTION" }, "Connection closed unexpectedly"), ["transport_temporary", "unknown", false, true]);
	assert.deepEqual(classify({ code: "ESOCKET", syscall: "read" }), ["transport_temporary", "unknown", false, true]);
	// SMTP replies are definitive refusals.
	assert.deepEqual(classify({ code: "EMESSAGE", responseCode: 554 }), ["delivery_rejected", "rejected", true, false]);
	assert.deepEqual(classify({ code: "EENVELOPE", responseCode: 550 }), ["delivery_rejected", "rejected", true, false]);
	assert.deepEqual(classify({ code: "EENVELOPE", responseCode: 451 }), ["transport_temporary", "rejected", true, true]);
	assert.deepEqual(classify({ code: "EENVELOPE" }), ["delivery_rejected", "not_attempted", true, false], "nodemailer's own envelope check");
	// The Node Cloudflare REST transport.
	assert.deepEqual(classify({ status: 400 }), ["delivery_rejected", "rejected", true, false]);
	assert.deepEqual(classify({ status: 403 }), ["transport_temporary", "rejected", true, true]);
	assert.deepEqual(classify({ status: 429 }), ["transport_temporary", "rejected", true, true]);
	assert.deepEqual(classify({ status: 502 }), ["transport_temporary", "unknown", false, true]);
	// Unknown shapes (the Workers binding, network errors, non-errors) fail closed.
	assert.deepEqual(classify({}), ["transport_temporary", "unknown", false, true]);
	for (const thrown of [new TypeError("fetch failed"), "a string", null, undefined, 42]) {
		const error = app.classifyTransportError(thrown);
		assert.deepEqual([error.kind, error.delivery, error.retrySafe], ["transport_temporary", "unknown", false]);
	}
	// toSendError keeps a classification and never upgrades an unknown one.
	const unknown = app.classifyTransportError(new Error("x"));
	assert.equal(app.toSendError(unknown), unknown);
	assert.deepEqual([app.toSendError(new Error("db")).kind, app.toSendError(new Error("db")).delivery], ["internal_temporary", "not_attempted"]);
});

// ---- B. The send transaction --------------------------------------------------------------

test("smtp-1 B1: a successful send records one sent row, a sent job, the canonical copy, the audit log", async (t) => {
	const context = await install(t);
	const outcome = await app.sendEmailWithOutcome(context.env, { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "S", text: "t", replyTo: "Help <help@example.test>" });
	assert.deepEqual([outcome.status, outcome.degraded], ["accepted", []]);
	const [row] = context.outbound();
	assert.deepEqual([row.id, row.status, row.provider_message_id], [outcome.messageId, "sent", outcome.providerMessageId]);
	assert.ok(row.raw_r2_key.startsWith("canonical/"));
	const canonical = await app.PostalMime.parse(context.bucket.objects.get(row.raw_r2_key));
	assert.equal(canonical.replyTo[0].address, "help@example.test", "Reply-To reaches the Sent copy");
	assert.equal(context.sent[0].replyTo, "Help <help@example.test>", "and the transport");
	const [job] = context.jobs();
	assert.deepEqual([job.status, job.error, job.message_id], ["sent", null, row.id]);
	assert.equal(context.one("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'email.send' AND message_id = ?", row.id).n, 1);
	// The legacy wrapper's shape is unchanged.
	assert.deepEqual(Object.keys(await app.sendEmail(context.env, { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "S", text: "t" })), ["messageId"]);
});

test("smtp-1 B2: retain (the default) keeps a failed row as before; discard removes the row and its objects and keeps a redacted job", async (t) => {
	const context = await install(t);
	context.fake.behavior = () => { throw Object.assign(new Error("Message failed: 451 try later"), { code: "EMESSAGE", responseCode: 451 }); };
	const input = { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "Secret plan", text: "the body text", attachments: [{ filename: "a.png", type: "image/png", content: PNG.buffer.slice(0) }] };
	const retained = await app.sendEmail(context.env, input).catch((error) => error);
	assert.ok(retained instanceof app.SendError);
	assert.deepEqual([retained.kind, retained.delivery, retained.retrySafe, retained.message], ["transport_temporary", "rejected", true, "Message failed: 451 try later"]);
	assert.deepEqual(context.outbound().map((row) => row.status), ["failed"], "web/JMAP behavior unchanged");
	assert.equal(context.jobs()[0].status, "failed");
	assert.match(context.jobs()[0].error, /^transport_temporary\/transport_deferred delivery=rejected/);

	context.exec("DELETE FROM messages; DELETE FROM outbound_jobs;");
	context.bucket.objects.clear();
	const discarded = await app.sendEmailWithOutcome(context.env, { ...input, attachments: [{ filename: "a.png", type: "image/png", content: PNG.buffer.slice(0) }] }, { failedAttempt: "discard" }).catch((error) => error);
	assert.equal(discarded.kind, "transport_temporary");
	assertNothingStored({ ...context, sent: [] });
	const [job] = context.jobs();
	assert.deepEqual([job.status, job.message_id], ["failed", null], "the attempt's record survives, detached");
	const payload = JSON.parse(job.payload);
	assert.equal(payload.discarded, true);
	assert.equal(payload.delivery, "rejected");
	assert.ok(!job.payload.includes("the body text") && !("text" in payload) && !("attachments" in payload), "no message content is kept for a discarded attempt");

	// A discarded attempt cannot be scheduled: there would be nothing to deliver later.
	const scheduled = await app.sendEmailWithOutcome(context.env, { ...input, attachments: [], scheduledAt: new Date(Date.now() + 3600_000) }, { failedAttempt: "discard" }).catch((error) => error);
	assert.equal(scheduled.reason, "schedule_not_supported");
});

test("smtp-1 B3: validation and authorization failures are typed, keep their messages, and write nothing", async (t) => {
	const context = await install(t);
	const base = { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "S", text: "t" };
	const cases = [
		[{ mailboxId: "" }, "invalid_message", "mailbox_required", "Mailbox is required"],
		[{ mailboxId: "nope" }, "unauthorized_sender", "mailbox_not_found", "Mailbox not found"],
		[{ from: "xavier@example.test" }, "unauthorized_sender", "sender_address_not_permitted", "Sender address does not match the selected mailbox"],
		[{ userId: "user-r", mailboxId: "mbx-s", from: "sales@example.test" }, "unauthorized_sender", "send_permission_denied", "You do not have permission to send from this mailbox"],
		[{ subject: "x".repeat(999) }, "invalid_message", "subject_too_long", "Subject exceeds Cloudflare's 998-character limit"],
		[{ to: "" }, "invalid_message", "no_recipients", "At least one recipient is required"],
		[{ to: Array.from({ length: 51 }, (_, i) => `r${i}@elsewhere.test`) }, "invalid_message", "too_many_recipients", "A message can have at most 50 recipients"],
		[{ replyTo: "a@x.test, b@x.test" }, "invalid_message", "reply_to_invalid", "Reply-To must be a single valid address"],
		[{ replyTo: "a@x.test\r\nBcc: evil@x.test" }, "invalid_message", "reply_to_invalid", "Reply-To must be a single valid address"],
	];
	for (const [override, kind, reason, message] of cases) {
		const error = await app.sendEmail(context.env, { ...base, ...override }).catch((caught) => caught);
		assert.deepEqual([error.kind, error.reason, error.message, error.delivery], [kind, reason, message, "not_attempted"], reason);
	}
	context.exec("UPDATE users SET disabled = 1 WHERE id = 'user-a'");
	assert.equal((await app.sendEmail(context.env, base).catch((error) => error)).reason, "sender_account_unavailable");
	assertNothingStored(context);
	assert.equal(context.one("SELECT COUNT(*) AS n FROM contacts").n, 0, "contacts only for a message that passed validation");
});

test("smtp-1 B4: database and storage failures before acceptance fail closed as temporary and retry-safe", async (t) => {
	const context = await install(t);
	const input = () => ({ userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "S", text: "t", attachments: [{ filename: "a.png", type: "image/png", content: PNG.buffer.slice(0) }] });
	const expect = async (label, options) => {
		const error = await app.sendEmailWithOutcome(context.env, input(), options).catch((caught) => caught);
		assert.ok(error instanceof app.SendError, label);
		assert.deepEqual([error.kind, error.delivery, error.retrySafe, error.temporary], ["internal_temporary", "not_attempted", true, true], label);
		assert.equal(context.sent.length, 0, label);
	};
	context.exec("CREATE TRIGGER t_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected'); END;");
	await expect("message insert");
	context.exec("DROP TRIGGER t_fail; CREATE TRIGGER t_fail BEFORE INSERT ON outbound_jobs BEGIN SELECT RAISE(ABORT, 'injected'); END;");
	await expect("job insert", { failedAttempt: "discard" });
	assertNothingStored(context);
	context.exec("DROP TRIGGER t_fail;");
	context.bucket.failPut = (key) => key.startsWith("attachments/");
	await expect("attachment object", { failedAttempt: "discard" });
	assertNothingStored(context);
	context.bucket.failPut = null;
	context.exec("ALTER TABLE app_settings RENAME TO app_settings_gone;");
	await expect("settings read");
	context.exec("ALTER TABLE app_settings_gone RENAME TO app_settings; ALTER TABLE mailboxes RENAME TO mailboxes_gone;");
	const authorization = await app.sendEmail(context.env, input()).catch((error) => error);
	assert.deepEqual([authorization.kind, authorization.reason], ["internal_temporary", "authorization_unavailable"], "an authorization lookup failure never lets the send through");
	context.exec("ALTER TABLE mailboxes_gone RENAME TO mailboxes;");
	assertNothingStored(context);
});

/** Each post-acceptance operation, failed after the transport accepted the message. */
const POST_ACCEPTANCE_FAULTS = [
	["job_state", (context) => context.exec("CREATE TRIGGER t_job BEFORE UPDATE OF status ON outbound_jobs WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'injected'); END;")],
	["canonical_copy", (context) => { context.bucket.failPut = (key) => key.startsWith("canonical/"); }],
	["message_state", (context) => context.exec("CREATE TRIGGER t_msg BEFORE UPDATE OF status ON messages WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'injected'); END;")],
	["webhooks", (context) => context.exec("ALTER TABLE webhooks RENAME TO webhooks_gone;")],
	["audit_log", (context) => context.exec("CREATE TRIGGER t_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'injected'); END;")],
];

test("smtp-1 B5: every post-acceptance failure still reports acceptance, is recorded for reconciliation, and never resends", async (t) => {
	for (const [issue, inject] of POST_ACCEPTANCE_FAULTS) {
		await t.test(issue, async (st) => {
			const context = await install(st);
			inject(context);
			const errors = [];
			st.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
			const outcome = await app.sendEmailWithOutcome(context.env, { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "S", text: "t" }, { failedAttempt: "discard" });
			assert.equal(outcome.status, "accepted");
			assert.deepEqual(outcome.degraded, [issue]);
			assert.equal(context.sent.length, 1, "delivered exactly once");
			const [row] = context.outbound();
			assert.ok(row, "the accepted message's row is never discarded");
			assert.notEqual(row.status, "failed", "an accepted message is never marked failed");
			assert.equal(row.status, issue === "message_state" ? "queued" : "sent");
			const [job] = context.jobs();
			if (issue !== "job_state") {
				assert.equal(job.status, "sent");
				assert.match(job.error, new RegExp(`accepted as <provider-1@mail.example.test>; post-acceptance failures: ${issue}`));
			} else {
				assert.equal(job.status, "queued", "the injected fault blocked every job update");
			}
			assert.ok(errors.some((line) => line.includes("send.post-acceptance degraded") && line.includes(row.id) && line.includes("provider-1")), "logged with the ids reconciliation needs");
			// The legacy wrapper resolves too: web and JMAP never see a post-acceptance failure.
			const again = await app.sendEmail(context.env, { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "S2", text: "t" });
			assert.ok(again.messageId);
			assert.equal(context.sent.length, 2);
		});
	}
});

test("smtp-1 B6: all post-acceptance failures at once, and an unexpected throw, still report acceptance", async (t) => {
	const context = await install(t);
	for (const [, inject] of POST_ACCEPTANCE_FAULTS) inject(context);
	t.mock.method(console, "error", () => {});
	const outcome = await app.sendEmailWithOutcome(context.env, { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "S", text: "t" });
	assert.equal(outcome.status, "accepted");
	assert.deepEqual(outcome.degraded.sort(), POST_ACCEPTANCE_FAULTS.map(([issue]) => issue).sort());
	assert.equal(context.sent.length, 1);

	// A transport whose result is not even an object: reading it fails after acceptance.
	const odd = await install(t);
	odd.fake.behavior = () => ({ get messageId() { return "<odd@mail.example.test>"; } });
	const fine = await app.sendEmailWithOutcome(odd.env, { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "S", text: "t" });
	assert.equal(fine.status, "accepted");
});

test("smtp-1 B7: a scheduled send records acceptance on the job first, so a redelivered queue message never resends", async (t) => {
	const context = await install(t);
	const { messageId, scheduled } = await app.sendEmail(context.env, { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "Later", text: "t", replyTo: "help@example.test", scheduledAt: new Date(Date.now() + 1000) });
	assert.equal(scheduled, true);
	const [{ message }] = context.queued;
	const due = { ...message, scheduledAt: new Date(Date.now() - 1000).toISOString() };
	t.mock.method(console, "error", () => {});
	context.exec("CREATE TRIGGER t_msg BEFORE UPDATE OF status ON messages WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'injected'); END;");
	await app.processOutboundQueue(context.env, due);
	assert.equal(context.sent.length, 1);
	assert.equal(context.sent[0].replyTo, "help@example.test", "Reply-To survives scheduling");
	assert.equal(context.jobs()[0].status, "sent");
	await app.processOutboundQueue(context.env, due);
	assert.equal(context.sent.length, 1, "the at-least-once queue redelivery found the job sent");
	assert.equal(context.one("SELECT status FROM messages WHERE id = ?", messageId).status, "queued", "the row is left for reconciliation, never failed");
});

test("smtp-1 B8: acceptance reaches the job row before any other post-acceptance write", async (t) => {
	const context = await install(t);
	let jobAtCanonicalWrite = null;
	context.bucket.failPut = (key) => {
		if (key.startsWith("canonical/")) jobAtCanonicalWrite = context.jobs()[0].status;
		return false;
	};
	accepted(await submit(context, { message: simple() }));
	assert.equal(jobAtCanonicalWrite, "sent", "a crash after this point leaves the attempt recorded as sent");
});

// ---- C. The submission adapter ------------------------------------------------------------

test("smtp-1 C1: a plain message becomes exactly one server-side Sent message, visible over IMAP and JMAP", async (t) => {
	const context = await install(t);
	const message = simple({ "Message-ID": "<client-1@thunderbird.test>", Date: "Mon, 1 Jan 2001 00:00:00 +0000", "User-Agent": "Thunderbird", "X-Custom": "keep?", "Disposition-Notification-To": "ann@example.test" }, "Hello there");
	const result = accepted(await submit(context, { message }));
	assert.equal(result.recipientCount, 1);
	assert.deepEqual(result.degraded, []);
	assert.equal(context.sent.length, 1);
	const [sent] = context.sent;
	assert.equal(sent.headers, undefined, "no client header is carried: not Message-ID, Date, User-Agent or X- headers");
	assert.deepEqual([sent.to, sent.cc, sent.bcc, sent.subject, sent.text, sent.html], [["bob@elsewhere.test"], undefined, undefined, "Hi", "Hello there\n", undefined]);
	assert.match(sent.from, /<ann@example\.test>$/);

	const rows = context.outbound();
	assert.equal(rows.length, 1, "exactly one Sent row");
	assert.deepEqual([rows[0].status, rows[0].provider_message_id], ["sent", "<provider-1@mail.example.test>"]);
	const view = await app.imap.openImapFolder(context.env, { userId: "user-a", mailboxId: "mbx-a" }, "sent");
	assert.deepEqual(view.messages.map((entry) => entry.messageId), [result.messageId]);
	const fetched = await app.imap.fetchImapMessage(context.env, { userId: "user-a", mailboxId: "mbx-a" }, "sent", view.messages[0].uid);
	const parsed = await app.PostalMime.parse(fetched.bytes);
	assert.equal(parsed.messageId, "<provider-1@mail.example.test>", "the Sent copy carries the transport's Message-ID, not the client's");
	assert.notEqual(new Date(parsed.date).getUTCFullYear(), 2001, "Date is the server's");
	assert.ok(!parsed.headers.some((header) => ["x-custom", "user-agent", "disposition-notification-to"].includes(header.key)));

	const { fullKey, prefix, hash } = app.generateApiKey();
	context.database.db.prepare("INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, created_at) VALUES ('k1', 'legacy', 'user-a', 'jmap', ?, ?, ?, 1)").run(prefix, hash, JSON.stringify(["jmap"]));
	const body = { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [["Email/query", { accountId: "user-a", filter: { subject: "Hi" } }, "0"]] };
	const response = await app.handleJmapRequest(new Request("http://localhost/jmap/api", { method: "POST", headers: { Authorization: `Bearer ${fullKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), context.env);
	assert.deepEqual((await response.json()).methodResponses[0][1].ids, [result.messageId]);
});

test("smtp-1 C2: HTML, multipart/alternative, attachments, inline Content-ID images and UTF-8 survive reconstruction", async (t) => {
	const context = await install(t);
	const message = await compose({
		from: '"Änn Ëxample ✓" <ann@example.test>',
		to: '"Bøb Ünicode" <bob@elsewhere.test>',
		cc: "carol@elsewhere.test",
		subject: "Rapport ✓ ünïcode – 日本語",
		text: "Plain ünïcode ✓",
		html: '<p>HTML ünïcode ✓ <img src="cid:logo@ann"></p>',
		attachments: [
			{ filename: "logo.png", content: Buffer.from(PNG), contentType: "image/png", cid: "logo@ann" },
			{ filename: "résumé.txt", content: "attached ✓", contentType: "text/plain" },
			{ filename: "forward.eml", content: "From: z@elsewhere.test\r\nSubject: inner\r\n\r\ninner body\r\n", contentType: "message/rfc822" },
		],
	});
	accepted(await submit(context, { rcpt: ["bob@elsewhere.test", "carol@elsewhere.test"], message }));
	const [sent] = context.sent;
	assert.equal(sent.subject, "Rapport ✓ ünïcode – 日本語");
	assert.equal(sent.text.trim(), "Plain ünïcode ✓");
	assert.match(sent.html, /<img src="cid:logo@ann">/);
	assert.deepEqual(sent.to, ['"Bøb Ünicode" <bob@elsewhere.test>']);
	assert.deepEqual(sent.cc, ["carol@elsewhere.test"]);
	assert.match(sent.from, /<ann@example\.test>$/);
	assert.ok(!sent.from.includes("Änn"), "the From display name is the server's, as for every send");
	const attachments = sent.attachments.map((attachment) => [attachment.filename, attachment.type, attachment.disposition, attachment.contentId ?? null]);
	assert.deepEqual(attachments, [
		["logo.png", "image/png", "inline", "logo@ann"],
		["résumé.txt", "text/plain", "attachment", null],
		["forward.eml", "message/rfc822", "attachment", null],
	]);
	assert.deepEqual(new Uint8Array(sent.attachments[0].content), PNG);
	assert.equal(decoder.decode(sent.attachments[1].content), "attached ✓");
	assert.equal(context.one("SELECT COUNT(*) AS n FROM message_attachments").n, 3, "attachments are stored on the Sent row");
	const canonical = await app.PostalMime.parse(context.bucket.objects.get(context.outbound()[0].raw_r2_key));
	assert.equal(canonical.attachments.find((attachment) => attachment.filename === "logo.png").contentId, "<logo@ann>");
});

test("smtp-1 C3: Reply-To, In-Reply-To and References are kept; a reply joins its parent's thread", async (t) => {
	const context = await install(t);
	context.exec(`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, provider_message_id, thread_id, created_at) VALUES ('parent', 'user-a', 'mbx-a', 'inbound', 'bob@elsewhere.test', 'ann@example.test', 'received', '<parent@elsewhere.test>', 'thread-p', 1)`);
	const message = simple({ "Reply-To": '"Help Desk" <help@example.test>', "In-Reply-To": "<parent@elsewhere.test>", References: "<root@elsewhere.test>\n <parent@elsewhere.test>", Subject: "Re: Hi" });
	accepted(await submit(context, { message }));
	const [sent] = context.sent;
	assert.equal(sent.replyTo, '"Help Desk" <help@example.test>');
	assert.deepEqual(sent.headers, { "In-Reply-To": "<parent@elsewhere.test>", References: "<root@elsewhere.test> <parent@elsewhere.test>" });
	const [row] = context.outbound();
	assert.deepEqual([row.in_reply_to, row.references_header, row.thread_id], ["parent@elsewhere.test", "root@elsewhere.test parent@elsewhere.test", "thread-p"]);

	// Several Reply-To addresses cannot be carried by the transports' single replyTo.
	const several = failure(await submit(context, { message: simple({ "Reply-To": "a@example.test, b@example.test" }) }));
	assert.deepEqual([several.kind, several.reason], ["unsupported_message", "reply_to_multiple"]);
	// A fresh message is keyed by its own transport Message-ID, as every send.
	accepted(await submit(context, { message: simple({ Subject: "new" }) }));
	assert.equal(context.outbound().find((row) => row.subject === "new").thread_id, "provider-2@mail.example.test");
});

test("smtp-1 C4: the envelope decides delivery; Bcc is delivered privately and the Bcc header never travels", async (t) => {
	const context = await install(t);
	const message = await compose({ from: "ann@example.test", to: "Bob <BOB@Elsewhere.test>", cc: ["carol@elsewhere.test", "bob@elsewhere.test"], bcc: ["dave@elsewhere.test", "nobody@elsewhere.test"], subject: "Bcc", text: "x" });
	assert.match(decoder.decode(message), /^Bcc: /m, "the client sent a Bcc header");
	const result = accepted(await submit(context, { rcpt: ["bob@elsewhere.test", "CAROL@elsewhere.test", "dave@elsewhere.test", "erin@elsewhere.test", "Bob@Elsewhere.Test"], message }));
	assert.equal(result.recipientCount, 4);
	const [sent] = context.sent;
	assert.deepEqual(sent.to, ['"Bob" <bob@elsewhere.test>']);
	assert.deepEqual(sent.cc, ["carol@elsewhere.test"], "an address in To and Cc is presented once, in To");
	assert.deepEqual(sent.bcc, ["dave@elsewhere.test", "erin@elsewhere.test"], "envelope-only recipients are Bcc; a header Bcc not in the envelope is not delivered");
	assert.ok(!JSON.stringify(sent.headers ?? {}).toLowerCase().includes("bcc"));
	assert.ok(![...sent.to, ...sent.cc].some((entry) => /dave|erin|nobody/.test(entry)), "Bcc recipients never appear in To or Cc");
	const [row] = context.outbound();
	assert.deepEqual([row.to_addr, row.cc_addr, row.bcc_addr], ['"Bob" <bob@elsewhere.test>', "carol@elsewhere.test", "dave@elsewhere.test, erin@elsewhere.test"], "the sender's own Sent copy records Bcc, as for web sends");
});

test("smtp-1 C5: recipient edge cases are refused deterministically before anything is stored or sent", async (t) => {
	const context = await install(t);
	const cases = [
		[{ rcpt: [] }, "invalid_message", "no_recipients"],
		[{ rcpt: ["not-an-address"] }, "invalid_message", "recipient_invalid"],
		[{ rcpt: ["bob@elsewhere.test", "bad@@elsewhere.test"] }, "invalid_message", "recipient_invalid"],
		[{ rcpt: ['"quoted local"@elsewhere.test'] }, "invalid_message", "recipient_invalid"],
		[{ rcpt: ["bob@[192.0.2.1]"] }, "invalid_message", "recipient_invalid"],
		[{ rcpt: ["bob@localhost"] }, "invalid_message", "recipient_invalid"],
		[{ rcpt: ["bob@elsewhere.test\r\nRCPT TO:<evil@x.test>"] }, "invalid_message", "recipient_invalid"],
		[{ rcpt: Array.from({ length: 51 }, (_, i) => `r${i}@elsewhere.test`) }, "invalid_message", "too_many_recipients"],
		[{ rcpt: ["carol@elsewhere.test"] }, "invalid_message", "header_recipient_not_in_envelope"],
		[{ rcpt: ["bob@elsewhere.test"], message: simple({ To: "bob@elsewhere.test, not an address" }) }, "invalid_message", "header_recipient_invalid"],
		[{ rcpt: ["bob@elsewhere.test"], message: simple({ To: "undisclosed-recipients:;" }) }, "unsupported_message", "no_visible_recipient"],
		[{ rcpt: ["bob@elsewhere.test"], message: simple({ To: null }) }, "unsupported_message", "no_visible_recipient"],
	];
	for (const [override, kind, reason] of cases) {
		const result = failure(await submit(context, { message: simple(), ...override }));
		assert.deepEqual([result.kind, result.reason, result.delivery, result.retrySafe], [kind, reason, "not_attempted", true], reason);
	}
	// 50 distinct recipients, given 60 times with case variations, are within the limit.
	const fifty = Array.from({ length: 50 }, (_, i) => `r${i}@elsewhere.test`);
	accepted(await submit(context, { rcpt: [...fifty, ...fifty.slice(0, 10).map((address) => address.toUpperCase())], message: simple({ To: "r0@elsewhere.test" }) }));
	assert.equal(context.sent[0].bcc.length, 49);
	assert.equal(app.MAX_SUBMISSION_RECIPIENTS, app.MAX_RECIPIENTS);
	assert.equal(context.outbound().length, 1);
});

test("smtp-1 C6: sender authorization — MAIL FROM and From must agree and both pass the existing sender rule", async (t) => {
	const context = await install(t);
	const go = (from, headers = {}, as) => submit(context, { from, message: simple({ From: from, ...headers }), as });
	// Allowed: the mailbox address and its alias, case-insensitively.
	accepted(await go("ann@example.test"));
	accepted(await go("Annie@Example.test", { From: "annie@example.test" }));
	// The same local part on the owner's other domain, while "use all domains" is on (the default).
	accepted(await go("ann@other.test"));
	// Refused: another local user's address, another of the same user's mailboxes, an external address.
	for (const from of ["xavier@example.test", "ops@example.test", "ceo@bank.test", "ops@other.test"]) {
		const result = failure(await go(from));
		assert.deepEqual([result.kind, result.reason], ["unauthorized_sender", "sender_address_not_permitted"], from);
	}
	context.exec("UPDATE mailboxes SET use_all_domains = 0 WHERE id = 'mbx-a'");
	assert.equal(failure(await go("ann@other.test")).reason, "sender_address_not_permitted", "the domain rule is evaluated at send time");
	context.exec("UPDATE mailboxes SET use_all_domains = 1 WHERE id = 'mbx-a'");
	// MAIL FROM and From must name the same address, whichever is the authorized one.
	assert.equal(failure(await submit(context, { from: "ann@example.test", message: simple({ From: "xavier@example.test" }) })).reason, "from_mail_from_mismatch");
	assert.equal(failure(await submit(context, { from: "xavier@example.test", message: simple({ From: "ann@example.test" }) })).reason, "sender_address_not_permitted");
	assert.equal(failure(await submit(context, { from: "annie@example.test", message: simple({ From: "ann@example.test" }) })).reason, "from_mail_from_mismatch");
	// The null reverse-path and malformed MAIL FROM.
	assert.deepEqual(Object.values((({ kind, reason }) => ({ kind, reason }))(failure(await go("")))), ["unauthorized_sender", "null_sender"]);
	assert.equal(failure(await go("ann@example.test>")).reason, "mail_from_invalid");
	// From must be exactly one mailbox.
	assert.equal(failure(await submit(context, { message: simple({ From: "ann@example.test, xavier@example.test" }) })).reason, "from_invalid");
	assert.equal(failure(await submit(context, { message: rawBytes("From: ann@example.test\nFrom: xavier@example.test\nTo: bob@elsewhere.test\n\nx\n") })).reason, "from_invalid");
	assert.equal(failure(await submit(context, { message: simple({ From: "team: ann@example.test;" }) })).reason, "from_invalid");
	assert.equal(failure(await submit(context, { message: simple({ From: null }) })).reason, "from_invalid");
	// Display-name manipulation changes nothing: the name is replaced, the address decides.
	accepted(await go("ann@example.test", { From: '"ceo@bank.test" <ann@example.test>' }));
	assert.ok(!context.sent.at(-1).from.includes("bank"), "a spoofed display name is replaced by the mailbox's");
	assert.equal(failure(await go("ann@example.test", { From: '"ann@example.test" <xavier@example.test>' })).reason, "from_mail_from_mismatch");
	// Sender: the From address is harmless and dropped; any other identity is refused.
	accepted(await go("ann@example.test", { Sender: "Ann <ANN@example.test>" }));
	assert.equal(failure(await go("ann@example.test", { Sender: "xavier@example.test" })).reason, "sender_header_mismatch");
	assert.equal(failure(await go("ann@example.test", { Sender: "ann@example.test, x@example.test" })).reason, "sender_header_mismatch");
	assert.ok(!context.sent.some((message) => JSON.stringify(message).includes("Sender")));
});

test("smtp-1 C7: the principal is re-authorized for every message: credential, scope, account, mailbox permission", async (t) => {
	const context = await install(t);
	const sales = (id, userId) => submit(context, { from: "sales@example.test", message: simple({ From: "sales@example.test" }), as: principal(id, userId, "mbx-s") });
	// Shared mailbox: send_as and send_on_behalf send under the existing display-name policy; read_only cannot.
	accepted(await sales("map-b", "user-b"));
	assert.equal(context.sent.at(-1).from, '"Sales" <sales@example.test>');
	accepted(await sales("map-c", "user-c"));
	assert.equal(context.sent.at(-1).from, '"Cal on behalf of Sales" <sales@example.test>');
	assert.equal(failure(await sales("map-r", "user-r")).reason, "send_permission_denied");
	// Sharing turned off by policy removes delegated sending immediately.
	process.env.BLUEPINE_DISABLED_FEATURES = "sharedMailboxes";
	t.after(() => { delete process.env.BLUEPINE_DISABLED_FEATURES; });
	assert.equal(failure(await sales("map-b", "user-b")).kind, "unauthorized_sender");
	delete process.env.BLUEPINE_DISABLED_FEATURES;
	// The credential must still be smtp-scoped and belong to exactly this user and mailbox.
	const credentialCases = [
		[principal("map-a-imap"), "credential_unavailable"],
		[principal("map-missing"), "credential_unavailable"],
		[principal("map-o"), "credential_unavailable"],
		[principal("map-a", "user-x"), "credential_unavailable"],
		[principal("map-x", "user-x", "mbx-a"), "credential_unavailable"],
	];
	for (const [as, reason] of credentialCases) assert.equal(failure(await submit(context, { as, message: simple() })).reason, reason, as.appPasswordId);
	accepted(await submit(context, { as: principal("map-a-both"), message: simple() }));
	// Revoked or narrowed mid-session: the next message is refused.
	context.exec("UPDATE mail_app_passwords SET scopes = '[\"imap\"]' WHERE id = 'map-a-both'");
	assert.equal(failure(await submit(context, { as: principal("map-a-both"), message: simple() })).reason, "credential_unavailable");
	context.exec("DELETE FROM mail_app_passwords WHERE id = 'map-a'");
	assert.equal(failure(await submit(context, { message: simple() })).reason, "credential_unavailable");
	// A disabled account or mailbox.
	context.exec("UPDATE users SET disabled = 1 WHERE id = 'user-b'");
	assert.equal(failure(await sales("map-b", "user-b")).reason, "sender_account_unavailable");
	context.exec("UPDATE mailboxes SET disabled = 1 WHERE id = 'mbx-s'");
	assert.equal(failure(await sales("map-c", "user-c")).kind, "unauthorized_sender");
	// The MAIL FROM pre-check for the listener applies the same rules.
	assert.deepEqual(await app.authorizeSubmissionSender(context.env, principal("map-o", "user-a", "mbx-o"), "ops@example.test"), { ok: true });
	const denied = await app.authorizeSubmissionSender(context.env, principal("map-o", "user-a", "mbx-o"), "ann@example.test");
	assert.deepEqual([denied.ok, denied.failure.reason, denied.failure.retrySafe], [false, "sender_address_not_permitted", true]);
	assert.equal((await app.authorizeSubmissionSender(context.env, principal("map-a-imap"), "ann@example.test")).failure.reason, "credential_unavailable");
	assert.equal((await app.authorizeSubmissionSender(context.env, principal("map-o", "user-a", "mbx-o"), "")).failure.reason, "null_sender");
});

test("smtp-1 C8: signed or encrypted MIME is refused as unsupported, never rebuilt", async (t) => {
	const context = await install(t);
	const head = "From: ann@example.test\nTo: bob@elsewhere.test\nSubject: S\nMIME-Version: 1.0\n";
	const messages = {
		"S/MIME signed": `${head}Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="b1"\n\n--b1\nContent-Type: text/plain\n\nsigned text\n--b1\nContent-Type: application/pkcs7-signature; name=smime.p7s\nContent-Transfer-Encoding: base64\n\nAAAA\n--b1--\n`,
		"PGP/MIME signed": `${head}Content-Type: multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256; boundary="b1"\n\n--b1\nContent-Type: text/plain\n\nsigned text\n--b1\nContent-Type: application/pgp-signature; name=signature.asc\n\n-----BEGIN PGP SIGNATURE-----\nAAAA\n-----END PGP SIGNATURE-----\n--b1--\n`,
		"PGP/MIME encrypted": `${head}Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"\n\n--b1\nContent-Type: application/pgp-encrypted\n\nVersion: 1\n--b1\nContent-Type: application/octet-stream; name=encrypted.asc\n\n-----BEGIN PGP MESSAGE-----\nAAAA\n-----END PGP MESSAGE-----\n--b1--\n`,
		"S/MIME encrypted": `${head}Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name=smime.p7m\nContent-Transfer-Encoding: base64\n\nAAAA\n`,
		"signed part nested in mixed": `${head}Content-Type: multipart/mixed; boundary="m"\n\n--m\nContent-Type: multipart/signed; protocol="application/pgp-signature"; boundary="b1"\n\n--b1\nContent-Type: text/plain\n\nx\n--b1\nContent-Type: application/pgp-signature\n\nsig\n--b1--\n--m--\n`,
	};
	for (const [label, text] of Object.entries(messages)) {
		const result = failure(await submit(context, { message: rawBytes(text) }));
		assert.deepEqual([result.kind, result.reason, result.temporary], ["unsupported_message", "signed_or_encrypted", false], label);
	}
	assertNothingStored(context);
	// A public key attachment is not a signature.
	accepted(await submit(context, { message: await compose({ from: "ann@example.test", to: "bob@elsewhere.test", subject: "key", text: "my key", attachments: [{ filename: "key.asc", content: "-----BEGIN PGP PUBLIC KEY BLOCK-----", contentType: "application/pgp-keys" }] }) }));
});

test("smtp-1 C9: malformed and oversized input is refused; the size bound is checked before parsing", async (t) => {
	const context = await install(t);
	const cases = [
		[new Uint8Array(0), "malformed_message"],
		[rawBytes("just some text without headers\n"), "malformed_message"],
		[rawBytes("\nFrom: ann@example.test\n\nx\n"), "malformed_message"],
		[rawBytes("From: ann@example.test\nTo: bob@elsewhere.test\n\nnul\0byte\n"), "malformed_message"],
		[rawBytes(`From: ann@example.test\nTo: bob@elsewhere.test\nContent-Type: multipart/mixed; boundary=a\n\n${"--a\nContent-Type: multipart/mixed; boundary=a\n\n".repeat(40)}`), "malformed_message"],
	];
	for (const [message, reason] of cases) assert.equal(failure(await submit(context, { message })).reason, reason);
	const oversized = new Uint8Array(app.MAX_SUBMISSION_MESSAGE_BYTES + 1);
	oversized.set(simple());
	const parse = t.mock.method(app.PostalMime, "parse");
	assert.deepEqual(Object.values((({ kind, reason }) => ({ kind, reason }))(failure(await submit(context, { message: oversized })))), ["invalid_message", "message_too_large"]);
	assert.equal(parse.mock.callCount(), 0);
	// Attachments beyond the outgoing limits are refused by the shared send path.
	const many = await compose({ from: "ann@example.test", to: "bob@elsewhere.test", subject: "many", text: "x", attachments: Array.from({ length: 11 }, (_, i) => ({ filename: `f${i}.txt`, content: "x" })) });
	assert.deepEqual(Object.values((({ kind, reason }) => ({ kind, reason }))(failure(await submit(context, { message: many })))), ["invalid_message", "attachments_invalid"]);
	assertNothingStored(context);
	// Plain text without headers beyond the minimum, and a message without any body part.
	accepted(await submit(context, { message: rawBytes("From: ann@example.test\nTo: bob@elsewhere.test\n\n") }));
	assert.deepEqual([context.sent[0].subject, context.sent[0].text], ["", ""]);
});

test("smtp-1 C10: a pre-acceptance failure leaves no Sent artifact, so retries never accumulate; the retry sends once", async (t) => {
	const context = await install(t);
	let attempts = 0;
	context.fake.behavior = () => {
		attempts += 1;
		if (attempts <= 3) throw Object.assign(new Error("Connection refused"), { code: "ESOCKET", syscall: "connect" });
		return null;
	};
	const message = await compose({ from: "ann@example.test", to: "bob@elsewhere.test", subject: "Retry", text: "x", attachments: [{ filename: "a.png", content: Buffer.from(PNG) }] });
	for (let i = 0; i < 3; i++) {
		const result = failure(await submit(context, { message }));
		assert.deepEqual([result.kind, result.delivery, result.retrySafe, result.temporary], ["transport_temporary", "not_attempted", true, true]);
		assert.equal(context.outbound().length, 0, "no failed copy is kept");
		assert.equal(context.one("SELECT COUNT(*) AS n FROM message_attachments").n, 0);
		assert.deepEqual([...context.bucket.objects.keys()], []);
	}
	accepted(await submit(context, { message }));
	assert.equal(context.sent.length, 1, "delivered once");
	const rows = context.outbound();
	assert.deepEqual(rows.map((row) => row.status), ["sent"], "exactly one Sent message after three failed attempts and a success");
	const jobs = context.jobs();
	assert.deepEqual(jobs.map((job) => job.status).sort(), ["failed", "failed", "failed", "sent"], "every attempt is on record");
	assert.ok(jobs.filter((job) => job.status === "failed").every((job) => job.message_id === null && JSON.parse(job.payload).discarded === true));
});

test("smtp-1 C11: an ambiguous transport failure is never reported as safe to retry; an unexpected provider exception fails closed", async (t) => {
	const context = await install(t);
	t.mock.method(console, "error", () => {});
	context.fake.behavior = () => { throw Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION" }); };
	const unknown = failure(await submit(context, { message: simple() }));
	assert.deepEqual([unknown.kind, unknown.delivery, unknown.retrySafe, unknown.temporary], ["transport_temporary", "unknown", false, true]);
	assert.equal(context.outbound().length, 0);
	assert.match(context.jobs()[0].error, /delivery=unknown/, "the job row records that the outcome is unknown");
	for (const thrown of [new TypeError("cannot read properties of undefined"), "plain string", null]) {
		context.fake.behavior = () => { throw thrown; };
		const result = failure(await submit(context, { message: simple() }));
		assert.deepEqual([result.kind, result.delivery, result.retrySafe], ["transport_temporary", "unknown", false]);
	}
	// A rejected message is permanent and safe; a deferral is temporary and safe.
	context.fake.behavior = () => { throw Object.assign(new Error("Message failed: 554 no"), { code: "EMESSAGE", responseCode: 554 }); };
	assert.deepEqual(Object.values((({ kind, delivery, retrySafe, temporary }) => ({ kind, delivery, retrySafe, temporary }))(failure(await submit(context, { message: simple() })))), ["delivery_rejected", "rejected", true, false]);
	assert.equal(context.outbound().length, 0);
});

test("smtp-1 C12: post-acceptance failures through the adapter answer accepted, with the Sent row kept", async (t) => {
	for (const [issue, inject] of POST_ACCEPTANCE_FAULTS) {
		await t.test(issue, async (st) => {
			const context = await install(st);
			st.mock.method(console, "error", () => {});
			inject(context);
			const result = accepted(await submit(context, { message: simple() }));
			assert.deepEqual(result.degraded, [issue]);
			assert.equal(context.sent.length, 1);
			assert.equal(context.outbound().length, 1, "never discarded after acceptance");
		});
	}
});

test("smtp-1 C13: database failures inside the adapter fail closed before anything is sent", async (t) => {
	const context = await install(t);
	t.mock.method(console, "error", () => {});
	context.exec("ALTER TABLE mail_app_passwords RENAME TO gone;");
	const credential = failure(await submit(context, { message: simple() }));
	assert.deepEqual([credential.kind, credential.reason, credential.delivery], ["internal_temporary", "authorization_unavailable", "not_attempted"]);
	context.exec("ALTER TABLE gone RENAME TO mail_app_passwords; ALTER TABLE mailbox_aliases RENAME TO gone;");
	assert.deepEqual(Object.values((({ kind, reason, delivery }) => ({ kind, reason, delivery }))(failure(await submit(context, { message: simple() })))), ["internal_temporary", "authorization_unavailable", "not_attempted"]);
	context.exec("ALTER TABLE gone RENAME TO mailbox_aliases; ALTER TABLE messages RENAME TO gone;");
	assert.equal(failure(await submit(context, { message: simple({ "In-Reply-To": "<p@elsewhere.test>" }) })).kind, "internal_temporary", "the thread lookup");
	context.exec("ALTER TABLE gone RENAME TO messages;");
	context.exec("CREATE TRIGGER t_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected'); END;");
	assert.deepEqual(Object.values((({ kind, retrySafe }) => ({ kind, retrySafe }))(failure(await submit(context, { message: simple() })))), ["internal_temporary", true]);
	assertNothingStored(context);
});

test("smtp-1 C13b: a failing logger after acceptance, and a failing thread lookup before it, are both contained", async (t) => {
	const context = await install(t);
	// Before SMTP-1's logging hardening, a throwing logger turned a post-acceptance failure
	// into a thrown error after delivery.
	t.mock.method(console, "error", () => { throw new Error("log sink down"); });
	context.exec("CREATE TRIGGER t_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'injected'); END;");
	const result = accepted(await submit(context, { message: simple() }));
	assert.deepEqual(result.degraded, ["audit_log"]);
	assert.equal(context.sent.length, 1);
	const outcome = await app.sendEmailWithOutcome(context.env, { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "S", text: "t" });
	assert.deepEqual([outcome.status, outcome.degraded], ["accepted", ["audit_log"]]);
	context.exec("DROP TRIGGER t_audit;");
	t.mock.restoreAll();

	// Only the parent-thread query fails: the submission fails closed instead of guessing a thread.
	const real = context.env.DB;
	context.env.DB = new Proxy(real, {
		get(target, property) {
			if (property === "prepare") {
				return (sql) => {
					if (/from "messages" where .*"provider_message_id" in/i.test(sql)) throw new Error("injected thread lookup failure");
					return target.prepare(sql);
				};
			}
			const value = target[property];
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const lookup = failure(await submit(context, { message: simple({ "In-Reply-To": "<p@elsewhere.test>" }) }));
	assert.deepEqual([lookup.kind, lookup.delivery, lookup.retrySafe], ["internal_temporary", "not_attempted", true]);
	assert.equal(context.sent.length, 2, "nothing more was sent");
	context.env.DB = real;
});

test("smtp-1 C14: nothing sensitive reaches the logs: no bodies, subjects, attachments or credentials", async (t) => {
	const context = await install(t);
	const lines = [];
	for (const method of ["log", "error", "warn", "info"]) t.mock.method(console, method, (...args) => lines.push(args.map(String).join(" ")));
	const message = await compose({ from: "ann@example.test", to: "bob@elsewhere.test", subject: "SUBJECT-CANARY", text: "BODY-CANARY", attachments: [{ filename: "a.txt", content: "ATTACHMENT-CANARY" }] });
	for (const [, inject] of POST_ACCEPTANCE_FAULTS) inject(context);
	await submit(context, { message });
	context.fake.behavior = () => { throw Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION" }); };
	await submit(context, { message });
	context.exec("ALTER TABLE mail_app_passwords RENAME TO gone;");
	await submit(context, { message });
	const output = lines.join("\n");
	assert.ok(lines.length > 0);
	for (const canary of ["SUBJECT-CANARY", "BODY-CANARY", "ATTACHMENT-CANARY", "p-a", "secret_hash"]) assert.ok(!output.includes(canary), canary);
});

test("smtp-1 C14b: database errors never carry message content into errors, logs or job rows", async (t) => {
	// drizzle's query errors list every bound parameter, message bodies included.
	const drizzleLike = Object.assign(new Error('Failed query: insert into "messages" ("text_body") values (?)\nparams: BODY-CANARY'), { cause: new Error("SQLITE_CONSTRAINT: injected") });
	assert.equal(app.safeErrorText(drizzleLike), 'Failed query: insert into "messages" ("text_body") values (?) (SQLITE_CONSTRAINT: injected)');
	assert.equal(app.toSendError(drizzleLike).message.includes("CANARY"), false);

	const context = await install(t);
	const lines = [];
	for (const method of ["log", "error", "warn", "info"]) t.mock.method(console, method, (...args) => lines.push(args.map(String).join(" ")));
	const input = { userId: "user-a", mailboxId: "mbx-a", from: "ann@example.test", to: "canary-rcpt@elsewhere.test", subject: "SUBJECT-CANARY", text: "BODY-CANARY" };
	const errors = [];
	for (const trigger of [
		"CREATE TRIGGER t_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected'); END;",
		"CREATE TRIGGER t_fail BEFORE INSERT ON outbound_jobs BEGIN SELECT RAISE(ABORT, 'injected'); END;",
		"CREATE TRIGGER t_fail BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'injected'); END;",
		"CREATE TRIGGER t_fail BEFORE UPDATE OF status ON messages WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'injected'); END;",
	]) {
		context.exec(trigger);
		for (const policy of ["retain", "discard"]) {
			errors.push(await app.sendEmailWithOutcome(context.env, input, { failedAttempt: policy }).then((outcome) => JSON.stringify(outcome), (error) => `${error.message} ${error.reason}`));
		}
		context.exec("DROP TRIGGER t_fail;");
	}
	const stored = JSON.stringify(context.all("SELECT error FROM outbound_jobs"));
	for (const [label, text] of [["errors", errors.join("\n")], ["logs", lines.join("\n")], ["job errors", stored]]) {
		for (const canary of ["BODY-CANARY", "SUBJECT-CANARY", "canary-rcpt"]) assert.ok(!text.includes(canary), `${canary} in ${label}`);
	}
	assert.ok(lines.some((line) => line.includes("injected")), "the driver's reason is still logged");
});

test("smtp-1 C15: limiter identity for the listener is per account and per credential", () => {
	assert.deepEqual(app.submissionUtils.submissionLimiterKeys(principal()), { user: "smtp-submission:user:user-a", credential: "smtp-submission:credential:map-a" });
	assert.equal(app.submissionUtils.normalizeMailboxAddress(" Bob.Smith+tag@Sub.Example.TEST "), "bob.smith+tag@sub.example.test");
	for (const bad of ["", "@x.test", "a@", "a..b@x.test", ".a@x.test", "a@x", "a b@x.test", "a@x_y.test", `${"a".repeat(65)}@x.test`, "ä@x.test", "a@-x.test"]) {
		assert.equal(app.submissionUtils.normalizeMailboxAddress(bad), null, bad);
	}
});

// ---- D. The real Node transport against a loopback test relay ------------------------------

/** A loopback SMTP relay fixture, as Mailpit stands in for the operator's relay. */
async function relay(t, behavior = {}) {
	const received = [];
	const server = new SMTPServer({
		authOptional: true,
		disabledCommands: ["STARTTLS", "AUTH"],
		logger: false,
		onRcptTo(address, session, callback) {
			if (behavior.rcpt) return behavior.rcpt(address, callback);
			callback();
		},
		onData(stream, session, callback) {
			const chunks = [];
			stream.on("data", (chunk) => chunks.push(chunk));
			stream.on("end", () => {
				const raw = Buffer.concat(chunks);
				received.push({ envelope: session.envelope, raw: raw.toString("utf8") });
				if (behavior.data) return behavior.data(callback, sockets);
				callback();
			});
		},
	});
	const sockets = new Set();
	server.server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	return { received, sockets, url: `smtp://127.0.0.1:${server.server.address().port}`, server };
}

test("smtp-1 D1: through the real Node Mailer, Bcc reaches the envelope only and the message keeps its threading and Reply-To", async (t) => {
	const target = await relay(t);
	const context = await install(t, { transport: new app.Mailer({ kind: "smtp", url: target.url }) });
	const message = await compose({ from: "ann@example.test", to: "bob@elsewhere.test", bcc: "dave@elsewhere.test", replyTo: "help@example.test", subject: "Real", text: "real body", inReplyTo: "<p@elsewhere.test>", references: ["<p@elsewhere.test>"], messageId: "<client@thunderbird.test>" });
	const result = accepted(await submit(context, { rcpt: ["bob@elsewhere.test", "dave@elsewhere.test"], message }));
	const [delivered] = target.received;
	assert.deepEqual(delivered.envelope.rcptTo.map((entry) => entry.address).sort(), ["bob@elsewhere.test", "dave@elsewhere.test"]);
	assert.equal(delivered.envelope.mailFrom.address, "ann@example.test");
	const headers = delivered.raw.split("\r\n\r\n")[0];
	assert.ok(!/^bcc:/im.test(headers), "no Bcc header in the delivered message");
	assert.ok(!delivered.raw.includes("dave@"), "the blind recipient appears nowhere in the delivered message");
	assert.match(headers, /^Reply-To: help@example\.test$/m);
	assert.match(headers, /^In-Reply-To: <p@elsewhere\.test>$/m);
	assert.ok(!headers.includes("client@thunderbird.test"), "the client's Message-ID is replaced");
	const messageId = headers.match(/^Message-ID: (<[^>]+>)$/m)[1];
	assert.equal(result.providerMessageId, messageId, "the Sent copy's Message-ID is the one actually delivered");
	assert.equal(context.outbound()[0].provider_message_id, messageId);
});

test("smtp-1 D2: real relay refusals, deferrals, a refused connection and a connection lost after DATA are classified correctly", async (t) => {
	t.mock.method(console, "error", () => {});
	const outcome = async (behavior) => {
		const target = await relay(t, behavior);
		const context = await install(t, { transport: new app.Mailer({ kind: "smtp", url: target.url }) });
		const result = failure(await submit(context, { message: simple() }));
		assert.equal(context.outbound().length, 0);
		return [result.kind, result.delivery, result.retrySafe];
	};
	assert.deepEqual(await outcome({ data: (callback) => callback(Object.assign(new Error("rejected"), { responseCode: 554 })) }), ["delivery_rejected", "rejected", true]);
	assert.deepEqual(await outcome({ data: (callback) => callback(Object.assign(new Error("later"), { responseCode: 451 })) }), ["transport_temporary", "rejected", true]);
	assert.deepEqual(await outcome({ rcpt: (address, callback) => callback(Object.assign(new Error("no such user"), { responseCode: 550 })) }), ["delivery_rejected", "rejected", true]);
	// The relay received the whole message, then the connection died before its reply.
	let delivered = 0;
	assert.deepEqual(await outcome({ data: (callback, sockets) => { delivered += 1; for (const socket of sockets) socket.destroy(); } }), ["transport_temporary", "unknown", false]);
	assert.equal(delivered, 1, "the relay had the whole message: a retry could deliver it twice");
	// Nothing listening: the connection was refused before any data moved.
	const closed = await relay(t);
	await new Promise((resolve) => closed.server.close(resolve));
	const context = await install(t, { transport: new app.Mailer({ kind: "smtp", url: closed.url }) });
	const refused = failure(await submit(context, { message: simple() }));
	assert.deepEqual([refused.kind, refused.delivery, refused.retrySafe], ["transport_temporary", "not_attempted", true]);
	// No transport configured at all.
	const none = await install(t, { transport: new app.Mailer({ kind: "none" }) });
	const unconfigured = failure(await submit(none, { message: simple() }));
	assert.deepEqual([unconfigured.kind, unconfigured.reason, unconfigured.delivery], ["transport_temporary", "transport_configuration", "not_attempted"]);
});

// ---- E. Regression: the existing send surfaces ---------------------------------------------

test("smtp-1 E1: web /api/send, API v1 and JMAP EmailSubmission keep their contracts", async (t) => {
	const context = await install(t);
	const token = await app.createSession(context.env, "user-a");
	const web = await app.sendRoute(new Request("http://localhost/api/send", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "Web", text: "w" }) }));
	assert.equal(web.status, 200);
	assert.ok((await web.json()).messageId);
	const forbidden = await app.sendRoute(new Request("http://localhost/api/send", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId: "mbx-a", from: "xavier@example.test", to: "bob@elsewhere.test", subject: "Web", text: "w" }) }));
	assert.deepEqual([forbidden.status, (await forbidden.json()).error], [403, "Sender address does not match the selected mailbox"]);
	// A post-acceptance failure is now a success for the web too (it was a 500 after delivery).
	t.mock.method(console, "error", () => {});
	context.exec("CREATE TRIGGER t_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'injected'); END;");
	const degraded = await app.sendRoute(new Request("http://localhost/api/send", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "Web2", text: "w" }) }));
	assert.equal(degraded.status, 200);
	context.exec("DROP TRIGGER t_audit;");
	// A transport failure keeps the web's failed row and 500, as before.
	context.fake.behavior = () => { throw new Error("provider down"); };
	const failed = await app.sendRoute(new Request("http://localhost/api/send", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId: "mbx-a", from: "ann@example.test", to: "bob@elsewhere.test", subject: "Web3", text: "w" }) }));
	assert.deepEqual([failed.status, (await failed.json()).error], [500, "provider down"]);
	assert.deepEqual(context.outbound().map((row) => [row.subject, row.status]).sort(), [["Web", "sent"], ["Web2", "sent"], ["Web3", "failed"]]);
	context.fake.behavior = null;

	// API v1 with a send-scoped key: success, and the sender rule as a 403.
	const sendKey = app.generateApiKey();
	context.database.db.prepare("INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, created_at) VALUES ('k-send', 'legacy', 'user-a', 'send', ?, ?, ?, 1)").run(sendKey.prefix, sendKey.hash, JSON.stringify(["send"]));
	const v1 = (from) => app.apiV1SendRoute(new Request("http://localhost/api/v1/send", { method: "POST", headers: { Authorization: `Bearer ${sendKey.fullKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId: "mbx-a", from, to: "bob@elsewhere.test", subject: "V1", text: "v", attachments: [{ filename: "a.png", type: "image/png", contentBase64: Buffer.from(PNG).toString("base64") }] }) }));
	const v1ok = await v1("ann@example.test");
	assert.equal(v1ok.status, 200);
	assert.equal(context.one("SELECT status FROM messages WHERE id = ?", (await v1ok.json()).messageId).status, "sent");
	assert.equal(context.sent.at(-1).attachments[0].filename, "a.png");
	assert.equal((await v1("ceo@bank.test")).status, 403);

	// JMAP: a draft submitted through EmailSubmission/set becomes one sent row; the draft goes.
	context.exec(`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, bcc_addr, subject, text_body, status, created_at) VALUES ('draft-1', 'user-a', 'mbx-a', 'outbound', 'ann@example.test', 'bob@elsewhere.test', 'hidden@elsewhere.test', 'Jmap', 'j', 'draft', 1)`);
	const { fullKey, prefix, hash } = app.generateApiKey();
	context.database.db.prepare("INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, created_at) VALUES ('k1', 'legacy', 'user-a', 'jmap', ?, ?, ?, 1)").run(prefix, hash, JSON.stringify(["jmap"]));
	const identities = await app.handleJmapRequest(new Request("http://localhost/jmap/api", { method: "POST", headers: { Authorization: `Bearer ${fullKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"], methodCalls: [["Identity/get", { accountId: "user-a" }, "0"]] }) }), context.env);
	const identity = (await identities.json()).methodResponses[0][1].list.find((entry) => entry.email === "ann@example.test");
	const submission = await app.handleJmapRequest(new Request("http://localhost/jmap/api", { method: "POST", headers: { Authorization: `Bearer ${fullKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"], methodCalls: [["EmailSubmission/set", { accountId: "user-a", create: { s1: { emailId: "draft-1", identityId: identity.id } } }, "0"]] }) }), context.env);
	const created = (await submission.json()).methodResponses[0][1].created.s1;
	assert.ok(created.id);
	assert.equal(context.one("SELECT status FROM messages WHERE id = ?", created.id).status, "sent");
	assert.equal(context.one("SELECT COUNT(*) AS n FROM messages WHERE id = 'draft-1'").n, 0);
	assert.deepEqual(context.sent.at(-1).bcc, ["hidden@elsewhere.test"]);
});
