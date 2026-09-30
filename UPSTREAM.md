# Upstream integration contract

Blue Pine Solutions Mail is a downstream distribution of Mailflare. This file records where Blue Pine follows upstream, where it diverges, and how upstream changes are brought in. Read it before any architectural change.

| | |
|---|---|
| Blue Pine public source and releases | https://github.com/blue-pine-solutions/blue-pine-mail (`public`) |
| Blue Pine development | Blue Pine's private development repository (`origin`) |
| Upstream | https://github.com/hieunc229/mailflare (`upstream`) |
| Current upstream base | `ccca978b777a3b9b8e9b75b6436e2d1b5427b9b5` (upstream `main`; package version 0.4.0), certified 2026-09-29 |
| Blue Pine main containing it | `2f9be7b8642f1be8b60a1f266acb1909033e303a` (integration merge `0e28557`, promoted to `main` 2026-09-29) |
| Previous upstream base | `c57671f` (2026-09-28) |

Update these SHAs after every upstream integration. The next integration merges new upstream commits on top of the current upstream base.

## Boundary

### Preserve / follow upstream

Changes here come from upstream. Blue Pine fixes in these areas must stay upstream-compatible and should be offered upstream.

- Upstream database schema (`src/db/schema/index.ts`): every upstream table and column.
- Upstream migrations (`drizzle/migrations/`): verbatim and in upstream order.
- Backup format and required table set (`src/lib/backups/`).
- Persisted storage markers and layouts (stored HTML markers, bucket key prefixes, `/data`).
- Mail engine: intake, inbound pipeline, outbound pipeline, threading, spam, search, folders, contacts, calendar, attachments.
- Routing semantics (`src/lib/email/routing.ts` phase order and rule scopes).
- SMTP behavior (`server/runtime/smtp.ts`).
- JMAP behavior (`src/lib/jmap/`).
- API v1 routes and API-key scopes (`/api/v1/*`).
- MCP tool names and schemas.
- The relay protocol (`deploy/cloudflare-email-relay` ↔ `/api/inbound`).
- `X-Mailflare-*` technical protocol headers.
- Calendar UID compatibility.
- Authentication and security engine (sessions, MFA, password reset, registration rules).
- Runtime contracts (`getEnv()` / `CloudflareEnv` shape, Workers and Node runtimes).
- Existing environment-variable names.
- Internal technical identifiers wherever renaming would break compatibility.

### Blue Pine owns

Changes here are Blue Pine decisions. Upstream changes in these areas are translated or ignored.

- Distribution identity (product name, icon defaults, version display).
- Feature policy (which capabilities a deployment enables).
- Commercial policy.
- Customer branding policy.
- Legal and source surfaces (`NOTICE`, source links, attribution).
- Update and release channel.
- Managed deployment and operations.
- Blue Pine documentation.
- Guard tests and downstream engineering rules (`tests/distribution-guard.test.mjs`, this file, the Blue Pine section of `CLAUDE.md`).

Optional features (custom branding, multiple accounts, shared mailboxes, account forwarding) are gated by the Blue Pine feature policy in `src/lib/distribution/features.ts`. Upstream's Paymug licensing layer (`src/lib/licenses/`, `/api/licenses`, the Licenses page and Upgrade pill) is removed. The `license_settings` table is kept, unused, for schema and backup compatibility.

## Distribution identity and source offer

- `src/lib/distribution/identity.ts` is the single source of the product name (Blue Pine Solutions Mail), distributor (Blue Pine Solutions), Blue Pine version, upstream attribution (Mailflare by Hieu Nguyen, upstream version from `package.json`) and license (AGPL-3.0-or-later).
- `/about` shows that identity; `/source` redirects to the Corresponding Source. The sidebar footer and the sign-in/setup screens link to both. Keep these reachable: they are the AGPL source offer for network users.
- `BLUEPINE_BUILD_COMMIT` (a Docker build argument or runtime variable) makes `/source` point at the exact commit. Without it, the link falls back to the repository.
- Admin-editable branding (`app_settings`) changes the app name users see, not the distribution identity on the About page or in `NOTICE`.
- Keep upstream attribution in `NOTICE` and `LICENSE`; do not state or imply that Mailflare or its author endorses Blue Pine Solutions Mail.
- Releases 0.1.0 and 0.1.1 were published under the earlier product name "Blue Pine Mail". Their GitHub Releases, the `bluepine-v*` tags and the `blue-pine-mail` repository and asset file names keep that form; do not rename or rewrite them. A stored app name of "Blue Pine Mail" counts as never customized (`LEGACY_DEFAULT_APP_NAMES`).
- Brand artwork: `brand/` holds the approved, operator-supplied masters, which are not served and must not be redrawn. The runtime copies (`public/brand/blue-pine-mail-logo.*`, `public/icon-192.png`, `public/icon-96.png`, `public/favicon.ico`) are resampled from them. The full logo appears on `/about` and, only while default branding is in effect, on the sign-in and setup screens; administrator branding always wins elsewhere.

