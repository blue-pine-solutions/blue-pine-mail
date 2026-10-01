# A5.5b — Stored IMAP subscriptions: certification report

Certified 1 October 2026 on the private development repository (the `origin` remote). Nothing was pushed, and the public release repository was not touched.

## Why

A5.5a answered SUBSCRIBE with OK, UNSUBSCRIBE with `NO [CANNOT] All mailboxes are always subscribed`, and listed every mailbox in LSUB, and deferred stored subscriptions until a real client needed them. Thunderbird-0 testing showed the need: in the Subscribe dialog for `userb@smoketest.test`, unchecking Archive and confirming did not stick, so the next opening of the dialog showed Archive checked again. Thunderbird ignored the refused UNSUBSCRIBE, and LSUB kept listing Archive.

## Commits and worktree

- **Starting commit:** `d8695fa2659860bf98215d31d62a36914163bfb2` ("Add IMAP COPY support"), equal to `origin/main` on `main`.
- **Resulting commit:** the single local commit "Add stored IMAP subscriptions" that adds this report, one commit ahead of `origin/main`. Its SHA is reported with the certification, and the commit is not pushed.
- **Operator-local files preserved, not staged:** the modified `docker-compose.yml` and the untracked `local-certs/` (Thunderbird TLS material). `.env.docker` and the running containers' configuration were not changed. For the volume-upgrade check, a consistent read-only snapshot of the live database was taken with SQLite's backup API inside the container, copied out, and removed from the container; the live volume itself was not modified.

## Files changed

| File | Change |
|---|---|
| `drizzle/migrations/bp0005_add_imap_subscriptions.sql` | New Blue Pine migration: table `imap_unsubscribed_folders` and its index |
| `src/db/schema/bluepine.ts` | `imapUnsubscribedFolders` declaration |
| `src/lib/imap/state.ts` | `readerGuard` (the in-SQL counterpart of `authorizeImapAccess` for preference writes) and `recordImapUnsubscription` |
| `src/lib/imap/service.ts` | `listImapUnsubscribed`, `setImapSubscription`; `listImapMailboxes` also removes subscription rows of deleted custom folders |
| `src/lib/imap-server/session.ts` | LSUB filters by stored state; SUBSCRIBE and UNSUBSCRIBE store it |
| `src/lib/backups/export.ts`, `table-groups.ts`, `types.d.ts` | The new table in `DOWNSTREAM_BACKUP_TABLES` and the "mail" group |
| `tests/imap-subscriptions.test.mjs` | New: 12 tests (below) |
| `tests/imap-mailbox-management.test.mjs` | A5.5a's subscription expectations updated to the stored behavior |
| `tests/downstream-migrations.test.mjs` | The new index; a bp0005 upgrade test; the bp0004 upgrade test now expects bp0004 and its successors |
| `scripts/imap-state-d1-check.mjs` | Migration pins (53 files, 5 Blue Pine, bp0005 last); 9 subscription checks on D1; a void result is encoded as `null` |
| `UPSTREAM.md`, `CLAUDE.md` | The stored-subscription semantics, the migration table, the rebuild note |
| `docs/notes/imap-a5.5b-stored-subscriptions-report.md` | This report |

## Schema: `bp0005_add_imap_subscriptions.sql`

```sql
CREATE TABLE imap_unsubscribed_folders (
  user_id    text NOT NULL REFERENCES users(id)     ON DELETE cascade,
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE cascade,
  folder_key text NOT NULL,
  created_at integer NOT NULL,
  PRIMARY KEY (user_id, mailbox_id, folder_key)
);
CREATE INDEX imap_unsubscribed_folders_mailbox_idx ON imap_unsubscribed_folders (mailbox_id, folder_key);
```

It follows UPSTREAM.md "Downstream migrations":
- the next contiguous `bpNNNN`, outside the drizzle journal;
- the table declared only in `bluepine.ts`;
- foreign keys only to the anchored `users` and `mailboxes`, and no triggers;
- nothing upstream altered;
- listed for backups as a downstream table, never in `includedTables`.

There is no down-migration, in line with the policy; recovery is a forward fix or a restore. Restoring an older backup without the table leaves it empty, which means everything subscribed.

## Semantics

