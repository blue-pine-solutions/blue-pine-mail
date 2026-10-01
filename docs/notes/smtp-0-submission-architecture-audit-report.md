# SMTP-0 — Authenticated SMTP Submission and Sent Behavior Architecture Audit

**Verdict: GO WITH ARCHITECTURAL CHANGES.** Authenticated submission fits the existing architecture: A2 credentials, mailbox authorization, the single application send service, and server-side Sent storage. No migration and no broad redesign are needed. The shared send path needs two targeted corrections before a client that retries automatically is connected to it (see "Blockers and must-fix items").

Audit only: no code, configuration, migration or runtime state was changed. Prepared 1 October 2026 in the private development repository (the `origin` remote). Nothing was pushed, and the public release repository was not touched.

## Repository baseline

- `main` at `2f6aa0068a3a0d626a99663ca357ca81f259ac02` ("Add Thunderbird compatibility certification report"), equal to `origin/main`.
- Operator-local state was read only where noted and not changed: `docker-compose.yml` (modified), `local-certs/`, `.env.docker`, the runtime database, and the Thunderbird profile. From `.env.docker` only the scheme, host and port of `SMTP_URL` were read (`smtp://mailpit:1025`, no credentials in it); no secret was read.

## 1. Current outbound architecture

### Call and data flow

```
web compose /api/send ─┐
API v1 /api/v1/send ───┤
JMAP EmailSubmission ──┤
calendar invitations ──┼─► sendEmail()  (src/lib/email/send.ts)
agent send approvals ──┤      1. getAuthorizedSenderAddress()   sender authorization (sender.ts)
auto-reply ────────────┘      2. attachment checks (count/size, admin outgoing limit), subject ≤ 998, headers ≤ 16 KB
                              3. recipients: To/Cc/Bcc lists, deduplicated per list, ≤ 50 in total, contacts upserted
                              4. INSERT messages (status "queued", direction "outbound")      ← the Sent row
                              5. storeMessageAttachments()   objects first, then rows; the row is deleted on failure
                              6. INSERT outbound_jobs ("queued")
                              7. scheduled? enqueue on OUTBOUND_QUEUE : deliverEmail()
                                   a. prepareCloudflareAttachments()  ≤ 5 MiB message; attachments > 3 MB become links
                                   b. env.EMAIL.send(builder)         ← transport boundary
                                   c. storeSentCanonicalMessage()     A1 copy rebuilt from what (b) accepted; best effort
                                   d. UPDATE messages: "sent", providerMessageId, threadId, rawR2Key
                                   e. UPDATE outbound_jobs "sent"; webhooks "message.outbound"; audit log "email.send"
                                   on any error in a–e: messages and job become "failed"; webhook "message.failed"; rethrow

system mail (password reset)  ─► env.EMAIL.send() directly; no messages row (system-mail.ts)
forwarding (routing/account) ─► Workers: message.forward();  Node: Mailer.sendRaw() (raw relay, SMTP transport only)
```

### Transports

`env.EMAIL.send` takes a *structured builder*: from, to, cc, bcc, replyTo, subject, html, text, headers and attachments with disposition and Content-ID. It does not take raw MIME.

| Runtime | `env.EMAIL` |
|---|---|
| Workers | The native `send_email` binding; Cloudflare assigns the Message-ID |
| Node/Docker | `server/runtime/mailer.ts` `Mailer`: `SMTP_URL` through nodemailer (any relay; locally Mailpit), or Cloudflare Email Sending REST (`CF_ACCOUNT_ID` / `CF_TOKEN`). The Mailer generates a Message-ID. |

Raw passthrough (`Mailer.sendRaw`) exists only for the Node SMTP relay transport and is used only for forwarding.

### Canonical service to reuse

**`sendEmail()`.** Every user-originated send already uses it: sender authorization, limits, contacts, the Sent row, attachments, delivery, the A1 canonical copy, webhooks and the audit log. There is no other safe user-send path.

Its closest precedent is JMAP: `Email/import` parses client MIME, `EmailSubmission/set` then calls `sendEmail` with the parsed fields, and the transport regenerates the message.

## 2. Current inbound SMTP listener (`server/runtime/smtp.ts`)

