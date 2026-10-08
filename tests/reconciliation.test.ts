import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { expectAppError, grantStepUp, makeCompany, makeTx, makeUser, resetDb } from "./helpers";
import { recordReceipt, postEntry } from "@/server/ledger/journal";
import { autoMatch, confirmFundingFromBank, importBankStatement, parseBankCsv, requestReconciliationReview, runReconciliation } from "@/server/services/reconciliation";
import { decideApproval } from "@/server/services/approvals";
import type { Ctx } from "@/server/context";

describe("bank reconciliation", () => {
  let accounting: Ctx, accounting2: Ctx, officer: Ctx;
  let bankAccountId: string, txA: string, txB: string;

  beforeAll(async () => {
    await resetDb();
    const c = await makeCompany("Recon Co");
    accounting = await makeUser(c.company.id, "ACCOUNTING");
    accounting2 = await makeUser(c.company.id, "ACCOUNTING");
    officer = await makeUser(c.company.id, "ESCROW_OFFICER");
    await grantStepUp(accounting2);
    bankAccountId = (await db.bankAccount.findFirstOrThrow({ where: { companyId: c.company.id } })).id;
    txA = (await makeTx(officer)).id;
    txB = (await makeTx(officer)).id;
    await recordReceipt(accounting, txA, { amount: "26,250.00", date: "2026-10-01", memo: "Deposit A" });
    await recordReceipt(accounting, txB, { amount: "10,000.00", date: "2026-10-02", memo: "Deposit B" });
    await postEntry(accounting, { transactionId: txB, effectiveDate: "2026-10-03", memo: "Check 1001 to county", kind: "DISBURSEMENT", lines: [{ account: "ESCROW_LIABILITY", transactionId: txB, debit: "1,200.00" }, { account: "TRUST_BANK", transactionId: txB, credit: "1,200.00" }] });
  });

  const STMT1 = `Date,Description,Amount,Transaction ID\n2026-10-01,"DEPOSIT, BUYER A",26250.00,BK-1\n2026-10-03,Check 1001,-1200.00,BK-2\n`;

  it("parses CSV with quotes and derives stable ids when the bank gives none", () => {
    const rows = parseBankCsv(`date,description,amount\n10/01/2026,"Wire, ""ref"" 1",100.00\n10/01/2026,"Wire, ""ref"" 1",100.00\n`);
    expect(rows).toHaveLength(2);
    expect(rows[0].description).toBe('Wire, "ref" 1');
    expect(rows[0].externalId).not.toBe(rows[1].externalId);
    expect(() => parseBankCsv("date,amount\n2026-10-01,1.00")).toThrow();
  });

  it("imports idempotently: same file and overlapping rows are not duplicated", async () => {
    const first = await importBankStatement(accounting, bankAccountId, { filename: "oct-1.csv", content: STMT1, statementDate: "2026-10-03", endingBalance: "25,050.00" });
    expect(first).toMatchObject({ duplicateFile: false, import: { newRows: 2, duplicateRows: 0 } });
    const again = await importBankStatement(accounting, bankAccountId, { filename: "oct-1-copy.csv", content: STMT1, statementDate: "2026-10-03", endingBalance: "25,050.00" });
    expect(again.duplicateFile).toBe(true);
    const overlap = await importBankStatement(accounting, bankAccountId, { filename: "oct-2.csv", content: STMT1 + "2026-10-04,Unknown wire in,500.00,BK-3\n", statementDate: "2026-10-04", endingBalance: "25,550.00" });
    expect(overlap).toMatchObject({ duplicateFile: false, import: { newRows: 1, duplicateRows: 2 } });
    expect(await db.bankTransaction.count({ where: { bankAccountId } })).toBe(3);
  });

  it("produces a three-way reconciliation with outstanding items and unresolved differences", async () => {
    await autoMatch(accounting, bankAccountId);
    const stmt1 = await db.bankStatementImport.findFirstOrThrow({ where: { filename: "oct-1.csv" } });
    const r1 = await runReconciliation(accounting, bankAccountId, stmt1.id);
    // Book: 26,250 + 10,000 − 1,200 = 35,050. Bank 25,050 + deposit in transit 10,000 = 35,050.
    expect(r1).toMatchObject({ bookBalanceCents: 3_505_000n, adjustedBankCents: 3_505_000n, outstandingDepositsCents: 1_000_000n, fileBalancesTotalCents: 3_505_000n, bankVsBookCents: 0n, bookVsFilesCents: 0n, status: "BALANCED" });
    const stmt2 = await db.bankStatementImport.findFirstOrThrow({ where: { filename: "oct-2.csv" } });
    const r2 = await runReconciliation(accounting, bankAccountId, stmt2.id);
    expect(r2.status).toBe("OUT_OF_BALANCE");
    expect(r2.bankVsBookCents).toBe(50_000n);
    expect((r2.details as { unmatchedBankItems: unknown[] }).unmatchedBankItems).toHaveLength(1);
  });

  it("requires a different reviewer with step-up", async () => {
    const rec = await db.reconciliation.findFirstOrThrow({ where: { status: "BALANCED" } });
    const approval = await requestReconciliationReview(accounting, rec.id);
    await expectAppError(decideApproval(accounting, approval.id, "APPROVED"), "FORBIDDEN");
    await decideApproval(accounting2, approval.id, "APPROVED");
    expect((await db.reconciliation.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("REVIEWED");
  });

  it("confirms funding from a matched bank credit, not from an unmatched one", async () => {
    const unmatched = await db.bankTransaction.findFirstOrThrow({ where: { externalId: "BK-3" } });
    await expectAppError(confirmFundingFromBank(accounting, unmatched.id), "PRECONDITION_FAILED");
    const matched = await db.bankTransaction.findFirstOrThrow({ where: { externalId: "BK-1" } });
    await confirmFundingFromBank(accounting, matched.id);
    const m = await db.milestone.findFirstOrThrow({ where: { transactionId: txA, kind: "FUNDING" } });
    expect(m).toMatchObject({ status: "COMPLETE", confirmationSource: "BANK_RECONCILIATION", reference: "BK-1" });
  });
});
