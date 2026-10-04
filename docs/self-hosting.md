# Self-hosting Blue Pine Solutions Mail (Docker)

Cloudflare Workers is Blue Pine Solutions Mail's primary deployment target (see [deployment](deployment.md)). The same code can also run as a single container on your own host. The container provides its own database (SQLite on a volume), blob storage (files on the same volume), job queue, realtime WebSocket, backup schedule and an SMTP listener for inbound mail.

## Quick start

```bash
git clone https://github.com/blue-pine-solutions/blue-pine-mail && cd blue-pine-mail
cp .env.docker.example .env.docker      # edit: how to receive and send mail
docker compose build --build-arg BLUEPINE_BUILD_COMMIT=$(git rev-parse HEAD)
docker compose up -d
```

Open `http://your-host:3000/setup`, create the admin account and add your domain. All data lives in the `mailflare-data` volume (`/data` in the container): the SQLite database, raw messages, attachments and backups.

The `BLUEPINE_BUILD_COMMIT` build argument records which commit the image was built from, so the in-app **Source** link points at exactly that commit. It is optional; without it the link points at the repository. Build from a clean checkout of the commit you mean to run.

Behind a reverse proxy, set `APP_URL=https://mail.example.com` so links in password-reset mail and the JMAP session point at the public address, and forward WebSocket upgrades for `/api/realtime`.

## Receiving mail

Pick one; both can be on at once.

**Built-in SMTP listener (default).** The container listens on port 25 and accepts mail for every domain you add. Point the domain's MX record at the host, set `MAIL_HOSTNAME` to that host's name, and make sure port 25 is reachable from the internet (several clouds block it by default). The domain page in the app lists the MX, SPF and DMARC records to create. Mail for addresses that do not exist is rejected. Domain routing rules work as on Cloudflare: reject rules answer the sender with a 550 during delivery, and forward rules relay the message through your outbound SMTP.

Optional: `SMTP_TLS_KEY` and `SMTP_TLS_CERT` (paths inside the container) enable STARTTLS with your own certificate. Without them STARTTLS is not offered, which is safe but means transport encryption depends on the sender.

This listener only receives mail for your domains from other mail servers. It does not authenticate users and never relays, so it is not a mail client's outgoing server; mail clients use [SMTP submission](#sending-from-mail-clients-smtp-submission) on port 465. It limits concurrent connections and refuses oversized messages (`SMTP_MAX_SIZE`); a peer that keeps sending well past the limit is disconnected instead of being buffered. These limits are per process.

**Cloudflare Email Routing relay.** Keep MX on Cloudflare and deploy the Worker in `deploy/cloudflare-email-relay`. It posts each message to `/api/inbound` on your server, signed with `INBOUND_WEBHOOK_SECRET`, and acts on the reject or forward decision the server returns. Set `SMTP_INBOUND_PORT=0` if you do not want the listener at all.

## Sending mail

**Any SMTP relay.** `SMTP_URL=smtps://user:pass@host:465` (or `smtp://` with STARTTLS). Works with your hosting provider's relay, Amazon SES, Postmark, Mailgun, or a Postfix you run. Set `SMTP_TLS_REJECT_UNAUTHORIZED=false` only for a relay with a self-signed certificate on a private network.

**Cloudflare Email Sending.** `CF_ACCOUNT_ID` plus a `CF_TOKEN` with Email Sending: Edit. The domain must be a Cloudflare zone with Email Sending set up; the server calls the REST API, no Workers plan needed.

## Mail clients over IMAP

