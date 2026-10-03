# SMTP-1 — Send-Path Correctness and Submission Adapter Certification

**Verdict: SMTP-1 CERTIFIED.** The shared send path now has an explicit delivery boundary, typed and retry-classified results, deliberate failed-attempt semantics, and an internal SMTP submission adapter that SMTP-2 can call. No SMTP listener, port, TLS endpoint or AUTH handler was added. No migration was needed.

This certifies the send transaction and the adapter. It does not make the product production-ready.

## Baseline and repository state

- `main` at `dcda29f7c3418193da1f043d2ceb7db709f886a1` ("Add SMTP submission architecture audit report"), equal to private `origin/main`.
- Operator-local files were left untouched and are not committed: `docker-compose.yml` (modified), `local-certs/`, `.env.docker`, runtime databases, Thunderbird data.
- **Pre-existing draft disclosed.** The phase began with five uncommitted files in the working tree, from an earlier interrupted SMTP-1 attempt (dated 1 October 2026, about 8 minutes after the SMTP-0 commit):
  - `server/runtime/mailer.ts`
  - `src/lib/email/send.ts`
  - `src/lib/email/sender.ts`
  - `src/lib/email/send-result-types.d.ts`
  - `src/lib/email/send-result-utils.ts`
- With the operator's approval, the draft was treated as untrusted. Its whole diff was audited line by line against `dcda29f`, the SMTP-0 report and the existing code, then kept, revised or replaced. Nothing in this report relies on the draft being correct; certification rests only on the tests, fault injection and review below.

**What the audit found in the draft:**

| Draft choice | Finding | Outcome |
|---|---|---|
| Boundary at `env.EMAIL.send` resolving; post-acceptance steps best effort | Correct | Kept |
| "Every failure is before acceptance, so always safe to retry" | **Wrong.** A connection lost or timed out during or after DATA, an HTTP 5xx, or any unclassified Workers binding error may follow provider acceptance | Replaced by `delivery: not_attempted / rejected / unknown` and `retrySafe` |
| `EAUTH`/socket codes in one "temporary" set; `ENOTCONFIGURED` assumed | `ENOTCONFIGURED` was never set by the Mailer; connection refusal and mid-DATA loss were indistinguishable | Mailer now tags the not-configured error; refusal is detected from `syscall: "connect"` and nodemailer's connect-phase timeouts |
| Reply-To added to the canonical copy as a plain header | **Defect.** mimetext accepts Reply-To only as a mailbox, so every send with a Reply-To lost its Sent copy (it showed up as `degraded: canonical_copy`) | `replyTo` is now a canonical-builder input; `reply-to`/`sender` are managed headers |
| Job row marked `sent` last | Widens the crash window in which a scheduled send's queue redelivery could send twice | Job row is now marked `sent` first after acceptance |
| Swallowed post-acceptance errors logged with `console.error` | A throwing logger could still escape after delivery | Never-throwing `log()` plus an outer catch |
| Error messages logged and stored verbatim | **Defect.** drizzle errors embed every bound parameter (addresses, subjects, message bodies), which reached logs and `outbound_jobs.error`. Seen on D1 | `safeErrorText` strips parameters wherever error text is stored, logged or returned |
| Discard: delete the row, then the objects | Correct order; on a failed delete the row could stay `queued` | Kept; a failed delete now falls back to `failed`; the discarded job's payload is redacted |
| `rate_limited` failure kind | Nothing produced it | Removed: rate limiting is SMTP-2's (see below) |
| Size errors classified by message-prefix matching | Fragile | `cloud-attachment-utils.ts` now throws `SendError` directly |
| Contacts upserted after validation; typed authorization errors in `sender.ts` with unchanged messages | Correct; routes map statuses from unchanged text | Kept |

## Files changed

