# Integration setup

To see what is actually running, open **Settings → Integrations**. Every integration shows one mode:

| Mode | Meaning |
|---|---|
| **Not configured** | Unavailable. Actions that need it are refused. |
| **Demo** | Simulated, clearly labeled output. It is never real data and never reaches a real provider. |
| **Sandbox** | The provider's test environment, with real credentials. |
| **Live** | The real provider. |

The mode shown is the *effective* mode, computed from the server configuration. An administrator can request a mode for vendor integrations and for email, but the request is refused when no implemented adapter has the required credentials.

## Ground rules

- **No invented endpoints.** EscrowFlow ships live adapters only where the protocol is public and standard: the Anthropic API, SMTP, S3 and clamd.
- **Vendor APIs ship as interfaces plus Demo adapters.** This covers title platforms, property data, e-signature, e-recording and banking. A live adapter must be written from the vendor's official API documentation.
- **A subscription is not API access.** Many vendor subscriptions do not include API access. Confirm API access and terms in writing before building an adapter.
- **No scraping.** Do not scrape restricted portals (county recorders, title plants, bank portals).
- **No payment execution.** Payment execution is intentionally absent. `disabledPayments.execute()` always throws.
- **Credentials stay out of the database and the browser.** All credentials live in server environment variables. Use a secrets manager in production.

## Implemented live adapters

### Anthropic API (document extraction, OCR, assistant)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Enables the live provider. Used server-side only. |
| `ANTHROPIC_MODEL` | Model id. Default `claude-opus-5-5`. |
| `ANTHROPIC_EFFORT` | `low` / `medium` / `high`. Default `medium`. |
| `AI_PROVIDER` | `auto` (default) uses Anthropic when a key is set. `demo` forces the demo adapter. |
| `OCR_PROVIDER` | `anthropic` sends scanned PDFs and images to Claude for transcription. `none` disables OCR. |

How the adapter behaves:

- Uses structured outputs with zod schemas and server-side refusal fallbacks.
- Document text is wrapped in a per-request nonce fence and treated as untrusted data.
- Every response is re-validated by application code. Values are re-parsed, excerpts must appear in the page text, and unknown fields are dropped.
- Calls are rate-limited per user: 30 assistant calls and 60 extractions per hour.

Before using it with real documents, review your data-processing terms with Anthropic. Decide whether client documents may be sent to the API under your retention and confidentiality obligations.

### SMTP (email)

| Variable | Purpose |
|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Relay settings |
| `EXTERNAL_SEND_ENABLED` | Server kill switch. Default `false`. |

Configuring SMTP does not send anything by itself. Mail leaves the system only when **all** of the following hold:

1. SMTP is configured, and the Email integration is set to Sandbox or Live in Settings → Integrations.
2. `EXTERNAL_SEND_ENABLED=true` on the server **and** "Allow external email sending" is on in Settings → Company.
3. The message was approved by a person with `comms.approve_send` who is not the requester. Alternatively, an enabled rule in "send automatically" mode generated it from an approved template.
4. The content passes the sensitive-data check. Routing or account numbers, SSNs, wire-instruction wording and long numeric identifiers are blocked.
5. The recipient has an email address and has not turned off email notifications in the portal.