The container can serve IMAP4rev1 to desktop mail clients. Clients can list folders, open and search mail and download attachments, and mark messages read, unread, flagged or unflagged; opening a message marks it read, as in the web app. These are the same read and starred states the web app shows, in both directions. Users with full access to a mailbox can also delete messages: a message marked deleted and then expunged (or closed) by the client moves to **Trash**, exactly like the web app's Delete, and can be restored from there. They can also move messages between folders (IMAP MOVE, which clients use for drag and drop, "Archive" and "Junk"): into INBOX, Archive, Spam, Trash or a custom folder. Moving a message into **Spam** reports it as spam and moving it from Spam back to **INBOX** marks it as not spam, training the mailbox's spam filter exactly like the web app's buttons; other moves train nothing. **Sent** and **Drafts** cannot receive moved messages, a draft can only be moved to Trash (and only by the user who wrote it), and sent mail cannot be moved to Spam. A sent message moved to Trash cannot be put back into Sent over IMAP, because Trash does not remember where a message came from; restore it from the web app instead. A moved message keeps its read and flagged state and its content, and a pending deletion mark does not follow it. Deleting from **Trash** is permanent: a message marked deleted in Trash and then expunged (or closed) by the client is removed for good, for every user of the mailbox, and cannot be restored except from a database backup (see the limitations below). In **Drafts** the same permanently deletes a draft, but only the user who wrote it can mark it deleted; another user's draft is refused, and a draft edited in the web app after it was marked is not deleted (it becomes a new message the client sees again). The message's database record goes first; its stored bytes and attachment files are removed right after, and if that storage cleanup fails the files are left behind as unused objects (logged as `expunge.cleanup-failed`) while the message stays deleted. Users with full access can also copy messages (COPY and UID COPY; a copy is an independent message, and copies cannot go into Sent or Drafts), create, rename and delete custom folders, subscribe and unsubscribe folders (stored per user and mailbox), and use UID EXPUNGE (UIDPLUS). APPEND is accepted for **Drafts only**, so a client can save and edit drafts; uploading into any other folder is refused. Read-only and send-only delegates cannot delete, move or copy. This is IMAP4rev1 with a deliberately limited extension set (the server advertises `NAMESPACE UNSELECT SPECIAL-USE MOVE UIDPLUS IDLE`), not a complete implementation: CONDSTORE, QRESYNC, MULTIAPPEND, LITERAL+ and hierarchical folders are not supported. Mail clients send through the separate SMTP submission service described below. Only Mozilla Thunderbird 157.0 on Windows, against a local Docker runtime, has been tested; other clients may work but are not certified.

IMAP is off unless you turn it on, and it only speaks **implicit TLS** (IMAPS, port 993). There is no plaintext port 143 and no STARTTLS.

```bash
IMAP_PORT=993
IMAP_TLS_CERT=/data/tls/fullchain.pem   # PEM certificate chain
IMAP_TLS_KEY=/data/tls/privkey.pem      # PEM private key
```

Mount the certificate files into the container (a volume or Docker secrets); a Let's Encrypt `fullchain.pem`/`privkey.pem` pair works as is. The certificate must cover the hostname clients connect to. If `IMAP_PORT` is set and the files are missing, unreadable, not PEM, or do not belong together, the server refuses to start and says why. After renewing the certificate, send the process `SIGHUP` (`docker compose kill -s HUP mailflare`) to load the new files without dropping connections, or restart the container; an invalid replacement is ignored and the current certificate stays in use.

Publish the port in `docker-compose.yml` alongside the existing ones:

```yaml
    ports:
      - "993:993"     # IMAP over TLS
```

The application keeps running as the unprivileged `node` user; Docker lets containers bind low ports without root, as it already does for port 25. Map the port directly rather than through a TCP proxy, so the listener sees each client's address for its limits.

**Signing in.** The username is the mailbox address (for example `ann@example.com`). The password is a **mail app password** created in the web app under **Settings → App passwords** (Mail app passwords) with the **IMAP** scope, for that mailbox. The account's web password and API keys are never accepted. A mail app password for a shared mailbox signs in with the shared mailbox's address. Revoking the mail app password, disabling the account or mailbox, or removing someone's access to a shared mailbox closes their open IMAP connections within a minute.

**Folders.** INBOX, Drafts, Sent, Archive, Spam and Trash (advertised with their special-use roles) and your own folders. The namespace is flat: a folder name containing `/` or `.` is one folder, not a hierarchy.