| File | Change |
|---|---|
| `src/lib/email/send.ts` | Transaction model, boundary, failed-attempt policy, post-acceptance handling, `replyTo` |
| `src/lib/email/send-result-types.d.ts` (new) | Result and failure vocabulary |
| `src/lib/email/send-result-utils.ts` (new) | `SendError`, `classifyTransportError`, `toSendError`, `safeErrorText` |
| `src/lib/email/sender.ts` | Typed authorization errors (same messages) |
| `src/lib/email/cloud-attachment-utils.ts` | Typed size and storage errors |
| `src/lib/email/canonical-message-utils.ts`, `canonical-message-types.d.ts` | `replyTo` support; `Reply-To`/`Sender` managed |
| `src/lib/email/threading.ts` | `findParentThreadId` extracted from `resolveThreadId` (same behavior) |
| `server/runtime/mailer.ts` | HTTP status on REST errors; `ENOTCONFIGURED` code |
| `src/lib/submission/service.ts`, `utils.ts`, `types.d.ts` (new) | Submission adapter |
| `tests/smtp-submission.test.mjs` (new) | 39 focused, fault-injection and adversarial tests |
| `tests/distribution-guard.test.mjs` | SMTP-1 guard: adapter runtime-neutral, no submission listener |
| `scripts/smtp-send-d1-check.mjs` (new) | Workers/D1 certification (20 checks) |
| `CLAUDE.md`, `UPSTREAM.md` | Architecture notes; the post-acceptance fix offered upstream |

## Old transaction model

`sendEmail` authorized, validated, upserted contacts, inserted the `queued` row, stored attachments, inserted the job, then called `deliverEmail`. One `try` wrapped attachment preparation, `env.EMAIL.send`, the canonical copy, the row update, the job update, webhooks and the audit log. **Any** error in it, including one after the provider had accepted the message, marked the row and job `failed`, fired `message.failed` and rethrew. Errors were untyped.

## New transaction model

1. **Authorization and validation:** sender rule, attachment limits, subject, recipients (at most 50), Reply-To, header size. Contacts are written only after validation passes.
2. Message row (`queued`), attachment objects and rows, job row (`queued`); a scheduled send is enqueued here.
3. Transport preparation (large attachments become links), then `env.EMAIL.send`.
4. **Delivery boundary.**
5. Job `sent`, canonical copy, row `sent` (provider Message-ID, thread), `message.outbound` webhooks, audit log. Each step is isolated; failures are collected into `degraded`, logged with message, job and provider ids, and noted on the job row.

`sendEmailWithOutcome` returns `{status: "accepted", messageId, providerMessageId, degraded}` or `{status: "scheduled"}`, and throws only a `SendError` from steps 1–3. `sendEmail` keeps its old return shape, so every existing caller is unchanged.

## The irreversible delivery boundary

**`env.EMAIL.send(...)` resolving.** On Node SMTP this is the relay's 250 reply to DATA; on the Node REST transport, a 2xx; on Workers, the binding resolving. Nothing after it can throw out of the send path, and nothing after it marks the message failed.

There is no atomicity between the provider and the database, and none is faked.

## Result and error taxonomy

`SendError.kind`:

| Kind | Meaning | Temporary |
|---|---|---|
| `invalid_message` | Request or message cannot be sent as given | no |
| `unsupported_message` | Valid, but the structured path cannot carry it faithfully (signed/encrypted, Bcc-only, several Reply-To) | no |
| `unauthorized_sender` | Credential, account, permission or address not authorized | no |
| `delivery_rejected` | Transport refused definitively | no |
| `transport_temporary` | Transport unreachable, deferred, misconfigured or unknown | yes |
| `internal_temporary` | Database or storage failure, or anything unclassified (fails closed) | yes |

Each `SendError` also carries:

- `reason`: a stable code, e.g. `from_mail_from_mismatch`.
- `delivery`: `not_attempted` / `rejected` / `unknown`.
- `retrySafe`.

**Successful outcomes:**

- `accepted`
- `accepted` with a non-empty `degraded` list (`job_state`, `canonical_copy`, `message_state`, `webhooks`, `audit_log`, `internal`)

No SMTP codes appear in the shared service.

**Transport classification (`classifyTransportError`):**

- **Nothing was sent (`not_attempted`):**
  - relay DNS/TLS/proxy (`EDNS`, `ETLS`, `EREQUIRETLS`, `EPROXY`): temporary;
  - relay authentication or configuration (`EAUTH`, `ENOAUTH`, `EOAUTH2`, `ECONFIG`, `ENOTCONFIGURED`): temporary, never permanent;
  - socket failure with `syscall: connect`/`getaddrinfo`, `Connection timeout`, `Greeting never received`: temporary;
  - nodemailer's own envelope/message checks: `delivery_rejected`.
