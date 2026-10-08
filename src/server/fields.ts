import { z } from "zod";
import { parseMoneyToCents, formatCents } from "@/lib/money";
import { formatDateOnly, parseDateOnly } from "@/lib/dates";

/**
 * Transaction fields whose authoritative values are tracked with provenance.
 * The `parse` function converts an incoming JSON value (from a form, or an AI
 * proposal) into the stored representation, rejecting anything malformed.
 * Unknown values are represented as null and are never invented.
 */
export type FieldKind = "money" | "date" | "enum" | "boolean" | "text";

export interface FieldDef {
  key: TxFieldKey;
  label: string;
  kind: FieldKind;
  options?: readonly string[];
}

export const TX_FIELDS = [
  { key: "purchasePriceCents", label: "Purchase price", kind: "money" },
  { key: "initialDepositCents", label: "Initial deposit", kind: "money" },
  { key: "additionalDepositCents", label: "Additional deposit", kind: "money" },
  { key: "loanAmountCents", label: "Loan amount", kind: "money" },
  {
    key: "financingType",
    label: "Financing",
    kind: "enum",
    options: ["CASH", "CONVENTIONAL", "FHA", "VA", "SELLER_CARRY", "COMMERCIAL_LOAN", "OTHER"],
  },
  { key: "acceptanceDate", label: "Acceptance date", kind: "date" },
  { key: "proposedClosingDate", label: "Proposed closing date", kind: "date" },
  { key: "hasHoa", label: "HOA applies", kind: "boolean" },
  { key: "hasTenants", label: "Tenants in possession", kind: "boolean" },
  { key: "is1031Exchange", label: "1031 exchange", kind: "boolean" },
  { key: "title", label: "File title", kind: "text" },
] as const satisfies readonly { key: string; label: string; kind: FieldKind; options?: readonly string[] }[];

export type TxFieldKey = (typeof TX_FIELDS)[number]["key"];

export const TX_FIELD_KEYS = TX_FIELDS.map((f) => f.key) as TxFieldKey[];

export function fieldDef(key: string): FieldDef | undefined {
  return (TX_FIELDS as readonly FieldDef[]).find((f) => f.key === key);
}

export function isTxField(key: string): key is TxFieldKey {
  return TX_FIELD_KEYS.includes(key as TxFieldKey);
}

/** Stored JSON form for provenance rows: money as string cents, dates as YYYY-MM-DD. */
export type StoredValue = string | boolean | null;

export function parseFieldInput(key: TxFieldKey, input: unknown): StoredValue {
  const def = fieldDef(key)!;
  if (input === null || input === undefined || input === "") return null;
  switch (def.kind) {
    case "money": {
      if (typeof input === "number") {
        throw new Error("Money values must be provided as strings to avoid floating-point rounding.");
      }
      const cents = parseMoneyToCents(String(input));
      if (cents < 0n) throw new Error(`${def.label} cannot be negative`);
      return cents.toString();
    }
    case "date":
      return formatDateOnly(parseDateOnly(String(input)));
    case "enum": {
      const v = String(input).toUpperCase();
      if (!def.options!.includes(v)) throw new Error(`${def.label} must be one of ${def.options!.join(", ")}`);
      return v;
    }
    case "boolean":
      if (typeof input === "boolean") return input;
      if (input === "true" || input === "on") return true;
      if (input === "false") return false;
      throw new Error(`${def.label} must be true or false`);
    case "text":
      return z.string().max(200).parse(String(input));
  }
}

/** Converts a stored value to the Prisma column value. */
export function toColumnValue(key: TxFieldKey, v: StoredValue): unknown {
  const def = fieldDef(key)!;
  if (v === null) return def.kind === "boolean" ? false : null;
  switch (def.kind) {
    case "money":
      return BigInt(v as string);
    case "date":
      return parseDateOnly(v as string);
    default:
      return v;
  }
}

/** Reads the current column value into the stored representation. */
export function fromColumnValue(key: TxFieldKey, raw: unknown): StoredValue {
  if (raw === null || raw === undefined) return null;
  const def = fieldDef(key)!;
  switch (def.kind) {
    case "money":
      return (raw as bigint).toString();
    case "date":
      return formatDateOnly(raw as Date);
    case "boolean":
      return Boolean(raw);
    default:
      return String(raw);
  }
}

export function displayValue(key: string, v: unknown): string {
  const def = fieldDef(key);
  if (v === null || v === undefined || v === "") return "—";
  if (!def) return String(v);
  switch (def.kind) {
    case "money":
      return formatCents(BigInt(v as string));
    case "boolean":
      return v ? "Yes" : "No";
    case "enum":
      return String(v).replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
    default:
      return String(v);
  }
}
