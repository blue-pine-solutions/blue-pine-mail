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

## Downstream changes to offer upstream

- `40720fb` — manual domain setup without Cloudflare credentials, manual-mode MX setup, inbound SMTP recipient validation.
