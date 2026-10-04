# SMTP-2 — Authenticated TLS Submission Listener Certification

**Verdict: SMTP-2 CERTIFIED.** The Node/Docker runtime has an opt-in, authenticated SMTP submission listener over implicit TLS. Every message goes through the SMTP-1 adapter (`submitMessage`), which parses it and sends it through `sendEmail`. Raw MIME is never relayed. DATA, connections, authentication, concurrency and sending rate are bounded. Replies come from the adapter's semantic result, and a delivery-unknown outcome is answered with a temporary failure. No migration was needed.

This certifies the listener. It does not make the product production-ready: see the known limitations at the end. SMTP-3 (client configuration and Sent-copy guidance in a real client) was not started, and the operator's Thunderbird configuration was not touched.

## Baseline and repository state

- `main` at `cb761f75b0927a9665b121b36ece1c8fb9ae4bad` ("Add SMTP send-path correctness and submission adapter").
- Operator-local files were left untouched and are not committed: `docker-compose.yml` (modified), `local-certs/`, `.env.docker`, runtime databases, certificates, credentials and Thunderbird data.
- Tooling:
  - Node 22.23.2 on Windows 11;
  - smtp-server 3.19.12 (`@types/smtp-server` 3.5.13, which lags the library);
  - OpenSSL 3.5.7.

## Files changed