- **Definitive refusal (`rejected`):**
  - SMTP reply 5xx: permanent;
  - SMTP reply 4xx: temporary;
  - HTTP 4xx: permanent, except 401/403 (configuration), 408 and 429, which are temporary.
- **Outcome `unknown`:**
  - `ECONNECTION`, `ESOCKET` or `ETIMEDOUT` after connecting;
  - HTTP 5xx;
  - any other error shape, including every Workers binding error and non-`Error` throws.

## Retry-safety rules

- `retrySafe` is false exactly when `delivery` is `unknown`.
- An accepted outcome, degraded or not, is never a failure.
- A known post-acceptance failure is never represented as safe to retry.
- For `unknown`, SMTP-2 should still answer temporary: RFC 5321 prefers a possible duplicate to a lost message. The duplicate risk is reported explicitly, never hidden.

## Pre-acceptance failure behavior

- **Validation and authorization:** throw; nothing is written (no row, no objects, no contacts).
- **Database/storage before the row exists:** `internal_temporary`.
- **Attachment storage failure:** objects removed by the helper; the row deleted (cascade), as before.
- **Job insert, enqueue, preparation or transport failure:** `failAttempt`:
  - job `failed`, with `kind/reason delivery=…: <sanitized text>`;
  - then the policy;
  - then `message.failed` webhooks.

  Bookkeeping failures are logged and never replace the classification.

## Post-acceptance failure behavior

Every operation after the boundary was fault-injected (SQLite and D1 triggers, R2 put failures, a dropped `webhooks` table, a throwing logger). In every case:

- the outcome is `accepted`, with exactly the failing step in `degraded`;
- the transport was called once;
- the row is never discarded and never marked `failed`;
- the job row records the outcome.

| Step that failed | Job row | Sent row |
|---|---|---|
| Any step except `job_state` | `sent`, with `accepted as <provider id>; post-acceptance failures: …` | `sent` (`queued` if `message_state` failed) |
| `job_state` | Stays `queued` (the injected fault blocked every job write) | `sent` |

If every write fails, the console line `send.post-acceptance degraded message=… job=… provider=…` is the remaining evidence. A `queued` row next to a `sent` job, or a `queued` job older than its request, means "accepted; reconcile".

## Failed-Sent semantics

- **Why failed rows appeared under Sent:** JMAP's Sent role includes `queued` and `failed` (`email-query.ts`, `mailboxes.ts`). Web Sent and IMAP Sent show only `sent`.
- **Correction:** an explicit `failedAttempt` policy, not caller detection:
  - **`retain`** (default; web, JMAP, API v1, calendar, agent approvals, auto-reply): unchanged; a failed row stays.
  - **`discard`** (only the submission adapter, enforced by the distribution guard):
    - the row and its attachment objects are removed (row first, objects after the delete commits);
    - the `outbound_jobs` row stays `failed`, with `message_id` set to null and a redacted payload (`discarded`, `delivery`, mailbox, from, recipients, subject, and no body or attachments) as the durable diagnostic record;
    - a failed delete falls back to `failed`, never leaving the row `queued`;
    - discard and scheduling are mutually exclusive.
- **Retry behavior:** three failed submissions followed by a success leave exactly one `sent` row and four job records.

## Submission adapter contract (`src/lib/submission/`)

`submitMessage(env, { principal: { appPasswordId, userId, mailboxId }, envelope: { mailFrom, rcptTo }, message: Uint8Array, publicOrigin? })` returns a result and never throws:

- `{status: "accepted", messageId, providerMessageId, recipientCount, degraded}`
- `{status: "failed", failure: {kind, reason, delivery, temporary, retrySafe}}`

Failures carry no message text.

**Order of checks:**

1. Size, at most `MAX_SUBMISSION_MESSAGE_BYTES` = 36 MiB, before any parsing.
2. Envelope recipients.
3. Credential, MAIL FROM authorization.
4. Parse.
5. From and Sender.
6. Signed/encrypted.
7. Recipient reconciliation, Reply-To, threading.
8. `sendEmailWithOutcome(..., {failedAttempt: "discard"})`.

**Also exported for SMTP-2:**

- `authorizeSubmissionSender` (the MAIL FROM pre-check);
- `MAX_SUBMISSION_RECIPIENTS` (= 50);
- `submissionLimiterKeys`;
- `normalizeMailboxAddress` (for RCPT validation).

