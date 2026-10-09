# Production-readiness checklist

EscrowFlow builds, passes its tests and runs end to end with fictional data. **That does not make it production-ready.** Every item below must be completed and signed off by the named owner before real clients, real documents or real funds are involved. Until then:

- do not deploy it publicly
- do not connect real client funds
- do not send real external messages

The legend for the Status column is:

- ☐ means not started
- ◐ means partly in place in this repository; the remaining work is described in the row

## 1. Jurisdiction-specific professional review

| # | Item | Owner | Status |
|---|---|---|---|
| 1.1 | Review the residential and commercial workflow templates (stages, tasks, prerequisites, deadlines) against California escrow practice and the company's written procedures. | Licensed escrow officer / compliance | ◐ Templates exist and are configurable; not professionally reviewed |
| 1.2 | Legal review of every customer-facing text: portal copy, email templates, disclaimers, and "draft estimate" labels. | Counsel | ☐ |
| 1.3 | Confirm the regulator and licensing posture: EscrowFlow is a software vendor, the company remains the licensed escrow holder. | Counsel / compliance | ☐ |
| 1.4 | Define record-retention periods and legal-hold procedures. The `retentionYearsAfterClose` default of 7 is a placeholder. | Counsel / records | ☐ |
| 1.5 | Review how deadlines are computed (business vs. calendar days, holidays) against the contract forms in use. | Escrow officer / counsel | ◐ Computed deterministically; holiday calendar not implemented |
| 1.6 | Privacy review (CCPA/CPRA notices, data subject requests, vendor data processing terms, including the AI provider). | Privacy counsel | ☐ |
| 1.7 | Confirm that AI-assisted extraction and drafting are acceptable under company policy, with the human-review procedures documented. | Compliance | ☐ |

## 2. Trust-accounting validation

| # | Item | Owner | Status |
|---|---|---|---|
| 2.1 | Decide the system of record. Validate that EscrowFlow's tracking ledger reconciles with it daily. | Controller | ☐ |
| 2.2 | Independent CPA review of the ledger design, reconciliation method and reports against California escrow trust-accounting requirements. | CPA | ☐ |
| 2.3 | Validate proration and settlement math against real closed files and the statements actually issued. | Escrow accounting | ◐ Unit-tested against hand-computed cases only |
| 2.4 | Define the reconciliation cadence, sign-off, exception handling and retention of signed reconciliations. | Controller | ◐ Workflow implemented |
| 2.5 | Bank integration for statements (BAI2/camt.053 or bank API), under the bank's agreement. | Treasury / IT | ☐ CSV import only |
| 2.6 | Keep payment execution outside EscrowFlow, or design and test bank-side dual control and positive pay before enabling any initiation. | Treasury / security | ☐ Execution intentionally disabled |
| 2.7 | Define the wire-fraud procedure: approved callback sources, the verification script and incident response. Train staff on it. | Operations / security | ◐ Controls implemented in software |

## 3. Security assessment

| # | Item | Owner | Status |
|---|---|---|---|
| 3.1 | Independent penetration test and code review, including tenant isolation, portal access, file handling, webhooks and AI prompt injection. | External assessor | ☐ |
| 3.2 | Threat model and data-flow diagram, with data classification for documents, PII and bank data. | Security | ☐ |
| 3.3 | Move secrets and the field-encryption key to a KMS or secrets manager. Implement and test key rotation (see SECURITY.md). | Security / platform | ☐ |
| 3.4 | Write-once audit-log export (e.g. S3 Object Lock in compliance mode) and external anchoring of the hash chain. | Security / platform | ◐ Append-only triggers and hash chain in place; this alone is not tamper-proof |
| 3.5 | Real malware scanning with monitored signature updates. Never run with `MALWARE_SCANNER=demo`. | Platform | ◐ ClamAV adapter implemented |
| 3.6 | Private, encrypted, versioned object storage with lifecycle and object-lock policies. | Platform | ◐ S3 adapter implemented |
| 3.7 | Harden the CSP with nonces. Add a WAF and bot protection. Use distributed rate limiting. | Platform | ☐ |
| 3.8 | Dependency and container scanning in CI. Define a patch cadence. | Engineering | ☐ |
| 3.9 | SSO/SAML for staff, if required. Session/device management UI. Admin access reviews. | Security | ☐ |
| 3.10 | Remove all demo accounts and the demo TOTP secret. Confirm the seed never runs in production. | Engineering | ☐ |
| 3.11 | Logging and monitoring: centralized redacted logs, alerts on DEAD jobs, signature failures, audit-chain breaks and repeated step-up failures. | Platform | ☐ |
| 3.12 | Incident response plan, including breach notification obligations. | Security / counsel | ☐ |

