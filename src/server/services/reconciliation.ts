import { db } from "../db";
import { isExternal, requirePermission, requireUser, type Ctx } from "../context";
import { invalid, notFound, precondition } from "../errors";
import { audit } from "../audit";
import { sha256Hex, canonicalJson } from "../crypto";
import { allFileBalances, trustBookBalance } from "../ledger/journal";
import { createApproval } from "./approvals";
import { parseMoneyToCents, formatCents } from "@/lib/money";
import { addDays, formatDateOnly, parseDateOnly } from "@/lib/dates";
import { installDefaultAccounts } from "../ledger/journal";
import type { Tx } from "../db";
import type { Prisma, Reconciliation } from "@/generated/prisma/client";

/**
 * Bank reconciliation for the internal tracking ledger:
 *   adjusted bank balance  = statement balance + deposits in transit − outstanding disbursements
 *   book balance           = trust bank account per the ledger
 *   file balances total    = sum of every escrow file's balance (plus suspense)
 * All three must agree, with no unmatched bank activity, for a BALANCED result.
 */

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180 subset: quoted fields, escaped quotes)
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export interface ParsedBankRow {
  date: Date;
  description: string;
  amountCents: bigint;
  externalId: string;
}

/** Expects a header with date, description, amount and optionally id/reference columns. */
export function parseBankCsv(text: string): ParsedBankRow[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length < 2) throw invalid("The file has no transactions.");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));
  const di = col(["date", "posted date", "posting date"]);
  const ds = col(["description", "memo", "details"]);
  const am = col(["amount", "amount (usd)"]);
  const id = col(["id", "transaction id", "reference", "fitid"]);
  if (di < 0 || ds < 0 || am < 0) throw invalid("CSV must include date, description and amount columns.");
  const seen = new Map<string, number>();
  return rows.slice(1).map((r, i) => {
    let date: Date;
    let amountCents: bigint;
    try {
      date = parseDateOnly(r[di]);
      amountCents = parseMoneyToCents(r[am].replace(/\s/g, ""));
    } catch (e) {
      throw invalid(`Row ${i + 2}: ${(e as Error).message}`);
    }
    const description = (r[ds] ?? "").trim().slice(0, 300);
    let externalId = id >= 0 && r[id]?.trim() ? r[id].trim() : "";
    if (!externalId) {
      // No bank id: derive a stable id from content plus occurrence index for identical rows.
      const base = sha256Hex(`${formatDateOnly(date)}|${amountCents}|${description}`).slice(0, 24);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      externalId = `h:${base}:${n}`;
    }
    return { date, description, amountCents, externalId };
  });
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/**
 * Imports a statement. Idempotent twice over: the same file (by SHA-256) is
 * recognized and not re-imported, and individual rows are de-duplicated by
 * bank transaction id across overlapping statements.
 */
