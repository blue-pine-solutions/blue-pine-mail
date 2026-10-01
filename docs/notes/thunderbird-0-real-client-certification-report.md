# THUNDERBIRD-0 — Real-Client Compatibility Certification

**Status: THUNDERBIRD-0 REAL-CLIENT IMAP COMPATIBILITY CERTIFIED**, for the IMAP workflows listed below, in the local test environment described below. This is not a statement that the product as a whole is production-ready.

Prepared 1 October 2026 in the private development repository (the `origin` remote). Nothing was pushed, and the public release repository was not touched.

## Evidence classes

This report keeps four kinds of evidence apart and labels each finding with them:

| Label | Meaning |
|---|---|
| **Automated** | Repository tests and checks (`node --test`, the D1/workerd check, builds), as certified for each IMAP phase. |
| **Server log** | The IMAP listener's own event log (`docker logs`, event names such as `auth.success`) and the startup migration log. The listener logs events, not IMAP commands, and never logs credentials or message content. |
| **Manual** | What the operator did and saw in the real Thunderbird client. |
| **Inferred** | The implemented IMAP behavior the manual observation is consistent with. No raw IMAP command transcript was captured during the session, so no specific command is claimed to have been observed. |

## Tested client

- **Mozilla Thunderbird desktop** on Windows, configured manually with Advanced Config.
- **Version:** not captured during the manual session, so per-step versions are not claimed.
  - The executable's file version read **154.0** during the THUNDERBIRD-0 preflight earlier on 1 October 2026.
  - At report time `thunderbird.exe` reports **157.0**, last modified 1 October 2026 13:04 local: Thunderbird updated itself during the day.
  - The post-rebuild A5.5b retest (below) took place after that file update and included a full client restart.

## Repository baseline

- **Commit:** `4882b2a5cdc4d8e18223ef351771ae54dbacd9df` ("Add stored IMAP subscriptions", A5.5b), equal to `origin/main` on `main` when this report was written. This report is a documentation-only commit on top of it.
- **Server capabilities:** before login `IMAP4rev1 SASL-IR AUTH=PLAIN ID`; after login `IMAP4rev1 ID NAMESPACE UNSELECT SPECIAL-USE MOVE UIDPLUS IDLE`. No extension was added for this certification, and no IMAP code was changed.
- **Operator-local state preserved, not staged or committed:** the modified `docker-compose.yml`, `local-certs/`, `.env.docker`, the runtime database and volumes, and the Thunderbird profile. The database and logs were only read.

## Test environment

- The Blue Pine Solutions Mail Node/Docker runtime, built from the promoted commits, on the operator's Windows PC:
  - the web app on `localhost:3000`;
  - IMAP on `127.0.0.1:993` (loopback only);
  - inbound SMTP intake on `127.0.0.1:2525`;
  - Mailpit on `localhost:8025`.
- **IMAP over implicit TLS** (no STARTTLS), with a dedicated, short-lived, self-signed test certificate: `CN=localhost`, SAN `DNS:localhost` and `IP:127.0.0.1`.
- **Data:** the disposable `smoketest.test` domain with synthetic identities and messages. Test mail was injected through the local inbound SMTP listener. The client account is `userb@smoketest.test`, a non-admin user who owns a personal mailbox.
- **Credential:** a mail app password created in Settings → App passwords → Mail app passwords (IMAP and SMTP), labelled "Thunderbird test", for mailbox `userb@smoketest.test`, with the IMAP scope only. Server-side, its stored scopes are `["imap"]`.
- **Not available by design:** authenticated SMTP submission is not implemented. Thunderbird's account setup asked for an outgoing server; the account was created with Advanced Config, and nothing was sent through Thunderbird.

## Initial connection

1. **TLS.** *Manual:* Thunderbird first rejected the self-signed certificate, as expected. The operator added a certificate exception for `localhost:993` only, after which TLS succeeded.
   - *Server log (before the exception):* TLS "bad certificate" alerts from Thunderbird, matching the rejection.
   - *Server log (after):* every IMAP connection of the current runtime negotiated **TLSv1.3** (12 of 12 since the post-A5.5b rebuild).
   - An earlier bare socket hang-up came from the operator's raw TCP reachability check against port 993; it is not an IMAP failure.
2. **Authentication.** *Manual:* "Normal password" with the mail app password; the web password was not used.
   - *Server log:* `auth.success` for userb's user id, the expected mailbox id and one specific app password id. Since the rebuild, 12 of 12 connections authenticated, all with that single credential, user and mailbox. There were no authentication failures, protocol violations, command errors, timeouts or revocations.
   - *Automated:* A2 scoped credentials and the IMAP authentication paths are covered by the IMAP session and listener suites.
