# SMTP-3 Thunderbird Real-Client SMTP Submission Certification

**Verdict: SMTP-3 CERTIFIED for Thunderbird 157.0 on Windows, against the local Docker runtime.** A real Thunderbird client authenticated with an SMTP-only app password over implicit TLS on `127.0.0.1:465` and sent seven composed messages. Six were accepted and delivered to Mailpit exactly once each. One oversize message was permanently rejected and left no trace. The server stored exactly one Sent copy per accepted message, and Thunderbird, with its own Sent upload disabled, showed exactly one. No source change was needed.

This certifies one client against one local environment. It does not make the product production-ready (see Limitations).

## Evidence key

| Tag | Meaning |
|---|---|
| **OPERATOR** | Observed on screen by the operator in Thunderbird |
| **LOG** | Container log lines from the `smtp-submission` and `imap` components |
| **MAILPIT** | Mailpit HTTP API (message list, message, raw source, attachment part) |
| **DB** | Read-only queries against the synthetic mailbox in the SQLite database. No credential, password, hash or secret column was read |
| **AUTO** | The automated SMTP-1 and SMTP-2 test suites (not re-run in SMTP-3) |
| **INFERENCE** | Reasoned from the above, not directly observed |

## Baseline

- Branch `main`, start and end commit `a7354aeaa476883851378292c96f178da322e2e4` ("Add authenticated SMTP submission listener"). 0 ahead / 0 behind `origin/main` at the start. Nothing was pushed.
- Thunderbird 157.0. Synthetic account `userb@smoketest.test` (IMAP already certified in Thunderbird-0).
- Runtime (operator-local, not committed): `docker-compose.yml` publishes `127.0.0.1:465:465`; `.env.docker` sets `SMTP_SUBMISSION_PORT=465` and `SMTP_SUBMISSION_HOST=0.0.0.0` (inside the container only). The listener reuses the IMAP certificate: `CN=localhost`, SAN `DNS=localhost` and `IP=127.0.0.1`, valid to 31 Oct 2026.
- Start-of-session state (DB): 1 archived inbound, 1 draft, 0 Sent. Mailpit 0 messages.

## Thunderbird configuration (operator-local)

| Setting | Value |
|---|---|
| Outgoing server | Description `Blue Pine Solutions Mail Test`, `localhost`, port 465, SSL/TLS, Normal password, user `userb@smoketest.test` |
| Credential | A dedicated Mail App Password, SMTP scope only, created by the operator. The value was never shown to, requested by, or logged for the assistant |
| Sent copy | "Place a copy in" **unchecked for this account only** |
| Certificate | Per-host exception for `localhost:465`, confirmed from Thunderbird's own dialog (same SHA-256 as the existing `localhost:993` exception) |
| Password | The operator chose to remember it in Thunderbird. Later sends did not prompt |

A temporary trust import of the certificate as a CA was tried and then deleted (see Compatibility findings). No other account was changed.

## Results

| # | Test | Result |
|---|---|---|
| 1 | TLS | **Pass.** TLS 1.3, `CN=localhost` (LOG, handshake probe) |
| 2 | Authentication | **Pass.** `auth.success method=PLAIN` on the SMTP-only credential for every send; no send used the IMAP credential (LOG) |
| 3 | Basic send, 001 | **Pass.** Accepted `recipients=1`. Thunderbird reported success (OPERATOR, LOG) |
| 4 | Mailpit | **Pass.** Exactly one delivery per accepted message: 6 sent, 6 present (MAILPIT) |
| 5 | Sent copy | **Pass.** One DB row (`outbound`, `sent`) per message; the IMAP Sent folder holds 6 distinct messages after 6 sends; Thunderbird lists 6 and no duplicate upload occurred (DB, OPERATOR) |
| 6 | Attachment / MIME, 002 | **Pass.** Attachment SHA-256 identical to the original file (107 bytes); `multipart/mixed`; UTF-8 body `café naïve résumé` intact in Mailpit and in Thunderbird's Sent copy; DB attachment row correct (MAILPIT, DB, OPERATOR) |
| 7 | Reply / threading | **Pass.** Reply to our own Sent message and reply to an inbound message both carried `In-Reply-To` and `References` equal to the parent's Message-ID, and the DB `thread_id` matched the parent. Thunderbird threads 001 with its reply (MAILPIT, DB, OPERATOR) |
| 8 | To / Cc / Bcc, 005 | **Pass.** Accepted `recipients=3`; Mailpit shows To, Cc and the Bcc envelope recipient. The delivered header block had no Bcc of its own: the single `Bcc:` line in Mailpit's raw output is the first line, ahead of `Return-Path` and `Received`, where Mailpit places it from the envelope. The stored Sent copy keeps its Bcc header (normal for the sender's copy). Bcc-only was not attempted (known limitation) (LOG, MAILPIT, DB; INFERENCE for "no Bcc on the delivered data") |
| 9 | Safe permanent failure, 006 | **Pass.** A 40 MB attachment (54.8 MB encoded) against `SIZE 37748736`. Thunderbird showed "message exceeds fixed maximum message size 37748736" and kept the draft open. No DB row, no Mailpit message, Sent and Drafts unchanged, the connection closed after the error was dismissed (OPERATOR, DB, MAILPIT, LOG). The listener does not log the 552 reply itself, so that reply is evidenced by Thunderbird's text. SMTP-2 certifies the 552 mapping (AUTO) |
| 10 | Reconnect / restart, 007 | **Pass.** `docker restart` of the mailflare container only. Clean startup: four listeners up, 53 migrations, last `bp0005_add_imap_subscriptions.sql`, integrity `ok`. The next send needed no password and no certificate prompt, and was accepted and delivered once (LOG, DB, MAILPIT, OPERATOR). This was a container restart, not a host reboot |

