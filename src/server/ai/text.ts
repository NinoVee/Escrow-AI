import { extractText, getDocumentProxy } from "unpdf";

/**
 * Text extraction. Born-digital PDFs are read locally with unpdf (pdf.js).
 * Scanned PDFs and images need OCR, which is delegated to the configured
 * provider (Anthropic document/vision input) and is unavailable in demo mode.
 */
export interface ExtractedPages {
  pages: string[];
  needsOcr: boolean;
}

const MIN_CHARS_PER_PAGE = 25;

export async function extractPdfText(data: Buffer): Promise<ExtractedPages> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((t) => t ?? "");
  const total = pages.reduce((n, p) => n + p.trim().length, 0);
  return { pages, needsOcr: total < MIN_CHARS_PER_PAGE * Math.max(1, pages.length) };
}

/** Image formats the Anthropic vision input accepts. TIFF must be converted first. */
export const OCR_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

// ---------------------------------------------------------------------------
// Prompt-injection indicators
// ---------------------------------------------------------------------------

const INDICATORS: { label: string; re: RegExp }[] = [
  { label: "Asks to ignore prior instructions", re: /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|all)\b.{0,20}\b(instructions|rules|prompts?)\b/i },
  { label: "Claims a system or assistant role", re: /^\s*(system|assistant|developer)\s*:/im },
  { label: "Attempts role reassignment", re: /\byou are now\b|\bact as\b.{0,30}\b(officer|admin|escrow)/i },
  { label: "Requests approval or release of funds", re: /\b(approve|release|send|initiate)\b.{0,40}\b(disbursement|wire|payment|funds)\b/i },
  { label: "Requests a bank-detail change", re: /\b(change|update|replace)\b.{0,40}\b(bank|account|routing|wiring)\b/i },
  { label: "Requests permissions", re: /\b(grant|give|elevate)\b.{0,30}\b(admin|permission|access|privilege)/i },
  { label: "Asserts title or funding status", re: /\b(declare|mark|confirm)\b.{0,30}\b(title clear|funding complete|funds received)\b/i },
];

export interface InjectionFlag {
  label: string;
  page: number;
  excerpt: string;
}

export function detectInjection(pages: string[]): InjectionFlag[] {
  const flags: InjectionFlag[] = [];
  pages.forEach((text, i) => {
    for (const ind of INDICATORS) {
      const m = ind.re.exec(text);
      if (m) {
        const start = Math.max(0, m.index - 30);
        flags.push({ label: ind.label, page: i + 1, excerpt: text.slice(start, m.index + m[0].length + 30).replace(/\s+/g, " ").trim() });
      }
    }
  });
  return flags;
}

export function normalizeForMatch(s: string) {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

/** True when the excerpt appears in the page text (whitespace/quote-insensitive). */
export function excerptFound(pageText: string | undefined, excerpt: string | null): boolean {
  if (!excerpt || !pageText) return false;
  const e = normalizeForMatch(excerpt).replace(/\.\.\.|…/g, "");
  if (e.length < 4) return false;
  return normalizeForMatch(pageText).includes(e);
}
