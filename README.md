# Blue Pine Solutions Mail

Blue Pine Solutions Mail is a self-hosted email inbox for custom domains, distributed by Blue Pine Solutions.

It is an independent downstream distribution of [Mailflare](https://github.com/hieunc229/mailflare) by Hieu Nguyen. Blue Pine Solutions Mail is not affiliated with or endorsed by the Mailflare project or its author. See [NOTICE](NOTICE) for attribution and the list of downstream changes.

## What you can do

- **Domains**: connect domains. On Cloudflare, Email Routing and sending DNS are configured for you; without Cloudflare credentials the DNS page lists the records to create by hand.
- **Mailboxes and accounts**: create personal and shared mailboxes, add user accounts, and delegate mailbox access.
- **Email**: send and receive email with attachments, rich formatting, signatures, automatic replies and account forwarding.
- **Organization**: search, custom folders, stars, snoozing, archive, spam and trash.
- **Routing rules**: store, forward, reject or categorize incoming messages.
- **Notifications**: real-time inbox updates and browser notifications.
- **Import and export**: import and export mail, manage contacts, block senders.
- **Administration**: accounts, permissions, API keys, webhooks, audit logs, database backups and branding (app name and icon).
- **Integrations**: an HTTP API, JMAP, an optional email assistant and an MCP endpoint for external AI clients.

Optional features (custom branding, multiple accounts, shared mailboxes, account forwarding) are on by default and can be turned off per deployment with `BLUEPINE_DISABLED_FEATURES`.

## Deployment

Cloudflare Workers is the primary deployment target: mail data stays in your own D1 database, attachments in your own R2 bucket, and Cloudflare Email Routing delivers incoming mail to the Worker. See the [deployment guide](docs/deployment.md).

A Node/Docker build is also supported for self-hosting on your own server, with SQLite and local files instead of D1 and R2 and a built-in SMTP listener for inbound mail. See [self-hosting](docs/self-hosting.md).

Cloudflare charges depend on your plan and usage; check Cloudflare's current pricing for Workers, D1, R2, Queues and Email Sending before deploying.

## Versions, updates and source

- **Blue Pine Solutions Mail version** is the distribution's own version. The **Mailflare base** it was built from is shown separately. Both appear under **Admin → Version and updates** and on the **About** page.
- **Updates** come only from approved Blue Pine Solutions Mail releases: published GitHub Releases tagged `bluepine-vMAJOR.MINOR.PATCH`. The app checks for them but never installs anything; you deploy a release with the method your installation uses.
- **Source**: every page links to **Source** and **About**. `/source` leads to the source of the running build: the exact commit when the build records `BLUEPINE_BUILD_COMMIT`, otherwise this repository.

## Current limitations

- There is no IMAP server or SMTP submission service for desktop and phone mail clients. Use the web app, JMAP clients or the API.
- The Docker build keeps its database and files on one local volume. The built-in backups are record exports stored on that same volume, so they are not an off-host disaster-recovery copy.
- One host can bind public port 25 only once. Running several Docker installations on one server needs an inbound mail front end (or the Cloudflare relay Worker) to route mail to each.

## Local development

```bash
cp .dev.vars.example .dev.vars
npm install
npm run db:migrate:local
npm run dev
```

Add your Cloudflare credentials to `.dev.vars`, then open [http://localhost:3000](http://localhost:3000). For sample data, run `npm run db:seed` while the development server is running.

Tests are `node:test` files: `node --test tests/*.test.mjs`. `npm run build` builds the complete Worker; `npm run build:node` builds the Node/Docker server.

Some internal names keep their upstream form for compatibility (for example the `mailflare` Worker name, `MAILFLARE_RUNTIME` and the `X-Mailflare-Forwarded` header). See [UPSTREAM.md](UPSTREAM.md) before renaming anything.

## Upstream integration

This repository follows Mailflare as an engineering input, not as an update source for installations. Upstream changes are merged on an integration branch, reviewed and tested, then shipped as a Blue Pine Solutions Mail release. [UPSTREAM.md](UPSTREAM.md) describes the process and the boundary between upstream engine code and Blue Pine's product layer. Generic fixes are offered back to Mailflare where they fit.

## Documentation

- [Deployment and configuration](docs/deployment.md)
- [Self-hosting with Docker](docs/self-hosting.md)
- [API and integrations](docs/api.md)
- [Email assistant and MCP](docs/email-assistant-and-mcp.md)
- [Spam protection](docs/spam-protection.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

Blue Pine Solutions Mail is free software under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [LICENSE](LICENSE) and [NOTICE](NOTICE). If you run a modified version for others over a network, the AGPL requires you to offer them its source.