**Parsing:** the adapter holds the whole message in memory (postal-mime, with nesting depth 32 and a 256 KiB header cap, attached messages kept as attachments). SMTP-2 must stop reading DATA at the limit and cap concurrent submissions.

## Sender authorization

No second system was introduced:

- On every call, the credential row must exist for this user and mailbox and still carry `smtp`, so an IMAP-only, revoked, narrowed or other-mailbox credential is refused (`credential_unavailable`).
- MAIL FROM then passes `getAuthorizedSenderAddress`:
  - `canSendOnBehalf`;
  - the address is the mailbox's primary, an alias, or, with "use all domains", the same local part on the owner's other domains, excluding addresses that belong to another mailbox.
- `sendEmail` checks the header From with the same rule again.
- Database errors fail closed (`internal_temporary`, `authorization_unavailable`).

**Tested:**

- the mailbox address and an alias;
- the all-domains address, both on and off;
- another local user's address, another of the same user's mailboxes, an external From;
- `send_as` (mailbox name), `send_on_behalf` ("Cal on behalf of Sales") and `read_only` (refused);
- sharing turned off by policy;
- a disabled account or mailbox;
- revocation and scope removal between messages.

## MAIL FROM, From and Sender policy

- **MAIL FROM** must be a valid dot-atom address and authorized; `<>` is refused (`null_sender`).
- **Header From** must be exactly one From field holding exactly one mailbox, with no group. Its address must equal MAIL FROM (case-insensitive) and pass the sender rule again. The client's display name is always replaced by the server's (owner/`send_as`: the mailbox name; `send_on_behalf`: "X on behalf of Y"), so display-name spoofing has no effect.
- **Sender** is never carried. A Sender naming the From address is dropped; any other or malformed Sender is refused (`sender_header_mismatch`).

## Envelope and header recipients

- **The envelope is authoritative.** Addresses are validated (dot-atom local part, a DNS name with at least two labels, at most 254 characters; no quoted local parts, address literals or non-ASCII), lowercased and deduplicated.
  - Empty: `no_recipients`.
  - More than 50: `too_many_recipients`.
- **To and Cc:**
  - keep the client's entries and display names;
  - every address must be an envelope recipient (`header_recipient_not_in_envelope`), because the transports deliver to every address they are given;
  - an address in both lists stays in To only;
  - group members are flattened.
- **Bcc** is every envelope recipient in neither To nor Cc, passed to the transport as Bcc only.
  - A client `Bcc:` header is ignored for delivery and never travels; a Bcc-header address absent from the envelope is not delivered.
  - Verified against a real nodemailer relay: no Bcc header in the delivered message, and the blind address appears nowhere in it.
  - The sender's own Sent copy records Bcc, as web sends do.
- **No To** (Bcc-only, or `undisclosed-recipients:;`) is `unsupported_message`/`no_visible_recipient` (backlog).

## MIME and header policy

Structured reconstruction only; there is no raw relay.

**Kept:**

- Subject (control characters collapsed);
- text and HTML bodies (format=flowed text is unflowed; with no body part an empty text body is sent);
- attachments with filename and type;
- inline parts with a bare Content-ID (`cid:` references keep working);
- attached messages, as `message/rfc822` attachments;
- one Reply-To;
- In-Reply-To and References (validated Message-IDs); a reply joins the stored parent's thread.

**Replaced:**

- **Message-ID:** the Node Mailer generates one; on Workers, Cloudflare assigns it. The delivered message, the Sent row and the Sent copy all carry that ID (verified end to end with the real Mailer).
- **Date:** set by the transport and the Sent copy.

**Dropped:** every other client header (X-, User-Agent, Disposition-Notification-To, Autocrypt, MIME layout headers). Transport and security headers stay the provider's.

**Refused:**

- Several Reply-To addresses: `unsupported_message`. All three transports take a single reply-to.
- Malformed input: `invalid_message`/`malformed_message`. This covers empty input, a NUL octet, a first line that is not a header field, parser failure, and excessive nesting.
- Attachment and size limits: the shared path's own checks.

## Signed and encrypted messages

The following are refused as `unsupported_message`/`signed_or_encrypted`, never rebuilt:

- top-level `multipart/signed` and `multipart/encrypted`;
- `application/(x-)pkcs7-mime` and `pkcs7-signature`;
- `application/pgp-encrypted` and `pgp-signature`;
- any such part nested anywhere in the message.

