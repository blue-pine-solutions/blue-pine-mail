# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev                    # Vite + vinext in local workerd
npm run lint                   # eslint (next/core-web-vitals + next/typescript)
npm run build                  # vinext build, including the complete Worker

npm run db:generate            # drizzle-kit generate from src/db/schema/index.ts
npm run db:migrate:local       # wrangler d1 migrations apply DB --local
npm run db:migrate:remote      # --remote (needs a concrete database_id in wrangler.jsonc)
npm run db:seed                # POST /api/seed against localhost:3000

npm run deploy                 # vinext build + wrangler deploy
npm run deploy                 # build and deploy; migrate later from Admin settings
npm run preview                # build and preview the vinext Worker locally
npm run cf-typegen             # regenerate cloudflare-env.d.ts from wrangler.jsonc
```

There is no test script in `package.json`; the checks under `tests/` are `node:test` files run with `node --test tests/*.test.mjs` (pass the glob — on Node 24 a bare `tests/` is read as a module path). They must not need Workers bindings, so anything that reaches D1 or R2 belongs in a script under `scripts/` run against `npm run dev` instead.

`next.config.ts` sets `typescript.ignoreBuildErrors: true` and `tsconfig.json` sets `noImplicitAny: false`, so the build will not catch type errors. Run `npx tsc --noEmit` if you want real type checking.

`npm run deploy` builds with vinext and uploads with Wrangler. The Cloudflare Vite plugin generates `dist/server/wrangler.json` and redirects Wrangler to it, preserving the custom `worker.ts` entrypoint.

## Architecture

Next.js App Router APIs running on Cloudflare Workers via vinext. Drizzle ORM over D1, R2 for raw MIME, attachments, and record backups, Queues for async mail processing, a Durable Object for realtime, and a cron trigger for scheduled backups.

### worker.ts is the entrypoint

`worker.ts` wraps `vinext/server/fetch-handler` and adds handlers Next.js cannot express:

- **`fetch`** — intercepts `/api/realtime` for the WebSocket upgrade (authenticates the session cookie, then routes to `env.REALTIME.getByName(user.id)`), delegating everything else to vinext.
- **`email`** — the Cloudflare Email Routing handler. Resolves domain routing rules first (`resolveIncomingMail` in `src/lib/email/incoming.ts`) because `message.setReject()` and `message.forward()` only exist here, then applies optional account-level forwarding (loop-guarded by the `MAILFLARE_FORWARDED_HEADER`), writes raw MIME to R2, and enqueues to `INBOUND_QUEUE`. It never parses mail inline.
- **`queue`** — a single consumer for both queues; `isInboundQueueMessage` and `isWebhookRetryMessage` in `worker-utils.ts` discriminate inbound mail, webhook retries, and outbound payloads. Failures `retry({ delaySeconds: 10 })`.

It also re-exports `RealtimeHub`, which must remain exported from the Worker entrypoint.

### Mail pipeline

Inbound: `email` handler → R2 → queue → `processInboundMessage` (`src/lib/email/inbound.ts`) → `resolveInboundAddress` routing decision (deliver / reject / forward) → `parseRawMime` (postal-mime) → insert message + attachments → upsert contacts → `dispatchWebhooks` → `notifyUsersOfNewMessage` over the Durable Object.

Outbound: `src/lib/email/send.ts` / `sender.ts`, composing with mimetext and sending through the `EMAIL` send_email binding, with `outbound_jobs` rows tracking queued sends. `to`, `cc` and `bcc` accept a header string or an array; `toAddr`/`ccAddr`/`bccAddr` on `messages` store the full comma-joined lists (use `splitEmailAddressList` from `src/lib/email/address.ts`, not `getEmailAddress`, when a value may be a list).

Canonical representation: every persisted message has one RFC 5322 copy, referenced by `messages.raw_r2_key` (`src/lib/email/canonical-message.ts`). Received and imported mail keeps its original bytes. Mail Blue Pine sends gets a copy built with `mimetext` (browser build, same on Workers and Node) from exactly what the transport accepted, stored under `canonical/<messageId>/…` with the Message-ID the transport returned; Cloudflare Email Sending assigns that ID and rejects a caller-supplied one. Drafts get a copy keyed by a content fingerprint that is replaced after an edit; queued/failed sends are generated per read and never stored. `/original` and JMAP `readBlob` go through `resolveCanonicalMessage`; legacy messages are materialized on first read or by the scheduled maintenance. Never regenerate an immutable message's stored copy.

Composer: `src/components/compose/rich-text-editor.tsx` is a contentEditable HTML editor; the body is one HTML string and the text/plain part is derived with `htmlToPlainText` (`rich-text-utils.ts`). Quoted/forwarded content is wrapped by `wrapQuotedHtml` and folded by both the composer and the reader (`splitQuotedHtml`). Forward copies the source's attachments onto the draft (`copyMessageAttachments`); `/api/send` with `draftId` sends them.

Threading: `resolveThreadId` in `src/lib/email/threading.ts` files an inbound or imported message under the thread of the stored message its `In-Reply-To`/`References` name (matched against `providerMessageId` in the same mailbox); otherwise its own Message-ID seeds a new thread. Outbound replies carry `inReplyTo`/`references`/`threadId` from the draft, and a fresh send is keyed by the Message-ID Cloudflare returns. `/api/messages/[id]/thread` returns the conversation. Lists pass `group=thread` (the "conversation view" toggle, `use-conversation-view.ts`) to get one row per thread plus `threadMessageIds`, which row actions and bulk actions expand to.

### Routing rules have two scopes

`routing_rules.scope` splits two genuinely different mechanisms, and mixing them up is the easy mistake:

- **`domain`** — evaluated by `resolveInboundAddress` (`src/lib/email/routing.ts`) *while resolving the address*, in three phases: `reject` rules first (so a sender can be blocked even when the recipient is a real mailbox), then exact mailbox and alias lookup, then `forward`/`store` catch-all fallbacks. Ordered by descending `priority`, then oldest first. This phase split is what stops a `*` catch-all from shadowing real mailboxes — preserve it.
- **`mailbox`** — evaluated by `resolveInboxRuleDestination` *after* delivery, to pick a folder or move to spam/trash.

Both queries filter on `scope`, so any new rule must set it explicitly. `forward` and `reject` are actioned in `worker.ts`, never in the queue consumer.

### Webhook retries ride the outbound queue

`src/lib/email/webhooks.ts` records every attempt (status, error snippet, duration, `nextRetryAt`) on `webhook_deliveries` and re-enqueues failures onto `OUTBOUND_QUEUE` with a `delaySeconds` backoff rather than adding a third queue binding. `env.d.ts` widens `OUTBOUND_QUEUE` to the union of both payload types accordingly. `runDelivery` is shared by the retry queue and the manual retry endpoint.

### Cloudflare is a live dependency, not just a host

Domain and mailbox management call the Cloudflare API at runtime (`src/lib/cloudflare-api.ts`, `src/lib/domains/`). Adding a domain enables Email Routing DNS and sending subdomains on the zone; creating a mailbox creates a Cloudflare Email Routing rule targeting `CF_EMAIL_WORKER_NAME`; removing a domain cleans those up (`src/lib/domains/cloudflare-cleanup.ts`).

Consequence: `CF_EMAIL_WORKER_NAME`, the deployed Worker `name`, and `services[].service` for `WORKER_SELF_REFERENCE` in `wrangler.jsonc` must all agree. Cloudflare service bindings need a literal name and cannot reference the top-level `name`.

Auth is `CF_TOKEN` (preferred) or the legacy `CF_EMAIL` + `CF_API_KEY` pair.

### Schema and the dual-migration gotcha

Upstream schema lives in one file: `src/db/schema/index.ts` (21 tables); Blue Pine-owned tables are in `src/db/schema/bluepine.ts`. Migrations are generated into `drizzle/migrations/`. Note that `drizzle-kit generate` currently prompts interactively about a snapshot rename conflict, so recent migrations were hand-written to match the generated style.

`npm run db:bundle` packages the SQL files for the Worker. `/api/setup/prepare` and the admin migration endpoint use the shared runner in `src/lib/migrations/service.ts`; migration files remain the only schema history to maintain. Build, deploy, preview, and development scripts generate the bundle before loading application code.

The setup path only ever initializes an empty database — it refuses to touch one that already has tables.

### Two runtimes, one code path

The Node build aliases `cloudflare:workers` to `server/runtime/cloudflare-workers.ts`, allowing the shared helper to use its existing `getNodeEnv()` fallback. That alias only applies when `MAILFLARE_RUNTIME=node`; vinext uses the native Workers module. Next outputs to `.next-node` so its generated types do not collide with vinext's `.next/types`.

The app reaches every platform service through `getEnv()` (`src/lib/cloudflare.ts`). On Workers that is the native `cloudflare:workers` env. In the self-hosted runtime, `server/index.ts` builds an object with the same shape (`server/runtime/env.ts`: a D1-compatible wrapper over better-sqlite3, an R2-compatible file bucket, `EMAIL` over nodemailer or the Cloudflare Sending REST API, in-process queues, a WebSocket hub standing in for the Durable Object, a fixed-window rate limiter) and publishes it as `globalThis.__mailflareNodeEnv` before Next starts; `getNodeEnv()` in `src/lib/runtime.ts` returns it. Application code must not care which one it got. The few places that must differ check `isNodeRuntime(env)`: setup requirement checks, the self-update button, and domain provisioning, which without Cloudflare credentials records the zone as `"manual"` (`src/lib/domains/provision.ts`) so every Cloudflare call is a no-op and the DNS page lists records to set by hand. Inbound mail off Workers goes through `intakeIncomingMail` (`src/lib/email/intake.ts`) from either the SMTP listener (`server/runtime/smtp.ts`) or the signed `/api/inbound` webhook the relay Worker in `deploy/cloudflare-email-relay` calls. `npm run build:node` builds Next in Node mode and bundles the server with esbuild to `dist/server.mjs`; the Dockerfile runs that. Migrations are applied from `drizzle/migrations` at start (`server/runtime/migrate.ts`), so the bootstrap schema in `src/lib/setup/migration.ts` is not used there.

### JMAP lives in `src/lib/jmap/`

`handleJmapRequest` (`src/lib/jmap/handler.ts`) owns `/jmap/*` and `/.well-known/jmap`; the Next routes under `src/app/jmap/[[...segments]]` and `src/app/.well-known/jmap` only delegate to it, and it is framework-free so it could be mounted from `worker.ts` too. Auth is an API key with the `jmap` scope via `authenticateApiRequest` (`src/lib/api/key-auth.ts`, the Next-free core that `src/lib/api/auth.ts` now wraps). JMAP Mailbox ids encode `mailboxId`, `mailboxId~role` or `mailboxId~f~folderId` (`ids.ts`); `email-query.ts` maps filters onto `messages` columns, `email-objects.ts` builds Email objects from stored rows (no MIME parsing), and states are digests of counts (`state.ts`), which is why every `/changes` method answers `cannotCalculateChanges`.

`Email/set` create and `Email/import` share one insert (`insertDraft` in `emails.ts`) and one target rule (`resolveDraftsMailbox` in `email-import-utils.ts`): a new message goes into exactly one Drafts mailbox, never Inbox or a folder, because delivered mail is the inbound pipeline's job. `Email/import` parses the uploaded blob with `parseRawMime`, stores the `Message-ID` in `providerMessageId` with its angle brackets (as inbound rows do) and keeps the uploaded bytes at `drafts/<messageId>.eml` in `rawR2Key`, so `readBlob` serves the client's own MIME back instead of the rebuilt minimal message; the `jmap-uploads/` object is deleted once claimed. `Email/copy` and `Email/parse` are still `emailUnsupported`. `Mailbox/set` never writes `folders` itself: create/rename/destroy go through `src/lib/mailboxes/folder-management.ts` (R-1), the one protocol-neutral folder-management boundary (future IMAP CREATE/RENAME/DELETE must use it too). It authorizes with `canManage` (owner, or `full_access` delegate while sharing is enabled), repeats that authority inside each write (`managementGuard`, every write one D1 batch), scopes every statement to the authoritative mailbox and a folder verified to belong to it, and returns typed outcomes (`notFound`, `forbidden`, `invalidName`, `alreadyExists`, `hasMessages`, `unchanged`) that the protocol maps; a folder id from another mailbox must stay `notFound` and reveal nothing.

`email-query.ts` answers the `header` filter from columns — `Message-ID` from `providerMessageId` (compared with and without angle brackets, since inbound rows store them and outbound rows do not), `In-Reply-To` from `inReplyTo`, `References` by a padded `LIKE` on the space-joined chain. Any other header name throws `unsupportedFilter` (RFC 8620 §5.5). Filter conditions must never be silently dropped: a client that de-duplicates with `header` would otherwise match every message in the mailbox.

### IMAP state lives in `src/lib/imap/`, the listener in `src/lib/imap-server/`

`src/lib/imap/service.ts` is the protocol-neutral contract the IMAP listener consumes, keyed by an A2 mail app password principal and re-authorized on every call. Folders are INBOX/Drafts/Sent/Archive/Spam/Trash plus custom folders, using the web app's partition (a custom folder only holds `received` mail; queued/failed sends are invisible). `imap_folders` and `imap_message_uids` (bp0002) hold UIDVALIDITY, UIDNEXT and per-folder UIDs; membership is recomputed from `messages` on every read, so any code path that moves or deletes mail is picked up without hooks. The one exception is bp0003's `bp_imap_membership_clears_deleted` trigger on `messages`, which clears a message's pending \Deleted marks whenever its `mailbox_id`, `status` or `folder_id` changes; \Deleted, EXPUNGE and MOVE are offered only while it exists (fail closed, checked on every operation and inside each such write); see UPSTREAM.md, "IMAP \Deleted invariant (bp0003)". bp0004 adds the only other Blue Pine attachments: `bp_imap_draft_content_releases_uid` on `messages` and two triggers on `message_attachments`, which delete a draft's Drafts UID whenever a column `draftFingerprint` digests changes or an attachment is added or removed, so an old UID or \Deleted mark never reaches an edited draft; \Deleted and permanent EXPUNGE in Drafts are offered only while all three exist (UPSTREAM.md, "IMAP draft UID invariant (bp0004)"). Multi-statement writes (`relocateImapMessages`, `deleteImapMessagesPermanently`) are one D1 batch of self-guarding statements, compiled with drizzle's SQLite dialect because drizzle's `batch()` cannot carry parameterized raw SQL. Content is A1's canonical representation and RFC822.SIZE is the length of exactly those bytes (JMAP `Email.size` is still the older estimate). See UPSTREAM.md, "IMAP mailbox state".

The listener (A4, with A5.1 flag writes, A5.2a recoverable deletion, A5.2b MOVE, A5.2c permanent deletion, A5.3 UIDPLUS, A5.4 IDLE and A5.5a mailbox management) is IMAP4rev1 over implicit TLS, Node/Docker only, enabled by `IMAP_PORT` with `IMAP_TLS_CERT`/`IMAP_TLS_KEY` (startup fails on unusable TLS material; SIGHUP reloads it). `src/lib/imap-server/` is the runtime-neutral engine (no Node APIs: `Uint8Array` and byte strings, one octet per character) and `server/runtime/imap.ts` owns sockets, limits and timers; nothing the Worker compiles may import either (distribution guard). Advertised capabilities are listed in `session.ts` and must each be implemented and tested. Writes happen only in a mailbox opened with SELECT (EXAMINE is read-only): \Seen and \Flagged (`messages.read`/`messages.starred`) through A3's batched `storeImapFlags` (STORE/UID STORE and the implicit \Seen of a non-PEEK body fetch); \Deleted (`imap_message_uids.deleted`) through the same STORE, for management access only, in Drafts only on the principal's own drafts (checked, and guarded in the write); EXPUNGE/CLOSE through A3's `expungeImapFolder`, recoverable (A5.2a: \Deleted messages move to Trash, `status = 'trash'`, `folder_id = NULL`) everywhere but Trash and Drafts, where it is permanent (A5.2c): chunks of 25 UIDs, each one `deleteImapMessagesPermanently` batch whose SQL re-checks the exact UID's \Deleted mark, membership, authorship in Drafts, bp0003/bp0004 and the principal's authority (user enabled, app password, mailbox owner or `full_access`), captures attachment keys before the cascade and returns exactly what it deleted, then `cleanupDeletedMessageObjects` (`src/lib/imap/cleanup.ts`) removes raw bytes and attachment objects only after the commit, from an allowlist of key shapes and only if no live row references them, best effort (`expunge.cleanup-failed` logs, orphans left; never a restored row or a failed EXPUNGE). Never use `deleteMessageWithObjects` (files before row, unguarded; JMAP/web still do) for IMAP; and MOVE/UID MOVE (A5.2b, capability `MOVE`), where A3's `moveImapMessages` relocates messages under `imapMoveTarget`'s special-folder policy (Sent and Drafts are never destinations, Drafts only go to Trash and only their author's, sent mail never goes to Spam) with the same `relocateImapMessages` batches, and the listener then runs `trainImapSpamFeedback` (into Spam: spam; Spam → INBOX: ham), whose failure never fails the MOVE. `spamTrainingStatements` in `src/lib/spam/feedback.ts` is the training without the status change, guarded so it applies once. IDLE (A5.4, RFC 2177) is advertised: the database is its only source of truth (never the process-local realtime hub, so it stays correct with several Node instances). While idling the session polls A3's `getImapChangeSignal` (re-authorizes, then reads `jmap_mailbox_revisions` and the folder's UIDVALIDITY, indexed lookups only) every ~10 s ±20%, runs the existing refresh only when the revision moved, ends with BYE when UIDVALIDITY changed or access is gone, and reconciles unconditionally every ~300 s because the revision misses IMAP-only state (\Deleted marks, attachment-only Drafts UID releases); `* OK Still here` after 120 s without a write; BYE after 60 s of unconfirmable authority or 120 s without a successful poll. DONE is read by the framer's continuation-line mode (shared with AUTHENTICATE). Timings live in `ImapLimits` (`DEFAULT_IDLE_TIMING`). Resource limits (A5.6): an absolute 60 s login deadline (`loginTimeoutMs`, never extended by anything the client sends) and autologout (60 s / 30 min) run in the session on the host clock (`ImapSessionOptions.timeouts`) and count complete commands and continuation lines only, never raw octets, partial lines/literals or server writes; lines are 8 KiB before authentication (`PREAUTH_MAX_LINE`), 64 KiB after; content work takes a `ContentReadLimiter` permit (8 global, 2 per user via `maxConcurrentReadsPerUser`) held by FETCH until its response is written; whole-message FETCH never builds the byte string (`MessageView.text` is lazy) and writes literals by reference (`ResponseBuilder.parts()`); SEARCH sequence/UID keys use range matchers (`sequenceMatcher`), never mailbox-sized sets. UIDPLUS (A5.3, RFC 4315) is advertised: UID EXPUNGE is `expungeImapFolder` narrowed to the client's UID set (resolved only against UIDs the session announced), through the same recoverable or permanent path and guards; MOVE/UID MOVE send `* OK [COPYUID …]` before their EXPUNGEs from the destination UIDs and UIDVALIDITY that `relocateImapMessages` reads back inside its batch (`copyUidData` in `session.ts`; none for a move that did not commit, and none at all if a later chunk fails). CREATE, RENAME and DELETE (A5.5a) go through the R-1 folder-management service with `strictNames` (the listener never writes `folders`): new names are decoded from modified UTF-7 and must pass `imapFolderNameVerdict` (exact/system/INBOX → ALREADYEXISTS; case/NFC variants, colliding `<base> (<n>)` shapes, `*`/`%` → CANNOT), RENAME/DELETE refuse system folders and any folder in a collision group (`ambiguousFolderIds`, because a disambiguated listing name can shift to another folder), DELETE moves the folder's messages to Trash (the selected folder of this session is INUSE), and RENAME keeps the folder id, UIDVALIDITY and selection. SUBSCRIBE/UNSUBSCRIBE are compatibility answers (no stored subscriptions; all visible mailboxes are subscribed, SUBSCRIBE OK, UNSUBSCRIBE CANNOT; stored subscriptions are A5.5b, deferred). COPY and APPEND (which would owe COPYUID/APPENDUID) are not implemented and are refused before any storage call. The listener never calls the one-UID `setImapMessageFlags`. A permission the principal lacks is `ImapStateError("denied")` → `NO [NOPERM]` and the session continues; lost access is `forbidden` → `BYE`. The namespace is flat with a `NIL` delimiter, names are A3's in modified UTF-7. FETCH/SEARCH work on A3's canonical octets (`mime.ts` offsets), never on `messages` columns. Tests: `tests/imap-protocol.test.mjs` (grammar), `tests/imap-session.test.mjs` (engine over SQLite, in memory), `tests/imap-flags.test.mjs` (A5.1 STORE, implicit \Seen, concurrency), `tests/imap-expunge.test.mjs` (A5.2a \Deleted, EXPUNGE, CLOSE, bp0003, failures and races), `tests/imap-move.test.mjs` (A5.2b MOVE, folder policy, spam training, races), `tests/imap-permanent-expunge.test.mjs` (A5.2c bp0004, permanent EXPUNGE/CLOSE, cascades, races, storage failures), `tests/imap-uidplus.test.mjs` (A5.3 UID EXPUNGE, COPYUID), `tests/imap-idle.test.mjs` (A5.4 IDLE on a virtual clock, `createClock` in the harness, plus real TLS listener checks), `tests/imap-mailbox-management.test.mjs` (A5.5a CREATE/RENAME/DELETE, naming policy, collision groups, SUBSCRIBE), `tests/imap-resource-limits.test.mjs` (A5.6 login deadline, autologout, line limit, FETCH memory, per-user permits, SEARCH matchers) and `tests/imap-listener.test.mjs` (real TLS sockets, imaplib/curl/openssl), with shared helpers in `tests/support/imap-harness.mjs`. See UPSTREAM.md, "IMAP listener".

### Password reset and MFA

`reset_email` on `users` is the destination for reset links (`src/lib/auth/password-reset.ts`); links are hashed, single-use, 30 minutes, and redeeming one revokes every session. Reset mail is sent by `sendSystemEmail` (`src/lib/email/system-mail.ts`), which writes straight to the send binding from the first admin mailbox on a sending-enabled domain, so nothing lands in Sent and no webhooks fire. If no domain can send, the request still returns 200 and a warning is logged. TOTP lives in `src/lib/auth/totp.ts` (RFC 6238 over Web Crypto, no dependency); the secret is stored on `users` at enrolment but only counts once `totp_enabled` is set by a verified code. A login with MFA returns `{ mfaRequired, challengeToken }` (`login_challenges`, 5 minutes) instead of a session, and `/api/auth/mfa/verify` finishes it with a TOTP or recovery code. Password changes and admin resets call `deleteUserSessions`.

### Search is an FTS5 index kept by triggers

`messages_fts` (migration 0030) is an external-content FTS5 table over `messages`; three triggers in the same migration keep it in sync on insert, update and delete, so no application code touches the index. `buildSearchConditions` in `src/lib/search/conditions.ts` turns the Gmail-style grammar (`src/lib/search/query-utils.ts`) into a `rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)` predicate plus plain column filters. Two consequences: the bootstrap SQL in `src/lib/setup/migration.ts` is split with `splitSqlStatements`, which keeps trigger bodies whole; and the backup coverage check skips `messages_fts%`, since the shadow tables are derived and repopulate on restore. `wrangler d1 export` does not work on databases with virtual tables; the app's own JSON backup is unaffected.

### Access control

Two independent auth surfaces:

- **Session cookie** (`ep_session`) — `getCurrentUser` / `requireUser` in `src/lib/auth/cookies.ts`, backed by `src/lib/auth/session.ts`. Used by dashboard/admin API routes. `requireUser` *throws*, which Next surfaces as a 500; prefer `requireSessionUser` from `src/lib/api/auth.ts`, which returns a proper 401 response. Most older routes still use `requireUser` and 500 on unauthenticated requests.
- **API key bearer token** — `authenticateApiKey` + `requireScope` in `src/lib/api/auth.ts`, used by the public `/api/v1/*` surface.

Mailbox authorization is separate from user role and goes through `src/lib/mailboxes/access.ts` (`getMailboxAccessLevel`, `listAccessibleMailboxes`, `listAccessibleMailboxIds`), which accounts for ownership, the `mailbox_access` sharing table, and admin role. Message queries scope by accessible mailbox IDs, not by `userId` — see `src/app/api/messages/route.ts` for the canonical pattern.

### Folders are mostly virtual

`messages.status` is a free-text column driving the folder views: `received` (inbox), `sent`, `draft`, `spam`, `trash`, `archived`. Orthogonal to that are `starred`, `snoozedUntil`, and `folderId` (user-created folders in the `folders` table). A "folder" route under `src/app/(dashboard)/` is usually a status filter, not a table.

### Feature policy gates optional features

`getFeaturePolicy()` (`src/lib/distribution/features.ts`) decides whether custom branding, multiple accounts, shared mailboxes and account forwarding are available; `BLUEPINE_DISABLED_FEATURES` turns them off per deployment. It is availability only: routes still authenticate, check admin role and mailbox access as before. Upstream Mailflare's Paymug licensing (`src/lib/licenses/`) is removed from this distribution; the `license_settings` table stays in the schema and backups for compatibility and has no effect.

### Version and updates

The admin "Version and updates" card (`/api/admin/update`, GET only) shows the installed Blue Pine Solutions Mail version and build, and checks for approved releases: published GitHub Releases tagged `bluepine-vMAJOR.MINOR.PATCH` in the Blue Pine repository (`src/lib/distribution/releases.ts`; `BLUEPINE_RELEASE_REPOSITORY` overrides it). It never installs or deploys anything and never looks at upstream Mailflare. Upstream's workflow that replaced the installation repository with upstream `main` has been removed. The same card reports and applies pending database migrations through `/api/admin/migrations`.

## Conventions

- Tabs for indentation. `@/*` maps to `src/*`.
- Types and pure helpers are split out of components and modules into sibling `*-types.d.ts` and `*-utils.ts` files (41 and 27 of them respectively). Follow this when adding anything non-trivial.
- Server code reaches bindings through `getEnv()` / `getEnvAsync()` in `src/lib/cloudflare.ts`, then `getDb(env)` from `src/db`. Keep binding access centralized here.
- API routes return `NextResponse.json({ error: "..." }, { status })` for failures; there is no shared error envelope helper.
- UI is Tailwind v4 + shadcn/Radix primitives in `src/components/ui/`. `DialogContent` sets no max height, so a tall dialog overflows the viewport with an unreachable submit button — add `max-h-[calc(100vh-4rem)] overflow-y-auto` on any dialog with more than a few fields.
- `cloudflare-env.d.ts` is generated (500KB) — regenerate with `cf-typegen`, never hand-edit.

## Blue Pine downstream distribution

This repository is **Blue Pine Solutions Mail**, a downstream distribution derived from Mailflare (`upstream` = hieunc229/mailflare; `origin` = Blue Pine's private development repository; `public` = blue-pine-solutions/blue-pine-mail, the public source and release repository). `NOTICE` records the attribution and the modifications made so far. **Read `UPSTREAM.md` before any architectural change**; it is the engine/product boundary and the upstream integration contract.

- **Engine follows upstream, product layer is Blue Pine's.** Schema, migrations, mail pipeline, routing, SMTP, JMAP, API v1, MCP tools, relay protocol, auth and runtime contracts stay upstream-shaped. Identity, feature policy, commercial policy, branding policy, legal/source surfaces, the release channel and operations belong to Blue Pine.
- **Never casually rename compatibility-sensitive `mailflare` identifiers** (headers, stored HTML markers, backup format id, storage keys, env vars, `mailflare.sqlite`, ICS UIDs). The full list is in `UPSTREAM.md`. The word "Mailflare" in code is not by itself a reason to change it.
- **Upstream migrations are taken verbatim and in order.** Never edit, skip, reorder or renumber them. Blue Pine migrations use the `bpNNNN_*.sql` namespace described in `UPSTREAM.md` ("Downstream migrations"): they sort after every upstream migration in all three runners, are never listed in the drizzle journal, and their tables live in `src/db/schema/bluepine.ts`, outside drizzle-kit's input. Read that section before adding one.
- **Product policy belongs to Blue Pine.** Optional features are gated by the Blue Pine distribution policy in `src/lib/distribution/`; upstream's licensing layer has been removed. Upstream changes that add license or commercial gates must be translated to feature policy, not merged as-is.
- **Prefer offering generic engine fixes upstream** so downstream divergence shrinks.
- **Identity and source offer:** product, distributor, version and upstream attribution come from `src/lib/distribution/identity.ts`; `/about` and `/source` (the AGPL source offer) must stay reachable from the footer and auth screens. See `UPSTREAM.md`.
- **`LICENSE` must remain untouched.**
- **Git hygiene:** `docker-compose.yml` may hold operator-local changes. Never stage it without explicit instruction. Stage downstream work by explicit path (no `git add -A`, `git add .`, or `git commit -a`).
- `tests/distribution-guard.test.mjs` checks the downstream invariants; keep it passing and extend it as later phases land.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