- **Library:** `smtp-server` 3.19 (nodemailer project). Bound to `SMTP_INBOUND_PORT` (default 25, locally `127.0.0.1:2525`).
- **Settings:** `authOptional: true`; `AUTH` disabled; STARTTLS only with `SMTP_TLS_KEY`/`SMTP_TLS_CERT`; `size` = `SMTP_MAX_SIZE` (default 36 MiB).
- **DATA handling:** one handler buffers the whole message, then:
  1. runs an attachment-limit check (a full parse);
  2. calls `intakeIncomingMail` once per recipient;
  3. answers 250, 451 (temporary failure) or 550 (routing rejection) at the end of DATA.
- **Missing:** connection, client and rate limits; no explicit timeouts beyond the library defaults.
- **The library is appropriate for submission.** `smtp-server` natively provides implicit TLS (`secure: true`), STARTTLS, `onAuth` with PLAIN and LOGIN, and `onMailFrom`/`onRcptTo` hooks. It also offers SIZE, a cap on unauthenticated commands (`maxAllowedUnauthenticatedCommands`), `maxClients`, `socketTimeout`, PIPELINING, 8BITMIME and ENHANCEDSTATUSCODES.
- **What must stay separate:** submission must be its own `SMTPServer` instance on its own port, with its own handlers and configuration. Inbound accepts unauthenticated mail *to* local mailboxes and never relays; submission accepts mail only from authenticated principals and delivers it outward through `sendEmail`. Sharing a listener would put "relay for anyone" one configuration mistake away. Only small helpers may be shared (header parsing, TLS material loading).
- **Finding (pre-existing, inbound):** `smtp-server` keeps emitting DATA after `size` is exceeded; it only sets `stream.sizeExceeded`. The inbound handler pushes every chunk into memory and checks the flag at the end, so an unauthenticated sender can make the process buffer arbitrarily large data before the 552. Classified in section 13; submission must not copy this pattern.

## 3. Submission protocol target

| | Port 465, implicit TLS | Port 587, STARTTLS |
|---|---|---|
| Thunderbird | "SSL/TLS", fully supported | "STARTTLS", fully supported |
| Mobile and desktop clients | Supported widely (RFC 8314 recommends implicit TLS for submission) | Supported widely |
| Security | No plaintext phase; nothing before TLS to strip or inject | A plaintext greeting and EHLO, so AUTH must be refused before TLS and STARTTLS stripping must be guarded against |
| Reuse | Mirrors IMAP 993 exactly (implicit TLS, the same certificate handling, SIGHUP reload) | A different TLS mode from IMAP |
| Deployment | One TLS endpoint; certificates as for IMAP | The same certificate; more protocol states |

**Recommendation: port 465 with implicit TLS for the initial implementation.** Adding 587 with STARTTLS later is straightforward: `smtp-server` supports it natively, and it would be a second listener with `secure: false`, STARTTLS required, and AUTH refused before TLS.

**Minimum surface:**
- **Commands:** EHLO, HELO (accepted, though modern clients use EHLO), AUTH, MAIL FROM, RCPT TO, DATA, RSET, NOOP, QUIT.
- **Advertised:** `SIZE <limit>`, `PIPELINING`, `8BITMIME`, `ENHANCEDSTATUSCODES`, `AUTH PLAIN LOGIN`.
- **Not offered:** VRFY and EXPN (disabled), SMTPUTF8 (until the transports are verified with UTF-8 addresses), DSN, CHUNKING/BDAT, BURL, XCLIENT.

## 4. Authentication

- **Mechanism:** reuse A2's `verifyMailAppPassword(env, { username, password, scope: "smtp" })`. It already enforces what submission requires:
  - the username is the full address of the mailbox the credential was issued for (no other mailbox, no cross-mailbox use);
  - the secret is compared by digest, with equal cost on a miss;
  - the web password and API keys never match the credential format;
  - the account must be enabled;
  - the mailbox must be reachable through `getMailboxAccessLevel` (ownership, or current shared access while sharing is enabled);
  - the `smtp` scope must be granted, so an IMAP-only credential fails;
  - a revoked (deleted) credential does not exist.