3. **Folder discovery.** *Manual:* Inbox, Drafts, Sent, Archives, Spam and Trash appeared, and Inbox synchronized (initially empty) without errors.
   - *Inferred:* the server's six system folders, discovered through LIST with SPECIAL-USE (`\Drafts`, `\Sent`, `\Archive`, `\Junk`, `\Trash`). "Archives" is Thunderbird's display name for the server's `Archive` folder.

## Compatibility matrix

| # | Workflow | Manual observation | Inferred server behavior | Result |
|---|---|---|---|---|
| 1 | TLS connectivity | Exception for `localhost:993`, then TLS succeeds | Implicit TLS listener; TLSv1.3 in the server log | PASS |
| 2 | App-password authentication | IMAP-only mail app password accepted | `auth.success` (server log); A2 scoped credentials | PASS |
| 3 | Initial mailbox discovery | Six standard folders; empty Inbox synchronized | LIST/SPECIAL-USE, SELECT | PASS |
| 4 | New-message delivery | Message injected on 2525 appeared without a manual refresh | Consistent with the A5.4 IDLE path (advertised and certified); the client's mechanism was not captured, and Thunderbird can also poll | PASS |
| 5 | Seen / read state | Opening marked it read; Mark As Unread made it unread | STORE `\Seen` set and clear (A5.1); the message is now `read = 1` | PASS |
| 6 | Flagged / starred | Star kept across navigation and a full restart | STORE `\Flagged` (A5.1); the message is now `starred = 1` | PASS |
| 7 | MOVE | Inbox → Archives: gone from Inbox, present in Archives | MOVE (A5.2b; MOVE is advertised); the message is now `status = archived` | PASS |
| 8 | COPY | Archives → Inbox: original kept, copy in Inbox | COPY with independent copy objects (A5.8) | PASS |
| 9 | Recoverable deletion | The Inbox copy went to Trash; the Archives original was intact | Move to Trash (A5.2b MOVE or A5.2a recoverable EXPUNGE; which one was not captured) | PASS |
| 10 | Permanent deletion | The Trash copy disappeared; the Archives original was intact | Permanent removal in Trash (A5.2c, EXPUNGE or UID EXPUNGE; the exact sequence was not captured). No copy row remains in the database, and the original is unchanged | PASS |
| 11 | Draft save and round trip | Draft saved, reopened, and recipient, subject and body preserved | APPEND to Drafts (A5.7), stored byte for byte as `drafts/<id>.eml` | PASS |
| 12 | Draft edit and re-save | Updated content kept; exactly one draft remained | Consistent with APPEND of the new version plus removal of the old one (A5.7 with A5.2c; the exact commands were not captured). Exactly one such draft exists, and its object is an IMAP APPEND object | PASS |
| 13 | CREATE | "TB Test Folder" created | CREATE (A5.5a via R-1) | PASS |
| 14 | RENAME | Renamed to "TB Renamed Folder"; the old name disappeared | RENAME (A5.5a; the folder id is kept) | PASS |
| 15 | DELETE | Folder deleted and stayed gone | DELETE (A5.5a); no custom folders remain | PASS |
| 16 | Subscribe dialog | Before A5.5b, unchecking Archive did not persist | A5.5a refused UNSUBSCRIBE and LSUB listed everything | PASS AFTER A5.5b FIX |
| 17 | Subscribe retest | Uncheck, recheck and restart cases all persisted (below) | SUBSCRIBE, UNSUBSCRIBE and LSUB stored per user and mailbox (A5.5b, bp0005) | PASS AFTER A5.5b FIX |
| 18 | Reconnect / state persistence | After a full restart: the test message still in Archives and still starred | State in the database, not in sessions; UIDs stable (A3) | PASS |
| 19 | Folder switching | Inbox → Drafts → Archives → Spam → Trash → Inbox with no errors, prompts or stalls | SELECT across folders; no errors in the server log | PASS |
| 20 | Sending / SMTP | Not configured as a working service; nothing sent | Authenticated SMTP submission is not implemented | EXPECTED LIMITATION |

## The A5.5b finding

