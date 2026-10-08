/**
 * Exact money handling in integer minor units (cents) using BigInt.
 * No floating-point arithmetic is used anywhere in money paths.
 */

const MONEY_RE = /^\s*(-)?\$?\s*(\d{1,3}(,\d{3})*|\d+)(\.(\d{1,2}))?\s*$/;

/** Parses "$1,234.56", "1234.5", "-12" into cents. Rejects >2 decimal places. */
export function parseMoneyToCents(input: string): bigint {
  const m = MONEY_RE.exec(input);
  if (!m) throw new Error(`Invalid amount: "${input}"`);
  const negative = Boolean(m[1]);
  const whole = BigInt(m[2].replaceAll(",", ""));
  const frac = m[5] ? BigInt(m[5].padEnd(2, "0")) : 0n;
  const cents = whole * 100n + frac;
  return negative ? -cents : cents;
}

export function formatCents(cents: bigint, opts: { sign?: boolean } = {}): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const s = `$${wholeStr}.${frac}`;
  if (negative) return `-${s}`;
  return opts.sign && cents > 0n ? `+${s}` : s;
}

/** Plain decimal string without symbols, e.g. "1234.56". */
export function centsToDecimalString(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export type RoundingMode = "HALF_UP" | "HALF_EVEN";

/**
 * Exact rational division rounded to an integer: numerator / denominator.
 * HALF_UP rounds halves away from zero; HALF_EVEN rounds halves to even.
 */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode = "HALF_UP"): bigint {
  if (denominator === 0n) throw new Error("Division by zero");
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  let q = n / denominator;
  const r = n % denominator;
  const twice = r * 2n;
  if (twice > denominator) q += 1n;
  else if (twice === denominator) {
    if (mode === "HALF_UP" || q % 2n === 1n) q += 1n;
  }
  return negative ? -q : q;
}

/** Allocates `total` across weights so the parts sum exactly to total (largest remainder). */
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum <= 0n) throw new Error("Weights must sum to a positive value");
  const base = weights.map((w) => (total * w) / sum);
  let remainder = total - base.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));
  const step = remainder >= 0n ? 1n : -1n;
  for (let k = 0; remainder !== 0n; k = (k + 1) % order.length) {
    base[order[k].i] += step;
    remainder -= step;
  }
  return base;
}

export function sumCents(values: bigint[]): bigint {
  return values.reduce((a, b) => a + b, 0n);
}
