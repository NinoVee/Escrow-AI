import type { AiProvider, DraftKind } from "./provider";
import type { PageText } from "./prompts";
import type { Answer, ContractExtraction, Draft, ExtractedValue, OcrResult, Summary, TitleExceptions } from "./schemas";

/**
 * DEMO adapter: deterministic pattern matching, not AI. It exists so the full
 * review workflow can be exercised without credentials. Every value it returns
 * carries the exact line it matched, and it reports null when no pattern
 * matches. It is labeled "Demo" everywhere in the UI.
 */
const NONE: ExtractedValue = { value: null, page: null, excerpt: null, confidence: 0 };
/** Exact pattern matches whose excerpt is verified later; unverified ones are still flagged. */
const DEMO_CONFIDENCE = 0.8;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function toIsoDate(s: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (iso) return s.trim();
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function findLine(pages: PageText[], re: RegExp): { page: number; line: string; match: RegExpExecArray } | null {
  for (const p of pages) {
    for (const line of p.text.split(/\r?\n/)) {
      const m = re.exec(line);
      if (m) return { page: p.page, line: line.trim(), match: m };
    }
  }
  return null;
}

function value(pages: PageText[], re: RegExp, map: (m: RegExpExecArray) => string | null = (m) => m[1]): ExtractedValue {
  const hit = findLine(pages, re);
  if (!hit) return NONE;
  const v = map(hit.match);
  if (v === null) return NONE;
  return { value: v, page: hit.page, excerpt: hit.line.slice(0, 200), confidence: DEMO_CONFIDENCE };
}

const money = (m: RegExpExecArray) => m[1].replaceAll(",", "");

function classify(text: string): { type: ContractExtraction["documentType"]; confidence: number } {
  const t = text.toLowerCase();
  if (/amendment|addendum/.test(t)) return { type: "AMENDMENT", confidence: 0.7 };
  if (/counter ?offer/.test(t)) return { type: "COUNTER_OFFER", confidence: 0.7 };
  if (/purchase (and sale )?agreement/.test(t)) return { type: "PURCHASE_AGREEMENT", confidence: 0.8 };
  if (/preliminary report|title commitment|schedule b/.test(t)) return { type: "TITLE_REPORT", confidence: 0.8 };
  if (/payoff/.test(t)) return { type: "PAYOFF_STATEMENT", confidence: 0.7 };
  if (/rent roll/.test(t)) return { type: "RENT_ROLL", confidence: 0.7 };
  if (/estoppel/.test(t)) return { type: "ESTOPPEL", confidence: 0.6 };
  if (/operating agreement|resolution|written consent/.test(t)) return { type: "ENTITY_DOCUMENTS", confidence: 0.6 };
  if (/lender|pre-approval|loan approval/.test(t)) return { type: "LENDER_INSTRUCTIONS", confidence: 0.5 };
  return { type: "OTHER", confidence: 0.3 };
}

export class DemoProvider implements AiProvider {
  readonly name = "demo-rules";
  readonly model = null;
  readonly mode = "DEMO" as const;

  async extractContract(pages: PageText[]): Promise<ContractExtraction> {
    const all = pages.map((p) => p.text).join("\n");
    const c = classify(all);
    const fin = value(pages, /\b(Conventional|FHA|VA|Cash)\b(?: financing| loan)?/i, (m) => m[1].toUpperCase());
    const flag = (re: RegExp) => value(pages, re, () => "true");
    const fields: ContractExtraction["fields"] = {
      purchasePrice: value(pages, /Purchase Price:\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i, money),
      initialDeposit: value(pages, /(?:Initial|Earnest Money) Deposit:\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i, money),
      additionalDeposit: value(pages, /Additional Deposit:\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i, money),
      loanAmount: value(pages, /Loan Amount:\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i, money),
      financingType: fin,
      // An amendment's "Effective Date" is not the contract acceptance date.
      acceptanceDate: value(pages, c.type === "AMENDMENT" ? /Acceptance Date:\s*([A-Za-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})/i : /(?:Acceptance Date|Effective Date):\s*([A-Za-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})/i, (m) => toIsoDate(m[1])),
      closingDate: value(pages, /(?:Close of Escrow|Closing Date):\s*([A-Za-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})/i, (m) => toIsoDate(m[1])),
      hasHoa: flag(/homeowners association|common interest development/i),
      hasTenants: flag(/\btenants?\b|rent roll|estoppel/i),
      is1031Exchange: flag(/tax-deferred exchange|\b1031\b/i),
    };

    const parties: ContractExtraction["parties"] = [];
    const buyer = findLine(pages, /(?:^|\s)Buyer:?\s+(?!signature)([A-Z][\w&.,' -]+?)(?:,\s*a\b|\s+offers\b|$)/);
    if (buyer) parties.push({ role: "BUYER", name: buyer.match[1].trim(), partyType: entityType(buyer.line), page: buyer.page, excerpt: buyer.line.slice(0, 200), confidence: DEMO_CONFIDENCE });
    const seller = findLine(pages, /^Seller:\s+([A-Z][\w&.,' -]+?)\s*$/);
    if (seller) parties.push({ role: "SELLER", name: seller.match[1].trim(), partyType: entityType(seller.line), page: seller.page, excerpt: seller.line.slice(0, 200), confidence: DEMO_CONFIDENCE });

    const properties: ContractExtraction["properties"] = [];
    const addr = findLine(pages, /Property Address:\s*(.+)$/i);
    const apn = findLine(pages, /Assessor's Parcel No\.?:\s*([\d-]+)/i);
    if (addr || apn) {
      properties.push({ address: addr?.match[1].trim() ?? null, apn: apn?.match[1] ?? null, legalDescription: null, page: (addr ?? apn)!.page, excerpt: (addr ?? apn)!.line.slice(0, 200), confidence: DEMO_CONFIDENCE });
    }
    const parcels = findLine(pages, /^Parcels:\s*(.+)$/i);
    if (parcels) {
      for (const n of parcels.match[1].split(/[,;]\s*/)) {
        if (/^\d[\d-]+$/.test(n.trim())) properties.push({ address: null, apn: n.trim(), legalDescription: null, page: parcels.page, excerpt: parcels.line.slice(0, 200), confidence: DEMO_CONFIDENCE });
      }
    }

    const timePeriods: ContractExtraction["timePeriods"] = [];
    for (const p of pages) {
      for (const raw of p.text.split(/\r?\n/)) {
        const line = raw.trim();
        const m = /^(.+?(?:Contingency|Period)):\s*(\d+) days after (?:the )?(?:Acceptance|Effective Date)/i.exec(line);
        if (m) timePeriods.push({ title: m[1], type: "CONTINGENCY", date: null, daysAfterAcceptance: Number(m[2]), page: p.page, excerpt: line.slice(0, 200), confidence: DEMO_CONFIDENCE });
      }
    }
    if (fields.closingDate.value) {
      timePeriods.push({ title: "Close of escrow", type: "CLOSING", date: fields.closingDate.value, daysAfterAcceptance: null, page: fields.closingDate.page, excerpt: fields.closingDate.excerpt, confidence: DEMO_CONFIDENCE });
    }

    const suggestedTasks: ContractExtraction["suggestedTasks"] = [];
    const est = findLine(pages, /estoppel/i);
    if (est) suggestedTasks.push({ title: "Request tenant estoppel certificates required by the agreement", reason: "The agreement refers to estoppel certificates.", page: est.page, excerpt: est.line.slice(0, 200), confidence: DEMO_CONFIDENCE });
    const xch = findLine(pages, /exchange/i);
    if (xch) suggestedTasks.push({ title: "Confirm exchange documents and cooperation language with the qualified intermediary", reason: "The agreement refers to an exchange.", page: xch.page, excerpt: xch.line.slice(0, 200), confidence: DEMO_CONFIDENCE });
    const disc = findLine(pages, /Disclosures delivered within (\d+) days/i);
    if (disc) suggestedTasks.push({ title: "Track delivery of seller disclosures", reason: "The agreement sets a delivery period for disclosures.", page: disc.page, excerpt: disc.line.slice(0, 200), confidence: DEMO_CONFIDENCE });

    const found = Object.values(fields).filter((f) => f.value !== null).length;
    return {
      documentType: c.type,
      documentTypeConfidence: c.confidence,
      summary: `Demo extraction (rule-based, not AI): matched ${found} field pattern(s), ${parties.length} party line(s) and ${timePeriods.length} time period(s). Values are proposals only and must be verified against the document.`,
      fields,
      parties,
      properties,
      timePeriods,
      suggestedTasks,
    };
  }

  async extractTitleExceptions(pages: PageText[]): Promise<TitleExceptions> {
    const items: TitleExceptions["items"] = [];
    for (const p of pages) {
      const lines = p.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(\d{1,3})\.\s+(.+)$/.exec(lines[i]);
        if (!m) continue;
        let text = m[2].trim();
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) text += " " + lines[++i].trim();
        const t = text.toLowerCase();
        const category: TitleExceptions["items"][number]["category"] = /tax/.test(t) ? "TAXES" : /deed of trust/.test(t) ? "DEED_OF_TRUST" : /judgment/.test(t) ? "JUDGMENT" : /lien/.test(t) ? "LIEN" : /easement/.test(t) ? "EASEMENT" : /covenants|conditions and restrictions|cc&r/.test(t) ? "CCRS" : /statement of information|requirement/.test(t) ? "REQUIREMENT" : "OTHER";
        items.push({ itemNumber: m[1], category, text, plainLanguageSummary: `Demo classification: ${category.replaceAll("_", " ").toLowerCase()} item as listed in the report. Confirm treatment with the title officer.`, page: p.page });
      }
    }
    return { items };
  }

  async summarize(pages: PageText[]): Promise<Summary> {
    const first = pages.flatMap((p) => p.text.split(/\r?\n/).filter((l) => l.trim().length > 20).slice(0, 2).map((l) => ({ point: l.trim().slice(0, 160), page: p.page as number | null })));
    return { summary: "Demo mode: no AI summary generated. The first substantive lines of each page are shown as key points.", keyPoints: first.slice(0, 8) };
  }

  async answer(question: string, passages: PageText[]): Promise<Answer> {
    if (passages.length === 0) return { answer: "Demo mode: no matching passages were found in documents you can access.", insufficientEvidence: true, citations: [] };
    return {
      answer: "Demo mode: no AI answer was generated. These are the passages that best match your question; read them to confirm the answer.",
      insufficientEvidence: false,
      citations: passages.slice(0, 4).map((p) => ({ passageId: p.id, excerpt: bestLine(p.text, question) })),
    };
  }

  async draft(kind: DraftKind, facts: Record<string, string>): Promise<Draft> {
    const name = facts.recipientName ?? "there";
    const file = facts.escrowNumber ?? "your escrow";
    const property = facts.property ? ` for ${facts.property}` : "";
    const footer = "\n\nFor your protection: we will never send or change wiring instructions by email. Always verify instructions by calling our office at a phone number you already know.\n\n(Demo template; not AI-generated.)";
    if (kind === "DOCUMENT_REQUEST") {
      return { subject: `Escrow ${file}: document needed`, body: `Hello ${name},\n\nTo keep escrow ${file}${property} on schedule, please upload the following through the secure portal: ${facts.items ?? "the requested documents"}.${facts.dueDate ? ` We need this by ${facts.dueDate}.` : ""}\n\nThank you.${footer}` };
    }
    if (kind === "DEADLINE_REMINDER") {
      return { subject: `Escrow ${file}: upcoming deadline`, body: `Hello ${name},\n\nThis is a reminder that "${facts.deadline ?? "a deadline"}" is due ${facts.dueDate ?? "soon"} for escrow ${file}${property}. Please contact your agent or our office with any questions.${footer}` };
    }
    return { subject: `Escrow ${file}: status update`, body: `Hello ${name},\n\nEscrow ${file}${property} is currently in the "${facts.stage ?? "in progress"}" stage.${facts.closingDate ? ` The estimated closing date is ${facts.closingDate}, subject to change.` : ""}${facts.openItems ? ` Open items: ${facts.openItems}.` : ""}${footer}` };
  }

  async ocr(): Promise<OcrResult | null> {
    return null;
  }
}

function entityType(line: string): ContractExtraction["parties"][number]["partyType"] {
  if (/\bLLC\b|limited liability/i.test(line)) return "LLC";
  if (/\btrust\b/i.test(line)) return "TRUST";
  if (/\b(inc|corp|corporation)\b/i.test(line)) return "CORPORATION";
  if (/partnership|\bLP\b/i.test(line)) return "PARTNERSHIP";
  return "INDIVIDUAL";
}

function bestLine(text: string, question: string) {
  const terms = question.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let best = lines[0] ?? "";
  let score = -1;
  for (const l of lines) {
    const s = terms.filter((t) => l.toLowerCase().includes(t)).length;
    if (s > score) {
      score = s;
      best = l;
    }
  }
  return best.trim().slice(0, 200);
}
