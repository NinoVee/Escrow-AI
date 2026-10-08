import { describe, expect, it } from "vitest";
import { allocate, divRound, formatCents, parseMoneyToCents, sumCents } from "@/lib/money";
import { parseDateOnly, todayInZone } from "@/lib/dates";

describe("money", () => {
  it("parses amounts exactly", () => {
    expect(parseMoneyToCents("$1,234.56")).toBe(123456n);
    expect(parseMoneyToCents("0.1")).toBe(10n);
    expect(parseMoneyToCents("-12")).toBe(-1200n);
    expect(parseMoneyToCents("14,250,000.00")).toBe(1_425_000_000n);
    expect(() => parseMoneyToCents("1.234")).toThrow();
    expect(() => parseMoneyToCents("1,23.00")).toThrow();
    expect(() => parseMoneyToCents("abc")).toThrow();
  });

  it("avoids floating point drift (0.1 + 0.2)", () => {
    expect(parseMoneyToCents("0.10") + parseMoneyToCents("0.20")).toBe(30n);
    expect(sumCents(Array.from({ length: 1000 }, () => 1n))).toBe(1000n);
  });

  it("formats", () => {
    expect(formatCents(123456789n)).toBe("$1,234,567.89");
    expect(formatCents(-5n)).toBe("-$0.05");
    expect(formatCents(0n)).toBe("$0.00");
  });

  it("rounds explicitly", () => {
    expect(divRound(5n, 2n, "HALF_UP")).toBe(3n);
    expect(divRound(5n, 2n, "HALF_EVEN")).toBe(2n);
    expect(divRound(7n, 2n, "HALF_EVEN")).toBe(4n);
    expect(divRound(-5n, 2n, "HALF_UP")).toBe(-3n);
    expect(divRound(10n, 3n)).toBe(3n);
    expect(divRound(20n, 3n)).toBe(7n);
  });

  it("allocates without losing or creating cents", () => {
    const parts = allocate(100n, [1n, 1n, 1n]);
    expect(sumCents(parts)).toBe(100n);
    expect(parts).toEqual([34n, 33n, 33n]);
    expect(sumCents(allocate(1_000_001n, [3n, 7n]))).toBe(1_000_001n);
  });
});

describe("dates", () => {
  it("parses date-only values without timezone drift", () => {
    expect(parseDateOnly("2026-10-30").toISOString()).toBe("2026-10-30T00:00:00.000Z");
    expect(parseDateOnly("10/30/2026").toISOString()).toBe("2026-10-30T00:00:00.000Z");
    expect(() => parseDateOnly("2026-02-29")).toThrow();
  });

  it("computes today in the company time zone", () => {
    // 2026-10-09 03:00 UTC is still Oct 8 in Los Angeles.
    expect(todayInZone("America/Los_Angeles", new Date("2026-10-09T03:00:00Z")).toISOString().slice(0, 10)).toBe("2026-10-08");
  });
});
