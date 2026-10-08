/**
 * Date conventions
 * - Contract and closing dates are DATE-ONLY values stored as UTC midnight.
 *   They are always formatted in UTC so they never shift by a day.
 * - "Today" and "overdue" are evaluated in the company time zone
 *   (default America/Los_Angeles).
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateOnly(input: string): Date {
  const s = input.trim();
  let m = DATE_RE.exec(s);
  if (!m) {
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (us) m = [s, us[3], us[1].padStart(2, "0"), us[2].padStart(2, "0")] as unknown as RegExpExecArray;
  }
  if (!m) throw new Error(`Invalid date "${input}" (expected YYYY-MM-DD)`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    throw new Error(`Invalid calendar date "${input}"`);
  }
  return date;
}

export function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function displayDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

export function displayDateTime(d: Date | null | undefined, timeZone = "America/Los_Angeles"): string {
  if (!d) return "—";
  return d.toLocaleString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Today's date (UTC midnight representation) in the given time zone. */
export function todayInZone(timeZone = "America/Los_Angeles", now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return parseDateOnly(parts);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/** Whole days from a to b for date-only values (b - a). */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}
