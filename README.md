# EscrowFlow

Administrative workflow support for residential and commercial escrow staff. This is a California pilot. Jurisdiction, transaction type, procedures and approvals are all configurable.

> **What EscrowFlow is not.** It is software used by escrow professionals. It is **not** an escrow company, title insurer, attorney or holder of client funds. Escrow officers stay responsible for every consequential action. EscrowFlow does not move money, does not declare title clear or insurable, gives no legal conclusions, and does not claim regulatory compliance. It does not generate official regulated forms.
>
> **Status.** This is a working MVP with fictional demo data. A successful build does **not** make it production-ready. See [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md).

## Contents

- [Quick start](#quick-start)
- [Demo accounts](#demo-accounts)
- [What it does](#what-it-does)
- [Demo-only behavior, missing live integrations, production requirements](#demo-only-behavior-missing-live-integrations-production-requirements)
- [Deploying to Vercel](#deploying-to-vercel)
- [Commands](#commands)
- [Project layout](#project-layout)
- Documentation:
  - [docs/DEPLOY-VERCEL.md](docs/DEPLOY-VERCEL.md): Vercel deployment
  - [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md): integration setup
  - [docs/SECURITY.md](docs/SECURITY.md): security model
  - [docs/FINANCIAL-CONTROLS.md](docs/FINANCIAL-CONTROLS.md): ledger and payment controls
  - [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md): production checklist
  - [docs/TEST-RESULTS.md](docs/TEST-RESULTS.md): test results

## Quick start

Requirements: Node.js 22+, PostgreSQL 16, Redis 7. Docker is optional and only used for the services.

```bash
# 1. Services (PostgreSQL, Redis, MinIO; add --profile clamav for ClamAV)
docker compose up -d

# 2. Configuration
cp .env.example .env
#    Fill in the three secrets:
#      BETTER_AUTH_SECRET       openssl rand -base64 48
#      DOWNLOAD_SIGNING_SECRET  openssl rand -base64 48
#      FIELD_ENCRYPTION_KEY     openssl rand -base64 32
#    For the demo provider webhooks, also set ESIGN_/RECORDING_/TITLE_WEBHOOK_SECRET
#    (openssl rand -hex 24 each).

# 3. Install, migrate, seed fictional data
npm install                 # also runs `prisma generate`
npm run db:migrate
npm run db:seed

# 4. Run the web app and the background worker (two terminals)
npm run dev                 # http://localhost:3000
npm run worker              # document processing, email delivery, webhooks, automation
```

Without Redis, set `JOBS_MODE=inline`. Background jobs then run inside the web process and you do not need the worker.

To reset the demo data, drop and recreate the database, run `npm run db:migrate`, and then run `npm run db:seed`. The seed refuses to run twice against the same database.

**No AI key?** That is fine. With `ANTHROPIC_API_KEY` empty, document extraction uses a clearly labeled, rule-based **demo adapter** that is not AI. To use Claude, set `ANTHROPIC_API_KEY` (server-side only). You can also set `ANTHROPIC_MODEL`, which defaults to `claude-opus-5-5`.

## Demo accounts

All accounts are fictional and use reserved example domains.

- Password for every account: `EscrowFlow-Demo-2026!`
- Staff accounts are enrolled in MFA with a shared demo authenticator secret. Run `npm run demo:totp` to print the current 6-digit code.

| Email | Role | Company |
|---|---|---|
| admin@goldenoak.example | Company admin | Golden Oak Escrow, Inc. (Demo) |
| officer@goldenoak.example | Escrow officer (Morgan Ellison) | Golden Oak |
| officer2@goldenoak.example | Escrow officer (second approver) | Golden Oak |
| assistant@goldenoak.example | Escrow assistant | Golden Oak |
| accounting@goldenoak.example | Accounting (preparer) | Golden Oak |
| accounting2@goldenoak.example | Accounting (second person) | Golden Oak |
| manager@goldenoak.example | Manager / auditor | Golden Oak |
| officer@harborline.example | Escrow officer | Harbor Line Escrow Services (Demo), a second tenant |
| admin@harborline.example | Company admin | Harbor Line |
| buyer@example.com | Portal: buyer on GOE-2026-0101 | — |
| seller@example.com | Portal: seller on GOE-2026-0101 | — |
| loanofficer@example.net | Portal: lender | — |
| manager@bayline.example.org | Portal: commercial buyer representative | — |

Portal users sign in with a password only. MFA is enforced for staff.

Seeded files:

| File | Type | State |
|---|---|---|
| **GOE-2026-0101** | Residential | Document collection. Includes an amendment that conflicts with the agreement, payoff instructions awaiting verification, an e-signature envelope, email drafts and an approval request. |
| GOE-2026-0102 | Residential | Draft. Its addendum contains an embedded prompt-injection attempt, which is flagged. |
| GOE-2026-0103 | Residential | On hold. |
| GOE-2026-0104 | Residential | Disbursement review. Has a check disbursement pending approval and a simulated recording. |
| **GOE-2026-0201** | Commercial | Earnest money posted, verified wire instructions, a $15,000 wire pending approval, and a provider title order. |
| HLE-2026-0007 | Residential | Belongs to the second tenant. Used for isolation checks. |

## What it does

### Phase 1: core workflow

- **Authentication and access.**
  - Email/password sign-in with **TOTP MFA required for staff**, backup codes and rate limiting.
  - Step-up re-authentication for bank details, disbursement and reconciliation approvals.
  - Tenant-scoped role permissions: company admin, escrow officer, assistant, accounting, manager/auditor, and external participant.
  - Every service function checks permissions on the server. Hiding a button is never the security boundary.
- **Transactions.**
  - Residential and commercial files with properties, parcels, parties and entity signers.
  - Every field change keeps its **field provenance**: source, user and time.
- **Workflow templates.**
  - Versioned residential and commercial templates with stages, tasks, prerequisites and approvals.
  - Publishing a new version never changes existing files.
- **Workflow engine.**
  - Prerequisites are checked inside a locked database transaction, with optimistic concurrency.
  - Overrides need a permission and a justification.
  - Closing rules cannot be overridden: unresolved required tasks, open blockers, incomplete milestones, a non-zero file ledger and unreleased disbursements all block closing.
- **Tasks, deadlines and milestones.** Funding confirmation needs an authorized source, a reference and evidence.
- **Documents.**
  - Private storage with type detection by file content and size limits.
  - Malware-scan quarantine.
  - Short-lived, user-bound download links.
  - Explicit per-participant sharing. Identity and bank-verification documents can never be shared through the portal.
- **Manual title workflow.** Orders, reports, exceptions and dispositions.
- **Participant portal.** Participants see only their own files and explicitly shared items, and can opt out of email notifications.
- **Approvals.**
  - Each approval is bound to a hash of the exact state it covers. A change invalidates it.
  - The requester can never approve their own request.
- **Audit.** Append-only events that are hash-chained per company. See [docs/SECURITY.md](docs/SECURITY.md) for what this does and does not guarantee.

### Phase 2: document intelligence

- **Extraction.** Text extraction, then OCR (through Claude when configured), then schema-validated extraction into **proposals**. Every value cites a page and an excerpt that is checked against the page text.
- **Review.** Proposals need `proposal.review` to accept. AI output never changes authoritative data directly, and conflicts must be confirmed explicitly.
- **Deadlines.** Proposed deadlines are computed deterministically from the acceptance date.
- **Amendment comparison** against the original agreement.
- **Cited assistant.**
  - Answers come only from documents the user may see, and citations are verified.
  - Message drafts are never sent automatically.
- **Prompt-injection defenses.**
  - Document text is fenced as untrusted data.
  - Embedded instructions are flagged and ignored.
  - Model output is re-validated, and extra fields or actions are dropped.

### Phase 3: financial workspace

- **Internal tracking ledger.**
  - Integer cents throughout.
  - The database enforces one-sided lines and balanced entries.
  - Entries are immutable; corrections are made by reversal.
  - Idempotency keys prevent double posting, and no escrow file can be overdrawn.
- **Draft settlement statement.** Exact prorations and explicit rounding. It is clearly labeled a draft estimate, not an official statement.
- **Bank reconciliation.** Idempotent CSV imports, auto-matching, and three-way reconciliation (bank, book, sum of files). A different reviewer approves with step-up.
- **Bank instructions.**
  - Encrypted at rest with AES-256-GCM, versioned and masked.
  - Revealing the full numbers needs a permission and step-up, and is audited.
  - Instructions must be verified independently, by a different person, through an approved method.
- **Disbursements.**
  - Each approval is bound to the amount, payee and instruction version, and is invalidated when any of them changes.
  - Preparer and approver must be different people.
  - **Payment execution is disabled.** A release is only *recorded* after it has been executed in the bank's own system.

### Phase 4: integrations and automation

- **Integration registry.** Every integration shows *Not configured*, *Demo*, *Sandbox* or *Live*. An integration cannot be set to Live unless an implemented adapter has credentials.
- **Durable jobs.**
  - `JobRun` rows hold each job's idempotency key, status, attempts, last error and replay count. BullMQ handles retries with exponential backoff.
  - A job is marked DEAD after its maximum attempts.
  - Administrators can replay failed jobs safely.
  - Handlers are idempotent and scoped to the job's company.
- **Webhooks.**
  - HMAC-signed with timestamp tolerance.
  - Stored before processing, and unique per provider event, so duplicates are acknowledged without reprocessing.
  - Out-of-order events are detected by timestamp and status rank, and marked stale.
- **Email.**
  - **External sending is off by default.** It needs both the server switch and the company setting.
  - Each message needs approval by a person with send authority, who cannot be the requester.
  - Bank details and SSNs are blocked even after approval. Recipients without email, or who opted out, are suppressed.
  - An atomic claim prevents double sending.
- **Automation rules.**
  - Deterministic rules, **all off by default**: deadline reminders, document-request reminders, weekly status, document-ready notices, and internal overdue escalations.
  - "Send automatically" requires a template approved by someone other than its editor. Editing a template resets its approval.
- **Demo provider adapters.** Title orders and reports, property data, recorded-document index, e-signature and e-recording. Simulated outputs are labeled everywhere.
  - **A simulated signature is not a legally completed e-signature.**
  - **A simulated recording response is not proof of recording.**
- **Accounting export.** Journal CSV.

## Demo-only behavior, missing live integrations, production requirements

**Demo-only. Never treat these as real:**

- The **demo AI adapter**, used when no `ANTHROPIC_API_KEY` is set. It is rule-based pattern matching, not AI.
- **Demo malware scanner** (`MALWARE_SCANNER=demo`): it detects only the EICAR test string. Use ClamAV (`MALWARE_SCANNER=clamav`) or another real scanner.
- **Local disk storage** (`STORAGE_DRIVER=local`). Production needs private S3-compatible storage with encryption, versioning and object lock.
- **Demo provider adapters** for title, property data, recorded documents, e-signature and e-recording. Their outputs are simulated. "Simulate next event" buttons appear only for demo records.
- **Demo email outbox.** Approved emails are captured and never delivered unless SMTP is configured *and* both sending switches are on.
- **Demo accounts and the shared TOTP secret.** Never create them in production.
- **Fictional seed data.** No real people, properties, identity documents or bank accounts are used.

**Live integrations that are missing.** Only interfaces exist. A live adapter needs a vendor agreement that includes API access and the vendor's official documentation:

- E-signature (e.g. DocuSign, Dropbox Sign).
- Title order platforms (e.g. Qualia; the company's title provider channel).
- Property data and recorded-document research (e.g. ATTOM, First American DataTree).
- E-recording (e.g. Simplifile / CSC).
- Bank feeds and positive pay. Statements arrive by CSV import only.
- Trust-accounting system sync. Export is by CSV only.
- **Payment execution is deliberately not implemented.**

**Implemented live adapters,** using public standard protocols:

- Anthropic API: extraction, OCR, assistant.
- SMTP: email, with both switches still required.
- S3-compatible storage.
- ClamAV (clamd INSTREAM).

The Anthropic adapter is implemented and unit-tested with mocks, but it was **not exercised against the live API** in this build environment because no key was available.

**Production requirements** are listed in [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md). They include:

- jurisdiction-specific professional review
- trust-accounting validation
- a security assessment
- backup restoration drills
- vendor agreements
- integration credentials
- WORM audit storage
- key management

## Deploying to Vercel

The app is ready to deploy on Vercel with a hosted PostgreSQL database and a private S3-compatible bucket. Redis and a worker are not needed: background jobs run right after each response, and a Vercel Cron job retries failures and runs automation rules.

`npm run vercel-build` checks the configuration, applies migrations on production builds, and builds the app. Full steps, environment variables and limits (4 MB uploads, no ClamAV) are in [docs/DEPLOY-VERCEL.md](docs/DEPLOY-VERCEL.md).

**Turn on Vercel Deployment Protection.** The demo accounts' credentials are published in this README.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `npm run build` / `npm start` | Next.js dev server / production build / production server |
| `npm run worker` | Background worker (BullMQ). Also runs the automation scheduler every 15 minutes. Not used on Vercel. |
| `npm run vercel-build` | Vercel build: environment check, migrations (production), `next build` |
| `npm run typecheck` | TypeScript |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit and integration tests. Uses the `escrowflow_test` database, migrated automatically. |
| `npm run test:e2e` | Playwright end-to-end tests. Needs a running, freshly seeded app on :3000 and the worker. Set `AUTH_SIGNIN_MAX_ATTEMPTS=200` on the server, because the suite signs in many times. |
| `npm run db:migrate` / `npm run db:seed` | Apply migrations / load fictional data |
| `npm run demo:totp` | Print the current demo MFA code |

## Project layout

```
prisma/                schema, migrations (with hand-written DB triggers), seed + fixtures
src/app/(staff)/       staff UI: dashboard, transactions workspace, approvals, reconciliation, settings
src/app/portal/        participant portal
src/app/api/           auth, document downloads, signed file links, webhooks, CSV export
src/server/            server-only code
  auth/                Better Auth config, sessions, step-up
  workflow/            template schema, engine, closing rules
  services/            domain services (every function takes a Ctx and checks permissions)
  ai/                  provider abstraction, Anthropic + demo adapters, prompts, pipeline
  ledger/              journal, prorations, settlement math
  integrations/        registry, provider interfaces + demo adapters, webhooks, email
  jobs/                queue, runner, handlers
tests/                 Vitest suites;  e2e/  Playwright specs
docs/                  documentation and screenshots
```

Stack:

- Next.js 16 (App Router), React 19, TypeScript, Tailwind 4
- PostgreSQL with Prisma 7
- Better Auth (TOTP 2FA)
- BullMQ / Redis
- Anthropic SDK
- Vitest, Playwright
