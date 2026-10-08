import { db, type Tx } from "../db";
import { isExternal, requirePermission, requireUser, type Ctx } from "../context";
import { conflict, invalid, notFound, precondition } from "../errors";
import { audit } from "../audit";
import { parseMoneyToCents, formatCents } from "@/lib/money";
import { parseDateOnly } from "@/lib/dates";
import type { EntryKind } from "@/generated/prisma/enums";

/**
 * INTERNAL TRACKING LEDGER. Double-entry, integer cents, append-only.
 * It does not hold money, initiate payments, or replace a company's approved
 * trust accounting system. See docs/FINANCIAL-CONTROLS.md.
 */

export const ACCOUNTS = {
  TRUST_BANK: { code: "1000", name: "Trust bank account (tracking)", type: "ASSET" as const },
  ESCROW_LIABILITY: { code: "2000", name: "Escrow funds held for files", type: "LIABILITY" as const },
  SUSPENSE: { code: "2900", name: "Unidentified receipts (suspense)", type: "LIABILITY" as const },
  FEE_INCOME: { code: "4000", name: "Escrow fees earned", type: "INCOME" as const },
};
export type AccountPurpose = keyof typeof ACCOUNTS;

export async function installDefaultAccounts(client: Tx, companyId: string) {
  for (const [purpose, a] of Object.entries(ACCOUNTS)) {
    await client.ledgerAccount.upsert({
      where: { companyId_code: { companyId, code: a.code } },
      create: { companyId, code: a.code, name: a.name, type: a.type, purpose },
      update: {},
    });
  }
}

async function account(client: Tx | typeof db, companyId: string, purpose: AccountPurpose) {
  const a = await client.ledgerAccount.findFirst({ where: { companyId, purpose, active: true } });
  if (!a) throw precondition(`Ledger account ${purpose} is not set up for this company.`);
  return a;
}

/** Escrow-file balance: credits minus debits on the trust liability account for the file. */
export async function fileBalance(client: Tx | typeof db, companyId: string, transactionId: string, asOf?: Date): Promise<bigint> {
  const rows = await client.$queryRaw<{ bal: bigint | null }[]>`
    SELECT COALESCE(SUM(l."creditCents" - l."debitCents"), 0)::bigint AS bal
    FROM "JournalLine" l
    JOIN "LedgerAccount" a ON a."id" = l."accountId"
    JOIN "JournalEntry" e ON e."id" = l."entryId"
    WHERE l."companyId" = ${companyId} AND a."purpose" = 'ESCROW_LIABILITY' AND l."transactionId" = ${transactionId}
      AND (${asOf ?? null}::date IS NULL OR e."effectiveDate" <= ${asOf ?? null}::date)`;
  return rows[0]?.bal ?? 0n;
}

/** Book balance of the trust bank account (debits minus credits). */
export async function trustBookBalance(client: Tx | typeof db, companyId: string, asOf?: Date): Promise<bigint> {
  const rows = await client.$queryRaw<{ bal: bigint | null }[]>`
    SELECT COALESCE(SUM(l."debitCents" - l."creditCents"), 0)::bigint AS bal
    FROM "JournalLine" l
    JOIN "LedgerAccount" a ON a."id" = l."accountId"
    JOIN "JournalEntry" e ON e."id" = l."entryId"
    WHERE l."companyId" = ${companyId} AND a."purpose" = 'TRUST_BANK'
      AND (${asOf ?? null}::date IS NULL OR e."effectiveDate" <= ${asOf ?? null}::date)`;
  return rows[0]?.bal ?? 0n;
}

/** Per-file balances on the trust liability account (for the three-way reconciliation). */
export async function allFileBalances(client: Tx | typeof db, companyId: string, asOf?: Date) {
  return client.$queryRaw<{ transactionId: string | null; bal: bigint }[]>`
    SELECT l."transactionId" AS "transactionId", COALESCE(SUM(l."creditCents" - l."debitCents"), 0)::bigint AS bal
    FROM "JournalLine" l
    JOIN "LedgerAccount" a ON a."id" = l."accountId"
    JOIN "JournalEntry" e ON e."id" = l."entryId"
    WHERE l."companyId" = ${companyId} AND a."purpose" IN ('ESCROW_LIABILITY', 'SUSPENSE')
      AND (${asOf ?? null}::date IS NULL OR e."effectiveDate" <= ${asOf ?? null}::date)
    GROUP BY l."transactionId"`;
}