export async function importBankStatement(ctx: Ctx, bankAccountId: string, input: { filename: string; content: string; statementDate: string; endingBalance: string }) {
  if (isExternal(ctx)) throw notFound("Bank account");
  requirePermission(ctx, "recon.prepare");
  const userId = requireUser(ctx);
  const account = await db.bankAccount.findFirst({ where: { id: bankAccountId, companyId: ctx.companyId } });
  if (!account) throw notFound("Bank account");
  const fileSha256 = sha256Hex(input.content);
  const existing = await db.bankStatementImport.findUnique({ where: { bankAccountId_fileSha256: { bankAccountId, fileSha256 } } });
  if (existing) return { import: existing, duplicateFile: true };
  let statementDate: Date;
  let endingBalanceCents: bigint;
  try {
    statementDate = parseDateOnly(input.statementDate);
    endingBalanceCents = parseMoneyToCents(input.endingBalance);
  } catch (e) {
    throw invalid((e as Error).message);
  }
  const rows = parseBankCsv(input.content);
  try {
    return await db.$transaction(async (client) => {
      const imp = await client.bankStatementImport.create({
        data: { companyId: ctx.companyId, bankAccountId, fileSha256, filename: input.filename.slice(0, 200), statementDate, endingBalanceCents, rowCount: rows.length, newRows: 0, duplicateRows: 0, importedById: userId },
      });
      const res = await client.bankTransaction.createMany({
        data: rows.map((r) => ({ companyId: ctx.companyId, bankAccountId, importId: imp.id, externalId: r.externalId, postedDate: r.date, amountCents: r.amountCents, description: r.description })),
        skipDuplicates: true,
      });
      // Counts are written once at creation of the summary row below (import rows are not edited later).
      const summary = await client.bankStatementImport.update({ where: { id: imp.id }, data: { newRows: res.count, duplicateRows: rows.length - res.count } });
      await audit(ctx, { action: "recon.statement_imported", entityType: "BankStatementImport", entityId: imp.id, summary: `Imported ${input.filename}: ${res.count} new, ${rows.length - res.count} duplicate row(s)`, details: { sha256: fileSha256 } }, client);
      return { import: summary, duplicateFile: false };
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      const again = await db.bankStatementImport.findUnique({ where: { bankAccountId_fileSha256: { bankAccountId, fileSha256 } } });
      if (again) return { import: again, duplicateFile: true };
    }
    throw e;
  }
}

/** Matches unmatched bank lines to trust-bank journal entries with the same amount within ±3 days. */
export async function autoMatch(ctx: Ctx, bankAccountId: string) {
  requirePermission(ctx, "recon.prepare");
  const account = await db.bankAccount.findFirst({ where: { id: bankAccountId, companyId: ctx.companyId } });
  if (!account) throw notFound("Bank account");
  const bankRows = await db.bankTransaction.findMany({ where: { bankAccountId, matchedEntryId: null }, orderBy: { postedDate: "asc" } });
  const matchedIds = new Set((await db.bankTransaction.findMany({ where: { companyId: ctx.companyId, matchedEntryId: { not: null } }, select: { matchedEntryId: true } })).map((r) => r.matchedEntryId!));
  const entries = await bookCashEntries(ctx.companyId, account.ledgerAccountId);
  let matched = 0;
  for (const b of bankRows) {
    const candidate = entries.find((e) => !matchedIds.has(e.id) && e.amount === b.amountCents && Math.abs(e.date.getTime() - b.postedDate.getTime()) <= 3 * 86_400_000);
    if (!candidate) continue;
    matchedIds.add(candidate.id);
    await db.bankTransaction.update({ where: { id: b.id }, data: { matchedEntryId: candidate.id, matchedById: ctx.userId, matchedAt: new Date() } });
    matched++;
  }
  if (matched) await audit(ctx, { action: "recon.auto_matched", entityType: "BankAccount", entityId: bankAccountId, summary: `Auto-matched ${matched} bank transaction(s)` });
  return { matched };
}

export async function matchManually(ctx: Ctx, bankTransactionId: string, entryId: string | null) {
  requirePermission(ctx, "recon.prepare");
  const b = await db.bankTransaction.findFirst({ where: { id: bankTransactionId, companyId: ctx.companyId } });
  if (!b) throw notFound("Bank transaction");
  if (entryId) {
    const e = await db.journalEntry.findFirst({ where: { id: entryId, companyId: ctx.companyId } });
    if (!e) throw notFound("Journal entry");
  }
  await db.$transaction(async (client) => {
    await client.bankTransaction.update({ where: { id: b.id }, data: { matchedEntryId: entryId, matchedById: entryId ? ctx.userId : null, matchedAt: entryId ? new Date() : null } });
    await audit(ctx, { action: entryId ? "recon.matched" : "recon.unmatched", entityType: "BankTransaction", entityId: b.id, summary: `${entryId ? "Matched" : "Unmatched"} bank line ${formatCents(b.amountCents)} ${b.description}` }, client);
  });
}

/** Net cash effect (+ in, − out) of each journal entry on the trust bank account. */
async function bookCashEntries(companyId: string, ledgerAccountId: string, asOf?: Date) {
  const rows = await db.$queryRaw<{ id: string; entryNumber: number; date: Date; memo: string; transactionId: string | null; amount: bigint }[]>`
    SELECT e."id", e."entryNumber", e."effectiveDate" AS "date", e."memo", e."transactionId",
           SUM(l."debitCents" - l."creditCents")::bigint AS amount
    FROM "JournalEntry" e JOIN "JournalLine" l ON l."entryId" = e."id"
    WHERE e."companyId" = ${companyId} AND l."accountId" = ${ledgerAccountId}
      AND (${asOf ?? null}::date IS NULL OR e."effectiveDate" <= ${asOf ?? null}::date)
    GROUP BY e."id" ORDER BY e."effectiveDate", e."entryNumber"`;
  return rows.filter((r) => r.amount !== 0n);
}

export function reconciliationBinding(r: Reconciliation) {
  return {
    reconciliationId: r.id,
    periodEnd: formatDateOnly(r.periodEnd),
    bankBalanceCents: r.bankBalanceCents.toString(),
    bookBalanceCents: r.bookBalanceCents.toString(),
    fileBalancesTotalCents: r.fileBalancesTotalCents.toString(),
    bankVsBookCents: r.bankVsBookCents.toString(),
    bookVsFilesCents: r.bookVsFilesCents.toString(),
    status: r.status,
  };
}

/** Runs and saves a reconciliation as of a statement date. */
export async function runReconciliation(ctx: Ctx, bankAccountId: string, statementImportId: string) {
  if (isExternal(ctx)) throw notFound("Bank account");
  requirePermission(ctx, "recon.prepare");
  const userId = requireUser(ctx);
  const account = await db.bankAccount.findFirst({ where: { id: bankAccountId, companyId: ctx.companyId } });
  if (!account) throw notFound("Bank account");
  const stmt = await db.bankStatementImport.findFirst({ where: { id: statementImportId, bankAccountId } });
  if (!stmt) throw notFound("Statement");
  const periodEnd = stmt.statementDate;

  const [book, files, entries, bankRows] = await Promise.all([
    trustBookBalance(db, ctx.companyId, periodEnd),
    allFileBalances(db, ctx.companyId, periodEnd),
    bookCashEntries(ctx.companyId, account.ledgerAccountId, periodEnd),
    db.bankTransaction.findMany({ where: { bankAccountId, postedDate: { lte: periodEnd } } }),
  ]);
  const clearedEntryIds = new Set(bankRows.filter((b) => b.matchedEntryId).map((b) => b.matchedEntryId!));
  const outstanding = entries.filter((e) => !clearedEntryIds.has(e.id));
  const depositsInTransit = outstanding.filter((e) => e.amount > 0n);
  const outstandingDisb = outstanding.filter((e) => e.amount < 0n);
  const dit = depositsInTransit.reduce((a, e) => a + e.amount, 0n);
  const odisb = -outstandingDisb.reduce((a, e) => a + e.amount, 0n);
  const adjustedBank = stmt.endingBalanceCents + dit - odisb;
  const fileTotal = files.reduce((a, f) => a + f.bal, 0n);
  const unmatchedBank = bankRows.filter((b) => !b.matchedEntryId);
  const negativeFiles = files.filter((f) => f.bal < 0n);
  const bankVsBook = adjustedBank - book;
  const bookVsFiles = book - fileTotal;
  const status = bankVsBook === 0n && bookVsFiles === 0n && unmatchedBank.length === 0 && negativeFiles.length === 0 ? "BALANCED" : "OUT_OF_BALANCE";
  const txNumbers = new Map((await db.transaction.findMany({ where: { companyId: ctx.companyId }, select: { id: true, escrowNumber: true } })).map((t) => [t.id, t.escrowNumber]));

  const details = {
    statement: { id: stmt.id, filename: stmt.filename },
    depositsInTransit: depositsInTransit.map((e) => ({ entryNumber: e.entryNumber, date: formatDateOnly(e.date), memo: e.memo, amountCents: e.amount.toString(), file: e.transactionId ? txNumbers.get(e.transactionId) : null })),
    outstandingDisbursements: outstandingDisb.map((e) => ({ entryNumber: e.entryNumber, date: formatDateOnly(e.date), memo: e.memo, amountCents: (-e.amount).toString(), file: e.transactionId ? txNumbers.get(e.transactionId) : null })),
    unmatchedBankItems: unmatchedBank.map((b) => ({ id: b.id, date: formatDateOnly(b.postedDate), description: b.description, amountCents: b.amountCents.toString() })),
    fileBalances: files.filter((f) => f.bal !== 0n).map((f) => ({ file: f.transactionId ? (txNumbers.get(f.transactionId) ?? f.transactionId) : "Suspense", balanceCents: f.bal.toString() })),
    negativeFiles: negativeFiles.map((f) => ({ file: f.transactionId ? txNumbers.get(f.transactionId) : "Suspense", balanceCents: f.bal.toString() })),
    staleDepositsInTransit: depositsInTransit.filter((e) => e.date < addDays(periodEnd, -10)).length,
  };

  return db.$transaction(async (client) => {
    const rec = await client.reconciliation.create({
      data: {
        companyId: ctx.companyId,
        bankAccountId,
        periodEnd,
        bankBalanceCents: stmt.endingBalanceCents,
        bookBalanceCents: book,
        fileBalancesTotalCents: fileTotal,
        outstandingDepositsCents: dit,
        outstandingChecksCents: odisb,
        adjustedBankCents: adjustedBank,
        bankVsBookCents: bankVsBook,
        bookVsFilesCents: bookVsFiles,
        status,
        details: JSON.parse(canonicalJson(details)) as Prisma.InputJsonValue,
        preparedById: userId,
      },
    });
    await audit(ctx, { action: "recon.run", entityType: "Reconciliation", entityId: rec.id, summary: `Reconciliation as of ${formatDateOnly(periodEnd)}: ${status.replaceAll("_", " ").toLowerCase()} (bank vs book ${formatCents(bankVsBook)}, book vs files ${formatCents(bookVsFiles)})` }, client);
    return rec;
  });
}

/** Sends a reconciliation for review by a different person (step-up required to approve). */
export async function requestReconciliationReview(ctx: Ctx, reconciliationId: string) {
  requirePermission(ctx, "recon.prepare");
  const rec = await db.reconciliation.findFirst({ where: { id: reconciliationId, companyId: ctx.companyId } });
  if (!rec) throw notFound("Reconciliation");
  if (rec.status === "REVIEWED") throw precondition("Already reviewed.");
  const pending = await db.approval.findFirst({ where: { subjectId: rec.id, status: "PENDING" } });
  if (pending) return pending;
  return db.$transaction((client) =>
    createApproval(client, ctx, {
      type: "RECONCILIATION",
      title: `Trust reconciliation as of ${formatDateOnly(rec.periodEnd)} (${rec.status.replaceAll("_", " ").toLowerCase()})`,
      summary: rec.status === "BALANCED" ? "All three balances agree with no unmatched bank activity." : "Out of balance; reviewer must examine differences.",
      subjectType: "Reconciliation",
      subjectId: rec.id,
      binding: reconciliationBinding(rec),
      requiredPermission: "recon.review",
    }),
  );
}

export async function reconciliationWorkspace(ctx: Ctx) {
  if (isExternal(ctx)) throw notFound("Reconciliation");
  requirePermission(ctx, "ledger.read");
  const accounts = await db.bankAccount.findMany({ where: { companyId: ctx.companyId }, orderBy: { createdAt: "asc" } });
  return Promise.all(
    accounts.map(async (a) => ({
      account: a,
      imports: await db.bankStatementImport.findMany({ where: { bankAccountId: a.id }, orderBy: { statementDate: "desc" }, take: 10 }),
      unmatched: await db.bankTransaction.findMany({ where: { bankAccountId: a.id, matchedEntryId: null }, orderBy: { postedDate: "desc" }, take: 50 }),
      recent: await db.bankTransaction.findMany({ where: { bankAccountId: a.id, matchedEntryId: { not: null } }, orderBy: { postedDate: "desc" }, take: 20 }),
      reconciliations: await db.reconciliation.findMany({ where: { bankAccountId: a.id }, orderBy: { createdAt: "desc" }, take: 10 }),
      bookBalance: await trustBookBalance(db, ctx.companyId),
    })),
  );
}


/** Creates the default chart of accounts and a tracking record for the trust bank account. */
export async function installDefaultLedger(client: Tx, companyId: string, bank: { name: string; bankName: string; last4: string }) {
  await installDefaultAccounts(client, companyId);
  const trust = await client.ledgerAccount.findFirstOrThrow({ where: { companyId, purpose: "TRUST_BANK" } });
  const existing = await client.bankAccount.findFirst({ where: { companyId, ledgerAccountId: trust.id } });
  if (!existing) await client.bankAccount.create({ data: { companyId, name: bank.name, bankName: bank.bankName, accountLast4: bank.last4, ledgerAccountId: trust.id } });
}

/**
 * Confirms the FUNDING milestone from a bank credit that is matched to a
 * receipt for the file. This is the "authorized source" path: the evidence is
 * the bank statement line, not an email or screenshot.
 */
export async function confirmFundingFromBank(ctx: Ctx, bankTransactionId: string) {
  requirePermission(ctx, "milestone.confirm_funding");
  const userId = requireUser(ctx);
  const b = await db.bankTransaction.findFirst({ where: { id: bankTransactionId, companyId: ctx.companyId } });
  if (!b || !b.matchedEntryId) throw precondition("Match the bank credit to a receipt entry first.");
  if (b.amountCents <= 0n) throw precondition("Only incoming bank credits can confirm funding.");
  const entry = await db.journalEntry.findUniqueOrThrow({ where: { id: b.matchedEntryId } });
  if (!entry.transactionId || entry.kind !== "RECEIPT") throw precondition("The matched entry is not a receipt for an escrow file.");
  await db.$transaction(async (client) => {
    await client.milestone.upsert({
      where: { transactionId_kind: { transactionId: entry.transactionId!, kind: "FUNDING" } },
      create: { companyId: ctx.companyId, transactionId: entry.transactionId!, kind: "FUNDING", status: "COMPLETE", completedAt: new Date(), confirmedById: userId, confirmationSource: "BANK_RECONCILIATION", reference: b.externalId, notes: `Bank credit ${formatCents(b.amountCents)} on ${formatDateOnly(b.postedDate)} matched to receipt #${entry.entryNumber}` },
      update: { status: "COMPLETE", completedAt: new Date(), confirmedById: userId, confirmationSource: "BANK_RECONCILIATION", reference: b.externalId, notes: `Bank credit ${formatCents(b.amountCents)} on ${formatDateOnly(b.postedDate)} matched to receipt #${entry.entryNumber}` },
    });
    await audit(ctx, { action: "milestone.funding_confirmed_from_bank", entityType: "Milestone", entityId: entry.transactionId, transactionId: entry.transactionId, summary: `Funding confirmed from matched bank credit ${formatCents(b.amountCents)} (${b.description})` }, client);
  });
}
