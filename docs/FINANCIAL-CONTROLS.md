# Financial controls

EscrowFlow's financial workspace is an **internal tracking ledger and review tool**. It is **not** a trust-accounting system of record, it does **not** hold or move funds, and it has **not** been validated against California escrow trust-accounting requirements. A licensed company must reconcile it against its system of record and its bank, and have it reviewed (see [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md)).

## Money representation

- **Integer cents.** All amounts are integer cents: `BigInt` in code, `BIGINT` in PostgreSQL. Input is parsed from strings (`parseMoneyToCents`), and floats are rejected.
- **Rounding** is explicit. `HALF_UP` or `HALF_EVEN` is chosen per company.
- **Allocations** distribute remainders deterministically, so shares always sum exactly to the total.
- **Dates.** Date-only values are stored at UTC midnight. "Today" is computed in the company's time zone (default America/Los_Angeles).

## Ledger

Default chart of accounts (per company):

| Code | Account | Type |
|---|---|---|
| 1000 | Trust bank account (tracking) | Asset |
| 2000 | Escrow funds held for files | Liability, tracked per file |
| 2900 | Unidentified receipts (suspense) | Liability |
| 4000 | Escrow fees earned | Income |

Controls:

- **Database checks.** These are enforced by PostgreSQL itself, not only by application code:
  - **One-sided lines.** Each line is either a debit or a credit, never both and never negative (CHECK constraint).
  - **Balanced entries.** Debits equal credits, enforced by a deferred constraint trigger that runs at commit.
  - **Immutability.** Triggers reject updates and deletes on journal entries and lines.
- **Corrections** are made by **reversal entries** that reference the original (`reversesEntryId`, unique). Nothing is edited or deleted.
- **Idempotency.** Each posting carries an idempotency key, serialized with an advisory lock. A retried or concurrent duplicate posts at most once.
- **No overdrafts.** A file's escrow-liability balance can never go negative. Disbursements beyond the file balance are refused.
- **Permissions.** Posting needs `ledger.post`. System, AI and job actors cannot post.

## Draft settlement statement

- **Line items.** Settlement items are versioned, and buyer and seller totals are computed deterministically.
- **Prorations.** Supported bases are actual/365, actual/actual and 30/360 (banker's). A company setting decides which party owns the closing day. Closing dates outside the proration period are rejected.
- **Invalid items** are skipped with a visible warning, never guessed.
- **Labeling.** The printable view is labeled **"Draft estimate — not an official settlement statement."** EscrowFlow does not generate a Closing Disclosure, an ALTA statement or any regulated form.

## Bank reconciliation

1. **Import.** Import the bank's CSV export.
   - The whole file is de-duplicated by its SHA-256 hash.
   - Rows are de-duplicated by `(bank account, external id)`. When the bank supplies no id, a stable id is derived from date, amount and description.
2. **Matching.** Auto-match pairs each bank line with an unmatched ledger entry of the exact same amount within ±3 days. Anything unmatched, such as a bank fee, stays visible for manual handling.
3. **Three-way comparison:**
   - adjusted bank balance (statement balance, plus deposits in transit, minus outstanding checks)
   - book balance of the trust account
   - the sum of all file balances
4. **Review.** Any difference stays flagged. Approval requires a **different person** with `recon.review` and step-up.
5. **Funding confirmation.** Funding can be confirmed from a **matched** bank credit. An email, a screenshot or an unmatched line cannot confirm funding.

## Bank instructions and disbursements

Wire-fraud controls for bank instructions:

- **Storage.** Instructions are stored encrypted (AES-256-GCM) and versioned. They are shown masked; revealing them needs `bank.reveal`, step-up and an audit entry.
- **Entry.** Creating or changing instructions requires step-up. Any change creates a new version and **invalidates** prior verification and any approval bound to it.
- **Verification.**
  - Instructions must be verified by **a different person** than the one who entered them.
  - Approved methods: callback to a known number, in person, or video ID plus callback.
  - The verifier records the phone number's source, which must not be the document that supplied the instructions.
  - The AI assistant cannot verify, change or reveal instructions.
- **Routing numbers** are validated with the ABA checksum.

Disbursement controls:

- **Preparation.** A disbursement is prepared with `disbursement.prepare`. Wires require verified instructions whose payee matches.
- **Approval binding.** The approval is bound to a hash of the amount, payee, method and instruction version. Changing any of them **invalidates** the approval.
- **Approval.** It must come from **a different person** than the preparer, with `disbursement.approve` and step-up.
- **Payment execution is disabled.** After the payment is executed in the bank's own system, an authorized user records the release (`RECORDED_AS_RELEASED`) with the bank reference. This requires confirmed funding, a person other than the preparer, and happens once.
- **Closing.** Closing is blocked while any disbursement is unreleased or the file balance is not zero.

## How this differs from production trust accounting

| Production trust accounting needs | MVP status |
|---|---|
| A system of record accepted by the company's auditors and regulator | Not provided. EscrowFlow is a tracking layer with CSV export. |
| Daily three-way reconciliation, signed off and retained | Workflow present. Retention policy and sign-off procedure must be defined. |
| Bank feeds (BAI2 / camt.053), positive pay, and bank-side dual control | Not implemented. Statements come by CSV upload only. |
| Payment initiation with bank-side controls | Deliberately not implemented. |
| Interest-bearing accounts, sub-accounting, escheatment of unclaimed funds | Not implemented. |
| Fee accounting and disbursement of earned fees to operating | Fee income account only. No operating transfer workflow. |
| Independent validation of proration and settlement math against the forms used | Unit-tested against hand-computed cases only. Needs professional review. |
| Year-end, audit and regulator reporting | Not implemented. |
