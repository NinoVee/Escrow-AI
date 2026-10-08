import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { expectAppError, makeCompany, makeTx, makeUser, resetDb } from "./helpers";
import { fileBalance, postEntry, recordReceipt, reverseEntry, trustBookBalance, fileLedger } from "@/server/ledger/journal";
import { prorate } from "@/server/ledger/prorations";
import { computeSettlement } from "@/server/ledger/settlement";
import { addSettlementItem, draftStatement, saveStatementSnapshot } from "@/server/services/settlement";
import { parseDateOnly } from "@/lib/dates";
import type { Ctx } from "@/server/context";

describe("internal tracking ledger", () => {
  let accounting: Ctx, assistant: Ctx, officer: Ctx, otherAccounting: Ctx;
  let txA: string, txB: string, otherTx: string;

  beforeAll(async () => {
    await resetDb();
    const c = await makeCompany("Ledger Co");
    const o = await makeCompany("Other Ledger Co");
    accounting = await makeUser(c.company.id, "ACCOUNTING");
    assistant = await makeUser(c.company.id, "ESCROW_ASSISTANT");
    officer = await makeUser(c.company.id, "ESCROW_OFFICER");
    otherAccounting = await makeUser(o.company.id, "ACCOUNTING");
    txA = (await makeTx(officer)).id;
    txB = (await makeTx(officer)).id;
    otherTx = (await makeTx(await makeUser(o.company.id, "ESCROW_OFFICER"))).id;
  });

  it("posts balanced receipts in exact integer cents", async () => {
    await recordReceipt(accounting, txA, { amount: "0.10", date: "2026-10-01", memo: "Test receipt A" });
    await recordReceipt(accounting, txA, { amount: "0.20", date: "2026-10-01", memo: "Test receipt B" });
    expect(await fileBalance(db, accounting.companyId, txA)).toBe(30n);
    await recordReceipt(accounting, txA, { amount: "26,250.00", date: "2026-10-02", memo: "Initial deposit" });
    expect(await fileBalance(db, accounting.companyId, txA)).toBe(2_625_030n);
    expect(await trustBookBalance(db, accounting.companyId)).toBe(2_625_030n);
  });

  it("rejects unbalanced, two-sided, negative and malformed entries", async () => {
    const base = { transactionId: txA, effectiveDate: "2026-10-03", memo: "bad", kind: "ADJUSTMENT" as const };
    await expectAppError(postEntry(accounting, { ...base, lines: [{ account: "TRUST_BANK", transactionId: txA, debit: "10.00" }, { account: "ESCROW_LIABILITY", transactionId: txA, credit: "9.99" }] }), "VALIDATION");
    await expectAppError(postEntry(accounting, { ...base, lines: [{ account: "TRUST_BANK", transactionId: txA, debit: "10.00", credit: "10.00" }, { account: "ESCROW_LIABILITY", transactionId: txA, credit: "10.00" }] }), "VALIDATION");
    await expectAppError(postEntry(accounting, { ...base, lines: [{ account: "TRUST_BANK", transactionId: txA, debit: "-10.00" }, { account: "ESCROW_LIABILITY", transactionId: txA, credit: "-10.00" }] }), "VALIDATION");
    await expectAppError(postEntry(accounting, { ...base, lines: [{ account: "TRUST_BANK", transactionId: txA, debit: "10.001" }, { account: "ESCROW_LIABILITY", transactionId: txA, credit: "10.001" }] }), "VALIDATION");
    await expectAppError(postEntry(accounting, { ...base, lines: [{ account: "TRUST_BANK", transactionId: txA, debit: "10.00" }] }), "VALIDATION");
    await expectAppError(postEntry(accounting, { ...base, lines: [{ account: "TRUST_BANK", debit: "10.00" }, { account: "ESCROW_LIABILITY", credit: "10.00" }] }), "VALIDATION");
  });

  it("the database itself refuses unbalanced or edited entries", async () => {
    const acct = await db.ledgerAccount.findFirstOrThrow({ where: { companyId: accounting.companyId, purpose: "TRUST_BANK" } });
    await expect(
      db.$transaction(async (client) => {
        const e = await client.journalEntry.create({ data: { companyId: accounting.companyId, entryNumber: 9999, effectiveDate: parseDateOnly("2026-10-01"), memo: "raw", kind: "ADJUSTMENT", postedById: accounting.userId! } });
        await client.journalLine.create({ data: { companyId: accounting.companyId, entryId: e.id, accountId: acct.id, debitCents: 500n } });
      }),
    ).rejects.toThrow(/unbalanced/);
    await expect(db.journalLine.create({ data: { companyId: accounting.companyId, entryId: "x", accountId: acct.id, debitCents: 5n, creditCents: 5n } })).rejects.toThrow();
    const line = await db.journalLine.findFirstOrThrow({ where: { companyId: accounting.companyId } });
    await expect(db.journalLine.update({ where: { id: line.id }, data: { debitCents: 1n } })).rejects.toThrow(/append-only/);
    const entry = await db.journalEntry.findFirstOrThrow({ where: { companyId: accounting.companyId } });
    await expect(db.journalEntry.delete({ where: { id: entry.id } })).rejects.toThrow();
  });

  it("corrects mistakes with reversal entries, never edits or deletes", async () => {
    const { entry } = await recordReceipt(accounting, txB, { amount: "1,000.00", date: "2026-10-04", memo: "Keyed to wrong file" });
    expect(await fileBalance(db, accounting.companyId, txB)).toBe(100_000n);
    const rev = await reverseEntry(accounting, entry.id, "Posted to the wrong file");
    expect(rev.entry.kind).toBe("REVERSAL");
    expect(rev.entry.reversesEntryId).toBe(entry.id);
    expect(await fileBalance(db, accounting.companyId, txB)).toBe(0n);
    await expectAppError(reverseEntry(accounting, entry.id, "again"), "PRECONDITION_FAILED");
    await expectAppError(reverseEntry(accounting, rev.entry.id, "reverse the reversal"), "PRECONDITION_FAILED");
    expect(await db.journalEntry.count({ where: { id: entry.id } })).toBe(1);
    const ledger = await fileLedger(accounting, txB);
    expect(ledger.entries).toHaveLength(2);
  });

  it("idempotency keys post at most once, even concurrently", async () => {
    const input = { amount: "500.00", date: "2026-10-05", memo: "Bank import line 17", idempotencyKey: "import:stmt-1:line-17" };
    const results = await Promise.all([recordReceipt(accounting, txB, input), recordReceipt(accounting, txB, input), recordReceipt(accounting, txB, input)]);
    expect(new Set(results.map((r) => r.entry.id)).size).toBe(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(2);
    expect(await fileBalance(db, accounting.companyId, txB)).toBe(50_000n);
  });

  it("never lets an escrow file go negative", async () => {
    await expectAppError(
      postEntry(accounting, { transactionId: txB, effectiveDate: "2026-10-06", memo: "Overdraw", kind: "DISBURSEMENT", lines: [{ account: "ESCROW_LIABILITY", transactionId: txB, debit: "500.01" }, { account: "TRUST_BANK", transactionId: txB, credit: "500.01" }] }),
      "PRECONDITION_FAILED",
    );
    expect(await fileBalance(db, accounting.companyId, txB)).toBe(50_000n);
  });

  it("enforces permissions and tenant isolation", async () => {
    await expectAppError(recordReceipt(assistant, txA, { amount: "1.00", date: "2026-10-01", memo: "x" }), "FORBIDDEN");
    await expectAppError(recordReceipt(otherAccounting, txA, { amount: "1.00", date: "2026-10-01", memo: "x" }), "NOT_FOUND");
    await expectAppError(fileLedger(otherAccounting, txA), "NOT_FOUND");
    await expectAppError(recordReceipt(accounting, otherTx, { amount: "1.00", date: "2026-10-01", memo: "x" }), "NOT_FOUND");
  });
});

describe("prorations", () => {
  const year = { periodStart: parseDateOnly("2026-07-01"), periodEnd: parseDateOnly("2027-06-30") };

  it("computes a property-tax proration exactly (actual/365)", () => {
    const r = prorate({ amountCents: 730_000n, ...year, closingDate: parseDateOnly("2026-10-30"), basis: "ACTUAL_365", sellerOwnsClosingDay: false, rounding: "HALF_UP" });
    expect(r).toMatchObject({ sellerDays: 121, denominator: 365, sellerShareCents: 242_000n, buyerShareCents: 488_000n });
    const owns = prorate({ amountCents: 730_000n, ...year, closingDate: parseDateOnly("2026-10-30"), basis: "ACTUAL_365", sellerOwnsClosingDay: true, rounding: "HALF_UP" });
    expect(owns.sellerShareCents).toBe(244_000n);
  });

  it("supports 30/360 and actual/actual conventions", () => {
    const b360 = prorate({ amountCents: 730_000n, ...year, closingDate: parseDateOnly("2026-10-30"), basis: "BANKER_360", sellerOwnsClosingDay: false, rounding: "HALF_UP" });
    expect(b360).toMatchObject({ sellerDays: 119, denominator: 360, sellerShareCents: 241_306n });
    const month = prorate({ amountCents: 31_000n, periodStart: parseDateOnly("2026-10-01"), periodEnd: parseDateOnly("2026-10-31"), closingDate: parseDateOnly("2026-10-16"), basis: "ACTUAL_ACTUAL", sellerOwnsClosingDay: false, rounding: "HALF_UP" });
    expect(month).toMatchObject({ sellerDays: 15, denominator: 31, sellerShareCents: 15_000n, buyerShareCents: 16_000n });
  });

  it("shares always sum to the amount with explicit rounding", () => {
    for (let d = 0; d < 365; d += 7) {
      const closing = new Date(year.periodStart.getTime() + d * 86_400_000);
      for (const rounding of ["HALF_UP", "HALF_EVEN"] as const) {
        const r = prorate({ amountCents: 123_457n, ...year, closingDate: closing, basis: "ACTUAL_365", sellerOwnsClosingDay: false, rounding });
        expect(r.sellerShareCents + r.buyerShareCents).toBe(123_457n);
      }
    }
  });

  it("rejects closing dates outside the period", () => {
    expect(() => prorate({ amountCents: 1n, ...year, closingDate: parseDateOnly("2027-07-01"), basis: "ACTUAL_365", sellerOwnsClosingDay: false, rounding: "HALF_UP" })).toThrow();
  });
});

describe("draft settlement statement", () => {
  it("computes buyer and seller totals deterministically", () => {
    const s = computeSettlement({
      purchasePriceCents: 87_500_000n,
      initialDepositCents: 2_625_000n,
      additionalDepositCents: null,
      loanAmountCents: 70_000_000n,
      settlementDate: parseDateOnly("2026-10-30"),
      conventions: { basis: "ACTUAL_365", sellerOwnsClosingDay: false, rounding: "HALF_UP" },
      items: [
        { id: "1", kind: "PAYOFF", description: "Payoff to Redwood Coast Mortgage", payee: "Redwood Coast Mortgage", amountCents: 39_841_277n, chargeTo: "SELLER", buyerShareBps: null, proration: null },
        { id: "2", kind: "FEE", description: "Escrow fee", payee: "Golden Oak Escrow", amountCents: 250_001n, chargeTo: "SPLIT", buyerShareBps: 5000, proration: null },
        { id: "3", kind: "PRORATION", description: "County property taxes", payee: null, amountCents: 730_000n, chargeTo: "BUYER", buyerShareBps: null, proration: { type: "PREPAID_BY_SELLER", periodStart: "2026-07-01", periodEnd: "2027-06-30" } },
        { id: "4", kind: "SELLER_CREDIT", description: "Repair credit", payee: null, amountCents: 150_000n, chargeTo: "SELLER", buyerShareBps: null, proration: null },
      ],
    });
    const fee = s.lines.find((l) => l.description === "Escrow fee")!;
    expect(fee.buyerDebit + fee.sellerDebit).toBe(250_001n);
    expect(s.totals.buyerDebits).toBe(87_500_000n + fee.buyerDebit + 488_000n);
    expect(s.totals.buyerCredits).toBe(2_625_000n + 70_000_000n + 150_000n);
    expect(s.totals.dueFromBuyer).toBe(s.totals.buyerDebits - s.totals.buyerCredits);
    expect(s.totals.dueToSeller).toBe(87_500_000n + 488_000n - 39_841_277n - fee.sellerDebit - 150_000n);
    expect(s.warnings).toEqual([]);
  });

  it("skips invalid items with warnings instead of guessing", () => {
    const s = computeSettlement({ purchasePriceCents: null, initialDepositCents: null, additionalDepositCents: null, loanAmountCents: null, settlementDate: parseDateOnly("2026-10-30"), conventions: { basis: "ACTUAL_365", sellerOwnsClosingDay: false, rounding: "HALF_UP" }, items: [{ id: "x", kind: "PRORATION", description: "HOA", payee: null, amountCents: 100n, chargeTo: "BUYER", buyerShareBps: null, proration: null }] });
    expect(s.warnings.length).toBe(2);
    expect(s.lines).toHaveLength(0);
  });

  it("saves versioned snapshots through the service with company conventions", async () => {
    await resetDb();
    const c = await makeCompany("Settle Co");
    const officer = await makeUser(c.company.id, "ESCROW_OFFICER");
    const tx = await makeTx(officer, { fields: { purchasePriceCents: "500,000.00", proposedClosingDate: "2026-12-01" } });
    await expectAppError(addSettlementItem(officer, tx.id, { kind: "FEE", description: "Bad", amount: "0" }), "VALIDATION");
    await addSettlementItem(officer, tx.id, { kind: "FEE", description: "Escrow fee", amount: "1,500.00", chargeTo: "SPLIT", buyerSharePercent: "50" });
    const d = await draftStatement(officer, tx.id);
    expect(d.ready && d.totals.dueFromBuyer).toBe(50_075_000n);
    const s1 = await saveStatementSnapshot(officer, tx.id);
    const s2 = await saveStatementSnapshot(officer, tx.id);
    expect([s1.version, s2.version]).toEqual([1, 2]);
  });
});