Covered: S/MIME signed, S/MIME encrypted, PGP/MIME signed, PGP/MIME encrypted, and a signed part nested in `multipart/mixed`. A public-key attachment (`application/pgp-keys`) is allowed. Inline (armored) PGP is ordinary text and passes through as text.

## Authoritative Sent copy

The `messages` row created by `sendEmail` is the Sent message, with its canonical copy built from what the transport accepted.

- **One successful submission produces exactly one `sent` row,** visible once in IMAP Sent and in JMAP. Its FETCH content is the canonical copy, with the provider's Message-ID and the server's Date.
- **A failed pre-acceptance submission leaves no message row.**
- IMAP APPEND was not changed and there is no duplicate suppression. Thunderbird's "Place a copy in" must be off (SMTP-3).

## Rate-limit placement (M5): decision B, at the submission boundary

No per-user send limiter exists on any path today. Adding one to `sendEmail` would throttle web, API, JMAP, calendar invitations and auto-replies, which nothing has justified. SMTP-2 must enforce:

- a per-account limit, `smtp-submission:user:<userId>`, shared across the user's mailboxes;
- a per-credential limit, `smtp-submission:credential:<appPasswordId>`;
- counts of messages and of recipients (`recipientCount` is in the accepted result);
- the check before calling `submitMessage`, after AUTH.

A web/API limiter stays backlog.

## Migration status

No migration was needed. `bp0005` remains last, and the D1 runner applied every existing migration and nothing new. The Workers migration bundle regenerated with no tracked change.

## Security invariants

| # | Invariant | Evidence |
|---|---|---|
| 1, 2 | No SMTP submission listener, no new port | Guard: the only `new SMTPServer` is `server/runtime/smtp.ts`; no `SMTP_SUBMISSION_PORT`; nothing imports `src/lib/submission` |
| 3, 5 | No web-password path; SMTP-1 authenticates no client | The adapter takes a verified principal only |
| 4 | IMAP-only passwords gain nothing | C7, D1 check |
| 6, 7 | Send-time authorization; no external From | C6, C7; mutants M1–M5, M28 |
| 8 | No raw relay | Guard: no `sendRaw` or `EMAIL.send` in the adapter |
| 9 | No retry-safe result after acceptance | B5, B6, C11–C13b; M6–M10, M27, M29 |
| 10 | Failed attempts do not accumulate | B2, C10, D1 check; M11, M13 |
| 11 | Bcc private | C4, D1 (real relay); M16 |
| 12–14 | No credentials, AUTH payloads, bodies, subjects or attachments in logs | C14, C14b; M30. Error text is parameter-stripped |
| 15 | IMAP unchanged | Full IMAP suites and IMAP D1 check (165/0) |
| 16 | Inbound SMTP unchanged | No inbound code touched; forwarding and SMTP tests pass |

## Test and certification results

| Check | Result |
|---|---|
| `tests/smtp-submission.test.mjs` (new) | 39/39 |
| `tests/canonical-message.test.mjs` (sendEmail, canonical copy) | 10/10 |
| Distribution guard | 16/16 (15 plus the new SMTP-1 guard) |
| Full suite `node --test tests/*.test.mjs` | 544 tests: 537 passed, 4 failed, 3 skipped. Baseline at `dcda29f`: 504 tests, 496 passed, 4 failed, 4 skipped. The new tests are 40 (39 plus the guard); the baseline's fourth skip (Workers build guard) ran here because `dist/` exists. |
| D1/workerd `scripts/smtp-send-d1-check.mjs` (new) | 20/0 |
| D1/workerd `scripts/imap-state-d1-check.mjs` | 165/0 (unchanged) |
| `npm run build` (Workers) | Passed. The output contains the new send transaction and no submission adapter |
| Node build (Next in Node mode, then `scripts/build-server.mjs`) | Passed |
| TypeScript `tsc --noEmit` | 20 errors, equal to the baseline's 20; none in changed files |
| ESLint (changed files) | 0 errors; 1 warning (`_content` at `send.ts:254`), a line carried over unchanged from the baseline |

**The four failures** are the known Windows ones, with identical signatures at baseline:

- the CRLF form of the bp0003/bp0004 trigger text;
- gate6 (`chmod`);
- two `EBUSY` temp-file unlinks.

