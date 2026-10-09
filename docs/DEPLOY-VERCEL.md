# Deploying to Vercel

EscrowFlow can run on Vercel. It needs only a hosted PostgreSQL database, plus optional private S3-compatible storage. It does not need Redis or a worker.

> **Read this before you deploy.**
> - **Deployments are reachable from the internet.** Turn on **Deployment Protection** (Vercel Authentication or password protection) for every environment until the [production-readiness checklist](PRODUCTION-READINESS.md) is complete.
> - **The demo accounts are public knowledge.** If you seed demo data, its accounts use the password and shared MFA secret published in this repository, so anyone who can reach the site can sign in.
> - **Use fictional data only.** Do not upload real client documents, and do not connect real funds.
> - **Keep sending off.** Leave `EXTERNAL_SEND_ENABLED=false` unless you have explicitly decided to send real email.

## How the app runs on Vercel

| Concern | Self-hosted | On Vercel |
|---|---|---|
| Background jobs (document processing, email, webhooks) | BullMQ worker (`npm run worker`) | **Deferred mode.** Jobs run in the same function right after the response is sent (Next.js `after`). The default when `VERCEL=1`. |
| Retries, stalled jobs, automation rules | Worker and its scheduler | **Vercel Cron** calls `/api/cron/jobs`, authenticated with `CRON_SECRET`. |
| Document storage | Local disk or S3 | **`database`** stores documents privately in PostgreSQL; simplest, good for demos. **`s3`** uses an S3-compatible bucket; recommended for real volumes. The build fails with `STORAGE_DRIVER=local`. |
| Database connections | Pool of 10 | Pool of 3 per function instance (`DB_POOL_MAX`). Use a **pooled** connection string. |
| Migrations | `npm run db:migrate` | Applied by the build on **production** deployments. Previews skip them. |
| Upload size | `MAX_UPLOAD_MB` (default 25) | Capped at **4 MB**, because Vercel Functions reject larger request bodies. |
| Malware scanning | ClamAV | No clamd on Vercel. See [Limitations](#limitations). |

The build command (`npm run vercel-build`, set in `vercel.json`) checks the environment first. It stops with a clear list of anything missing, then runs migrations when appropriate, then runs `next build`.

## 1. Provision services

1. **PostgreSQL 16+.** Any hosted Postgres works, for example Neon, Supabase, AWS RDS, or a Postgres integration from the Vercel Marketplace. You need two connection strings:
   - **Pooled**, for the app (`DATABASE_URL`). With pgBouncer, transaction mode is fine: the app uses only transaction-scoped advisory locks.
   - **Direct**, unpooled, for migrations (`DIRECT_DATABASE_URL`).

   The migrations create triggers and constraint triggers, so the migrating role must own the tables. A normal database owner can do this; no superuser is needed.
2. **Optional: an S3-compatible bucket**, for example AWS S3 or Cloudflare R2. You can skip this and use `STORAGE_DRIVER=database`, which keeps documents in Postgres. That's fine for a demo, but it grows the database and isn't meant for production volumes. If you do use a bucket:
   - Keep it **private**: block public access.
   - Turn on default encryption and versioning.
   - Create an access key limited to that bucket (`GetObject`, `PutObject`, `DeleteObject`, `HeadObject`).
   - Downloads use short-lived presigned URLs, so the bucket does not need CORS.
3. **Optional: an Anthropic API key**, for real AI extraction and OCR. Without one, the clearly labeled demo adapter is used.

Put the Vercel functions' region close to the database (Project Settings → Functions → Region). Every request talks to Postgres several times.

## 2. Create the Vercel project

Import the Git repository in Vercel. The framework is detected as Next.js, and `vercel.json` sets the build command and cron job. Leave the root directory as the repository root.

## 3. Environment variables

Set these in Project Settings → Environment Variables. Use separate values for Production and Preview: previews should use their own database and bucket.

**Required:**

| Variable | Value |
|---|---|
| `DATABASE_URL` | Pooled PostgreSQL URL |
| `DIRECT_DATABASE_URL` | Direct PostgreSQL URL, used by migrations |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 48` |
| `DOWNLOAD_SIGNING_SECRET` | `openssl rand -base64 48` |
| `FIELD_ENCRYPTION_KEY` | `openssl rand -base64 32`. This encrypts bank details; **back it up**, because data encrypted with it cannot be recovered without it. |
| `STORAGE_DRIVER` | Leave unset to use `database`, the default on Vercel. Set `s3` to use a bucket (variables below). |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Only for `s3`: your bucket |
| `S3_ENDPOINT` | Only for `s3`. Leave empty for AWS. Set it for R2, MinIO and similar. |
| `S3_FORCE_PATH_STYLE` | Only for `s3`. `false` for AWS. Usually `true` for MinIO. |
| `CRON_SECRET` | `openssl rand -hex 32`. Vercel Cron sends it automatically. Without it, failed jobs are not retried and automation rules never run. |

**Recommended or optional:**

| Variable | Default and notes |
|---|---|
| `APP_URL` | Set it to your custom domain, e.g. `https://escrow.example.com`. If unset, the Vercel production domain is used, and previews use their own deployment URL. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT`, `OCR_PROVIDER` | See [INTEGRATIONS.md](INTEGRATIONS.md) |
| `MALWARE_SCANNER` | `demo` (labeled, EICAR only) or `none`, which keeps every upload quarantined |
| `EXTERNAL_SEND_ENABLED` | `false`. Keep it off unless you intend to send real email. |
| `SMTP_*` | Only if you will send email |
| `ESIGN_WEBHOOK_SECRET`, `RECORDING_WEBHOOK_SECRET`, `TITLE_WEBHOOK_SECRET` | `openssl rand -hex 24` each. Needed for the demo provider simulations. |
| `SEED_DEMO_DATA` | `true` loads the **fictional** demo data on the next production build. It is skipped if the data already exists. Remove it afterwards. The demo passwords are public, so use it only with Deployment Protection on. |
| `MIGRATE_ON_BUILD` | Default: `true` for production builds, `false` for previews. Set `true` on a preview only if it has its own database. |
| `DB_POOL_MAX` | `3` on Vercel |
| `JOBS_MODE` | Leave unset; Vercel uses `deferred`. `queue` requires a BullMQ worker hosted elsewhere, pointed at the same database and Redis. |

Do **not** set `REDIS_URL` unless you also run an external worker with `JOBS_MODE=queue`.

## 4. Deploy

Deploy from the Vercel dashboard or by pushing to the production branch. In the build log, check for these lines:

- `warning: …` lines about anything you have not configured yet
- `> npx prisma migrate deploy` (production only), followed by the migration result
- `✓ Compiled successfully`

## 5. Create the first accounts

There is no public sign-up.

- **Demo deployment, easiest way.** Add `SEED_DEMO_DATA=true` to the Production environment and redeploy. The build applies the migrations and then loads the demo data. Remove the variable afterwards.
- **Demo deployment, from your machine.** Run the seed against the deployed database and bucket. Only do this on a protected deployment (see the warning at the top).

  ```bash
  DATABASE_URL="<direct url>" STORAGE_DRIVER=s3 S3_BUCKET=… S3_REGION=… \
  S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… FIELD_ENCRYPTION_KEY="<same as Vercel>" \
  BETTER_AUTH_SECRET="<same as Vercel>" DOWNLOAD_SIGNING_SECRET="<same as Vercel>" \
  npm run db:seed
  ```

  `FIELD_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` must match the deployment exactly. The seed encrypts bank details and MFA secrets with them.
- **Real company.** Do not seed. Create the company and its first administrator with a one-off script run against the database, then invite everyone else from Settings → Users. Writing this bootstrap script is part of the production checklist.

## 6. Verify

1. Sign in, then open **Settings → Jobs**. The mode should read *deferred*.
2. Upload a small PDF to a file. The document page shows "Processing document" and refreshes by itself when proposals are ready.
3. **Settings → Integrations** should show the expected Demo, Live or Not configured labels.
4. In the Vercel dashboard, open **Cron Jobs** and run `/api/cron/jobs` once. It should return a JSON summary. To check it from a terminal:

   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/cron/jobs
   ```

## Cron schedule

`vercel.json` runs the sweep **once a day** (`45 14 * * *`, about 7:45 AM Pacific). Every Vercel plan accepts that schedule. Vercel's Hobby plan has historically limited cron jobs to once a day, so check your plan's current limits. The once-a-day schedule means:

- Each job's first attempt still runs immediately after the request. The sweep only retries failures and recovers stalled jobs, so on a daily schedule a failed job waits up to a day.
- Automation rules (reminders, escalations) run once a day.

On a plan that allows it, run more often by changing the schedule to `*/15 * * * *`. Automation runs are de-duplicated per 15-minute window, so a more frequent schedule never sends duplicates.

## Limitations

- **Uploads are capped at 4 MB.** Larger scanned packages need direct-to-S3 uploads with presigned POSTs. That is not implemented yet.
- **No real malware scanning on Vercel.** `demo` detects only the EICAR test string. For real scanning, use a scanning service, or a ClamAV instance reachable from Vercel (`MALWARE_SCANNER=clamav`, `CLAMAV_HOST`, `CLAMAV_PORT`), or a bucket-side scanner. Then mark files clean through an integration; that integration is not implemented.
- **Function duration.** Deferred jobs share the request function's time limit. A very long AI extraction can be cut off. The job is then left RUNNING, retried by the next sweep after 10 minutes, and marked DEAD after its attempts run out. Retry it from Settings → Jobs.
- **Rate limits** are stored in the database and are per IP. There is no WAF or bot protection. Consider Vercel Firewall rules.
- **Logs** go to Vercel's function logs. Ship them to your log platform and set alerts (DEAD jobs, signature failures, audit-chain breaks).

None of this changes the conclusion of the [production-readiness checklist](PRODUCTION-READINESS.md): a working deployment is not a production-ready one.
