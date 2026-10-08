import { divRound, type RoundingMode } from "@/lib/money";
import { daysBetween, formatDateOnly } from "@/lib/dates";

/**
 * Deterministic prorations in integer cents.
 *
 * Conventions (explicit, configurable per company):
 * - basis ACTUAL_ACTUAL: daily rate = amount / actual days in the period.
 * - basis ACTUAL_365: daily rate = amount / 365 for annual periods (365 or
 *   366 days); shorter periods fall back to actual days in the period.
 * - basis BANKER_360: 30/360 day counting for both the elapsed days and the
 *   period length.
 * - sellerOwnsClosingDay: whether the seller is charged for the closing date.
 * - The seller's share is rounded once using the configured mode; the buyer's
 *   share is the exact remainder, so shares always sum to the amount.
 *
 * These conventions vary by contract, county and company practice; they must be
 * confirmed for each file. This is a draft estimate, not an official statement.
 */
export type ProrationBasis = "ACTUAL_365" | "ACTUAL_ACTUAL" | "BANKER_360";

export interface ProrationInput {
  amountCents: bigint;
  periodStart: Date; // inclusive
  periodEnd: Date; // inclusive
  closingDate: Date;
  basis: ProrationBasis;
  sellerOwnsClosingDay: boolean;
  rounding: RoundingMode;
}

export interface ProrationResult {
  periodDays: number;
  denominator: number;
  sellerDays: number;
  buyerDays: number;
  sellerShareCents: bigint;
  buyerShareCents: bigint;
  formula: string;
}

function days360(a: Date, b: Date): number {
  // US (NASD) 30/360 between a (inclusive) and b (exclusive)
  let d1 = a.getUTCDate();
  let d2 = b.getUTCDate();
  if (d1 === 31) d1 = 30;
  if (d2 === 31 && d1 >= 30) d2 = 30;
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 360 + (b.getUTCMonth() - a.getUTCMonth()) * 30 + (d2 - d1);
}

export function prorate(input: ProrationInput): ProrationResult {
  const { amountCents, periodStart, periodEnd, closingDate, basis, sellerOwnsClosingDay, rounding } = input;
  if (periodEnd < periodStart) throw new Error("Proration period end is before its start");
  if (closingDate < periodStart || closingDate > periodEnd) throw new Error("Closing date must fall within the proration period");
  const endExclusive = new Date(periodEnd.getTime() + 86_400_000);
  const sellerEndExclusive = sellerOwnsClosingDay ? new Date(closingDate.getTime() + 86_400_000) : closingDate;

  let periodDays: number;
  let sellerDays: number;
  let denominator: number;
  if (basis === "BANKER_360") {
    periodDays = days360(periodStart, endExclusive);
    sellerDays = days360(periodStart, sellerEndExclusive);
    denominator = periodDays;
  } else {
    periodDays = daysBetween(periodStart, endExclusive);
    sellerDays = daysBetween(periodStart, sellerEndExclusive);
    denominator = basis === "ACTUAL_365" && periodDays >= 365 ? 365 : periodDays;
  }
  sellerDays = Math.max(0, Math.min(sellerDays, denominator));
  const buyerDays = Math.max(0, periodDays - sellerDays);
  const sellerShareCents = divRound(amountCents * BigInt(sellerDays), BigInt(denominator), rounding);
  const buyerShareCents = amountCents - sellerShareCents;
  return {
    periodDays,
    denominator,
    sellerDays,
    buyerDays,
    sellerShareCents,
    buyerShareCents,
    formula: `${amountCents} × ${sellerDays}/${denominator} (${basis}, ${rounding}, period ${formatDateOnly(periodStart)}–${formatDateOnly(periodEnd)}, seller ${sellerOwnsClosingDay ? "owns" : "does not own"} closing day)`,
  };
}