## Never rename (compatibility)

These identifiers contain "mailflare" but carry data, protocol or deployment compatibility. Do not rename them for cosmetic reasons.

| Identifier | Why |
|---|---|
| `X-Mailflare-Forwarded` | Forwarding loop guard between installations and versions |
| Relay headers `X-Mailflare-From`, `X-Mailflare-To`, `X-Mailflare-Headers`, `X-Mailflare-Signature`, and their HMAC signature scheme | Wire protocol between the relay Worker and `/api/inbound` |
| `data-mailflare-quote`, `data-mailflare-signature`, `.mailflare-quote` | Stored inside persisted message HTML |
| Backup format `mailflare-database-backup` (version 1) and its table set, including `license_settings` | Existing backups must stay restorable in both directions |
| `mailflare.sqlite` | Self-hosted database file name |
| `/data` layout (database, bucket directories) | Existing self-hosted volumes |
| Storage key layouts (`drafts/`, `jmap-uploads/`, `branding/app-icon`, `backups/`, and others under the bucket) | Referenced by persisted rows |
| `MAILFLARE_RUNTIME` | Build and runtime plumbing (`next.config.ts`, `package.json` scripts, esbuild define, tests) |
| `__mailflareNodeEnv` | Node runtime environment hand-off |
| ICS `UID:…@mailflare` suffix | Updates and cancellations of previously sent invitations |
| Existing `/api/v1` routes and API-key scope names | Customer integrations |
| Existing MCP tool names and schemas | Configured MCP clients and agents |
| Cloudflare resource names in `wrangler.jsonc` (Worker, D1, R2, queues) | Renaming creates new, empty resources |
| Browser storage keys `mailflare-navigation-opened-unread` and `mailflare-two-column-reading`, window event `mailflare:two-column-reading-changed` | Persisted in users' browsers by upstream's reading UI; renaming discards saved reading state and preferences, and the event name must match between the components that dispatch and listen for it |

Other browser storage keys and window event names prefixed `mailflare` follow the same rule: renaming them resets user preferences for no benefit. Leave them.

## Customer releases

Upstream Mailflare is an engineering input, never a customer update channel. Installations only learn about approved Blue Pine Solutions Mail releases: published (non-draft, non-prerelease) GitHub Releases tagged `bluepine-vMAJOR.MINOR.PATCH` in the Blue Pine repository, compared against `DISTRIBUTION.version`. The app checks for them but never installs or deploys; a release is rolled out with the installation's deployment method. Publish a release only for a commit that has passed the integration checks below.

The public repository is the Corresponding Source for every build offered to users. Publish a commit there, by pushing it with an explicit refspec (`git push public <sha>:refs/heads/main`, never `--all`, `--mirror` or `--tags`), before any installation runs it, and confirm with `npm run release:verify-source -- <sha>` that `/source` for that build resolves publicly.

## Integration process

1. Work on a dedicated branch: `integrate/upstream-<YYYY-MM-DD>` from Blue Pine `main`.
2. Pin a specific upstream SHA (upstream does not tag releases). Record it in the table above.
3. For routine integrations, **merge** the pinned SHA; do not re-create upstream history with wholesale cherry-picks. Merging preserves ancestry, so the next integration only sees new upstream commits.
4. Resolve by boundary:
   - **Engine changes** are reviewed and normally accepted. Re-apply Blue Pine engine fixes if upstream has not taken them.
   - **Product-layer changes** are translated or ignored; Blue Pine's version wins.
   - **New upstream license or product gates** must not simply be accepted. Translate them to Blue Pine feature policy; changes to upstream's removed licensing files are dropped.
   - **Upstream migrations** are accepted verbatim and in order. Never edit a historical upstream migration, never skip or reorder one.
5. Before merging the integration branch into `main`, run the full checks: `npm run lint`, `npx tsc --noEmit`, `node --test tests/*.test.mjs`, `npm run build:node`, a Docker smoke test, and an upgrade test against a copy of an existing data volume.
6. Merge into `main` through a reviewed pull request with a merge commit.
7. **Security fast lane:** an urgent upstream security fix may be cherry-picked directly onto `main` and released. The next scheduled merge reconciles it.

