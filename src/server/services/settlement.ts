import { db } from "../db";
import { isExternal, requirePermission, requireUser, type Ctx } from "../context";
import { invalid, notFound } from "../errors";
import { audit } from "../audit";
import { loadTransaction } from "./access";
import { getCompanySettings } from "../settings";
import { computeSettlement, ProrationConfigSchema, serializeStatement, SETTLEMENT_KINDS } from "../ledger/settlement";
import { parseMoneyToCents } from "@/lib/money";
import { parseDateOnly } from "@/lib/dates";
import type { Prisma } from "@/generated/prisma/client";

export const SETTLEMENT_DISCLAIMER =
  "DRAFT internal estimate prepared with EscrowFlow. Not a Closing Disclosure, ALTA settlement statement, or any other official or regulated form. Figures must be verified against final demands, lender figures and the company's trust accounting system.";

export async function listSettlementItems(ctx: Ctx, transactionId: string) {
  if (isExternal(ctx)) throw notFound("Transaction");
  requirePermission(ctx, "ledger.read");
  await loadTransaction(ctx, transactionId);
  return db.settlementItem.findMany({ where: { companyId: ctx.companyId, transactionId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
}

export async function addSettlementItem(
  ctx: Ctx,
  transactionId: string,
  input: { kind: string; description: string; payee?: string; amount: string; chargeTo?: string; buyerSharePercent?: string; proration?: { type: string; periodStart: string; periodEnd: string } },
) {
  requirePermission(ctx, "transaction.update");
  const userId = requireUser(ctx);
  const tx = await loadTransaction(ctx, transactionId);
  if (!(SETTLEMENT_KINDS as readonly string[]).includes(input.kind)) throw invalid("Unknown item type.");
  if (!input.description?.trim()) throw invalid("Description is required.");
  let amountCents: bigint;
  try {
    amountCents = parseMoneyToCents(input.amount);
  } catch (e) {
    throw invalid((e as Error).message);
  }
  if (amountCents <= 0n) throw invalid("Amount must be greater than zero.");
  let proration: object | undefined;
  if (input.kind === "PRORATION") {
    const p = ProrationConfigSchema.safeParse(input.proration);
    if (!p.success) throw invalid("Choose the proration type and the period start and end dates.");
    try {
      if (parseDateOnly(p.data.periodEnd) < parseDateOnly(p.data.periodStart)) throw new Error("Period end is before its start.");
    } catch (e) {
      throw invalid((e as Error).message);
    }
    proration = p.data;
  }
  let buyerShareBps: number | null = null;
  if (input.chargeTo === "SPLIT") {
    const pct = Number(input.buyerSharePercent ?? "50");
    if (!Number.isFinite(pct) || pct < 0 || pct > 100 || Math.round(pct * 100) !== pct * 100) throw invalid("Buyer share must be a percentage with up to two decimals.");
    buyerShareBps = Math.round(pct * 100);
  }
  const count = await db.settlementItem.count({ where: { transactionId: tx.id } });
  return db.$transaction(async (client) => {
    const item = await client.settlementItem.create({
      data: {
        companyId: ctx.companyId,
        transactionId: tx.id,
        kind: input.kind,
        description: input.description.trim(),
        payee: input.payee?.trim() || null,
        amountCents,
        chargeTo: ["BUYER", "SELLER", "SPLIT"].includes(input.chargeTo ?? "") ? input.chargeTo! : "BUYER",
        buyerShareBps,
        proration: proration as Prisma.InputJsonValue | undefined,
        sortOrder: count,
        createdById: userId,
      },
    });
    await audit(ctx, { action: "settlement.item_added", entityType: "SettlementItem", entityId: item.id, transactionId: tx.id, summary: `Settlement item added: ${item.description}` }, client);
    return item;
  });
}

export async function removeSettlementItem(ctx: Ctx, itemId: string) {
  requirePermission(ctx, "transaction.update");
  const item = await db.settlementItem.findFirst({ where: { id: itemId, companyId: ctx.companyId } });
  if (!item) throw notFound("Item");
  await db.$transaction(async (client) => {
    await client.settlementItem.delete({ where: { id: item.id } });
    await audit(ctx, { action: "settlement.item_removed", entityType: "SettlementItem", entityId: item.id, transactionId: item.transactionId, summary: `Settlement item removed: ${item.description}` }, client);
  });
}

/** Computes the draft statement from accepted terms and items using company conventions. */
export async function draftStatement(ctx: Ctx, transactionId: string, settlementDate?: string) {
  requirePermission(ctx, "ledger.read");
  const tx = await loadTransaction(ctx, transactionId);
  const items = await listSettlementItems(ctx, transactionId);
  const settings = await getCompanySettings(ctx.companyId);
  const date = settlementDate ? parseDateOnly(settlementDate) : (tx.proposedClosingDate ?? null);
  if (!date) return { ready: false as const, reason: "Accept a proposed closing date (or enter a settlement date) to compute prorations.", items };
  const conventions = { basis: settings.prorationBasis, sellerOwnsClosingDay: settings.prorationSellerOwnsClosingDay, rounding: settings.roundingMode };
  const result = computeSettlement({
    purchasePriceCents: tx.purchasePriceCents,
    initialDepositCents: tx.initialDepositCents,
    additionalDepositCents: tx.additionalDepositCents,
    loanAmountCents: tx.loanAmountCents,
    settlementDate: date,
    items,
    conventions,
  });
  return { ready: true as const, settlementDate: date, conventions, items, ...result };
}

export async function saveStatementSnapshot(ctx: Ctx, transactionId: string, settlementDate?: string) {
  requirePermission(ctx, "transaction.update");
  const userId = requireUser(ctx);
  const d = await draftStatement(ctx, transactionId, settlementDate);
  if (!d.ready) throw invalid(d.reason);
  const ser = serializeStatement(d);
  return db.$transaction(async (client) => {
    const max = await client.settlementStatement.aggregate({ where: { transactionId }, _max: { version: true } });
    const s = await client.settlementStatement.create({
      data: { companyId: ctx.companyId, transactionId, version: (max._max.version ?? 0) + 1, settlementDate: d.settlementDate, conventions: d.conventions, lines: ser.lines as Prisma.InputJsonValue, totals: ser.totals as Prisma.InputJsonValue, createdById: userId },
    });
    await audit(ctx, { action: "settlement.snapshot_saved", entityType: "SettlementStatement", entityId: s.id, entityVersion: s.version, transactionId, summary: `Draft settlement statement v${s.version} saved` }, client);
    return s;
  });
}
