import { z } from "zod";
import { allocate, type RoundingMode } from "@/lib/money";
import { parseDateOnly } from "@/lib/dates";
import { prorate, type ProrationBasis } from "./prorations";

/**
 * Draft settlement computation. Pure and deterministic: the same inputs always
 * produce the same lines. Output is an internal estimate for staff review. It
 * is not a Closing Disclosure, an ALTA settlement statement, or any other
 * official or regulated form.
 */

export const SETTLEMENT_KINDS = ["FEE", "PAYOFF", "PRORATION", "SELLER_CREDIT", "HOLDBACK", "OTHER_DEBIT", "OTHER_CREDIT"] as const;
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number];

export const ProrationConfigSchema = z.object({
  type: z.enum(["PREPAID_BY_SELLER", "UNPAID_ARREARS", "RENT_COLLECTED_BY_SELLER"]),
  periodStart: z.string(),
  periodEnd: z.string(),
});
export type ProrationConfig = z.infer<typeof ProrationConfigSchema>;

export interface SettlementItemInput {
  id: string;
  kind: string;
  description: string;
  payee: string | null;
  amountCents: bigint | null;
  chargeTo: string;
  buyerShareBps: number | null;
  proration: unknown;
}

export interface Conventions {
  basis: ProrationBasis;
  sellerOwnsClosingDay: boolean;
  rounding: RoundingMode;
}

export interface StatementLine {
  section: "PRICE_AND_FINANCING" | "PAYOFFS" | "FEES" | "PRORATIONS" | "CREDITS" | "HOLDBACKS" | "OTHER";
  description: string;
  payee: string | null;
  buyerDebit: bigint;
  buyerCredit: bigint;
  sellerDebit: bigint;
  sellerCredit: bigint;
  detail?: string;
  itemId?: string;
}

export interface StatementTotals {
  buyerDebits: bigint;
  buyerCredits: bigint;
  sellerDebits: bigint;
  sellerCredits: bigint;
  /** Positive: buyer must bring funds. Negative: refund to buyer. */
  dueFromBuyer: bigint;
  /** Positive: proceeds to seller. Negative: seller must bring funds. */
  dueToSeller: bigint;
}

const zero = (): Omit<StatementLine, "section" | "description" | "payee"> => ({ buyerDebit: 0n, buyerCredit: 0n, sellerDebit: 0n, sellerCredit: 0n });