## Downstream migrations

Blue Pine may own schema for Blue Pine features (for example mail app passwords). Upstream migrations stay verbatim and in upstream order; Blue Pine migrations live beside them in a separate namespace that every migration runner orders after them.

### How the runners behave

There are three runners, and all of them record applied migrations by file name in `d1_migrations`, so a file applies once per database whatever its position:

| Runner | Used by | Order |
|---|---|---|
| `server/runtime/migrate.ts` | Node / Docker, at start | `drizzle/migrations/meta/_journal.json` entries first, then every other `.sql` file by JavaScript string order |
| `src/lib/migrations/service.ts` over `bundle.json` | Workers: setup and Admin → Version and updates | every `.sql` file by JavaScript string order (`scripts/generate-migration-bundle.mjs`) |
| `wrangler d1 migrations apply` | `npm run migrate`, `db:migrate:*` | files with a numeric prefix by that number, then files without one by string order |

Upstream's hand-written `0021_add_api_keys_prefix_index.sql` is not in the journal, so the Node runner applies it after `0040` while the other two apply it after `0021_add_mailbox_signature.sql`. That existing difference is harmless because the statement is independent, and it shows the rule Blue Pine migrations must follow: never depend on a position relative to an upstream migration that is not already applied.

### Naming and ordering

- Blue Pine migrations are named `bpNNNN_<snake_case_description>.sql`: lowercase `bp`, four digits starting at `0001`, contiguous, never reused. Example: `bp0001_add_mail_app_passwords.sql`.
- `bp` sorts after every digit and has no numeric prefix, so all three runners apply Blue Pine migrations after every upstream migration present in the same build, in `bpNNNN` order. Wrangler's next-number logic ignores them, so upstream-style numbering is unaffected.
- Blue Pine migrations are hand-written and never listed in the drizzle journal. Blue Pine tables are declared in `src/db/schema/bluepine.ts`, which drizzle-kit does not read (`drizzle.config.ts` points at `index.ts`), so a future `drizzle-kit generate` never emits an upstream-numbered copy of them.
- A Blue Pine migration may depend only on upstream schema that existed when it was written. On a database created later, upstream migrations newer than it run before it; on an existing database they run after it. Write Blue Pine migrations so either order gives the same result, and never alter, drop or rebuild an upstream table from one.

### Ownership and changes

- Blue Pine owns `bp*` files and `src/db/schema/bluepine.ts`. Upstream owns every numbered file.
- Never edit a `bp` migration once it has been merged to `main`: installations have recorded it. Fix forward with the next `bpNNNN`.
- Never rename, renumber or delete one. There is no down-migration; recovery is a restore from backup (below) or a forward fix.
- `tests/downstream-migrations.test.mjs` enforces the naming, contiguity, journal exclusion, ordering in all three runners and the rebuild guard below.

### Upstream merges

- Upstream never touches `bp*` files, so file-level conflicts cannot occur. A conflict in `src/db/schema/index.ts` or `src/lib/backups/` is resolved in upstream's favour, then Blue Pine's additions (below) are re-applied.
- **Table rebuilds.** SQLite changes some columns by creating a new table, copying, dropping the old one and renaming. Dropping a table drops its triggers, and on D1 (where foreign keys cannot be switched off) the drop can cascade into child tables. Blue Pine migrations attach triggers or foreign keys to `users`, `mailboxes`, `domains` and `mailbox_access`. The guard test fails if any upstream migration drops or renames one of those tables. When it fails during an integration: verify on a copy of real data what happens to `mail_app_passwords` rows, and add a `bpNNNN` migration that recreates the Blue Pine triggers (and repairs data if the cascade removed it) before merging.
- **Triggers and indexes.** Blue Pine triggers are named `bp_*` and Blue Pine indexes carry the Blue Pine table's name, so they cannot collide with upstream names. Check new upstream triggers on the same tables for interaction (upstream's own are `messages_fts_*` and `jmap_messages_*`, on `messages`).

### Backups

- Every Blue Pine table must be listed in `DOWNSTREAM_BACKUP_TABLES` and assigned to a group in `src/lib/backups/table-groups.ts` in the same change that creates it; the coverage check aborts backups otherwise, and it must not be weakened.
- Downstream tables are written under `tables` but never listed in `includedTables`. Upstream Mailflare rejects a document whose `includedTables` names a table it does not know, and ignores extra entries under `tables`, so Blue Pine backups stay restorable into upstream (dropping the Blue Pine data) and upstream backups restore into Blue Pine (leaving the Blue Pine tables empty). The backup format id and version stay `mailflare-database-backup` / `1`.
- A restore replaces Blue Pine tables like every other table: the database returns to the state of the backup, including credentials revoked since. Restoring a backup into a build that has not applied a Blue Pine migration yet fails with an instruction to apply pending migrations first when the backup carries rows for that table.