- **Methods:** `AUTH PLAIN` (RFC 4616, with or without an initial response) is what Thunderbird uses with "Normal password" when it is advertised. `AUTH LOGIN` is justified: some clients (older Outlook, some mobile clients) use it, `smtp-server` provides it at no cost, and over implicit TLS it is no weaker than PLAIN. No CRAM-MD5 or DIGEST-MD5, which need the plaintext secret that A2 never stores. No XOAUTH2.
- **Authorization identity:** an authzid in PLAIN must be empty or equal to the username; anything else fails.
- **Fail closed:** a database or verifier error answers `454 4.7.0 Temporary authentication failure` and never succeeds. Failures look the same to the client (`535 5.7.8 Authentication credentials invalid`) whatever the reason.
- **Limits:** a failure throttle per client address and per username, reusing `SlidingWindowCounter` from `imap-limits.ts` as the IMAP listener does. Mail transaction commands before AUTH are refused with `530 5.7.0 Authentication required`.
- **Revocation after AUTH:** every MAIL FROM and every DATA re-runs authorization (section 5), so a credential revoked mid-connection cannot submit another message.
- **Never logged:** passwords, AUTH payloads (base64 or decoded), usernames together with failure reasons.

## 5. Sender authorization (security-critical)

The current rule, `getAuthorizedSenderAddress(env, { userId, from, mailboxId })`:
- requires `canSendOnBehalf` on the mailbox (owner, `full_access`, `send_as` or `send_on_behalf`; not `read_only`);
- requires the From address to be one of the mailbox's addresses: its primary address, its aliases, and, when `useAllDomains` is on, the same local part on the owner's other active domains, excluding addresses that belong to another mailbox (`getMailboxDomainAddresses`);
- then rewrites the From display name: the mailbox name for owners and `send_as`, "X on behalf of Y" for `send_on_behalf`.

**Initial submission policy (strict):**
- The principal is the A2 credential: one user and one mailbox. SMTP never chooses a mailbox, so there is no cross-mailbox sending.
- **MAIL FROM** must be one of the mailbox's addresses (the same list), checked at MAIL FROM with `getAuthorizedSenderAddress`. It answers `550 5.7.1 Sender address not authorized` otherwise, and also for a principal without send permission (for example a `read_only` delegate). The null reverse path `<>` is refused.
- **Header From** must be a single mailbox address. Its address must equal the MAIL FROM address (case-insensitive) and pass the same check again at DATA. Group syntax, several From addresses or a mismatch get `550 5.7.1`.
- **Sender:** a client `Sender:` header is not carried (the existing on-behalf display-name convention applies).
- **Unchanged:** another local user's address, an arbitrary external address, and an address of another mailbox owned by the same user are all refused by the existing rule. SMTP authentication grants nothing the web composer could not.

## 6. Recipient handling

- **Envelope is authoritative.** The RCPT TO set is exactly who receives the message.
  - To = header To ∩ envelope; Cc = header Cc ∩ envelope; **Bcc = envelope − (To ∪ Cc)**.
  - A header Bcc field is never delivered as a header (the builder carries Bcc separately). The sender's own Sent copy records Bcc, as it does today.