export function computeSettlement(input: {
  purchasePriceCents: bigint | null;
  initialDepositCents: bigint | null;
  additionalDepositCents: bigint | null;
  loanAmountCents: bigint | null;
  settlementDate: Date;
  items: SettlementItemInput[];
  conventions: Conventions;
}): { lines: StatementLine[]; totals: StatementTotals; warnings: string[] } {
  const lines: StatementLine[] = [];
  const warnings: string[] = [];
  if (input.purchasePriceCents != null) {
    lines.push({ section: "PRICE_AND_FINANCING", description: "Contract sales price", payee: null, ...zero(), buyerDebit: input.purchasePriceCents, sellerCredit: input.purchasePriceCents });
  } else warnings.push("Purchase price has not been accepted; totals are incomplete.");
  if (input.initialDepositCents) lines.push({ section: "PRICE_AND_FINANCING", description: "Initial deposit (held in escrow)", payee: null, ...zero(), buyerCredit: input.initialDepositCents });
  if (input.additionalDepositCents) lines.push({ section: "PRICE_AND_FINANCING", description: "Additional deposit", payee: null, ...zero(), buyerCredit: input.additionalDepositCents });
  if (input.loanAmountCents) lines.push({ section: "PRICE_AND_FINANCING", description: "New loan amount", payee: null, ...zero(), buyerCredit: input.loanAmountCents });

  for (const item of input.items) {
    const amt = item.amountCents ?? 0n;
    if (amt < 0n) {
      warnings.push(`"${item.description}" has a negative amount and was skipped.`);
      continue;
    }
    const base = { description: item.description, payee: item.payee, itemId: item.id };
    switch (item.kind) {
      case "FEE": {
        if (item.chargeTo === "SPLIT") {
          const bps = BigInt(Math.max(0, Math.min(10000, item.buyerShareBps ?? 5000)));
          const [b, s] = allocate(amt, [bps, 10000n - bps]);
          lines.push({ section: "FEES", ...base, ...zero(), buyerDebit: b, sellerDebit: s, detail: `Split ${Number(bps) / 100}% buyer / ${100 - Number(bps) / 100}% seller` });
        } else if (item.chargeTo === "SELLER") lines.push({ section: "FEES", ...base, ...zero(), sellerDebit: amt });
        else lines.push({ section: "FEES", ...base, ...zero(), buyerDebit: amt });
        break;
      }
      case "PAYOFF":
        lines.push({ section: "PAYOFFS", ...base, ...zero(), sellerDebit: amt });
        break;
      case "HOLDBACK":
        lines.push({ section: "HOLDBACKS", ...base, ...zero(), sellerDebit: amt, detail: "Held in escrow pending release conditions" });
        break;
      case "SELLER_CREDIT":
        lines.push({ section: "CREDITS", ...base, ...zero(), sellerDebit: amt, buyerCredit: amt });
        break;
      case "OTHER_DEBIT":
        lines.push({ section: "OTHER", ...base, ...zero(), ...(item.chargeTo === "SELLER" ? { sellerDebit: amt } : { buyerDebit: amt }) });
        break;
      case "OTHER_CREDIT":
        lines.push({ section: "OTHER", ...base, ...zero(), ...(item.chargeTo === "SELLER" ? { sellerCredit: amt } : { buyerCredit: amt }) });
        break;
      case "PRORATION": {
        const cfg = ProrationConfigSchema.safeParse(item.proration);
        if (!cfg.success) {
          warnings.push(`"${item.description}" is missing proration settings and was skipped.`);
          break;
        }
        let r;
        try {
          r = prorate({
            amountCents: amt,
            periodStart: parseDateOnly(cfg.data.periodStart),
            periodEnd: parseDateOnly(cfg.data.periodEnd),
            closingDate: input.settlementDate,
            basis: input.conventions.basis,
            sellerOwnsClosingDay: input.conventions.sellerOwnsClosingDay,
            rounding: input.conventions.rounding,
          });
        } catch (e) {
          warnings.push(`"${item.description}": ${(e as Error).message}.`);
          break;
        }
        const detail = `${r.sellerDays} seller day(s), ${r.buyerDays} buyer day(s); ${r.formula}`;
        if (cfg.data.type === "PREPAID_BY_SELLER") {
          lines.push({ section: "PRORATIONS", ...base, ...zero(), buyerDebit: r.buyerShareCents, sellerCredit: r.buyerShareCents, detail: `Seller paid in advance; buyer reimburses buyer's share. ${detail}` });
        } else if (cfg.data.type === "UNPAID_ARREARS") {
          lines.push({ section: "PRORATIONS", ...base, ...zero(), sellerDebit: r.sellerShareCents, buyerCredit: r.sellerShareCents, detail: `Unpaid; seller credits buyer for seller's share. ${detail}` });
        } else {
          lines.push({ section: "PRORATIONS", ...base, ...zero(), sellerDebit: r.buyerShareCents, buyerCredit: r.buyerShareCents, detail: `Rent collected by seller; seller credits buyer for days after closing. ${detail}` });
        }
        break;
      }
      default:
        warnings.push(`Unknown item type ${item.kind} skipped.`);
    }
  }

  const sum = (k: keyof Pick<StatementLine, "buyerDebit" | "buyerCredit" | "sellerDebit" | "sellerCredit">) => lines.reduce((a, l) => a + l[k], 0n);
  const totals: StatementTotals = {
    buyerDebits: sum("buyerDebit"),
    buyerCredits: sum("buyerCredit"),
    sellerDebits: sum("sellerDebit"),
    sellerCredits: sum("sellerCredit"),
    dueFromBuyer: 0n,
    dueToSeller: 0n,
  };
  totals.dueFromBuyer = totals.buyerDebits - totals.buyerCredits;
  totals.dueToSeller = totals.sellerCredits - totals.sellerDebits;
  return { lines, totals, warnings };
}

/** JSON-safe serialization (bigint → string) for snapshots. */
export function serializeStatement(s: { lines: StatementLine[]; totals: StatementTotals }) {
  const conv = (o: object) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  return { lines: s.lines.map(conv), totals: conv(s.totals) };
}