- **Rows record unsubscriptions only.** A visible mailbox is subscribed unless the user has unsubscribed it.
- **UNSUBSCRIBE** adds the row, with `INSERT OR IGNORE` in one statement guarded by `readerGuard` and, for a custom folder, by that folder still being in the mailbox. **SUBSCRIBE** deletes the user's own row.
  - Both return `OK SUBSCRIBE completed` / `OK UNSUBSCRIBE completed` and are idempotent.
  - Concurrent repeats leave exactly one row, or none.
- **LSUB** lists the visible mailboxes the user has not unsubscribed, applying LIST's reference and patterns, with `\Noinferiors` as before.
- **LIST and SPECIAL-USE are unchanged.** An unsubscribed mailbox is still listed by LIST, still carries its special-use attribute, and can still be selected.
- **Keying is by A3's stable folder key** (`inbox`, `drafts`, `sent`, `archive`, `junk`, `trash`, or `f:<folder id>`), never by name.
- **Deviations from RFC 3501, documented in UPSTREAM.md:**
  - subscriptions follow mailbox identity rather than names (RENAME carries them, and a deleted mailbox disappears from LSUB);
  - SUBSCRIBE of a nonexistent name is refused, which §6.3.6 allows;
  - UNSUBSCRIBE of an already unsubscribed mailbox is OK.

## Upgrade and default policy

A pre-A5.5b database has no rows, so after the upgrade every mailbox is still subscribed: exactly what clients saw before, and nothing disappears from Thunderbird. Folders created later on any surface (web, JMAP, IMAP) are subscribed too, without a write. Tested in three places:
- a fresh test database;
- the bp0005 upgrade test (data kept, zero rows, the same schema as a fresh database, cascades);
- a snapshot copy of the live operator volume. The Node runner applied exactly `bp0005`, a restart applied nothing, the existing rows (2 users, 4 mailboxes, 66 messages, IMAP state, 1 app password) were unchanged, and userb's six folders were all subscribed.

The alternative, storing subscriptions themselves, was rejected. It would need a backfill at migration time, and every folder created later in the web app would be missing from clients that show only subscribed folders.

## Authorization and isolation

- **Scope:** the authenticated user and the mailbox the credential is for, `(user_id, mailbox_id)`.
  - A delegate's choices never change the owner's or another delegate's.
  - The owner's personal and shared mailboxes are separate.
  - A new app password of the same user sees the same state, so it survives re-authentication.
- **Authority:** reading the mailbox (owner, or any delegation while sharing is enabled, `read_only` included), as in A5.5a. A subscription is a view preference that changes nothing anyone else sees. Mailbox management (CREATE, RENAME, DELETE) still needs management access, unchanged.
- **Names:** a name must resolve to one of the principal's visible mailboxes. Another mailbox's folder, an unknown name, a lowercase `drafts`, or a stale collision suffix are `NO [NONEXISTENT]` and record nothing. A3 checks the key again, and the guarded statement checks that a custom folder still exists in the mailbox.
- **Lost access:** a revoked credential, a removed `imap` scope, removed delegation, a disabled user or mailbox, or sharing turned off.
  - Before the command, it ends the session with `BYE Access revoked`, as everywhere.
  - Between the check and the write, the SQL `readerGuard` records nothing and the session ends with BYE. `readerGuard` covers the user, the credential and its `imap` scope (via `json_each`), the mailbox, and the delegation.
- **No fail-open:** every statement is parameterized, and the guard runs on both D1 and the Node SQLite wrapper.
- **Orphans:** deleting a folder on any surface removes every user's rows for it at the next listing (`listImapMailboxes`), and folder ids are never reused. Deleting the mailbox or the user cascades. A revoked delegate's own rows are inert, because no session can read them.

## CREATE, DELETE and RENAME

- **CREATE:** the new folder is subscribed (no row needed). Thunderbird's follow-up SUBSCRIBE is OK and writes nothing.
- **DELETE:** every user's state for the folder goes, so a new folder with the same name starts subscribed.
- **RENAME:** the folder keeps its state, consistent with A5.5a, where RENAME keeps the folder id, UIDVALIDITY and selection. The old name names nothing (UNSUBSCRIBE of it is NONEXISTENT). Thunderbird's sequence (UNSUBSCRIBE the old name, RENAME, SUBSCRIBE the new one) ends subscribed.

## Test results