- **A header To/Cc address missing from the envelope:** reject at DATA with `554 5.6.0`. Passing the header lists to `sendEmail` would otherwise deliver to addresses the client did not ask for.
- **Duplicates** across or within envelope and header lists collapse to one delivery.
- **Count:** at most 50 recipients (`sendEmail`'s `MAX_RECIPIENTS`). The 51st RCPT gets `452 4.5.3 Too many recipients`.
- **Malformed addresses:** `501 5.1.3` at RCPT.
- **Local recipients** are delivered through the transport like any other (and come back through inbound routing).
- **Initial limitation:** `sendEmail` requires at least one To recipient, so a Bcc-only message (`To: undisclosed-recipients:;`) is refused (`554 5.5.0`) until `sendEmail` supports an empty To with a placeholder header (a small SMTP-1 option; see section 16).

## 7. DATA and MIME handling

**Decision: B, parse and regenerate through `sendEmail`,** with a defined fidelity contract (a careful hybrid only in what is kept).

Option A (raw passthrough) was rejected:
- the Workers binding and the Cloudflare REST transport accept only the builder;
- raw relay exists only for the Node SMTP transport;
- sender authorization, the Sent row, attachments as stored objects, the A1 canonical copy, limits, webhooks and audit all live in `sendEmail`.

A raw-only path would bypass or duplicate every one of them, and would not work on Cloudflare transports. JMAP already uses the same parse-and-regenerate model.

**Kept:** Subject; text and HTML bodies (as alternatives); attachments with filename, type and disposition; inline parts with Content-ID (`cid:` references keep working); In-Reply-To and References (threading); To, Cc and Bcc as above; From address (display name per the policy above); Reply-To (via a `replyTo` field to add to `SendEmailInput`, which the builder already supports).

**Replaced or dropped, and documented:**
- Message-ID is assigned by the transport, as for every send today. Cloudflare rejects caller-supplied ones; whether the Node Mailer's Cloudflare REST path sends one must be verified in SMTP-1.
- Date is set by the transport.
- Custom `X-` and other headers are dropped (no client-controlled header passthrough into `headers`; an allowlist may come later).
- `Sender` is dropped.
- The MIME structure and encodings are rebuilt by the transport.

**Refused, because regeneration would silently break them:**
- `multipart/signed` (S/MIME, PGP/MIME signatures);
- `multipart/encrypted` and `application/pkcs7-mime`;
- messages whose top-level type cannot be represented as text, HTML and attachments.

All get `554 5.6.0` with a clear reason. They need raw passthrough, deferred.

**Existing behavior that also applies:** `prepareCloudflareAttachments` limits the transported message to 5 MiB and turns attachments over 3 MB into download links, on every transport (section 13).

**DKIM:** signing is the transport's (Cloudflare or the relay). Regenerated mail is signed as web mail is today.

## 8. Sent-folder semantics

- **Today:** the `messages` row created by `sendEmail` *is* the Sent message. It becomes `status = "sent"` when the transport accepts it, and IMAP Sent lists it, with its A1 canonical copy built from what the transport accepted under the provider's Message-ID. IMAP APPEND to Sent and COPY into Sent are refused (A5.7, A5.8).
- **Decision: model A. SMTP submission itself creates the Sent copy**, because it uses `sendEmail`.
- **Thunderbird must be configured not to save a copy:** Account Settings → Copies & Folders → untick "Place a copy in". If the tick stays, Thunderbird's APPEND to Sent is refused, it shows an error after each send, and no duplicate is created.
- **Duplicates are impossible by construction:** the server creates exactly one Sent row per accepted submission, and clients cannot add one. Message-ID deduplication would not work anyway: the delivered message, and therefore the Sent copy, carries the transport's Message-ID, not the client's.
- **Accepting client Sent copies is deferred.** A client that cannot disable saving (if one is found in testing) would need that, with deduplication that maps the client Message-ID to the sent row. That would need a migration.
- **Canonical store:** unchanged. The Sent row's A1 copy is rebuilt from what the transport accepted (`storeSentCanonicalMessage`), and IMAP FETCH of the Sent message serves exactly that.
- **Delivery succeeded but Sent bookkeeping failed:** today the error path marks the row `failed` and rethrows (must-fix M1). Submission must answer 250 once the transport accepted the message. The Sent row's bookkeeping is then repaired or logged; the client never retries a delivered message.
- **Bookkeeping succeeded but delivery failed:** the row becomes `failed`, and JMAP files `failed` under Sent. For SMTP the client keeps the message and retries after a 4xx, so the submission path must remove the failed row and its objects when it answers 4xx or 5xx (must-fix M2). Otherwise every retry leaves another failed copy.
- **UIDs:** the Sent row receives the next UID of the IMAP Sent folder on the next A3 sync, like any web send. IDLE sessions see it through the mailbox revision, and it is stable across reconnects.

## 9. Delivery failure semantics

The DATA reply is sent only after `sendEmail` returns, that is, after the transport accepted the message (synchronous delivery, the durability boundary `sendEmail` already defines). Scheduled sending is not used by submission.

| Case | Reply |
|---|---|
| Transport accepted; Sent row committed | `250 2.0.0 Ok: queued as <messageId>` (the internal id, not secret) |
| Transport accepted; post-acceptance bookkeeping failed | `250 2.0.0` (must-fix M1); error logged |
| Unauthorized sender (MAIL FROM or header From) | `550 5.7.1` |
| Too many recipients | `452 4.5.3` at RCPT |
| Oversized | `552 5.3.4` at DATA (receipt stops at the limit) |
| Malformed or unsupported MIME (signed/encrypted, no usable body, From mismatch, header recipients not in envelope) | `554 5.6.0` |
| `sendEmail` validation (subject length, attachment limits, header size) | `554 5.6.0` or `552 5.3.4` |
| Transport temporary failure, timeout, network | `451 4.4.1` |
| Transport permanent rejection | `554 5.0.0` when it is classified permanent; until the transports classify errors, unknown transport errors are `451` (fail safe, the client retries) |
| Database or storage failure before the transport | `451 4.3.0`; nothing sent; the row removed |
| Credential revoked or access lost mid-connection | `535` at AUTH; `550 5.7.1` at MAIL FROM or DATA |

Error text never includes internal messages, paths or provider responses.

## 10. Resource and abuse controls

| Control | Recommendation |
|---|---|
| Message size | `SIZE` = 36 MiB (the inbound `SMTP_MAX_SIZE` default; 25 MB of decoded attachments in base64 fit). **Stop buffering and abort at the limit**, never after. |
| Recipients | 50 per message (`sendEmail`) |
| Messages per connection | 50, then `421 4.7.0` and close |
| Concurrent submissions (parse and deliver) | 1 per user and 4 in all, reusing the `ContentReadLimiter` class as APPEND does; a parse costs several times the message size in memory (A5.7 measurement) |
| Connections | A global cap and a per-address cap (`ConcurrencyCounter`) |
| Authentication | A failure throttle per address and per username |
| Unauthenticated commands | At most 10 (`maxAllowedUnauthenticatedCommands`), then close; before AUTH only EHLO, HELO, AUTH, NOOP, RSET and QUIT |
| Timeouts | TLS handshake 10 s; an absolute login deadline of 60 s; command idle 5 min (RFC 5321 server timeouts); a DATA receive deadline with a minimum rate, like A5.7's literal deadline |
| Command line length | The library default (512 octets plus extensions) |
| Send rate | A per-user submissions-per-hour limit (in memory, like the IMAP limits); there is none today on any send path (backlog for web, required for SMTP) |
| MIME amplification | Bounded by size, concurrency and refusal of unsupported structures; postal-mime as for APPEND |

**Local versus managed deployments:** local tests can shorten every limit through configuration. A managed or public deployment needs at least these defaults, the inbound DATA fix below, and monitoring of the submission rate. A full anti-spam system is out of scope.

## 11. TLS and deployment

- **New and opt-in, like IMAP:** `SMTP_SUBMISSION_PORT` (unset means disabled), with `SMTP_SUBMISSION_TLS_CERT` and `SMTP_SUBMISSION_TLS_KEY`. If those are unset, it falls back to `IMAP_TLS_CERT` and `IMAP_TLS_KEY` (the same mail hostname in typical deployments). Startup fails on unusable material.
- **Shared mechanics:** IMAP's `loadTlsMaterial`, TLS 1.2 or newer, and SIGHUP reload, moved to a shared runtime helper.
- **Not reused:** the inbound STARTTLS variables `SMTP_TLS_KEY`/`SMTP_TLS_CERT` belong to port 25 and its own certificate.
- **No change** to existing variables, so existing deployments are unaffected. Node and Docker only; the Worker never imports the listener (distribution guard).

## 12. Logging and audit

- **Listener events,** one structured line each like the IMAP listener's: `connection.open` (with the TLS protocol), `connection.closed`, `tls.error`, `auth.success` (user id, mailbox id, app password id), `auth.failure` (a reason class only), `submission.accepted` (message id, recipient count, size in bytes), `submission.rejected` (stage and reply code), `submission.failed` (temporary or permanent class), `limit.*`.
- **Never logged:** passwords, AUTH payloads, usernames on failures, message bodies, MIME content, subjects.
- **Addresses:** console events carry internal ids and counts, not addresses, following the IMAP listener's convention. Sender and recipient addresses are already recorded by `sendEmail` in the database audit log (`email.send` with `to`, `cc` and `subject`), which is the existing, access-controlled place for them.

## 13. Security and backlog classification

| Item | Classification |
|---|---|
| **M1.** `deliverEmail` reports a failure, and marks the row `failed`, when an error happens *after* the transport accepted the message (status update, job update, webhooks, audit). A submission client would retry and **deliver twice.** | **Must fix during SMTP implementation** (SMTP-1). Post-acceptance errors must be logged and recovered, never thrown as a send failure; web and JMAP benefit too. |
| **M2.** A failed send leaves a `failed` row that JMAP (and the web) shows under Sent; SMTP retries would accumulate them. | **Must fix during SMTP implementation:** the submission path removes the row and its objects whenever it answers 4xx or 5xx. |
| **M3.** Transport errors are untyped, so permanent and temporary cannot be told apart. | **Must fix (minimal):** typed validation errors for `sendEmail`'s own checks (5xx); unknown transport errors stay 4xx. |
| **M4.** The submission DATA handler must bound memory (stop at `size`, not after). | **Must fix during SMTP implementation.** |
| **M5.** No per-user send rate limit exists on any path. | **Must fix for SMTP** (in-memory, per instance). Web and API remain backlog. |
| **B1.** The inbound listener on port 25 buffers DATA without bound before answering 552 (`smtp-server` keeps emitting after `size`). This is an unauthenticated memory-exhaustion vector on public Node deployments. Locally it is bound to loopback. | **Backlog, separate phase, high priority before any public port-25 exposure.** Not a blocker for submission, which must simply not copy the pattern. |
| `prepareCloudflareAttachments` applies Cloudflare's 5 MiB limit and attachment-to-link conversion to every transport, the SMTP relay included. | **Can remain backlog;** documented as submission behavior (large attachments arrive as links). |
| `sendEmail` requires a To recipient, so no Bcc-only messages. | **Can remain backlog** (an initial `554`); an optional SMTP-1 extension. |
| The Node Mailer's Cloudflare REST path sends a Message-ID header although Cloudflare assigns its own. | **Verify in SMTP-1** (affects Message-ID expectations only). |
| Sender authorization, shared/delegated mailboxes, app-password scope | **No blocker:** reused as is and checked at AUTH, MAIL FROM and DATA. |
| Canonical and attachment ordering | **No blocker:** `sendEmail` already stores attachment objects before the job and removes the row on failure; the canonical copy is best effort after acceptance. |
| Duplicate Sent storage | **No blocker:** structurally impossible under model A. |

## 14. Thunderbird target configuration

| | Incoming (unchanged) | Outgoing (after implementation) |
|---|---|---|
| Protocol | IMAP | SMTP |
| Hostname | `localhost` | `localhost` |
| Port | 993 | 465 |
| Connection security | SSL/TLS | SSL/TLS |
| Authentication | Normal password | Normal password |
| Username | `userb@smoketest.test` | `userb@smoketest.test` |
| Password | Existing mail app password (IMAP scope) | **A new** mail app password with the SMTP scope only (credentials cannot be edited, and least privilege suggests a separate one) |
| Copies & Folders | — | **"Place a copy in" unticked**; the server stores Sent |

**Operator-local steps, later and not done here:**
- publish `127.0.0.1:465:465` in the local `docker-compose.yml`;
- set `SMTP_SUBMISSION_PORT=465` in `.env.docker`;
- reuse the localhost certificate through the IMAP fallback.

Thunderbird needs a separate certificate exception for `localhost:465`, because exceptions are per host and port. Outbound mail goes to Mailpit (`SMTP_URL` → `mailpit:1025`), so test sends are captured locally and never reach the internet.

## 15. Test and certification plan

- **Authentication:** a valid SMTP-scoped credential; IMAP-only rejected; revoked; wrong password; wrong mailbox address; another user's credential; a disabled user or mailbox; delegated access removed; sharing off; scope removed or credential revoked mid-connection (the next MAIL FROM is refused); PLAIN with and without an initial response; LOGIN; a non-matching authzid; throttling; a database error fails closed; no secret in logs.
- **Protocol:**
  - EHLO capabilities exactly as specified; HELO;
  - MAIL, RCPT, DATA, RSET, NOOP and QUIT;
  - commands before AUTH refused and the unauthenticated cap enforced; wrong order;
  - pipelining;
  - implicit TLS only (plaintext refused); TLS 1.2 or newer; certificate reload.
- **Sender:** the primary address; an alias; a `useAllDomains` address; a shared-mailbox delegate with `send_as` or `send_on_behalf` (display name per policy); `read_only` refused; another local user, an arbitrary external address and another of the user's mailboxes refused; MAIL FROM and header mismatch refused; `<>` refused.
- **Fidelity** (against Mailpit, and the IMAP Sent copy):
  - plain text; HTML multipart; attachments; inline image by Content-ID;
  - UTF-8 subject and body;
  - In-Reply-To and References threading;
  - Bcc delivered but absent from delivered headers;
  - Reply-To;
  - signed or encrypted refused; header recipients not in the envelope refused.
- **Limits and failures:**
  - oversized DATA (memory bounded, measured);
  - 51 recipients;
  - transport temporary and permanent failures (a stub transport); a database or storage failure;
  - **a failure after transport acceptance still answers 250, with no retry duplicate (M1);**
  - a failed submission leaves no `failed` row (M2);
  - disconnect mid-DATA; timeouts and drip; the concurrency and rate limits.
- **Sent:**
  - exactly one Sent message per accepted submission, visible over IMAP (UID, FETCH matches the canonical copy), JMAP and the web;
  - none after a failed submission;
  - IDLE sees it; restart persistence.
- **Regression:** web send, API v1 send, JMAP submission, calendar invitations, agent approvals, auto-reply, forwarding, system mail; IMAP suites unchanged; inbound SMTP unchanged; D1/workerd; builds; distribution guard (the Worker never imports the listener).
- **Real client (Thunderbird):** account setup with the new SMTP credential; send to a controlled Mailpit target; the Sent folder shows exactly one copy; an attachment; a reply that threads; failure behavior (stop Mailpit: a temporary failure, Thunderbird keeps the message); restart and reconnect.
- **Mutation pass:**
  - auth without the scope check; the sender check removed at MAIL FROM or at DATA;
  - the envelope ignored for recipients; Bcc leaked into headers;
  - 250 before transport acceptance; post-acceptance error reported as failure;
  - failed row kept; size limit enforced only after buffering;
  - rate or concurrency limit removed; secrets logged.

## 16. Phase plan

| Phase | Scope | Migration |
|---|---|---|
| **SMTP-1** Send-path corrections and submission adapter | M1 (post-acceptance errors never reported as failure); M3 (typed validation errors); `replyTo` in `SendEmailInput`; a pure MIME-to-`SendEmailInput` adapter (`parseRawMime`, envelope reconciliation, Bcc, threading, the From policy inputs, refusal of signed/encrypted); verify the Mailer Message-ID behavior; optionally Bcc-only support. Web, JMAP and API regression. | No |
| **SMTP-2** Submission listener | A Node-only `SMTPServer` on `SMTP_SUBMISSION_PORT` (465, implicit TLS); AUTH PLAIN and LOGIN via A2 `smtp` scope; MAIL FROM and DATA sender authorization; RCPT limits; bounded DATA (M4); M2 cleanup; concurrency, rate (M5), connection and auth limits; timeouts; logging; certificate reload and shutdown; distribution guard; real-TLS tests and mutation pass. | No |
| **SMTP-3** Thunderbird real-client certification | Settings above; send, Sent, attachment, reply/threading, failure, restart | No |
| **INBOUND-SMTP-1** (separate, recommended) | B1: bound inbound DATA memory, plus basic connection limits on port 25 | No |

Sent semantics need no phase of their own: they follow from reusing `sendEmail` (SMTP-1 and SMTP-2). Security hardening is part of SMTP-2. **No phase is expected to need a schema migration.** The mail app password `smtp` scope, the Sent rows and the canonical store already exist. A migration would appear only if client Sent APPEND with deduplication is ever accepted (deferred).

## Verdict

**GO WITH ARCHITECTURAL CHANGES.**
- **Architecture:** authenticated submission as a separate Node-only listener (465, implicit TLS, AUTH PLAIN and LOGIN with SMTP-scoped mail app passwords), feeding the existing `sendEmail` service through a parse-and-regenerate adapter.
- **Sent:** server-side Sent storage, with the client's "Place a copy in Sent" off.
- **Required changes,** all targeted and none needing a migration or redesign:
  - the post-acceptance error handling in `deliverEmail` (M1);
  - failed-row cleanup and typed errors for the submission path (M2, M3);
  - bounded DATA (M4);
  - a submission rate limit (M5).
- **Separately:** the pre-existing inbound DATA buffering issue (B1) should be fixed before any public port-25 exposure.