### Certification for a new Blue Pine migration

Before a `bp` migration reaches `main`: `node --test tests/*.test.mjs` (fresh database, existing-database upgrade, second run applies nothing, ordering, backup coverage and round-trip), `npm run build` (the bundle contains the file last), `npm run build:node` and a Node start against a copy of an existing data volume (only the new file applies, a restart applies nothing), `wrangler d1 migrations apply --local` against an existing local database, and a backup and restore on the upgraded database.

### Current Blue Pine migrations

| File | Adds |
|---|---|
| `bp0001_add_mail_app_passwords.sql` | `mail_app_passwords`; triggers `bp_mail_app_passwords_revoke_on_password_change` (on `users`) and `bp_mail_app_passwords_revoke_on_access_removal` (on `mailbox_access`) |
| `bp0002_add_imap_mailbox_state.sql` | `imap_folders` (foreign key to `mailboxes`), `imap_message_uids`; triggers `bp_imap_message_uids_advance_uid_next`, `bp_imap_message_uids_immutable` and `bp_imap_folders_monotonic`, all on the Blue Pine tables themselves |

## IMAP mailbox state

`src/lib/imap/` holds the storage contract the IMAP listener consumes (see "IMAP listener" below); it has no parser or protocol dependency of its own. It reads the upstream mail model; its only write to it is `storeImapFlags` (A5.1), which sets `messages.read` and `messages.starred`, the same columns the web app's read and star actions and JMAP keywords change, so the upstream revision triggers on `messages` report the change to web and JMAP clients. Each write is one statement keyed by the UID mapping *and* current folder membership, so a stale UID changes nothing; clearing \Seen never writes outbound mail, which is always \Seen. Everything else IMAP keeps (UIDs, \Deleted) is in the Blue Pine tables.

- **Folders.** INBOX (`status = 'received'`, no folder), Drafts (`draft`), Sent (`sent`), Archive (`archived`), Spam (`spam`, special-use Junk), Trash (`trash`) and one folder per row of `folders` (`received` mail filed there). This is the web app's partition: a custom folder only holds `received` mail, so a message moved to Trash from a folder is in Trash. Queued and failed sends are not IMAP-visible (their representation is generated per read), and snoozing does not hide mail, as in JMAP.
- **Identity.** `imap_folders` keeps UIDVALIDITY and UIDNEXT per (mailbox, folder key); `imap_message_uids` keeps the UID a message holds in the folder it is in. A message that leaves a folder (any status or folder change, or deletion, by any code path) loses that UID the next time the folder is read and receives the next UID of its new folder; UIDs are never reused, because UIDNEXT only increases (enforced by triggers) and moves inside the same statement that assigns UIDs. A folder's existing mail gets UIDs on its first read, oldest first (`created_at`, then `id`), in bounded chunks. Draft UIDs are bound to A1's draft fingerprint and to the stored object first served, so an edited draft gets a new UID instead of new bytes under an old one.
- **UIDVALIDITY** is set when a folder's state row is created (the current Unix time, above every value the mailbox has used) and changes only when a restore replaces state clients may have seen (`src/lib/imap/restore.ts`). Upgrades and restarts never change it.
- **Nothing is attached to `messages` or `folders`.** No trigger and no foreign key, so an upstream rebuild of either cannot drop Blue Pine state; state is reconciled by join on read. The guard test fails if a Blue Pine migration attaches to an upstream table outside the anchored list.

When an upstream integration touches the mail model, certify before merging:

1. `messages.id` values survive any rebuild of `messages` (UIDs refer to them). If ids were rewritten, affected messages simply get new UIDs; raise UIDVALIDITY with a `bpNNNN` migration if the whole mapping should be discarded instead.
2. The meaning of `messages.status` values and of `folder_id` still matches `folderKeyForMessage` and `membershipCondition` in `src/lib/imap/`; a new status must be mapped or deliberately left invisible.
3. `folders.id` stays stable across renames (IMAP keeps UIDVALIDITY through a rename).
4. A rebuild of `mailboxes` is caught by the anchored-table guard (it would cascade into `imap_folders` on D1).
5. `node --test tests/*.test.mjs` (including `tests/imap-state.test.mjs`, SQLite, and the A4 listener suites `tests/imap-protocol.test.mjs`, `tests/imap-session.test.mjs` and `tests/imap-listener.test.mjs`) and `node scripts/imap-state-d1-check.mjs` (the state layer in workerd over D1 and R2) pass on the integrated tree.

