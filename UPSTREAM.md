# Upstream integration contract

Blue Pine Mail is a downstream distribution of Mailflare. This file records where Blue Pine follows upstream, where it diverges, and how upstream changes are brought in. Read it before any architectural change.

| | |
|---|---|
| Blue Pine repository | https://github.com/bofa-ds/mailflare (`origin`) |
| Upstream | https://github.com/hieunc229/mailflare (`upstream`) |
| Current Blue Pine HEAD | `40720fb` (2026-09-28) |
| Current upstream base | `c57671f` (upstream `main`, 2026-09-28; package version 0.4.0) |

Update the two SHAs above after every upstream integration.

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

Browser storage keys and window event names prefixed `mailflare` are not compatibility contracts in the same sense, but renaming them resets user preferences for no benefit. Leave them.

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

## Downstream changes to offer upstream

- `40720fb` — manual domain setup without Cloudflare credentials, manual-mode MX setup, inbound SMTP recipient validation.
