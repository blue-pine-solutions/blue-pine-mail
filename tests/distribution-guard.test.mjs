import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const BLUE_PINE_REPOSITORY = "https://github.com/blue-pine-solutions/blue-pine-mail";
const UPSTREAM_REPOSITORY = "https://github.com/hieunc229/mailflare";

test("LICENSE keeps the upstream Mailflare copyright notice", () => {
	assert.ok(existsSync(join(root, "LICENSE")), "LICENSE must exist");
	const license = read("LICENSE");
	assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/);
	assert.match(license, /Mailflare - Email for professionals and teams/);
	assert.match(license, /Copyright \(C\) 2026 Hieu Nguyen/);
});

test("NOTICE identifies Blue Pine Solutions Mail as a modified downstream version", () => {
	assert.ok(existsSync(join(root, "NOTICE")), "NOTICE must exist");
	const notice = read("NOTICE");
	assert.match(notice, /Blue Pine Solutions Mail is a modified, downstream version of Mailflare/);
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

const BROWSER_IDENTIFIERS = [
	["src/components/messages/message-detail-navigation-utils.ts", 'const openedUnreadKey = "mailflare-navigation-opened-unread";'],
	["src/components/messages/use-two-column-reading.ts", 'const STORAGE_KEY = "mailflare-two-column-reading";'],
	["src/components/messages/use-two-column-reading.ts", 'const CHANGE_EVENT = "mailflare:two-column-reading-changed";'],
];

test("upstream browser storage keys and event names keep their names", () => {
	const upstream = read("UPSTREAM.md");
	for (const [path, declaration] of BROWSER_IDENTIFIERS) {
		const identifier = declaration.match(/"([^"]+)"/)[1];
		assert.ok(upstream.includes(`\`${identifier}\``), `UPSTREAM.md must list ${identifier} as compatibility-sensitive`);
		assert.ok(read(path).includes(declaration), `${path} must keep ${identifier}`);
	}
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

test("forwarding follows Blue Pine policy and keeps the X-Mailflare-Forwarded loop guard", () => {
	for (const path of [
		"src/lib/email/account-forwarding.ts",
		"src/app/api/settings/forwarding/route.ts",
		"src/app/api/settings/profile/route.ts",
		"src/app/api/auth/me/route.ts",
		"src/app/api/accounts/[id]/route.ts",
		"src/app/api/v1/accounts/[id]/utils.ts",
	]) {
		const source = read(path);
		assert.doesNotMatch(source, /getLicenseEntitlements|@\/lib\/licenses|Pro or Team/, `${path} must not use upstream license entitlements`);
		assert.match(source, /getFeaturePolicy\(\)\.accountForwarding/, `${path} must use the accountForwarding policy`);
	}
	assert.match(read("src/lib/email/account-forwarding.ts"), /export const MAILFLARE_FORWARDED_HEADER = "X-Mailflare-Forwarded";/);
	assert.match(read("src/lib/email/intake.ts"), /alreadyForwarded[\s\S]*MAILFLARE_FORWARDED_HEADER[\s\S]*if \(!alreadyForwarded\)/);
	assert.match(read("worker.ts"), /message\.headers\.get\(MAILFLARE_FORWARDED_HEADER\) !== "1"/);
});

const DOCUMENTS = ["README.md", ...readdirSync(join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`), "deploy/cloudflare-email-relay/README.md"];

test("the README presents Blue Pine Solutions Mail as a downstream of Mailflare under the AGPL", () => {
	const readme = read("README.md");
	assert.match(readme, /^# Blue Pine Solutions Mail\b/);
	assert.match(readme, /Blue Pine Solutions/);
	assert.ok(readme.includes(UPSTREAM_REPOSITORY), "README must link the upstream project");
	assert.match(readme, /Hieu Nguyen/);
	assert.match(readme, /not affiliated with or endorsed by the Mailflare project/);
	assert.match(readme, /AGPL-3\.0-or-later/);
	assert.doesNotMatch(readme, /^# Mailflare/m);
});

test("documentation no longer describes the removed licensing layer or upstream updater", () => {
	for (const path of [...DOCUMENTS, "package.json", ".dev.vars.example", ".env.docker.example"]) {
		const text = read(path);
		assert.doesNotMatch(text, /paymug|Branding license|license key|(Team|Pro) license|GITHUB_UPDATE_|MAILFLARE_UPDATE_TOKEN|deploy-update|Update Mailflare|mailflare\.co\b/i, `${path} mentions removed licensing or update material`);
	}
	assert.ok(!existsSync(join(root, ".github/FUNDING.yml")), "upstream funding metadata is not republished by the downstream repository");
	assert.ok(!existsSync(join(root, ".github/workflows/deploy-update.yml")));
});

const SHIPPED_ROOTS = ["src", "server", "scripts", "docs", "deploy", "public", "worker.ts", "README.md", "NOTICE", "UPSTREAM.md", "CLAUDE.md", "package.json", "Dockerfile", "wrangler.jsonc.example", ".dev.vars.example", ".env.docker.example"];

function shippedTextFiles() {
	const files = [];
	const visit = (path) => {
		const full = join(root, path);
		if (!existsSync(full)) return;
		if (statSync(full).isDirectory()) {
			for (const name of readdirSync(full)) visit(`${path}/${name}`);
		} else if (!/\.(png|jpe?g|gif|ico|webp|woff2?|mp4|wav)$/i.test(path)) {
			files.push(path);
		}
	};
	for (const path of SHIPPED_ROOTS) visit(path);
	return files;
}

test("source, release and deployment links name the public Blue Pine repository, not the legacy fork or the private one", () => {
	for (const path of shippedTextFiles()) {
		const text = read(path);
		assert.doesNotMatch(text, /bofa-ds\/mailflare/, `${path} still points at the legacy fork`);
		assert.doesNotMatch(text, /blue-pine-mail-dev/, `${path} exposes the private development repository`);
	}
	assert.match(read("src/lib/distribution/identity.ts"), /sourceRepository: "https:\/\/github\.com\/blue-pine-solutions\/blue-pine-mail",/);
	assert.ok(read("docs/deployment.md").includes(`(https://deploy.workers.cloudflare.com/?url=${BLUE_PINE_REPOSITORY})`), "the Deploy button deploys the public repository");
	assert.ok(read("docs/self-hosting.md").includes(`git clone ${BLUE_PINE_REPOSITORY} `), "self-hosting clones the public repository");
	assert.match(read("NOTICE"), new RegExp(`Corresponding Source for Blue Pine Solutions Mail is available at:\\s+${BLUE_PINE_REPOSITORY.replaceAll(".", "\\.")}\\s`));
	assert.match(read("package.json"), /"release:verify-source": "node scripts\/verify-public-source\.mjs"/);
});

test("relative links in the documentation point at files that exist", () => {
	for (const path of DOCUMENTS) {
		const text = read(path);
		for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
			if (/^(https?:|mailto:|#)/.test(target)) continue;
			const file = target.split("#")[0];
			assert.ok(existsSync(join(root, dirname(path), file)), `${path} links to missing ${target}`);
		}
	}
	assert.ok(existsSync(join(root, ".env.docker.example")), "the self-hosting guide copies .env.docker.example");
});

/** Every .ts/.tsx file under a directory. */
function sourceFiles(directory) {
	return readdirSync(join(root, directory), { recursive: true })
		.map(String)
		.filter((file) => /\.(ts|tsx|mts)$/.test(file))
		.map((file) => join(directory, file));
}

test("the IMAP listener is Node-only: nothing the Worker compiles imports it or the protocol engine", () => {
	const workerSources = ["worker.ts", "worker-utils.ts", ...sourceFiles("src").filter((file) => !file.startsWith(join("src", "lib", "imap-server")))];
	for (const file of workerSources) {
		const source = read(file);
		assert.doesNotMatch(source, /from\s+["'][^"']*server\/runtime\//, `${file} imports the Node runtime`);
		assert.doesNotMatch(source, /from\s+["'](?:@\/lib\/imap-server|[^"']*\/imap-server\/)/, `${file} imports the IMAP protocol engine`);
	}
	// The protocol engine itself stays runtime-neutral, and only the Node entrypoint starts the listener.
	for (const file of sourceFiles(join("src", "lib", "imap-server"))) {
		assert.doesNotMatch(read(file), /from\s+["']node:|\bBuffer\b|\bprocess\./, `${file} must not use Node APIs`);
	}
	const starters = sourceFiles("server").filter((file) => /startImapListener\(/.test(read(file)) && !file.endsWith(join("runtime", "imap.ts")));
	assert.deepEqual(starters, [join("server", "index.ts")]);
});

test("the IMAP state layer, flag writes included, stays Workers/D1-safe", () => {
	// src/lib/imap/ is shared code: it must run on D1 (scripts/imap-state-d1-check.mjs) and never reach Node.
	for (const file of sourceFiles(join("src", "lib", "imap"))) {
		assert.doesNotMatch(read(file), /from\s+["']node:|\bBuffer\b|\bprocess\.|require\(/, `${file} must not use Node APIs`);
		assert.doesNotMatch(read(file), /from\s+["'](?:@\/lib\/imap-server|[^"']*server\/runtime\/)/, `${file} must not import the listener or the Node runtime`);
	}
	// Writes happen only through storeImapFlags, which only the listener calls; no Worker route does.
	// So do MOVE (A5.2b), recoverable EXPUNGE (A5.2a) and the post-MOVE spam training.
	for (const writer of ["storeImapFlags", "expungeImapFolder", "moveImapMessages", "trainImapSpamFeedback"]) {
		const callers = [...sourceFiles("src"), "worker.ts", "worker-utils.ts"].filter((file) => new RegExp(`\\b${writer}\\(`).test(read(file)) && dirname(file) !== join("src", "lib", "imap"));
		assert.deepEqual(callers, [join("src", "lib", "imap-server", "session.ts")], writer);
	}
	// UIDPLUS (A5.3): MOVE sends COPYUID in an untagged OK, from the mapping the relocation batch
	// read back (copyUidData); COPY (A5.8) sends it in its tagged OK, from what copyImapMessages'
	// commit read back, and only the listener copies messages. APPEND (A5.7) sends APPENDUID in
	// exactly one place, from what appendImapDraft's commit read back, and only the listener
	// creates drafts through it.
	const session = read(join("src", "lib", "imap-server", "session.ts"));
	assert.equal(session.match(/`\* OK \[COPYUID \$\{/g)?.length, 1);
	assert.match(session, /const copyUid = copyUidData\(result\.moved\);/);
	assert.match(session, /const copyUid = copyUidData\(result\.copied\);/);
	assert.equal(session.match(/\[COPYUID \$\{copyUid\}\]/g)?.length, 2, "COPYUID is built in exactly the MOVE and COPY answers");
	const copyCallers = [...sourceFiles("src"), "worker.ts", "worker-utils.ts"].filter((file) => /\bcopyImapMessages\(/.test(read(file)) && dirname(file) !== join("src", "lib", "imap"));
	assert.deepEqual(copyCallers, [join("src", "lib", "imap-server", "session.ts")], "copyImapMessages");
	// COPY never trains the spam filter: neither its handler nor A3's copy path calls the training.
	const copyHandler = session.slice(session.indexOf("private async copy("), session.indexOf("/** Post-MOVE spam training."));
	assert.ok(copyHandler.length > 0 && !/train/i.test(copyHandler), "the COPY handler does not train");
	const service = read(join("src", "lib", "imap", "service.ts"));
	const copyService = service.slice(service.indexOf("export async function copyImapMessages("), service.indexOf("async function countSources("));
	assert.ok(copyService.length > 0 && !/train|recordSpamTraining|spamTrainingStatements/.test(copyService), "A3's copy path does not train");
	// COPY's limits and its raw-object namespace (deletable on permanent expunge, like the other owned namespaces).
	const imapUtils = read(join("src", "lib", "imap", "utils.ts"));
	assert.match(imapUtils, /export const MAX_COPY_MESSAGES = 1000;/);
	assert.match(imapUtils, /export const MAX_COPY_BYTES = 256 \* 1024 \* 1024;/);
	assert.match(imapUtils, /namespace === "imports" \|\| namespace === "drafts" \|\| namespace === "copies"/);
	assert.equal(session.match(/\[APPENDUID/g)?.length, 1);
	assert.match(session, /OK \[APPENDUID \$\{result\.uidValidity\} \$\{result\.uid\}\] APPEND completed/);
	const appendCallers = [...sourceFiles("src"), "worker.ts", "worker-utils.ts"].filter((file) => /\bappendImapDraft\(/.test(read(file)) && dirname(file) !== join("src", "lib", "imap"));
	assert.deepEqual(appendCallers, [join("src", "lib", "imap-server", "session.ts")], "appendImapDraft");
	assert.match(session.match(/export const AUTH_CAPABILITIES = "([^"]*)"/)[1], /(^| )UIDPLUS( |$)/);
	assert.doesNotMatch(session.match(/export const AUTH_CAPABILITIES = "([^"]*)"/)[1], /LITERAL|MULTIAPPEND|APPENDLIMIT|CATENATE|BINARY/);
	assert.doesNotMatch(session, /UNSUPPORTED_COMMANDS|is not available on this server/, "every command offered is implemented");
	// The APPEND size limit is JMAP's maxSizeUpload itself, so the two cannot diverge.
	assert.match(read(join("src", "lib", "imap-server", "append.ts")), /export const MAX_APPEND_SIZE = LIMITS\.maxSizeUpload;/);
	// Mailbox management (A5.5a) goes through the R-1 service only; the engine never writes folders itself.
	assert.doesNotMatch(session, /insert\(folders\)|update\(folders\)|delete\(folders\)|FROM folders|INTO folders/);
	assert.match(session, /createFolder\(db, actor, mailboxId, name, \{ strictNames: true \}\)/);
	assert.match(session, /renameFolder\(db, actor, mailboxId, source\.folderId!, name, \{ strictNames: true \}\)/);
	assert.match(session, /deleteFolder\(db, actor, mailboxId, target\.folderId!, \{ removeMessages: true \}\)/);
	// IDLE (A5.4): the database is its only source of truth. Neither the engine nor the listener
	// may consult the process-local realtime hub, and only the listener polls the change signal.
	assert.match(session.match(/export const AUTH_CAPABILITIES = "([^"]*)"/)[1], /(^| )IDLE( |$)/);
	for (const file of [...sourceFiles(join("src", "lib", "imap-server")), join("server", "runtime", "imap.ts")]) {
		assert.doesNotMatch(read(file), /@\/lib\/realtime|RealtimeHub|REALTIME|runtime\/realtime/, `${file} must not use the realtime hub`);
	}
	const signalCallers = [...sourceFiles("src"), "worker.ts", "worker-utils.ts"].filter((file) => /\bgetImapChangeSignal\(/.test(read(file)) && dirname(file) !== join("src", "lib", "imap"));
	assert.deepEqual(signalCallers, [join("src", "lib", "imap-server", "session.ts")]);
});

test("SMTP-1: the submission adapter is protocol-free and only discards its own failed attempts", () => {
	// The adapter is a library: no sockets, no Node APIs, no SMTP server, no raw relay.
	for (const file of sourceFiles(join("src", "lib", "submission"))) {
		const source = read(file);
		assert.doesNotMatch(source, /from\s+["'](?:node:|smtp-server|nodemailer|net["']|tls["'])|Buffer|process\./, `${file} must stay runtime-neutral`);
		assert.doesNotMatch(source, /sendRaw|EMAIL\.send\(/, `${file} must send through sendEmail, never the transport`);
	}
	// Only the adapter discards failed attempts.
	const discarders = sourceFiles("src").filter((file) => /failedAttempt:\s*"discard"/.test(read(file)));
	assert.deepEqual(discarders, [join("src", "lib", "submission", "service.ts")]);
});

test("SMTP-2: the submission listener is Node-only, opt-in, and the adapter's only caller", () => {
	const listener = join("server", "runtime", "smtp-submission.ts");
	const replies = join("server", "runtime", "smtp-submission-replies.ts");
	const everything = [...sourceFiles("server"), ...sourceFiles("src"), "worker.ts", "worker-utils.ts"];
	// Two SMTP servers: inbound (smtp.ts) and submission. Nothing else listens for SMTP.
	assert.deepEqual(everything.filter((file) => /new SMTPServer\(/.test(read(file))).sort(), [join("server", "runtime", "smtp.ts"), listener].sort());
	// The port variable is named only by the listener's configuration and the entrypoint, which alone starts it.
	assert.deepEqual(everything.filter((file) => /SMTP_SUBMISSION_PORT/.test(read(file))).sort(), [join("server", "index.ts"), listener].sort());
	assert.deepEqual(everything.filter((file) => /startSubmissionListener\(/.test(read(file)) && file !== listener), [join("server", "index.ts")]);
	// Outside the adapter itself, only the listener and its reply mapping import it.
	const importers = everything.filter((file) => /from\s+["'](?:@\/lib\/submission|[^"']*\/lib\/submission\/)/.test(read(file)) && !file.startsWith(join("src", "lib", "submission")));
	assert.deepEqual(importers.sort(), [listener, replies].sort());
	// Nothing the Worker compiles reaches the listener.
	for (const file of ["worker.ts", "worker-utils.ts", ...sourceFiles("src")]) {
		assert.doesNotMatch(read(file), /from\s+["'][^"']*smtp-submission/, `${file} must not import the submission listener`);
	}
	// Implicit TLS only: no STARTTLS, no plaintext AUTH, TLS terminated by Node at 1.2 or later.
	const source = read(listener);
	assert.match(source, /const TLS_MIN_VERSION = "TLSv1\.2";/);
	assert.match(source, /secured: true,/);
	assert.match(source, /disabledCommands: \["STARTTLS",/);
	assert.doesNotMatch(source, /allowInsecureAuth|authOptional|needsUpgrade/);
	// It never relays raw MIME: every message goes through submitMessage.
	assert.doesNotMatch(source, /sendRaw|EMAIL\.send\(|sendEmail\(/);
});

const workersBuild = join(root, "dist", "server");
test("the Workers build output contains no IMAP or SMTP submission listener", { skip: !existsSync(workersBuild) && "no Workers build in dist/server (run npm run build)" }, () => {
	const files = readdirSync(workersBuild, { recursive: true }).map(String).filter((file) => /\.(m?js)$/.test(file));
	assert.ok(files.length > 0, "the Workers build has JavaScript output");
	for (const file of files) {
		const code = readFileSync(join(workersBuild, file), "utf8");
		for (const marker of ["startImapListener", "IMAP4rev1 SASL-IR AUTH=PLAIN ID", "IMAP_TLS_CERT", "Non-synchronizing literals are not supported", "startSubmissionListener", "SMTP_SUBMISSION_PORT"]) {
			assert.ok(!code.includes(marker), `${file} contains "${marker}"`);
		}
	}
});
