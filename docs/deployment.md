# Deployment and configuration

This guide covers deploying Blue Pine Mail to Cloudflare Workers, runtime configuration, database migrations and backups, versions and updates, and source provenance. For a Docker or Node deployment on your own server, see [self-hosting](self-hosting.md).

## Overview

1. **Deploy the Worker** to your Cloudflare account, with the Worker named `mailflare` and a runtime `CF_TOKEN`.
2. **Complete setup:** open the deployed app and follow `/setup` to check the installation and create the first admin account.
3. **Connect your domain:** add a domain managed by the same Cloudflare account. Blue Pine Mail configures Email Routing and, when selected, Email Sending before helping you create the first mailbox.

The Worker name must stay `mailflare`. It is a compatibility name: `CF_EMAIL_WORKER_NAME`, the Worker `name` and `services[].service` for `WORKER_SELF_REFERENCE` in `wrangler.jsonc` must all agree, and Email Routing rules target it.

Before starting, create the `CF_TOKEN` described below.

## Step 1: Deploy the Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bofa-ds/mailflare)

The button deploys this repository.

1. Click **Deploy to Cloudflare** and sign in if prompted.
2. Choose the Cloudflare account that owns the domain you want to use.
3. Set the app name to exactly `mailflare`.
4. Add `CF_TOKEN` when Cloudflare asks for the app's runtime variables or secrets.
5. Start the deployment and wait for Cloudflare to provision and deploy the Worker.

### Required configuration

- `CF_TOKEN`: a scoped Cloudflare API token with **Zone Read**, **DNS Edit**, **Email Routing Edit** and **Email Routing Rules Write** access for the domains you will connect. Add **Email Sending Edit** to send mail; it is optional for receive-only domains. DNS Edit lets the confirmed setup flow replace conflicting MX records.

The deploy flow's own token is not passed to the app at runtime, so create `CF_TOKEN` separately. Paste only the token secret, without `Bearer`, and not the token ID. The token must belong to the same account as the domains you connect.

### Optional configuration