## Compatibility findings

None required a source change. Both certificate items concern the operator's local certificate setup, not the SMTP code.

1. **Thunderbird's "Get Certificate" cannot reach the listener from `localhost`.** `localhost` resolves to `::1` first; Docker publishes only `127.0.0.1`, and the dialog's probe does not fall back to IPv4 (the sends do). The server saw no connection from the probe (LOG). Workaround that succeeded: send, dismiss the "self-signed" error, and confirm the exception in the dialog Thunderbird then opens. Alternative, untested: use `127.0.0.1` as the server name, which the certificate's SAN covers.
2. **The local certificate is a self-signed `CA:TRUE` certificate (critical).** Importing it as a trusted authority makes Thunderbird reject it as a server certificate ("basic constraints extension identifying it as a certificate authority"). Per-host exceptions work. Measured with .NET on the `.crt` file (public certificate only). A non-CA leaf certificate would avoid both the exception and this error; that is a documentation or tooling follow-up, not part of SMTP-3.
3. **The From display name is normalised.** Thunderbird sent `Thunderbird Test <userb@smoketest.test>`; the delivered and stored messages carry `userb <userb@smoketest.test>`. The address was preserved. This matches the server-owned identity model from SMTP-1 (INFERENCE); it is noted as an observation, not a defect.
4. **Thunderbird autosaves a draft over IMAP while composing** (`imap append` before the first send). The draft left the Drafts folder after sending. The old test draft (UID 2) was untouched.
5. **New Sent messages get IMAP UIDs when the folder is next viewed**, not at send time. This is existing behaviour of the IMAP layer. Thunderbird showed the right count after a refresh.

## Source changes

None. `git status` shows only the operator-local `docker-compose.yml` and `local-certs/`, plus this report.

## Test artefacts and state left behind

- Synthetic outbound messages in the synthetic mailbox (001, 002, two replies, 005, 007) and in Mailpit. Mailpit holds 6 messages.
- Test files in `C:\Users\brand\mailflare-test\smtp3-attachments\` (outside the repository). The 40 MB file was deleted after the test.
- The imported certificate authority was removed from Thunderbird.
- All recipients used the reserved `.test` TLD. No Internet delivery was attempted.

## Limitations

- One client (Thunderbird 157.0), one OS, loopback only. Other clients and LAN or Internet exposure are untested.
- Bcc-only submission, signed and encrypted messages, and reply-all were not tested.
- Restart was a container restart. Idle timeout, certificate reload (SIGHUP) and a host reboot were not exercised.
- Delivery went to Mailpit. Behaviour that depends on a real outbound provider (for example Bcc handling in a provider's own submission) was not exercised; Bcc privacy on the delivered data is inferred.
- Rate and size limits were not stress-tested beyond the single oversize case.
- The Thunderbird password was stored in Thunderbird's password manager at the operator's choice.
- Pre-existing and out of scope: ports 3000 and 8025 are reachable on the LAN.
- SMTP-3 does not make the product production-ready.

## Conclusion

Thunderbird 157.0 can submit mail through the authenticated listener, with the server owning the single Sent copy, without any change to the SMTP-1 or SMTP-2 code.