The skips are the three Python imaplib tests (no python3).

**Test areas covered:**

- **A:** classification of every transport signal.
- **B1–B8:** the transaction, the policies, validation, pre-acceptance database and storage faults, each post-acceptance fault individually and all at once, scheduled-send redelivery, and job-first ordering.
- **C1–C15:**
  - plain text, HTML/alternative, inline CID, attachments and UTF-8;
  - threading and Reply-To;
  - Bcc and envelope reconciliation;
  - recipient edge cases;
  - the sender authorization matrix and principal re-checks;
  - signed and encrypted messages;
  - malformed and oversized input;
  - retry without accumulation;
  - ambiguous and unexpected provider errors;
  - adapter post-acceptance faults and database faults;
  - log secrecy;
  - address validation.
- **D1, D2:** the real Node Mailer against a loopback test relay: Bcc, Reply-To, Message-ID, 554, 451, RCPT 550, connection lost after DATA (`unknown`), connection refused, not configured.
- **E1:** web `/api/send`, API v1 and JMAP EmailSubmission regression.

## Mutation and adversarial pass

31 mutants, each applied with an anchored edit, run against the SMTP-1 suite, then restored byte for byte (checksum verified). **29 killed:**

- M1–M9;
- M11–M26;
- M28–M31.

Together these cover:

- sender authorization bypass and From/MAIL FROM mismatch;
- credential scope and credential DB errors failing open;
- a trusted Sender header;
- every retry-safety misclassification;
- post-acceptance throw;
- discard disabled, payload unredacted and the retain policy in the adapter;
- job-last ordering;
- envelope reconciliation, Bcc leakage and duplicates;
- address validation;
- malformed-MIME, signed/encrypted and size checks;
- attachments, inline Content-ID, threading and Reply-To;
- thread-lookup DB errors;
- null sender;
- a throwing logger;
- unsanitized error text.

**2 equivalent mutants**, both defensive branches that are unreachable by construction:

- **M10:** the outer catch around post-acceptance recording. Every step catches and logging cannot throw.
- **M27:** the adapter's catch for a non-`SendError`. Every error from the send path is already classified.

## Known limitations and backlog

- **SMTP-2 requirements:**
  - bounded DATA (stop at 36 MiB);
  - submission concurrency limits (parsing costs several times the message size);
  - the rate limiter above;
  - mapping `unknown` to a temporary reply and logging it.
- **Bcc-only messages** are unsupported until `sendEmail` accepts an empty To.
- **Partial recipient refusal:** nodemailer delivers to the RCPTs a relay accepted and reports the rest only in its result, which the Mailer discards. A relay that refuses some recipients synchronously drops them silently (pre-existing).
- **Node REST Message-ID:** the Node Cloudflare REST path sends its own Message-ID header. Whether Cloudflare keeps or rejects it cannot be verified without credentials (SMTP-0's open item; unchanged).
- **Post-acceptance crash window:** a crash between acceptance and the first job write leaves the row and job `queued`. Nothing re-sends them, and reconciliation is manual (the console line, provider logs).
- **Webhook logging:** `dispatchWebhooks` logs whole error objects for webhook delivery failures (pre-existing, outside the send path).
- **Discarded-attempt job rows** accumulate without a cleanup sweep (part of the existing orphan/sweep backlog), and their redacted payload still lists recipients and the subject.
- **Unchanged since SMTP-0 and earlier:**
  - inbound SMTP DATA buffering (B1, INBOUND-SMTP-1);
  - `deleteMessageWithObjects` ordering;
  - JMAP Email/import ordering;
  - MIME parser amplification beyond these bounds;
  - storage and orphan crash windows;
  - backup versus storage;
  - IDLE transient behavior;
  - connection rate limiting.

## Next phase

**SMTP-2 — Authenticated TLS SMTP Submission Listener:**

- Node-only `SMTPServer` on `SMTP_SUBMISSION_PORT` (465, implicit TLS);
- AUTH PLAIN and LOGIN through `verifyMailAppPassword` with the `smtp` scope;
- `authorizeSubmissionSender` at MAIL FROM and `normalizeMailboxAddress` at RCPT;
- bounded DATA streaming into `submitMessage`;
- reply mapping from the semantic results;
- connection, auth, concurrency and rate limits;
- timeouts, logging, certificate reload and shutdown.

SMTP-2 was not started.