## IMAP listener

Blue Pine-owned and Node/Docker only: upstream has no IMAP server, and Workers cannot accept TCP. It is IMAP4rev1 over implicit TLS, on top of the A3 contract above; it defines no storage semantics of its own and needs no schema. Its only writes are the \Seen and \Flagged flags (A5.1).

- **`src/lib/imap-server/`** is the protocol engine: framing, grammar, session state, mailbox names, FETCH, MIME structure, ENVELOPE and SEARCH. It is runtime-neutral (`Uint8Array`, no Node APIs), reaches storage only through `src/lib/imap/service.ts` and A2's `verifyMailAppPassword`, and could sit behind a future gateway. **`server/runtime/imap.ts`** and **`imap-limits.ts`** own the TLS socket, timers, per-instance limits, certificate reload and shutdown; `server/index.ts` starts it when `IMAP_PORT` is set. The distribution guard fails if anything the Worker compiles imports either, or if a Workers build contains the listener.
- **Capabilities** are exactly `IMAP4rev1 SASL-IR AUTH=PLAIN ID` before login and `IMAP4rev1 ID NAMESPACE UNSELECT SPECIAL-USE` after (`session.ts`). Nothing else is advertised (no IMAP4rev2, IDLE, MOVE, UIDPLUS, CONDSTORE/QRESYNC, LITERAL+, UTF8=ACCEPT); adding one needs its behavior implemented and tested first.
- **Flags (A5.1):** SELECT answers `[READ-WRITE]` with `PERMANENTFLAGS (\Seen \Flagged)` for any principal that may read the mailbox, because the web app lets every reader, `read_only` delegates included, mark read and star; EXAMINE answers `[READ-ONLY]` with `PERMANENTFLAGS ()`. STORE and UID STORE (FLAGS, +FLAGS, -FLAGS, each with .SILENT) change \Seen and \Flagged through A3's `storeImapFlags`, in chunks of at most 80 UIDs, each chunk re-authorized. \Answered, \Draft and keywords are accepted and not kept (the FETCH response shows the real flags); \Recent and unknown system flags are BAD. Naming \Deleted is refused and writes nothing: `NO [NOPERM]` without management access, `NO [CANNOT]` with it. A permission denial never ends the session; lost access still ends it with BYE. Under SELECT, a non-PEEK `BODY[…]`, `RFC822` or `RFC822.TEXT` sets \Seen through the same write once the body has been read, and the response carries the new FLAGS; `BODY.PEEK`, `RFC822.HEADER` and EXAMINE never do. .SILENT still reports a flag that did not end up as requested (a concurrent change, or \Seen on outbound mail). The listener never calls the one-UID `setImapMessageFlags`.
- **Not writable yet:** COPY, EXPUNGE (and CLOSE never expunges), APPEND, CREATE, DELETE, RENAME, SUBSCRIBE and UNSUBSCRIBE are refused before any storage call. A3's own UID and canonical-size bookkeeping still happens on reads, as A3 intends.
- **Names:** a flat namespace with a `NIL` hierarchy delimiter, so every folder name (which may contain `/` or `.`) is exposed exactly as A3 names it, in modified UTF-7. Only INBOX is case-insensitive.
- **Sequence numbers** exist only in the session: a snapshot of A3's UIDs taken at SELECT and diffed against A3 before each command, with EXPUNGE withheld during FETCH and SEARCH (RFC 3501 §7.4.1). A UIDVALIDITY change or a vanished selected folder ends the session with BYE.
- **Content:** FETCH serves A3's canonical octets exactly. BODYSTRUCTURE, BODY, sections and ENVELOPE are derived from those same octets by an offset-based reading (`mime.ts`), never from database columns or rebuilt MIME. SEARCH answers header and body keys from those octets too. Derived metadata is cached per (mailbox, folder key, UIDVALIDITY, UID), which A3 guarantees is immutable.
- **Authentication** is A2 with the `imap` scope, then `authorizeImapAccess`; A3 re-authorizes each command and the listener re-checks idle sessions every 60 seconds, closing revoked ones with BYE.


## Downstream changes to offer upstream

- `40720fb` — manual domain setup without Cloudflare credentials, manual-mode MX setup, inbound SMTP recipient validation.