export interface LineInput {
  account: AccountPurpose;
  transactionId?: string | null;
  debit?: string | bigint;
  credit?: string | bigint;
  memo?: string;
}

export interface EntryInput {
  transactionId?: string | null;
  effectiveDate: string;
  memo: string;
  kind: EntryKind;
  reference?: string;
  idempotencyKey?: string;
  source?: string;
  /** Set only by reverseEntry; unique, so an entry can be reversed at most once. */
  reversesEntryId?: string;
  lines: LineInput[];
}

const toCents = (v: string | bigint | undefined) => (v === undefined || v === "" ? 0n : typeof v === "bigint" ? v : parseMoneyToCents(v));

/**
 * Posts a balanced entry. Rules enforced here (and again by DB constraints):
 * each line is one-sided and positive; debits equal credits; at least two
 * lines; no escrow file may go negative; an idempotency key posts at most once.
 */
export async function postEntry(ctx: Ctx, input: EntryInput, existingClient?: Tx) {
  if (isExternal(ctx)) throw notFound("Ledger");
  if (!existingClient) requirePermission(ctx, "ledger.post");
  const actorId = requireUser(ctx);
  if (!input.memo?.trim()) throw invalid("A memo is required.");
  let effectiveDate: Date;
  try {
    effectiveDate = parseDateOnly(input.effectiveDate);
  } catch (e) {
    throw invalid((e as Error).message);
  }
  let lines: { account: AccountPurpose; transactionId: string | null; debit: bigint; credit: bigint; memo?: string }[];
  try {
    lines = input.lines.map((l) => ({ account: l.account, transactionId: l.transactionId ?? null, debit: toCents(l.debit), credit: toCents(l.credit), memo: l.memo }));
  } catch (e) {
    throw invalid((e as Error).message);
  }
  if (lines.length < 2) throw invalid("An entry needs at least two lines.");
  for (const l of lines) {
    if (l.debit < 0n || l.credit < 0n) throw invalid("Amounts must be positive; use the opposite side instead of negatives.");
    if ((l.debit === 0n) === (l.credit === 0n)) throw invalid("Each line must have exactly one of debit or credit.");
  }
  const debits = lines.reduce((a, l) => a + l.debit, 0n);
  const credits = lines.reduce((a, l) => a + l.credit, 0n);
  if (debits !== credits) throw invalid(`Entry is unbalanced: debits ${formatCents(debits)} vs credits ${formatCents(credits)}.`);

  const run = async (client: Tx) => {
    await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"ledger:" + ctx.companyId}))`;
    if (input.idempotencyKey) {
      const dup = await client.journalEntry.findUnique({ where: { companyId_idempotencyKey: { companyId: ctx.companyId, idempotencyKey: input.idempotencyKey } }, include: { lines: true } });
      if (dup) return { entry: dup, duplicate: true };
    }
    const txIds = [...new Set([input.transactionId, ...lines.map((l) => l.transactionId)].filter(Boolean) as string[])];
    if (txIds.length) {
      const found = await client.transaction.count({ where: { id: { in: txIds }, companyId: ctx.companyId } });
      if (found !== txIds.length) throw notFound("Transaction");
    }
    const accounts = new Map<AccountPurpose, string>();
    for (const l of lines) if (!accounts.has(l.account)) accounts.set(l.account, (await account(client, ctx.companyId, l.account)).id);
    // Liability lines must identify the escrow file they belong to.
    for (const l of lines) if (l.account === "ESCROW_LIABILITY" && !l.transactionId) throw invalid("Escrow liability lines must reference an escrow file.");

    const max = await client.journalEntry.aggregate({ where: { companyId: ctx.companyId }, _max: { entryNumber: true } });
    const entry = await client.journalEntry.create({
      data: {
        companyId: ctx.companyId,
        entryNumber: (max._max.entryNumber ?? 0) + 1,
        transactionId: input.transactionId ?? null,
        effectiveDate,
        memo: input.memo.trim(),
        kind: input.kind,
        source: input.source ?? "MANUAL",
        reference: input.reference ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        reversesEntryId: input.reversesEntryId ?? null,
        postedById: actorId,
        lines: {
          create: lines.map((l) => ({ companyId: ctx.companyId, accountId: accounts.get(l.account)!, transactionId: l.transactionId, debitCents: l.debit, creditCents: l.credit, memo: l.memo })),
        },
      },
      include: { lines: true },
    });
    // No escrow file may be overdrawn.
    for (const t of txIds) {
      const bal = await fileBalance(client, ctx.companyId, t);
      if (bal < 0n) throw precondition(`This entry would overdraw escrow file funds (balance would be ${formatCents(bal)}).`);
    }
    await audit(ctx, {
      action: "ledger.entry_posted",
      entityType: "JournalEntry",
      entityId: entry.id,
      transactionId: input.transactionId ?? null,
      summary: `Posted ${input.kind.toLowerCase()} entry #${entry.entryNumber}: ${formatCents(debits)} (${input.memo.trim().slice(0, 80)})`,
      details: { idempotencyKey: input.idempotencyKey, reference: input.reference },
    }, client);
    return { entry, duplicate: false };
  };
  if (existingClient) return run(existingClient);
  try {
    return await db.$transaction(run);
  } catch (e) {
    if ((e as { code?: string }).code === "P2002" && input.idempotencyKey) {
      const dup = await db.journalEntry.findUnique({ where: { companyId_idempotencyKey: { companyId: ctx.companyId, idempotencyKey: input.idempotencyKey } }, include: { lines: true } });
      if (dup) return { entry: dup, duplicate: true };
      throw conflict("Duplicate entry.");
    }
    throw e;
  }
}