- **Reproduction:** in Thunderbird's Subscribe dialog the standard folders were shown checked. Unchecking Archive and clicking OK, then reopening the dialog, showed Archive checked again.
- **Cause:** A5.5a kept no subscription state. UNSUBSCRIBE was answered `NO [CANNOT] All mailboxes are always subscribed` and LSUB listed every mailbox, so the client's choice could not persist. This deferral was deliberate and documented, pending real-client evidence.
- **Why the fix was justified:** this was the only concrete defect in the tested workflow that needed an IMAP change, and it was user-visible in a standard client dialog.
- **Fix:** commit `4882b2a5cdc4d8e18223ef351771ae54dbacd9df`, with migration `bp0005_add_imap_subscriptions.sql` (table `imap_unsubscribed_folders`). See the A5.5b certification report in this folder.
  - Rows record unsubscriptions per user and mailbox, so everything is subscribed by default, including after the upgrade.
  - State is keyed by folder identity.
  - The A5.5b certification was: 12/12 new tests, the full suite at baseline plus 13, D1 165/0, and 8 of 8 mutants killed.
- **Deployment:** *server log:* after the rebuild, startup reported `Applied 1 migration(s): bp0005_add_imap_subscriptions.sql`, and the IMAP listener came back on 993. The database now has bp0001 through bp0005 applied.
- **Retest:** *manual*, with the same steps:
  - A. Uncheck Archive, OK, reopen: Archive stayed **unchecked**.
  - B. Recheck Archive, OK, reopen: Archive stayed **checked**.
  - C. Uncheck Archive, OK, exit Thunderbird completely, restart, reopen Subscribe: Archive stayed **unchecked**.
- **State at report time:** userb has no unsubscription rows, so every folder, Archive included, is currently subscribed. The database keeps only the current state, not the intermediate ones; this is consistent with Archive having been re-checked after step C.

## Security observations

- IMAP used a scoped mail app password, never the account's web password. The credential has the IMAP scope only, so it cannot be used for SMTP, and it is bound to the one mailbox.
- All IMAP traffic used TLS (TLSv1.3 in the server log). The listener offers no plaintext or STARTTLS port.
- The self-signed certificate is a local test certificate. Thunderbird trusts it only through an exception for `localhost:993`, and the listener is published on loopback only. Nothing here implies public exposure or a public certificate deployment.
- The server log contained no credential material, and none was read for this report. The plaintext app password was not inspected, and the stored credential was not read beyond its label and scopes.
- This report contains no secrets.

## Persistence observations

- **Starred:** *manual:* kept across navigation and a full Thunderbird restart. *Database:* `starred = 1`.
- **Archive membership:** *manual:* kept across a full restart. *Database:* `status = archived`, and it is the original inbound message, not a copy.
- **Subscriptions:** *manual:* kept across reopening the dialog and across a full restart (retest A–C).
- **Drafts:** *manual:* the round trip and the edit-and-re-save preserved recipient, subject and body without duplicates. *Database:* one draft, stored as an IMAP APPEND object.

## Known limitations and exclusions

- Authenticated SMTP submission, and therefore sending and Sent-folder copies from Thunderbird, is not implemented and was not tested.
- No public or production TLS deployment is claimed. TLS used a local self-signed certificate behind a per-host client exception.
- This does not cover every Thunderbird feature (for example templates, filters, offline compaction details or junk training), extension, setting or version, nor any other IMAP client.
- This manual pass was not exhaustive concurrency, load or network-failure testing. Those properties rest on the automated certification of the IMAP phases.
- The raw IMAP command sequence was not captured, so command-level mappings in this report are inferences.
- A5.5b's documented deliberate differences from RFC 3501 remain:
  - subscriptions follow mailbox identity rather than names;
  - SUBSCRIBE of a nonexistent name is refused;
  - UNSUBSCRIBE of an unsubscribed mailbox is OK.
- Existing documented IMAP limitations and backlog items remain unless separately resolved, as UPSTREAM.md describes for each phase. Examples: Drafts-only APPEND; no COPY into Sent or Drafts; no LITERAL+, MULTIAPPEND, CONDSTORE or QRESYNC; MIME parsing on the event loop.

## Verdict

**THUNDERBIRD-0 REAL-CLIENT IMAP COMPATIBILITY CERTIFIED** for:
- TLS connection;
- app-password authentication;
- folder discovery;
- new-message delivery;
- read and starred state;
- MOVE and COPY;
- recoverable and permanent deletion;
- draft save and update;
- CREATE, RENAME and DELETE;
- persistent subscriptions (after A5.5b);
- reconnect persistence;
- folder switching.

All were tested with Mozilla Thunderbird desktop against the local Blue Pine Solutions Mail runtime at `4882b2a`. The certification is limited to these IMAP workflows; it does not cover sending, and it does not declare the product production-ready.

## Next recommended phase

**Authenticated SMTP Submission and Sent behavior:** a submission service authenticating with the existing SMTP-scoped mail app passwords, and the client's copy-to-Sent behavior. It has not been started.