## 4. Backup and restoration

| # | Item | Owner | Status |
|---|---|---|---|
| 4.1 | Automated PostgreSQL backups with point-in-time recovery, encrypted and stored off-site. | Platform | ☐ |
| 4.2 | Object-storage versioning and cross-region replication for documents. | Platform | ☐ |
| 4.3 | **Restore drill:** restore the database and documents into an isolated environment. Verify the audit hash chain (Settings → Audit log), ledger balances and document downloads. Record the RTO and RPO achieved. | Platform | ☐ |
| 4.4 | Redis persistence (AOF), plus a documented procedure to rebuild queues from `JobRun` rows. | Platform | ☐ |
| 4.5 | Schedule restore drills (at least quarterly) and keep the evidence. | Platform | ☐ |

## 5. Vendor agreements

| # | Item | Owner | Status |
|---|---|---|---|
| 5.1 | AI provider: data-processing terms, retention and zero-retention options, permitted use with client documents. | Counsel / procurement | ☐ |
| 5.2 | E-signature vendor: agreement including API access, and confirmation that the signing process meets legal requirements for the documents used. | Counsel / procurement | ☐ Demo only |
| 5.3 | Title and property-data vendors: agreements that explicitly include API access and permitted use. No scraping. | Procurement | ☐ Demo only |
| 5.4 | E-recording submitter agreement with the provider and the counties served. | Procurement | ☐ Demo only |
| 5.5 | Email provider: sender domain authentication (SPF, DKIM, DMARC) and bounce/complaint handling. | IT | ☐ |
| 5.6 | Hosting, storage and Redis providers: SOC 2 reports and data-residency terms. | Procurement / security | ☐ |
| 5.7 | Bank: statement-feed agreement. Any payment-initiation agreement stays out of scope until 2.6 is done. | Treasury | ☐ |

## 6. Integration credentials and configuration

| # | Item | Owner | Status |
|---|---|---|---|
| 6.1 | Issue production credentials per environment, store them in the secrets manager, and grant least-privilege scopes. | Platform | ☐ |
| 6.2 | Build each live vendor adapter from official documentation and test it in the vendor sandbox (see INTEGRATIONS.md). | Engineering | ☐ |
| 6.3 | Generate unique webhook secrets per provider and environment, rotate them, and allowlist source IPs where the vendor publishes them. | Platform | ☐ |
| 6.4 | Confirm `EXTERNAL_SEND_ENABLED` stays `false` until templates, rules and approvers are reviewed. Then enable sending per company deliberately. | Operations | ◐ Defaults off |
| 6.5 | Review each automation rule and template. Approve templates (as someone other than the editor) before any rule is set to send automatically. | Operations / compliance | ◐ All rules off by default |
| 6.6 | Configure the Anthropic model and effort. Run an evaluation on de-identified sample documents and record the accuracy and failure modes before relying on extraction. | Engineering / operations | ☐ |
| 6.7 | Run the worker with redundancy, and add monitoring for queue depth and DEAD jobs. | Platform | ☐ |

## 7. Operational readiness

| # | Item | Owner | Status |
|---|---|---|---|
| 7.1 | Staff training: approvals, separation of duties, wire verification, proposal review, and the limits of demo outputs. | Operations | ☐ |
| 7.2 | Pilot with a limited set of files, running the existing process in parallel, with written go/no-go criteria. | Management | ☐ |
| 7.3 | Accessibility review (WCAG 2.2 AA) of the staff app and the portal. | Product | ◐ Semantic markup and labels; not audited |
| 7.4 | Support process and a status page for participants. | Operations | ☐ |
