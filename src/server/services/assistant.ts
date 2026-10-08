import { db } from "../db";
import { isExternal, requirePermission, requireUser, type Ctx } from "../context";
import { invalid, notFound, precondition } from "../errors";
import { audit } from "../audit";
import { RateLimitedError, rateLimit } from "../rate-limit";
import { documentScope, loadTransaction } from "./access";
import { getAiProvider, type DraftKind } from "../ai/provider";
import { excerptFound, normalizeForMatch } from "../ai/text";
import { processDocumentVersion } from "../ai/pipeline";
import { detectSensitiveContent } from "../sensitive";
import { loadDefinition, stageLabel } from "../workflow/engine";
import { displayValue, fieldDef } from "../fields";
import { displayDate } from "@/lib/dates";
import type { PageText } from "../ai/prompts";
import type { ContractExtraction } from "../ai/schemas";

const STOPWORDS = new Set("the a an and or of to in on for is are was were be by with what when who which does do did this that from as at it its how much many any there their about".split(" "));

function terms(q: string) {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9$.-]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t)))];
}

/**
 * Retrieves passages ONLY from documents the actor is permitted to read
 * (same scope used for listing and downloads). Quarantined and archived
 * documents are excluded.
 */
export async function retrievePassages(ctx: Ctx, transactionId: string, question: string, limit = 6): Promise<PageText[]> {
  const scope = await documentScope(ctx, transactionId);
  const docs = await db.document.findMany({ where: { ...scope, archivedAt: null }, select: { id: true, title: true, currentVersionId: true } });
  const versionIds = docs.map((d) => d.currentVersionId).filter(Boolean) as string[];
  if (!versionIds.length) return [];
  const pages = await db.documentPage.findMany({ where: { versionId: { in: versionIds }, version: { scanStatus: "CLEAN" } }, include: { version: { select: { documentId: true } } } });
  const title = new Map(docs.map((d) => [d.id, d.title]));
  const qs = terms(question);
  const scored = pages
    .map((p) => {
      const text = p.text.toLowerCase();
      const score = qs.reduce((s, t) => s + (text.split(t).length - 1) * (t.length > 6 ? 2 : 1), 0);
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map(({ p }) => ({ id: `${p.version.documentId}:${p.pageNumber}`, documentTitle: title.get(p.version.documentId) ?? "Document", page: p.pageNumber, text: p.text.slice(0, 6000) }));
}

export interface CitedAnswer {
  answer: string;
  insufficientEvidence: boolean;
  citations: { documentId: string; documentTitle: string; page: number; excerpt: string; verified: boolean }[];
  mode: "LIVE" | "DEMO";
  droppedCitations: number;
}

export async function askAssistant(ctx: Ctx, transactionId: string, question: string): Promise<CitedAnswer> {
  if (isExternal(ctx)) throw notFound("Transaction");
  requirePermission(ctx, "ai.use");
  const userId = requireUser(ctx);
  const q = question.trim();
  if (q.length < 5 || q.length > 1000) throw invalid("Ask a question between 5 and 1,000 characters.");
  try {
    await rateLimit(`ai:${userId}`, 30, 60 * 60);
  } catch (e) {
    if (e instanceof RateLimitedError) throw invalid("Assistant limit reached for this hour.");
    throw e;
  }
  await loadTransaction(ctx, transactionId);
  const passages = await retrievePassages(ctx, transactionId, q);
  const provider = await getAiProvider();
  const res = passages.length ? await provider.answer(q, passages) : { answer: "No passages in documents you can access mention this.", insufficientEvidence: true, citations: [] };

  // Only citations that point at passages we supplied, with excerpts that exist in them, are shown as verified.
  const byId = new Map(passages.map((p) => [p.id, p]));
  let dropped = 0;
  const citations = res.citations.flatMap((c) => {
    const p = byId.get(c.passageId);
    if (!p) {
      dropped++;
      return [];
    }
    return [{ documentId: p.id.split(":")[0], documentTitle: p.documentTitle, page: p.page, excerpt: c.excerpt.slice(0, 300), verified: excerptFound(p.text, c.excerpt) }];
  });
  const insufficient = res.insufficientEvidence || citations.length === 0;
  const answer = insufficient && !res.insufficientEvidence ? `${res.answer}\n\n(No supporting citation could be verified. Treat this as unconfirmed.)` : res.answer;

  await db.assistantInteraction.create({
    data: { companyId: ctx.companyId, transactionId, userId, kind: "QUESTION", prompt: q, response: answer, citations: citations as object, provider: provider.name, model: provider.model, mode: provider.mode },
  });
  await audit(ctx, { action: "ai.question", entityType: "Transaction", entityId: transactionId, transactionId, summary: `Asked the document assistant (${provider.mode === "DEMO" ? "demo" : provider.model})`, details: { passages: passages.length, citations: citations.length, dropped } });
  return { answer, insufficientEvidence: insufficient, citations, mode: provider.mode, droppedCitations: dropped };
}

/** Drafts a message for staff review. Never sends anything. */
export async function draftMessage(ctx: Ctx, transactionId: string, kind: DraftKind, participantId?: string) {
  if (isExternal(ctx)) throw notFound("Transaction");
  requirePermission(ctx, "comms.draft");
  requirePermission(ctx, "ai.use");
  const userId = requireUser(ctx);
  const tx = await loadTransaction(ctx, transactionId);
  const [def, props, participant, deadlines, requests] = await Promise.all([
    loadDefinition(tx.templateVersionId),
    db.property.findMany({ where: { transactionId }, take: 1 }),
    participantId ? db.participant.findFirst({ where: { id: participantId, transactionId } }) : null,
    db.deadline.findMany({ where: { transactionId, status: "PENDING" }, orderBy: { dueAt: "asc" }, take: 1 }),
    participantId ? db.documentRequest.findMany({ where: { transactionId, participantId, status: "OPEN" } }) : [],
  ]);
  if (participantId && !participant) throw notFound("Participant");
  const facts: Record<string, string> = {
    escrowNumber: tx.escrowNumber,
    stage: stageLabel(def, tx.stage),
    ...(props[0] ? { property: `${props[0].street}, ${props[0].city}` } : {}),
    ...(participant ? { recipientName: participant.displayName } : {}),
    ...(tx.proposedClosingDate ? { closingDate: displayDate(tx.proposedClosingDate) } : {}),
    ...(requests.length ? { items: requests.map((r) => r.title).join("; "), dueDate: requests[0].dueAt ? displayDate(requests[0].dueAt) : "" } : {}),
    ...(deadlines[0] ? { deadline: deadlines[0].title, dueDate: displayDate(deadlines[0].dueAt) } : {}),
  };
  const provider = await getAiProvider();
  const draft = await provider.draft(kind, facts);
  const sensitive = detectSensitiveContent(`${draft.subject}\n${draft.body}`);
  if (sensitive.length) throw precondition(`The draft contained ${sensitive.join(", ")} and was discarded.`);
  await db.assistantInteraction.create({ data: { companyId: ctx.companyId, transactionId, userId, kind: `DRAFT_${kind}`, prompt: JSON.stringify(facts), response: `${draft.subject}\n\n${draft.body}`, provider: provider.name, model: provider.model, mode: provider.mode } });
  await audit(ctx, { action: "ai.draft", entityType: "Transaction", entityId: transactionId, transactionId, summary: `Drafted ${kind.toLowerCase().replaceAll("_", " ")} for review (not sent)` });
  return { ...draft, mode: provider.mode };
}

/** Runs (or re-runs) extraction for a document version on request. */
export async function runExtraction(ctx: Ctx, versionId: string, kind?: "CONTRACT" | "TITLE" | "SUMMARY") {
  if (isExternal(ctx)) throw notFound("Document");
  requirePermission(ctx, "ai.use");
  const v = await db.documentVersion.findFirst({ where: { id: versionId, companyId: ctx.companyId }, include: { document: true } });
  if (!v) throw notFound("Document");
  await loadTransaction(ctx, v.document.transactionId);
  try {
    await rateLimit(`extract:${ctx.userId}`, 60, 60 * 60);
  } catch (e) {
    if (e instanceof RateLimitedError) throw invalid("Extraction limit reached for this hour.");
    throw e;
  }
  return processDocumentVersion(ctx, versionId, { kind });
}

// ---------------------------------------------------------------------------
// Document comparison (amendments vs. the agreement). Deterministic.
// ---------------------------------------------------------------------------

const FIELD_KEYS: [keyof ContractExtraction["fields"], string][] = [
  ["purchasePrice", "purchasePriceCents"],
  ["initialDeposit", "initialDepositCents"],
  ["additionalDeposit", "additionalDepositCents"],
  ["loanAmount", "loanAmountCents"],
  ["financingType", "financingType"],
  ["acceptanceDate", "acceptanceDate"],
  ["closingDate", "proposedClosingDate"],
  ["hasHoa", "hasHoa"],
  ["hasTenants", "hasTenants"],
  ["is1031Exchange", "is1031Exchange"],
];

async function latestContractRun(ctx: Ctx, versionId: string) {
  let run = await db.extractionRun.findFirst({ where: { companyId: ctx.companyId, documentVersionId: versionId, kind: "CONTRACT", status: "SUCCEEDED" }, orderBy: { createdAt: "desc" } });
  if (!run) {
    await processDocumentVersion(ctx, versionId, { kind: "CONTRACT" });
    run = await db.extractionRun.findFirst({ where: { companyId: ctx.companyId, documentVersionId: versionId, kind: "CONTRACT", status: "SUCCEEDED" }, orderBy: { createdAt: "desc" } });
  }
  return run;
}

export async function compareDocuments(ctx: Ctx, versionAId: string, versionBId: string) {
  if (isExternal(ctx)) throw notFound("Document");
  requirePermission(ctx, "document.read_internal");
  const [a, b] = await Promise.all([
    db.documentVersion.findFirst({ where: { id: versionAId, companyId: ctx.companyId }, include: { document: true, pages: { orderBy: { pageNumber: "asc" } } } }),
    db.documentVersion.findFirst({ where: { id: versionBId, companyId: ctx.companyId }, include: { document: true, pages: { orderBy: { pageNumber: "asc" } } } }),
  ]);
  if (!a || !b || a.document.transactionId !== b.document.transactionId) throw notFound("Document");
  const tx = await loadTransaction(ctx, a.document.transactionId);
  const [runA, runB] = await Promise.all([latestContractRun(ctx, a.id), latestContractRun(ctx, b.id)]);
  const outA = (runA?.output ?? null) as ContractExtraction | null;
  const outB = (runB?.output ?? null) as ContractExtraction | null;

  const rows = FIELD_KEYS.map(([name, key]) => {
    const va = outA?.fields[name];
    const vb = outB?.fields[name];
    const accepted = (tx as unknown as Record<string, unknown>)[key];
    const status = !va?.value && !vb?.value ? "NOT_STATED" : !va?.value ? "ONLY_B" : !vb?.value ? "ONLY_A" : normalizeForMatch(va.value) === normalizeForMatch(vb.value) ? "SAME" : "CHANGED";
    return {
      field: fieldDef(key)?.label ?? key,
      key,
      a: va?.value ? { value: va.value, page: va.page, excerpt: va.excerpt } : null,
      b: vb?.value ? { value: vb.value, page: vb.page, excerpt: vb.excerpt } : null,
      accepted: accepted == null ? null : displayValue(key, typeof accepted === "bigint" ? accepted.toString() : accepted instanceof Date ? accepted.toISOString().slice(0, 10) : accepted),
      status,
    };
  });

  const linesOf = (pages: { pageNumber: number; text: string }[]) => pages.flatMap((p) => p.text.split(/\r?\n/).map((l) => ({ page: p.pageNumber, line: l.trim() })).filter((x) => x.line.length > 3));
  const la = linesOf(a.pages);
  const lb = linesOf(b.pages);
  const setA = new Set(la.map((x) => normalizeForMatch(x.line)));
  const setB = new Set(lb.map((x) => normalizeForMatch(x.line)));
  const added = lb.filter((x) => !setA.has(normalizeForMatch(x.line))).slice(0, 60);
  const removed = la.filter((x) => !setB.has(normalizeForMatch(x.line))).slice(0, 60);

  await audit(ctx, { action: "document.compared", entityType: "Document", entityId: b.document.id, transactionId: tx.id, summary: `Compared "${a.document.title}" v${a.versionNumber} with "${b.document.title}" v${b.versionNumber}` });
  return {
    a: { title: a.document.title, version: a.versionNumber, documentId: a.document.id, runMode: runA?.mode ?? null },
    b: { title: b.document.title, version: b.versionNumber, documentId: b.document.id, runMode: runB?.mode ?? null },
    rows,
    added,
    removed,
  };
}