| File | Change |
|---|---|
| `server/runtime/smtp-submission.ts` | New. The listener: configuration, TLS, AUTH, envelope checks, bounded DATA, limits, logging, reload and shutdown |
| `server/runtime/smtp-submission-replies.ts` | New. Semantic result → SMTP reply mapping, with fixed client-safe texts |
| `server/runtime/imap.ts` | `loadTlsMaterial` takes the variable names its errors cite (default: the IMAP names, so IMAP messages are unchanged) |
| `server/index.ts` | Validates submission TLS before anything starts, starts the listener only when configured, isolates bind failures, SIGHUP reload, shutdown |
| `tests/smtp-submission-listener.test.mjs` | New. 31 tests over real TLS sockets |
| `tests/distribution-guard.test.mjs` | The SMTP-1 "no listener yet" guard is replaced by the SMTP-2 boundary; the Workers build check also looks for the listener |
| `docs/self-hosting.md`, `Dockerfile`, `CLAUDE.md`, `UPSTREAM.md` | Operator documentation, `EXPOSE 465`, architecture notes |

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `SMTP_SUBMISSION_PORT` | unset (off) | Port to listen on; empty or `0` disables. Anything else that is not a port fails startup |
| `SMTP_SUBMISSION_HOST` | `127.0.0.1` | Bind address. Loopback by default, so enabling the port alone exposes nothing; a container sets `0.0.0.0` |
| `SMTP_SUBMISSION_TLS_CERT`, `SMTP_SUBMISSION_TLS_KEY` | `IMAP_TLS_CERT`, `IMAP_TLS_KEY` | PEM chain and key. Both or neither; with neither, the IMAP pair is used; with no pair at all, startup fails |
| `MAIL_HOSTNAME` | `localhost` | Name in the greeting and EHLO reply (never the machine's hostname) |

- **Startup:**
  - Unusable TLS material fails startup before migrations, Next or any listener. The error names the variables the paths came from.
  - A bind failure is logged, and the app, inbound SMTP and IMAP keep running.
- **Certificate reload:** SIGHUP reloads the certificate. An invalid replacement keeps the current one.

## Architecture

- **TLS is terminated by Node's `tls.Server`.** smtp-server runs with `secure: true, secured: true` and receives each handshaken socket through its public `connect()`. smtp-server never wraps a raw socket.
  - The first design let smtp-server terminate TLS itself. Destroying a socket mid-handshake under that design killed the process with a native access violation (0xC0000005, Windows, Node 22): a silent client, a refused TLS 1.1 client or a handshake timeout could crash the server.
  - Node's own TLS server handles every one of those cases without fault. It is also the design the certified IMAP listener uses.
- **Connections are counted on the TCP socket**, before TLS, so connections still in their handshake count toward the caps. A connection's state is released once, on whichever of its sockets closes first.
- **A handshake timer covers a peer that never sends a ClientHello.** Node's `handshakeTimeout` only starts once a ClientHello arrives. Once the handshake completes, timers act on the TLS socket, because destroying the raw socket would not close it.

## Protocol surface

- **EHLO advertises exactly:**
  - `PIPELINING`
  - `8BITMIME`
  - `SIZE 37748736`
  - `AUTH PLAIN LOGIN`
- **Not advertised:** STARTTLS, SMTPUTF8, DSN, REQUIRETLS and ENHANCEDSTATUSCODES.
- **Disabled commands:** STARTTLS, VRFY, HELP, XCLIENT, XFORWARD, WIZ, SHELL and KILL.
- **TLS 1.2 minimum.**
  - The test proves the refusal is the server's: the client is set to `SECLEVEL=0` so it can actually offer TLS 1.1, and the server answers with a `protocol_version` alert.
  - OpenSSL 3's default security level would also refuse TLS 1.1 on the server. The explicit `minVersion` is therefore defense in depth, and the distribution guard pins it.
- **Plaintext clients** never get a greeting.
- **AUTH:**
  - Only PLAIN (initial response or continuation) and LOGIN.
  - The username is the mailbox address. The password is a mail app password with the `smtp` scope for that mailbox (`verifyMailAppPassword`), so the web password never works.
  - A PLAIN authorization identity must equal the authentication identity.
  - MAIL, RCPT and DATA require AUTH.
- **MAIL FROM:**
  - Checked with `authorizeSubmissionSender`.
  - `SIZE` above the limit is refused at MAIL.
  - A MAIL that carries `SMTPUTF8` is refused (555).
- **RCPT:**
  - `normalizeMailboxAddress`; at most 50 distinct recipients (a repeated recipient does not count twice).
  - An unparseable address gets smtp-server's own 501, an unacceptable one 553.
- **The adapter stays authoritative at DATA:** From must equal MAIL FROM, To/Cc must be envelope recipients, a To is required, and signed or encrypted MIME is refused.

## Reply mapping

The listener keeps four outcomes apart (`smtp-submission-replies.ts`):

| Outcome | Reply |
|---|---|
| Known provider acceptance, including accepted + degraded | `250 OK: queued as <messageId>` |
| Known failure before acceptance that may succeed later (`transport_temporary`/`internal_temporary`, delivery `not_attempted` or `rejected`) | `451 Temporary failure, try again later` |
| Known permanent rejection | 5xx by kind: `invalid_message` 554, or 552 for the size reasons; `unsupported_message` 554; `unauthorized_sender` 550; `delivery_rejected` 554 |
| **Delivery unknown** (`delivery: "unknown"`, `retrySafe: false`) | `451 Delivery status unknown: the message may already have been sent; try again later` |

- **Order of checks:** the ambiguous outcome is checked first. A failure with `retrySafe !== true` or `delivery === "unknown"` never gets a kind-based reply, even when its kind says permanent.
- **Throws:** an unexpected throw after the adapter was called is treated as delivery unknown; one before it as a temporary failure.
- **MAIL FROM refusals:**
  - 553 for an invalid address;
  - 550 for an unauthorized sender;
  - 451 for an authorization lookup that failed.

### Why delivery-unknown is temporary (451)

- **What the client is told.** A delivery-unknown outcome means the transport call ended without a definitive answer: the relay connection dropped during or after DATA, an HTTP 5xx came back, or an unclassified error occurred. The relay may have accepted the message. A 5xx would tell the client delivery definitely failed, which nobody knows. A 4xx says what is true: the server could not complete the request, and the client may try again.
- **Consistency with SMTP-1.** The SMTP-1 architecture recommended this ("For `unknown`, SMTP-2 should still answer temporary"). RFC 5321 prefers a possible duplicate to a lost message.
- **The tradeoff, stated plainly.** If the relay did accept the message and only its confirmation was lost, the client's retry sends it a second time. The recipient gets a duplicate.
- **What SMTP-2 deliberately does not do.** It does not suppress duplicates. An in-memory "already sent" record would be lost on restart and wrong across instances, giving false confidence. Durable, cross-instance deduplication (for example keyed by a client Message-ID with a retention window) would need its own design and migration, and is backlog.
- **What the person is told.** The reply text keeps the ambiguity visible ("may already have been sent"), distinct from the plain temporary failure. A test asserts that the two 451 texts differ.
- **Sent is not a place to check.** The adapter's discard policy leaves no Sent row for a failed attempt, so the operator documentation points to the recipient or the relay's logs, not to Sent.
- **Choice of code:**
  - 451 ("requested action aborted: local error in processing", RFC 5321 §4.2.3) is the conventional transient reply after DATA. It is already this listener's code for every temporary condition (rate, permits, temporary failure).
  - 421 would close the connection, and 452 means insufficient storage, so neither fits.
  - ENHANCEDSTATUSCODES is not advertised, so per RFC 2034 the reply carries no enhanced code. Had it been advertised, the fitting code would be 4.4.0 (RFC 3463, "other or undefined network or routing status").
  - The extension stays off because smtp-server attaches its generic per-code enhanced status to callback replies (for example 550 → 5.1.1), which would misreport them.

## Bounded DATA and memory

- **Byte retention:**
  - Bytes are kept only up to the size limit: 36 MiB, never above the adapter's `MAX_SUBMISSION_MESSAGE_BYTES`, even if configured higher.
  - The moment a message crosses the limit, everything kept is dropped. The rest is only counted, and the reply is 552.
  - A client that sends more than 1 MiB past the limit is disconnected.
  - A false `SIZE=` declaration changes nothing: the bytes themselves are counted.
- **Minimum rate.** DATA must finish within 60 s plus its size at 16 KiB/s. A slower client is disconnected.
- **Submission permits.** One is taken when DATA is admitted (4 in all, 1 per account) and held until `submitMessage` returns, even if the client disconnects meanwhile. A submission over the permits or over the sending rate is drained without keeping anything, then refused with 451.
- **Memory characteristic (a known resource cost, not unbounded buffering).**
  - Collection is bounded: one message never holds more than the limit plus one network chunk while it is being received, whatever the client sends.
  - At the end of DATA the kept chunks are joined into one buffer for the adapter (`Buffer.concat`, skipped when there is a single chunk). For that moment a second allocation of roughly the message's size exists alongside the chunks, so the transient peak is about twice the message size, at most about 72 MiB per submission.
  - The chunks are released right after, before the adapter runs.
  - With 4 concurrent submissions the worst-case transient peak of collection is therefore about 288 MiB. On top of that comes the adapter's own parsing cost (several times the message size, as SMTP-1 recorded).
  - The listener's `retainedBytes`/`peakRetainedBytes` diagnostics count the kept bytes, not the transient joined copy.
  - Streaming the chunks to the adapter without the join would remove the duplicate allocation. That is backlog, because the adapter takes one `Uint8Array`.

## Limits (per instance, in memory)

| Limit | Default |
|---|---|
| Connections: total / per client address (IPv6 per /64) / authenticated per account | 100 / 10 / 10 |
| Failed AUTH: per connection (then the connection closes) / per address in 15 min (then refused unverified) / per username in 15 min (then each attempt delayed 5 s, never locked out) | 3 / 10 / 20 |
| Delay before answering a failed AUTH | 1 s |
| TLS handshake / login deadline (absolute, never extended by activity) / idle | 10 s / 60 s / 5 min |
| Unauthenticated commands / command line length | 10 / 4096 bytes |
| Recipients per message / messages per connection | 50 / 50 |
| Concurrent submissions: total / per account | 4 / 1 |
| Sending rate per hour: messages per account / per credential / recipients per account | 100 / 50 / 500 |

- **When rate is counted.** Rate is counted when DATA is admitted, whatever the outcome, so failed submissions cannot be replayed for free. It is checked at MAIL, at RCPT and again atomically at DATA admission, so simultaneous connections of one account cannot pass the limit together.
- **Shutdown.** Shutdown stops accepting and releases the port, gives transactions in progress the grace period (2 s), then answers `421 Server shutting down` and closes (tested).

## Logging

- **What is logged:** event names, connection ids, client addresses, user, mailbox and credential ids, AUTH method, reason classes, sizes, and recipient counts.
- **What never appears** (asserted by a test that captures every log line and console stream):
  - the password or AUTH payload;
  - the username of a failed attempt;
  - headers or body.
- **Adapter throws.** An unexpected throw from the adapter logs only its error class. Its text could quote anything, including the message, and `safeErrorText` only strips drizzle's bound parameters.

## Defects found during certification

| Found by | Defect | Fix |
|---|---|---|
| TLS tests | Native crash when a socket was destroyed mid-handshake under smtp-server's own TLS wrapping | TLS terminated by `tls.Server`; smtp-server receives handshaken sockets only |
| TLS tests | smtp-server's default greeting names the machine (`os.hostname()`) | `MAIL_HOSTNAME`, else `localhost` |
| Envelope test | One refused `MAIL FROM … SMTPUTF8` made every later MAIL on the connection fail with 555. smtp-server sets `envelope.smtpUtf8` before the hook and keeps it after a refusal | The hook checks the command's own parameters |
| Mapping test | An adapter throw logged its message text, which could contain message content | Only the error class is logged |
| Review against SMTP-1 | Delivery-unknown was answered with a permanent 554 | Temporary 451 with its own text (see above) |

## Test and certification results

- **`tests/smtp-submission-listener.test.mjs`: 31/31.** Real TLS sockets on loopback, SQLite, an in-memory transport, and for the end-to-end test a loopback relay behind the real Node Mailer. Every test is bounded at 60 s, so a listener that stops cutting a client off fails instead of hanging the run.
  - Configuration and entrypoint order.
  - TLS: 1.2+, server-side refusal of 1.1, no plaintext service, handshake timeout, reload.
  - Protocol: advertisement, command order, chatter, line limit, pipelining.
  - AUTH: PLAIN/LOGIN, uniform failures, web password refused, database error fails closed, throttles, login deadline.
  - Envelope rules and the recipient cap.
  - DATA: real client with HTML, attachments, inline images and UTF-8; the exact size boundary; flood cut-off with nothing retained; minimum rate; disconnect mid-DATA.
  - Reply mapping: the table, every adapter outcome reaching the client, and real adapter outcomes.
  - Rate limits and recovery; simultaneous connections.
  - Concurrency per account, the global permit across accounts, and a permit held while an abandoned submission completes.
  - Connection caps and counter release; handshakes counted.
  - Shutdown: no new connections, 421 to open sessions, the port released.
  - Logging hygiene; end to end through a real relay.
- **`tests/distribution-guard.test.mjs`: 17/17.** The SMTP-2 guard pins the boundary:
  - there are exactly two `new SMTPServer(`, inbound and submission;
  - `SMTP_SUBMISSION_PORT` is named only by the listener and the entrypoint;
  - only `server/index.ts` starts the listener;
  - only the listener and its reply mapping import `src/lib/submission`;
  - nothing the Worker compiles imports the listener;
  - TLS 1.2, `secured: true`, STARTTLS disabled, no insecure-AUTH options;
  - no direct transport call or `sendEmail` from the listener.

  The Workers-build check also looks for `startSubmissionListener` and `SMTP_SUBMISSION_PORT`. It ran against a fresh `npm run build` of this tree, which succeeded.
- **Full suite (`node --test tests/*.test.mjs`, run before the shutdown test was added).** 575 tests: 568 pass, 3 skipped, 4 fail. All four fail on this Windows checkout for reasons outside SMTP-2:
  - `downstream-migrations` compares trigger SQL and sees CRLF from `core.autocrlf`;
  - two `imap-state` tests hit `EBUSY` deleting a still-open SQLite file;
  - gate6's `chmod 0` cannot make a file unreadable on Windows. Every IMAP TLS error-message assertion before it passes with the generalized `loadTlsMaterial`.
- **Type checking.** `npx tsc --noEmit` reports 20 errors, the repository baseline; none is in the files changed here.
- **Lint.** `eslint` is clean on the changed files.

## Mutation and adversarial pass

- **Method:**
  - 58 mutants, each an exact, unique replacement in one of `smtp-submission.ts`, `smtp-submission-replies.ts`, `imap.ts` or `index.ts`.
  - Each was run one at a time against the tests that should catch it, and the file was restored from its original bytes.
  - Restoration was checked by SHA-256 after every mutant, and all four files again at the end of every run against a snapshot taken before the pass. All were byte-identical.
- **First pass (56 mutants):**
  - 43 killed;
  - 4 detected only by hanging until the harness's 300 s limit (no per-test bound yet);
  - 9 survived.
- **Six of the survivors exposed test gaps,** each fixed and the mutant re-run:

| Mutant | What the test missed | Strengthened |
|---|---|---|
| L10 login deadline not enforced | The keep-alive NOOPs hit the unauthenticated-command limit first, so the wrong mechanism closed the connection | Command limit raised in that test; asserts closure within 2 s |
| L20 bytes kept after the limit | Peak memory stayed within the limit either way | Asserts `retainedBytes === 0` at the moment the oversize is logged, while the flood still arrives |
| L23 global permit not enforced | Only the per-account permit was exercised | New two-account test |
| L24 permit released while the adapter runs | Not exercised | Same test: an abandoned submission keeps the permit until it completes |
| L38 command length unbounded | The 60 s login deadline eventually closed the connection anyway | Requires a 421 within 2 s |
| L40 machine hostname in greeting | Nothing asserted the name | Asserts `220 localhost ESMTP` and no machine hostname |

- **Test fix: TLS 1.1.** The old TLS 1.1 assertion was satisfied by the client refusing itself (`ERR_SSL_NO_PROTOCOLS_AVAILABLE`). It now proves a server-side refusal.
- **Hangs.** A 60 s bound now applies to every test, and the close-waits are bounded explicitly. The hanging mutants (L3 handshake timer, L19 flood cut-off, L21 minimum rate) now fail within 8 s. L22 (per-account permit) and the re-run L23/L24 are detected through the 60 s test bound: their second submission waits on the gated adapter.
- **Shutdown mutants.** Two were added with the shutdown test: no 421 (killed), and the server never closed (survived at first because new sockets are refused anyway; killed once the test asserts the port is released).
- **Final:** 55 of 58 killed, and 3 equivalent:
  - **L1** `secured: false`: the listener passes already-secured sockets to `connect()`, so the flag only affects smtp-server's unused internal listener and its default-certificate warning. The guard pins the line.
  - **L11** MAIL hook's own principal check removed: smtp-server refuses MAIL before AUTH itself, so the hook's check is unreachable defense in depth.
  - **L18** oversize decided by smtp-server's `sizeExceeded` alone: the library counts the same emitted DATA bytes against the same limit with the same `>` comparison. The listener's own flag is defense in depth.

**Killed, by area:**

| Area | Mutants killed |
|---|---|
| Reply mapping | ambiguous → 5xx; ambiguous mapped by kind; `delivery: unknown` ignored; ambiguous indistinguishable from a clean temporary; temporary → permanent; degraded acceptance not success; size not 552; temporary MAIL refusal → permanent; relay rejection → temporary |
| TLS | below 1.2 allowed; handshake timer off |
| Connection caps | global cap off by one; per-address cap off; per-account cap off; slots never released |
| AUTH | `authzid` impersonation; per-connection limit off by one; per-address throttle off; per-username throttle off; login deadline off |
| Protocol | unimplemented AUTH method advertised; STARTTLS enabled; command line unbounded; pre-auth chatter unbounded; hostname leak; binds all interfaces |
| Envelope | SMTPUTF8 accepted; MAIL FROM authorization skipped; recipient cap off by one; duplicates counted twice; bad recipient accepted |
| DATA | size boundary off by one; flood never cut; bytes kept after the limit; slow DATA never cut; size above the adapter's accepted |
| Permits | per-account permit off; global permit off; permit released early |
| Rate | account, credential and recipient counting removed; MAIL and DATA rate checks removed |
| Replies and logs | temporary reported as success; adapter error text logged; failed username logged; throw after start treated as clean retry; messages per connection off by one |
| Configuration and entrypoint | TLS error names the wrong variable; bind failure fatal; SIGHUP not wired; reload does not install the certificate |
| Shutdown | no 421 to open sessions; port never released |

## Security invariants

| # | Invariant | Evidence |
|---|---|---|
| 1 | Nothing listens unless configured, and loopback by default | Config tests; L41 |
| 2 | Implicit TLS 1.2+ only; no plaintext SMTP, no STARTTLS | TLS test (server-side refusal); guard; L2, L36 |
| 3 | Only an `smtp`-scoped mail app password for the address given authenticates; never the web password | AUTH tests; L7 |
| 4 | No relay of raw MIME; every message through `submitMessage` | Guard |
| 5 | A client sends only as its authorized address | Envelope test; L13; adapter's From = MAIL FROM |
| 6 | Memory per submission is bounded by the size limit (plus the transient join), and submissions in memory are bounded | DATA tests; L17–L21, L22–L24 |
| 7 | No outcome that may have been delivered is reported as a definite failure; no failure is reported as success | Mapping tests; R1–R6, L28, L31 |
| 8 | No secret or message content in logs | Logging test; L29, L30 |
| 9 | The Worker never compiles the listener | Guard (source and Workers build output) |

## Known limitations and backlog

- **Possible duplicates.**
  - A delivery-unknown outcome is answered with 451, so a client retry can duplicate a message the relay had in fact accepted.
  - This is deliberate, as described above.
  - Durable deduplication is backlog.
- **Transient DATA memory.**
  - The final join briefly needs a second allocation of about the message's size, up to about 72 MiB per submission and about 288 MiB at 4 concurrent submissions.
  - The adapter's parsing cost comes on top.
  - This is a bounded resource cost, not unbounded buffering; streaming to the adapter is backlog.
- **Per instance.** Every limit is per instance and in memory, like IMAP's; several instances each enforce their own, and a restart resets the windows.
- **No ENHANCEDSTATUSCODES.** It is not advertised (see the reply mapping section).
- **Unsupported messages.** SMTPUTF8 addresses, Bcc-only and Cc-only messages (the adapter requires a To), and signed or encrypted MIME are refused.
- **Structural checks only.** Bind-failure isolation and the SIGHUP wiring are checked structurally (source order and shape), not by running the entrypoint.
- **Not tested here.**
  - No real desktop client was used in this phase.
  - nodemailer, a real SMTP client, covers PLAIN, LOGIN, HTML, attachments and UTF-8.
  - Real-client certification and client configuration (including turning off the client's own Sent copy) belong to SMTP-3.
- **Unchanged from SMTP-1 and earlier:**
  - inbound SMTP DATA buffering (B1);
  - partial recipient refusal by a relay;
  - the post-acceptance crash window;
  - discarded-attempt job rows without a sweep;
  - the Node REST Message-ID question.

## Next phase

**SMTP-3 — Real client certification:**
- Thunderbird (and at least one other client) against the submission listener;
- account setup guidance;
- the client's own Sent copy turned off, and duplicate-copy behavior verified;
- the delivery-unknown experience observed in a real client.

SMTP-3 was not started.