/** Records funds received into trust for a file. */
export async function recordReceipt(ctx: Ctx, transactionId: string, input: { amount: string; date: string; memo: string; reference?: string; idempotencyKey?: string }) {
  requirePermission(ctx, "ledger.post");
  return postEntry(ctx, {
    transactionId,
    effectiveDate: input.date,
    memo: input.memo,
    kind: "RECEIPT",
    reference: input.reference,
    idempotencyKey: input.idempotencyKey,
    lines: [
      { account: "TRUST_BANK", transactionId, debit: input.amount },
      { account: "ESCROW_LIABILITY", transactionId, credit: input.amount },
    ],
  });
}

/** Reverses a posted entry with an equal and opposite entry. Entries are never edited or deleted. */
export async function reverseEntry(ctx: Ctx, entryId: string, reason: string, date?: string) {
  requirePermission(ctx, "ledger.post");
  if (!reason?.trim()) throw invalid("A reason is required to reverse an entry.");
  const original = await db.journalEntry.findFirst({ where: { id: entryId, companyId: ctx.companyId }, include: { lines: { include: { account: true } } } });
  if (!original) throw notFound("Journal entry");
  if (original.kind === "REVERSAL") throw precondition("Reversal entries cannot themselves be reversed; post a new correcting entry.");
  const already = await db.journalEntry.findFirst({ where: { reversesEntryId: original.id } });
  if (already) throw precondition(`Entry #${original.entryNumber} was already reversed by #${already.entryNumber}.`);
  try {
    return await postEntry(ctx, {
      transactionId: original.transactionId,
      effectiveDate: date ?? new Date().toISOString().slice(0, 10),
      memo: `Reversal of #${original.entryNumber}: ${reason.trim()}`,
      kind: "REVERSAL",
      source: "REVERSAL",
      reversesEntryId: original.id,
      lines: original.lines.map((l) => ({ account: l.account.purpose as AccountPurpose, transactionId: l.transactionId, debit: l.creditCents || undefined, credit: l.debitCents || undefined, memo: l.memo ?? undefined })),
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw precondition(`Entry #${original.entryNumber} was already reversed.`);
    throw e;
  }
}

export async function fileLedger(ctx: Ctx, transactionId: string) {
  requirePermission(ctx, "ledger.read");
  const tx = await db.transaction.findFirst({ where: { id: transactionId, companyId: ctx.companyId } });
  if (!tx) throw notFound("Transaction");
  const entries = await db.journalEntry.findMany({
    where: { companyId: ctx.companyId, OR: [{ transactionId }, { lines: { some: { transactionId } } }] },
    include: { lines: { include: { account: true } } },
    orderBy: [{ effectiveDate: "asc" }, { entryNumber: "asc" }],
  });
  const reversedIds = new Set(entries.map((e) => e.reversesEntryId).filter(Boolean) as string[]);
  return { entries, reversedIds, balance: await fileBalance(db, ctx.companyId, transactionId) };
}
