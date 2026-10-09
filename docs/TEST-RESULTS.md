# Test results

These results were recorded on 2026-10-09 against the commit that adds this file. Environment:

- Linux container, Node.js 22.22
- PostgreSQL 16 and Redis 7, run locally
- Chromium (Playwright)
- AI in demo mode (no `ANTHROPIC_API_KEY`)
- external sending off

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **Pass** (0 errors) |
| Lint | `npm run lint -- --max-warnings=0` | **Pass** (0 errors, 0 warnings) |
| Unit and integration tests | `npm test` | **134 passed**, 0 failed (10 files) |
| Production build | `npm run build` | **Pass** |
| End-to-end (worker) | `npm run test:e2e` | **29 passed**, 0 failed. Production build, `next start`, BullMQ worker, freshly seeded database. |
| End-to-end (Vercel job mode) | `JOBS_MODE=deferred` server, **no worker** | **29 passed**, 0 failed. Every document, email and webhook job completed through `after()`. |
| Vercel build simulation | `VERCEL=1 npm run vercel-build` | Missing configuration fails with a list (exit 1). A valid preview build skips migrations; a valid production build applies them. Both build successfully. |
| Dependency audit | `npm audit --omit=dev` | 4 high-severity advisories, all transitive (see below) |

Passing these checks shows the implemented behavior works as tested. It does **not** establish production readiness (see [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md)).

## Required test areas and where they are covered

| Requirement | Tests |
|---|---|
| **Cross-tenant isolation** | `isolation.test.ts`: staff cannot see or change another company's transactions or download its documents, and other tenants cannot decide approvals. `ledger.test.ts`: permissions and tenant isolation. `integrations.test.ts`: outbound and simulated provider events are tenant-scoped, and job handlers use the JobRun's company. e2e: other tenants cannot open a staff file. |
| **Participant isolation** | `isolation.test.ts`: external users see only their own transaction; buyer and seller documents stay private from each other; share lists and scan details are hidden; uploads are private; share and portal revocation; thread membership. e2e: buyer and seller portals; the portal at phone width shows only the participant's own file. |
| **Unauthorized downloads** | `isolation.test.ts`: cross-company downloads. `documents-security.test.ts`: download links are short-lived, user-bound and tamper-evident; quarantined files cannot be downloaded or shared; identity and bank documents are never shared to the portal. |
| **Workflow prerequisites and overrides** | `workflow.test.ts`: transitions are blocked until prerequisites are met; overrides need permission and a justification; non-overridable rules hold; no stage skipping; reasons are required; optimistic versioning; concurrent transitions are serialized. |
| **AI proposals requiring acceptance** | `ai.test.ts`: extraction creates cited proposals without touching authoritative data; only reviewers accept; corrections and rejections; amendments create conflicts that must be confirmed; title proposals never disposition exceptions. e2e: accepting proposals; assistants cannot accept. |
| **Prompt injection** | `ai.test.ts`: embedded instructions are flagged and nothing happens; extra keys and actions in model output are ignored; excerpts not in the document are flagged; the Anthropic adapter's fence cannot be closed from inside; invented citations are dropped. e2e: injection warning on the seeded addendum. |
| **Exact arithmetic and balanced entries** | `money.test.ts`: exact parsing, no floating-point drift, explicit rounding, allocation without lost cents. `ledger.test.ts`: balanced integer-cent postings; the database refuses unbalanced, two-sided or edited entries; reversal-only corrections; prorations sum exactly. |
| **Duplicate imports and webhooks** | `reconciliation.test.ts`: same file and overlapping rows are not duplicated. `ledger.test.ts`: idempotency keys post at most once, even concurrently. `integrations.test.ts`: duplicate webhooks are acknowledged without reprocessing; out-of-order events are marked stale; jobs are created once per idempotency key; email is never sent twice. e2e: the webhook endpoint de-duplicates. |
| **Approval invalidation on bank-detail or amount change** | `payments.test.ts`: approval is invalidated when the amount changes; verification and approval are invalidated when bank details change; a change between request and decision is detected. `workflow.test.ts`: a stage approval is invalidated when the file moves. |
| **Preparer/approver separation** | `payments.test.ts`: separate preparer and approver, plus step-up; release recorded by someone other than the preparer; independent bank verification. `reconciliation.test.ts`: a different reviewer, with step-up. `workflow.test.ts`: approvals need a different person. `integrations.test.ts`: the email requester cannot approve; template editor and approver are separated. e2e: approval inbox and disbursement flows. |
| **Closing blocked by unresolved items** | `workflow.test.ts`: closing is blocked by unresolved required tasks (even with an override), open blockers and incomplete milestones. `payments.test.ts`: closing is blocked by unreleased disbursements and a non-zero file balance. e2e: closing stays blocked while the file ledger is not zero. |

