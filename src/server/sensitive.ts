/**
 * Detects content that must not travel through ordinary email or portal
 * messages: bank account/routing numbers, SSNs, and similar identifiers.
 * Heuristic by design; it errs toward blocking.
 */
const PATTERNS: { label: string; re: RegExp }[] = [
  { label: "a Social Security number", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { label: "a bank routing number", re: /\b(routing|aba|rtn)\b[^\d]{0,20}\d{9}\b/i },
  { label: "a bank account number", re: /\b(acct|account)(\s*(no|number|#))?[^\d]{0,20}\d{6,17}\b/i },
  { label: "wire instructions", re: /\b(wire instructions|beneficiary account|swift|iban)\b/i },
  { label: "a long numeric identifier", re: /\b\d{12,19}\b/ },
];

export function detectSensitiveContent(text: string): string[] {
  return PATTERNS.filter((p) => p.re.test(text)).map((p) => p.label);
}