**Limits.** Per server instance: 500 connections in total, 20 per client address (IPv6 per /64), and 20 signed-in connections per account. After 10 failed sign-ins from one address in 15 minutes, further attempts from it fail for the rest of the window; after 20 failures for one username, its attempts are slowed rather than blocked, so nobody can lock another person out. Three failures end a connection. Idle connections close after 60 seconds before sign-in and 30 minutes after. These limits are held in memory by each instance and reset on restart; several instances behind a load balancer each enforce them separately.

## Sending from mail clients (SMTP submission)

The container can also accept mail from desktop mail clients and send it the same way the web app does: the message goes out through the configured sending path (`SMTP_URL` or Cloudflare Email Sending) and the server files the authoritative copy in the mailbox's **Sent** folder (visible over IMAP and JMAP too). This listener is separate from inbound SMTP. It is off unless you enable it, and it only speaks SMTP over implicit TLS (port 465); there is no plaintext port, no STARTTLS and no port 587. Only Mozilla Thunderbird 157.0 on Windows, against a local Docker runtime, has been tested.

```bash
SMTP_SUBMISSION_PORT=465
SMTP_SUBMISSION_HOST=0.0.0.0                       # in a container; the default is 127.0.0.1
SMTP_SUBMISSION_TLS_CERT=/data/tls/fullchain.pem   # optional: defaults to IMAP_TLS_CERT/KEY
SMTP_SUBMISSION_TLS_KEY=/data/tls/privkey.pem
```

Publish the port in `docker-compose.yml`:

```yaml
    ports:
      - "465:465"     # SMTP submission over TLS
```

The certificate rules are the same as for IMAP: unusable files stop startup with a message naming the variables, and `SIGHUP` reloads them. If neither `SMTP_SUBMISSION_TLS_*` variable is set, the IMAP certificate is used. Only TLS 1.2 and later are accepted. If the port cannot be bound, the error is logged and everything else keeps running.

**Signing in.** AUTH PLAIN or LOGIN, with the mailbox address as the username and a mail app password that has the **SMTP** scope for that mailbox (the web password never works). The full mailbox address is the username (not a bare name), and the account's web password is never accepted. A client can only send as the authenticated mailbox's address, and the message's From must match it.

**In the mail client:** server port 465, connection security "SSL/TLS", authentication "Normal password". The server creates the Sent copy of every accepted message, so the client must not upload its own. In Thunderbird, uncheck "Place a copy in" under Account Settings → Copies & Folders for this account (it is a per-account setting, and it was disabled in the certified setup). The server cannot stop a client from creating its own copy; if one does, Sent holds two.

**What is refused.** Messages without a To recipient (Cc- or Bcc-only), signed or encrypted (S/MIME, PGP/MIME) messages, `SMTPUTF8` addresses, and messages over 36 MiB. 

**Delivery outcomes.** When the relay accepts a message, the client is told it succeeded, even if a later local bookkeeping step has a problem. When the relay clearly rejects it, the client gets a permanent or temporary error as appropriate. If the outcome is unknown (for example the connection dropped after the message was handed over), the client gets a temporary `451` error saying "Delivery status unknown": the message **may already have been sent**, and the client will normally try again later. Retrying can then deliver a duplicate, because there is no durable deduplication across attempts or restarts; the server prefers a possible duplicate to a lost message. Nothing is filed in Sent for a failed attempt, so Sent cannot settle it; only the recipient or the relay's logs can.

**Limits.** Per server instance: 100 connections, 10 per client address and 10 signed-in connections per account; 50 recipients per message and 50 messages per connection; 4 messages being received or sent at once (1 per account). Sending is limited per hour to 100 messages per account, 50 per app password and 500 recipients per account. Three failed sign-ins close the connection; 10 from one address in 15 minutes block that address for the rest of the window, and repeated failures for one username slow its attempts down. A connection must finish its TLS handshake within 10 seconds and sign in within 60, and is closed after 5 minutes idle.