| Name | Purpose |
| --- | --- |
| `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Bot protection on login and first-run registration |
| `BLUEPINE_DISABLED_FEATURES` | Comma-separated features to turn off for this deployment: `customBranding`, `multipleAccounts`, `sharedMailboxes`, `accountForwarding`, `gravatar`. All are on by default. |
| `BLUEPINE_BUILD_COMMIT` | The Blue Pine commit this deployment was built from; see [Source and build provenance](#source-and-build-provenance) |
| `BLUEPINE_RELEASE_REPOSITORY` | `owner/repository` to check for approved releases instead of the default Blue Pine repository |
| `AI_MODEL` | Workers AI model for the email assistant |

## Step 2: Complete setup

1. Open the URL of the deployed `mailflare` Worker.
2. Go to `/setup` if you are not taken there automatically.
3. Let setup check the required Cloudflare configuration and initialize the empty D1 database.
4. Create the first admin account.

Setup applies the committed migrations through the Worker's D1 binding before creating the admin account. Registration closes once an admin exists.

## Step 3: Connect your primary domain

1. Enter a domain that uses Cloudflare DNS on the same account as `CF_TOKEN`.
2. Continue while Email Routing and the routing and sending DNS are configured.
3. Choose the address for your first mailbox and finish setup.
4. Open the inbox and send a test message to the new address.

To connect more domains later, open **Admin → Domains** and select **New domain**.

---

## Manual deployment

Install dependencies, configure the Cloudflare bindings in `wrangler.jsonc` (start from `wrangler.jsonc.example`), and run:

```bash
npm install
npm run deploy
```

This builds with vinext and uploads the complete Worker with Wrangler. The Cloudflare Vite plugin generates `dist/server/wrangler.json` and redirects Wrangler to that build. It does not modify D1. The complete Worker is required because `worker.ts` also handles inbound email, queues, scheduled backups and the real-time Durable Object.

To record the exact source of a deployment, set `BLUEPINE_BUILD_COMMIT` to the commit you deployed (for example as a Worker variable, from `git rev-parse HEAD`).

## Database migrations

Deployment and database migration are separate. After a new build is deployed, open **Admin → Version and updates**. It shows whether the database matches this build; select **Update database** to apply pending migrations through the Worker's D1 binding. The same runner initializes a new database during setup.

If the Cloudflare dashboard has a custom deploy command containing `wrangler d1 migrations apply DB --remote`, remove that part and use `npm run deploy`.

For manual recovery, pending migrations can be applied with `npm run db:migrate:remote`. It needs the target account's `database_id` in your local `wrangler.jsonc`; do not commit an account-specific database ID.

Each migration and its `d1_migrations` history entry run in one D1 batch. If a migration fails, its changes are rolled back, the failed filename is shown, and it can be retried after the problem is corrected.

New builds must stay compatible with the previous schema until an administrator applies their migrations: prefer additive changes, keep old columns during the transition, and avoid making authentication or the admin pages depend immediately on a new column. Migrations follow upstream Mailflare's history exactly; see [UPSTREAM.md](../UPSTREAM.md) before adding one.

## Database backups

Backups export the D1 records as JSON into the configured R2 bucket. A cron trigger in `wrangler.jsonc` runs daily at 02:00 UTC and applies the schedule chosen under **Admin → Backups**. Manual backups run the same export from the admin API. The backup format is shared with upstream Mailflare, so backups restore in either direction.

Backups contain database records only; raw messages and attachments stay in R2. Keep your own copy of the R2 bucket if you need full disaster recovery. Deploy the complete Worker with `npm run deploy` whenever the cron trigger changes.

Installations that predate the cron-based backups can remove the old Workflow with `npx wrangler workflows delete mailflare-database-backup` once the cron trigger is active. This deletes its historical Workflow instances; backup files in R2 and the backup history are unaffected.

## Email assistant and MCP

The assistant uses the Workers AI `AI` binding and a separate `mailflare-agent` queue. Provision the queue before deploying a configuration that declares it. The five-minute cron recovers pending auto-draft work; the 02:00 UTC cron runs backups. See [Email assistant and MCP](email-assistant-and-mcp.md) for configuration.

## Versions and updates

Three things identify what is running, and **Admin → Version and updates** and the **About** page show them:

- **Blue Pine Mail version**: the distribution's own version.
- **Mailflare base**: the upstream version this build is based on. It is not a Blue Pine version and is never offered as an update.
- **Build commit**: the exact Blue Pine commit, when the deployment records `BLUEPINE_BUILD_COMMIT`.

New versions reach installations this way:

1. Blue Pine integrates upstream Mailflare changes on a separate branch, then reviews and tests them.
2. A tested commit is published as a GitHub Release tagged `bluepine-vMAJOR.MINOR.PATCH` in the Blue Pine repository. Drafts and prereleases are not considered.
3. Each installation's **Version and updates** card reports when such a release is newer than the installed version. It only checks; it never installs.
4. You deploy the release with the method your installation uses (for example `npm run deploy` from the release tag), then apply any pending migrations.

If GitHub cannot be reached, the release source is private or no releases exist, the card says so and everything else keeps working. Set `BLUEPINE_RELEASE_REPOSITORY` to check a different `owner/repository`. Installations never update themselves from upstream Mailflare.

## Source and build provenance

Blue Pine Mail is licensed under the GNU Affero General Public License v3.0 or later. The app offers its source to everyone who uses it:

- `/about` shows the product, distributor, version, Mailflare base, build commit, license and the upstream attribution.
- `/source` redirects to the source of the running build: `https://github.com/bofa-ds/mailflare/tree/<commit>` when `BLUEPINE_BUILD_COMMIT` holds a valid commit SHA, otherwise the repository itself.

Every page links to **Source** and **About** in the sidebar footer and on the sign-in screens. Set `BLUEPINE_BUILD_COMMIT` on production deployments so the source link points at exactly what is running. It is not needed for development.