Use a sandbox relay (Mailpit, or your provider's test mode) before going live. Every email carries a stable Message-ID, so a relay can de-duplicate retries.

### Database storage

`STORAGE_DRIVER=database` keeps document bytes in a private PostgreSQL table. Downloads use the same user-bound, short-lived signed links as local disk. It needs no extra service, which makes it the simplest choice for demos and serverless hosts. It grows the database and its backups, so use S3 for production volumes.

### S3-compatible storage

Set `STORAGE_DRIVER=s3` with `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_FORCE_PATH_STYLE`. `docker-compose.yml` includes MinIO for local testing.

For production storage:

- Keep the bucket private.
- Turn on server-side encryption, versioning and, for retained records, object lock.
- Downloads use short-lived presigned URLs (`DOWNLOAD_LINK_TTL_SECONDS`, default 60) issued after an authorization check.

### ClamAV

Set `MALWARE_SCANNER=clamav`, plus `CLAMAV_HOST` and `CLAMAV_PORT`. Run `docker compose --profile clamav up -d` to start a local clamd.

- With `MALWARE_SCANNER=none`, every upload stays quarantined.
- With `demo`, only the EICAR test string is detected. That is **not** real protection.

## Demo adapters and how to replace them

Interfaces live in `src/server/integrations/providers.ts`:

| Kind | Interface | Demo adapter | Candidate vendors (interface only, not implemented) |
|---|---|---|---|
| Title orders | `TitleOrderProvider` | `demoTitle`: simulated order number and a PDF stamped "SIMULATED, NOT A TITLE REPORT" | Qualia; your title company's ordering channel |
| Property data | `PropertyDataProvider` | `demoProperty`: fictional owner and characteristics | ATTOM, First American DataTree |
| Recorded documents | `RecordedDocumentsProvider` | `demoRecordedDocs` | First American DataTree |
| E-signature | `ESignProvider` | `demoESign`: simulated envelopes | DocuSign eSignature, Dropbox Sign |
| E-recording | `RecordingProvider` | `demoRecording`: simulated submissions | Simplifile / CSC eRecording |
| Payments | `PaymentExecutionProvider` | `disabledPayments`: always throws | Intentionally none in the MVP |

To add a live adapter:

1. Obtain a vendor agreement that includes API access, plus sandbox credentials and the official API documentation.
2. Implement the interface in a new module. Read credentials from the environment and never log them.
3. Add the provider to `CATALOG` in `src/server/integrations/registry.ts` with `liveImplemented: true` and its `requiredEnv`, and return the right mode from `integrationStatuses`.
4. Route the service functions in `src/server/services/integrations.ts` to the adapter for Sandbox and Live modes.
5. Verify the vendor's own webhook signatures natively (see below), then call `storeAndQueue`.
6. Add tests for each of these cases:
   - success
   - provider errors and timeouts
   - retries
   - duplicate webhooks
   - out-of-order webhooks
   - tenant scoping
7. Run against the vendor sandbox before requesting Live.

Even in Live mode, these limits remain:

- **Signatures.** A provider's "completed" status creates a *review task*. It does not complete the signing milestone; an officer confirms every signature.
- **Recording.** A provider's "recorded" status creates a task to confirm the recorded document. The instrument number shown is the provider's claim, not proof.
- **Title.** Title data is never treated as clearing title. Title exceptions extracted from a report arrive as proposals for review.

## Webhooks

Endpoint: `POST /api/webhooks/{provider}`. Current providers are `esign-demo`, `recording-demo` and `title-demo`.

| Variable | Provider |
|---|---|
| `ESIGN_WEBHOOK_SECRET` | `esign-demo` |
| `RECORDING_WEBHOOK_SECRET` | `recording-demo` |
| `TITLE_WEBHOOK_SECRET` | `title-demo` |

Each secret must be at least 16 characters. If a secret is missing, the endpoint returns 503.

Signature header:

```
x-escrowflow-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

Body:

```json
{ "id": "evt_123", "type": "envelope.status", "occurredAt": "2026-10-08T17:00:00Z",
  "data": { "externalId": "DEMO-ENV-1A2B3C4D", "status": "DELIVERED" } }
```

Processing:

1. **Verification.** The signature is checked in constant time. Timestamps more than 5 minutes off are rejected (401), as are unknown providers (404) and bodies over 256 KB (413).
2. **Storage.** The event is stored first, unique on `(provider, event id)`. A duplicate gets `200 {"duplicate": true}` and is not reprocessed.
3. **Queueing.** Processing runs as a durable `webhook.process` job.
4. **Ordering.** An event older than the record's last event, or with a lower status rank, is marked **STALE** and not applied. Status ranks are: envelope `CREATED < SENT < DELIVERED < COMPLETED|DECLINED|VOIDED`.
5. **Unknown references.** Events for unknown references are marked **IGNORED**.

In Demo mode, **Simulate next event** buttons sign a payload with the real secret and send it through this same path.

Production checklist for webhooks: rotate secrets, restrict source IPs where the vendor publishes them, and alert on rejected-signature spikes.

## Background jobs

- **Modes:**
  - `JOBS_MODE=queue` (the default when `REDIS_URL` is set) uses BullMQ, and you must run `npm run worker`.
  - `JOBS_MODE=deferred` (the default on Vercel) runs each job right after the response is sent. A scheduled sweep (`/api/cron/jobs`, protected by `CRON_SECRET`) retries failed jobs with exponential backoff, recovers stalled ones and runs the automation rules. See [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md).
  - `JOBS_MODE=inline` runs jobs before the response returns. Use it for tests or a single-process demo.
- **Job types:**
  - `document.process`: text, OCR and extraction
  - `email.send`
  - `webhook.process`
  - `automation.company`: scheduled every 15 minutes per company with enabled rules, with a time-window idempotency key
- **Reliability.**
  - Each job has an idempotency key, so it is created once.
  - Failed attempts retry with exponential backoff (5 s base).
  - After `maxAttempts` the job is marked **DEAD**.
  - A claim step prevents two workers from running the same job.
- **Payloads** carry ids only, never secrets or document contents. Handlers take the company from the `JobRun` row, never from the payload.
- **Monitoring.** **Settings → Jobs** shows counts by status, last errors, replay history and recent webhook events. **Replay** re-queues a FAILED or DEAD job. It is safe because every handler is idempotent and re-checks its gates; for example, email re-checks approval and both switches, and uses an atomic `APPROVED → SENDING` claim.
- **Production.** Run at least two worker replicas. Alert on DEAD jobs and on queue depth, and back Redis with persistence (AOF).

## Bank statements and accounting export

- **Bank statements.** Upload the CSV exported from your bank under Reconciliation.
  - Columns: date, description, amount (or debit/credit), and an optional bank reference.
  - A re-imported file is recognized by its SHA-256 hash.
  - Overlapping rows are recognized by bank reference, or by a derived id when the bank gives none.
- **Accounting export.** Settings → Integrations → *Download journal CSV* (`GET /api/exports/journal?from=YYYY-MM-DD&to=YYYY-MM-DD`). This needs `ledger.read`. The export is audited.