## Cloudflare zone management (optional)

If `CF_TOKEN` can also edit DNS and Email Routing on your zones, adding a domain configures Email Routing and the sending subdomain automatically, as on Workers. Without it, domains are recorded as manually managed and the DNS page shows what to set by hand.

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `/data` | SQLite database, blobs and backups |
| `APP_URL` | request origin | Public URL behind a proxy |
| `SMTP_INBOUND_PORT` | `25` | Inbound SMTP; `0` disables |
| `MAIL_HOSTNAME` | `mail.<domain>` | Host the MX record points at |
| `SMTP_MAX_SIZE` | 36 MiB | Largest raw inbound message; allows for encoding overhead on up to 25 MB of attachments. Oversized mail receives an SMTP rejection. |
| `SMTP_TLS_KEY`, `SMTP_TLS_CERT` | unset | STARTTLS certificate for the listener |
| `SMTP_URL` | unset | Outbound relay |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | Trust self-signed relay certificates when `false` |
| `IMAP_PORT` | `0` (off) | IMAP over implicit TLS; `993` to enable |
| `IMAP_HOST` | `0.0.0.0` | Address the IMAP listener binds |
| `IMAP_TLS_CERT`, `IMAP_TLS_KEY` | unset | PEM certificate chain and key for IMAP; required when `IMAP_PORT` is set |
| `SMTP_SUBMISSION_PORT` | unset (off) | Authenticated SMTP submission for mail clients, implicit TLS only; `465` to enable |
| `SMTP_SUBMISSION_HOST` | `127.0.0.1` | Address the submission listener binds; `0.0.0.0` in a container |
| `SMTP_SUBMISSION_TLS_CERT`, `SMTP_SUBMISSION_TLS_KEY` | `IMAP_TLS_CERT`, `IMAP_TLS_KEY` | PEM certificate chain and key for submission; set both or neither |
| `CF_ACCOUNT_ID`, `CF_TOKEN` | unset | Cloudflare Email Sending, and zone management if the token allows |
| `INBOUND_WEBHOOK_SECRET` | unset | Enables `/api/inbound` for the relay Worker |
| `TURNSTILE_SECRET_KEY` | unset | Bot protection on login and reset forms (`NEXT_PUBLIC_TURNSTILE_SITE_KEY` at build time) |
| `AI_BASE_URL` | unset | OpenAI-compatible model API base URL for the assistant |
| `AI_API_KEY` | unset | Server-only key for that model API |
| `AI_MODEL` | `gpt-4o-mini` | Model ID supported by the configured API |
| `BLUEPINE_DISABLED_FEATURES` | unset | Comma-separated features to turn off: `customBranding`, `multipleAccounts`, `sharedMailboxes`, `accountForwarding`, `gravatar` |
| `BLUEPINE_BUILD_COMMIT` | build argument | Commit shown on the About page and used by `/source`; usually set with the Docker build argument above |
| `BLUEPINE_RELEASE_REPOSITORY` | Blue Pine repository | `owner/repository` checked for approved releases |

## Operations

