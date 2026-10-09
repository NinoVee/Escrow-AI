# Security model

This document describes what the MVP enforces, how, and its known limitations. It is not a security assessment. An independent assessment is a production requirement (see [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md)).

## Identity and sessions

- **Accounts.** Email/password through Better Auth. Public sign-up is disabled: staff join by an admin invitation, and portal users by an officer's invitation.
- **MFA.**
  - Staff must enroll in TOTP MFA before they can reach any staff page. This is enforced server-side in `requireStaffCtx`.
  - TOTP secrets and backup codes are stored encrypted.
- **Step-up re-authentication.** A fresh TOTP code is required for these actions, within a configurable window (default 10 minutes):
  - creating or revealing bank instructions
  - approving disbursements, bank-instruction changes and reconciliations
- **Sessions.** Sessions last 8 hours and are refreshed every 30 minutes. Cookies are httpOnly and SameSite=Lax, and Secure in production.
- **Rate limits.** Rate-limit storage is in the database:
  - sign-in and TOTP: 10 attempts per 5 minutes (`AUTH_SIGNIN_MAX_ATTEMPTS`)
  - backup codes: 5 attempts per 5 minutes
  - assistant: 30 calls per hour per user
  - extraction: 60 runs per hour per user

## Authorization and tenant isolation

- **One context per request.** Every request builds a `Ctx` (actor, company, role) from the session on the server, never from client input. Every service function calls `requirePermission`, using the matrix in `src/server/authz.ts`, and scopes every query by `companyId`.
- **External participants.** They see data only through a `Participant` row with portal access, plus an explicit `DocumentShare` or thread membership. Shares are revocable immediately.
- **Restricted document types.** Identity and bank-verification documents cannot be shared through the portal at all.
- **Hidden existence.** Unauthorized access to another tenant's or another participant's record returns **not found**, so the record's existence is not revealed.
- **Non-human actors.** System, job, webhook and AI actors have a deliberately narrow permission set. They cannot approve anything, verify or change bank details, release funds, or send email without an enabled rule.
- **Tests.** Isolation is covered in `tests/isolation.test.ts`, with further checks in every other suite.

## Documents

- **Upload checks.** File type is detected from content, not the file name. A size limit applies (`MAX_UPLOAD_MB`).
- **Quarantine.** Every upload is quarantined until a malware scan reports clean. Infected or unscanned files cannot be downloaded or shared.
- **Downloads.** Each download passes an authorization route and then receives a short-lived link bound to the user (presigned S3 URL, or an HMAC-signed local token). Responses are `no-store`.
- **Untrusted content.** Document text is treated as untrusted data:
  - it is fenced in prompts
  - embedded instructions are detected and flagged
  - it can never grant permissions or trigger actions
  - AI output becomes proposals that require human acceptance

## Sensitive data

- **Bank instruction numbers.**
  - Encrypted with AES-256-GCM using `FIELD_ENCRYPTION_KEY`, with a fresh IV each time.
  - Ciphertext is versioned (`v1:<keyId>:…`) and never returned to the client.
  - Numbers are masked by default. Revealing them needs `bank.reveal` and step-up, and every reveal is audited.
- **Redaction.** Logs and audit details are redacted (`src/server/logger.ts`).
- **Messages and email.** Portal messages and outbound email containing routing or account numbers, SSNs or wire-instruction wording are blocked. Email never carries bank details or identity documents.
- **Demo data.** Seed data is entirely fictional and uses reserved example domains.

### Key rotation (field encryption)

The current code reads a single key (`k1`). To rotate:

1. Add the new key (`FIELD_ENCRYPTION_KEY_K2`).
2. Extend `decryptField` to select the key by id.
3. Write new ciphertexts with `k2`.
4. Run a re-encryption job over the `BankInstruction` rows.
5. Retire `k1`.

This procedure is **not implemented yet**. In production, keep keys in a KMS or HSM, not in plain environment files.

## Audit trail

**What is implemented:**

- Every consequential action writes an `AuditEvent` recording actor, actor type, company, file, entity, version, summary, redacted details, IP and user agent.
- Database triggers reject `UPDATE` and `DELETE` on `AuditEvent` and `StageTransition`. Journal entries and lines are immutable in the same way.
- Events are **hash-chained per company**. Each event stores the SHA-256 of its content plus the previous hash, and writes are serialized with an advisory lock. Settings → Audit log verifies the chain.

**What this does not guarantee.** An ordinary database audit table is **not tamper-proof**:

- A database superuser can disable triggers, truncate tables (as the test suite does), or rewrite the whole chain consistently.
- The hash chain detects edits made through normal channels and casual tampering, not a privileged attacker.

Production needs more:

- Ship audit events continuously to write-once storage (S3 Object Lock in compliance mode, or a managed immutable log).
- Periodically anchor chain heads outside the database.
- Restrict superuser access, and alert on trigger changes.

## Web security

- **Response headers:**
  - a strict CSP (`default-src 'self'`; scripts limited to self plus inline, which Next.js needs)
  - `X-Frame-Options: DENY`
  - `nosniff`
  - a strict referrer policy
  - a restrictive permissions policy
- **Request handling.** Server actions use Next.js origin checks. Request bodies are size-limited.
- **Webhooks.** HMAC signatures with timestamp tolerance, compared in constant time. The body size is limited.

## Known limitations

- **CSP.** It allows `'unsafe-inline'` scripts. Moving to nonces is a hardening item.
- **Malware scanning.** The demo scanner detects only EICAR. Production requires ClamAV or a commercial scanner, with signature updates monitored.
- **Rate limits.** Limits are per instance and per IP or user. There is no bot management or WAF.
- **Session management.** Users cannot revoke individual devices from the UI; only an admin deactivating the membership cuts access.
- **Security review.** There has been no penetration test or dependency audit beyond `npm audit`.
- **Backups.** Backups and restores are not configured by this repository (see the production checklist).