Deployment coverage in `deploy.test.ts`:

- public URL derivation (APP_URL, Vercel production domain, preview URL)
- the 4 MB upload cap on Vercel
- the deferred job mode, with its fallback outside a request
- the backoff schedule
- the sweep retrying failed jobs only after backoff, then marking them DEAD
- recovery of lost QUEUED and stalled RUNNING jobs
- automation enqueued once per window
- the cron endpoint requiring its bearer token
- local disk storage refused on Vercel

Additional Phase 4 coverage in `integrations.test.ts`:

- webhook signature rejection: missing, wrong, stale or tampered
- jobs that fail, become DEAD, and are replayed by authorized users only
- outbound email: default off, the company switch, demo capture exactly once, sensitive-content blocking, recipient suppression, unapproved drafts never delivered
- automation: rules off by default, AUTO_SEND requiring an approved template, an edit resetting approval, review-mode drafts once per window, system actors unable to approve, escalations that are internal-only
- integration modes: only the four modes; no Live mode without an implemented adapter
- payment execution disabled

## End-to-end walkthrough (Playwright)

| Spec | What it covers |
|---|---|
| `phase1.spec.ts` (9) | MFA sign-in and wrong-code rejection; list search and filters; workspace prerequisites and provenance; manual file creation; separation of duties in the approval inbox; tenant and portal boundaries; buyer portal at phone width; seller cannot see buyer documents. |
| `phase2.spec.ts` (5) | Amendment conflict confirmation; cited document review with an injection warning; assistant citations; starting a file from an uploaded agreement and accepting proposals (with background processing and auto-refresh); assistants cannot accept proposals. |
| `phase3.spec.ts` (4) | Finances tab with masked bank details and draft statement; disbursement with preparer, a different approver, step-up and recorded release; closing blocked by a non-zero ledger; three-way reconciliation flagging an unmatched bank fee. |
| `phase4.spec.ts` (6) | Integration mode labels and refusal of Live; automation rules and the jobs page; email approval by someone else, blocked while sending is off, sensitive content blocked; demo e-signature advanced by a signed event, creating a review task; webhook endpoint auth and de-duplication; role restrictions and the integrations page at phone width. |
| `walkthrough.spec.ts` (5) | Every tab of the commercial file (desktop and phone width) and the residential file (phone width); empty states on a sparse file (tablet width); dashboard, queues and settings for each staff role; portal at phone width. Every page is checked for error pages and **horizontal overflow**. |

The walkthrough found and fixed three responsive-layout defects:

1. Grid columns grew to fit their content on phones (missing `grid-cols-1`).
2. Long approval-binding hashes didn't wrap.
3. The staff content column had no `min-width: 0`, so wide tables widened the page instead of scrolling inside their container.

Screenshots from the run are in [screenshots/](screenshots/).

## Not covered by automated tests

- **Live Anthropic API.** The adapter is tested with a mock client only, because no key was available. Before relying on extraction, run an evaluation on de-identified documents (checklist item 6.6).
- **Real delivery services.** No tests run against a real SMTP relay, S3/MinIO bucket or ClamAV daemon. The adapters are implemented but were exercised only through configuration; the local disk, demo scanner and demo outbox were used.
- **Load and concurrency** beyond the targeted concurrency tests (transitions and ledger idempotency).
- **Accessibility audit** with assistive technology.
- **Browsers other than Chromium.**

## Dependency audit findings

`npm audit --omit=dev` reports 4 high-severity advisories, all transitive:

- `mysql2` is pulled in by `better-auth` and `prisma`. EscrowFlow uses PostgreSQL only and never loads the MySQL driver.
- `deepmerge-ts` is used by `@prisma/config`, the Prisma CLI configuration loader, at build and migrate time.

The suggested `npm audit fix --force` makes breaking changes to these packages, so it was not applied. Track the upstream fixes, and re-run the audit as part of checklist item 3.8.