- **Updates.** Admin → **Version and updates** reports when an approved Blue Pine Solutions Mail release (a GitHub Release tagged `bluepine-vMAJOR.MINOR.PATCH`) is newer than the installed version. It never installs anything. To update, check out the release tag, rebuild the image with the build argument above, and recreate the container; migrations run at start. Back up the volume first. See [Upgrading from 0.1.2 to 0.2.0](#upgrading-from-012-to-020).
- **Backups.** The daily 02:00 UTC backup and the admin Backups page export database records to `/data/blobs/backups`, on the same volume as the data. They are not an off-host copy: back up the whole volume to another machine for disaster recovery.
- **Logs.** `docker compose logs -f mailflare`.
- **Queues.** Jobs are held in memory. Inbound mail is written to the volume before it is queued, so a restart never loses a message; at worst one stays unparsed until it is re-imported.
- **Several installations on one host.** Only one container can bind public port 25. To run more, put an inbound mail front end in front of them, or use the Cloudflare relay Worker for each.

## Upgrading from 0.1.2 to 0.2.0

Version 0.2.0 adds five Blue Pine migrations, `bp0001` to `bp0005`. They add the tables and triggers for mail app passwords, IMAP mailbox state and IMAP subscriptions, are additive to the existing schema, and run after upstream's migrations. The existing migration runner applies them at start, in a transaction per migration, and records each by name, so already-applied migrations are skipped.

1. Back up the whole volume (`/data`: the database, raw messages, attachments) to another machine first. The built-in backups on the same volume do not count.
2. Check out the release tag, rebuild the image with the build argument above and recreate the container.
3. Check the startup log for the applied migrations. IMAP and SMTP submission stay off until you set the variables described above.

There is no downgrade procedure: once the migrations have run, return to 0.1.2 only by restoring the pre-upgrade backup. Review the limitations below, and the [0.2.0 release notes](release-notes/0.2.0.md), before exposing the mail-client ports.

## Email assistant and MCP

Set `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` in the container environment to configure the built-in assistant. These values stay on the server. Assistant chat is available by default when a provider is configured; a mailbox manager can change its writing instructions and availability through the settings button in the assistant panel. Automatic reply drafts stay off until enabled there. Auto-draft work is recorded in SQLite and retried after a restart by the local scheduler. AI failure does not reject inbound mail. Out-of-office auto-replies and AI auto-drafts are separate features; turn off out-of-office replies before enabling auto-drafts for a mailbox.

The MCP endpoint is `/mcp`. Create a mailbox-scoped key in **Settings → API keys** with **Allow MCP access** and give it to a client that supports custom HTTP headers. The endpoint uses Streamable HTTP; `request_send` gives the client a review URL, and only a signed-in browser session can confirm delivery. MCP read and draft tools remain available when no AI model is configured.

## Running without Docker

```bash
npm ci
npm run build:node
MAILFLARE_RUNTIME=node NODE_ENV=production DATA_DIR=./data node dist/server.mjs
```

`MAILFLARE_RUNTIME` keeps its upstream name for compatibility. Ports 25, 465 and 993 need root or a capability; rather than running Node as root, use `SMTP_INBOUND_PORT=2525`, `SMTP_SUBMISSION_PORT=4465` and `IMAP_PORT=9993` behind a port forward (or give the service `CAP_NET_BIND_SERVICE`, for example with systemd's `AmbientCapabilities`).

## Limitations

- **Not production-ready.** Blue Pine Solutions Mail 0.2.0 is not presented as production-ready, and managed-service operational hardening is not complete. You provision and renew TLS certificates, monitor the host and plan capacity.
- **Clients.** Only Mozilla Thunderbird 157.0 on Windows has been tested, against a local Docker runtime on loopback. Outlook, Apple Mail, phone clients and other software are untested.
- **IMAP** is a limited IMAP4rev1 command set: APPEND only into Drafts, COPY and MOVE not into Sent or Drafts, no CONDSTORE or QRESYNC, flat folder namespace. A message deleted permanently from Trash or Drafts can be restored only from a database backup.
- **SMTP submission** is implicit TLS on port 465 only (no port 587 or STARTTLS), and does not support `SMTPUTF8` addresses, signed or encrypted messages, or Bcc-only messages.
- **Possible duplicates.** If delivery status is unknown the client gets a temporary error, and a retry can send the message twice; there is no durable deduplication.
- **Sent copies.** The server files the Sent copy; a client that also uploads its own creates a duplicate.
- **Process-local limits.** IMAP and SMTP connection, sign-in and rate limits are per instance, held in memory and reset on restart.
- **Node/Docker only.** IMAP and SMTP submission are not available on Cloudflare Workers.
- **Storage.** All state lives on one local volume with SQLite; plan off-host volume backups and host capacity. Backups hold database records, not stored message bytes or attachment files. If removing a permanently deleted message's stored files fails, the files remain as unused objects and nothing reclaims them automatically yet.