| Check | Result |
|---|---|
| `tests/imap-subscriptions.test.mjs` (new) | 12/12 |
| `tests/imap-mailbox-management.test.mjs` (A5.5a, updated) | 19/19 |
| Full suite `node --test tests/*.test.mjs` | 504 tests: 497 passed, 4 failed, 3 skipped. Baseline 491 / 484 / 4 / 3 plus 13 new (12 subscription tests and the bp0005 upgrade test). |
| D1/workerd `scripts/imap-state-d1-check.mjs` | 165 passed, 0 failed. Baseline 156 plus 9 subscription checks, including the credential and `json_each` guard path, a removed scope, and survival through a backup restore. |
| Distribution guard | 15/15 |
| `npm run build` | Passed; the Workers migration bundle has 53 files with `bp0005` last |
| Node build | Passed |
| `wrangler d1 migrations apply --local` | Scratch persisted state: an existing database at bp0004 applied exactly `bp0005`, and a second run applied nothing |
| Live-volume copy (Node runner) | Exactly `bp0005`, then nothing on restart; backup export and restore preserved subscription state and UIDs |
| TypeScript | 20 errors, the existing count; none in changed files |
| eslint (changed files) | 0 errors. One existing warning at `src/lib/backups/export.ts:23` (`_env`), on a line not changed here. |

**The four failures** are the known Windows ones, with the same causes as the baseline:
- the CRLF form of the bp0003/bp0004 trigger text;
- gate6 (`chmod`);
- two `EBUSY` temp-file unlinks in `imap-state`.

## Mutation pass

Each mutant was applied with anchored edits, run against targeted tests under finite timeouts, then restored byte-for-byte (verified by checksum). **8 of 8 killed:**

| # | Mutant | Killed by |
|---|---|---|
| 1 | LSUB ignores stored state | Persistence test, Thunderbird case |
| 2 | Default inverted (only unsubscribed listed) | Default-state test |
| 3 | UNSUBSCRIBE not persisted | Thunderbird case |
| 4 | State shared across users (user id not filtered) | Isolation test |
| 5 | SQL `readerGuard` removed | Lost-access-between-check-and-write test |
| 6 | SUBSCRIBE clears every row of the user | Persistence test |
| 7 | Deleted folders' state kept | DELETE test |
| 8 | Nonexistent folder keys accepted by A3 | D1 check "a folder of another mailbox is nonexistent", and four more |

The runner first misreported mutant 8 as surviving: the D1 check script crashed (`.code` of `null`) instead of printing its summary. The runner now counts a non-zero exit as a failure, and the D1 checks read `?.code`, so the kill is reported as an ordinary FAIL.

## Known limitations

- Subscriptions are identity-keyed (see the RFC deviations above): a client cannot keep a subscription to a name that does not exist.
- LSUB does not return `\Noselect` placeholders, because the namespace is flat.
- LIST-EXTENDED (`\Subscribed`, `LIST (SUBSCRIBED)`) is not offered; nothing advertises it.
- The `imap` scope is checked in SQL only for the unsubscribe write; reads re-authorize through `authorizeImapAccess`.
- Not certified with GUI clients beyond the retest below.

## Thunderbird retest procedure

1. The operator reviews and authorizes this commit. Locally, rebuild and restart the existing container from it: `docker compose build`, then `docker compose up -d`. This uses the unchanged operator-local `docker-compose.yml`, `.env.docker` and `local-certs/`. The start applies `bp0005` automatically, and its log shows it once.
2. In the existing Thunderbird test profile, connect `userb@smoketest.test` (no settings change). Open the Subscribe dialog: every standard folder is checked.
3. Uncheck **Archive** and click OK. Reopen Subscribe: Archive is unchecked.
4. Recheck **Archive** and click OK. Reopen Subscribe: Archive is checked.
5. Uncheck Archive again, close Thunderbird entirely, restart it, and reopen Subscribe: still unchecked. Recheck it.
6. Optional: rename a custom folder, then delete one, reopening Subscribe after each.
7. Collect the Thunderbird IMAP log (`MOZ_LOG=IMAP:5`) and `docker logs` for the window. Expect `UNSUBSCRIBE "Archive"` and `SUBSCRIBE "Archive"` answered OK, and no `[CANNOT]`.

## Readiness

The A5.5b implementation and certification are complete. It is **ready for operator promotion** once the operator has reviewed the local commit and run the Thunderbird retest above. Nothing has been pushed.
