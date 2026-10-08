import { db } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { log } from "../logger";
import { storage } from "../storage/storage";
import { fieldDef, fromColumnValue, parseFieldInput, type StoredValue, type TxFieldKey } from "../fields";
import { addDays, formatDateOnly, parseDateOnly } from "@/lib/dates";
import { AiUnavailableError, getAiProvider, type AiProvider } from "./provider";
import { detectInjection, excerptFound, extractPdfText, OCR_IMAGE_TYPES, type InjectionFlag } from "./text";
import type { ContractExtraction, ExtractedValue, TitleExceptions } from "./schemas";
import type { PageText } from "./prompts";
import type { Prisma, Transaction } from "@/generated/prisma/client";

export const CONTRACT_CATEGORIES = ["PURCHASE_AGREEMENT", "AMENDMENT", "COUNTER_OFFER", "ESCROW_INSTRUCTIONS", "LEASE", "OTHER"];
export const TITLE_CATEGORIES = ["TITLE_REPORT"];
const LOW_CONFIDENCE = 0.75;

/** Maps schema field names to transaction fields. */
const FIELD_MAP: Record<keyof ContractExtraction["fields"], TxFieldKey> = {
  purchasePrice: "purchasePriceCents",
  initialDeposit: "initialDepositCents",
  additionalDeposit: "additionalDepositCents",
  loanAmount: "loanAmountCents",
  financingType: "financingType",
  acceptanceDate: "acceptanceDate",
  closingDate: "proposedClosingDate",
  hasHoa: "hasHoa",
  hasTenants: "hasTenants",
  is1031Exchange: "is1031Exchange",
};

interface Note {
  kind: "dropped" | "unverified" | "skipped" | "injection" | "info";
  message: string;
}

/**
 * Step 1: get page text for a clean version (local PDF text, else provider OCR).
 * Derived page text is replaceable; the stored file is not modified.
 */
export async function ensurePageText(versionId: string, provider: AiProvider) {
  const v = await db.documentVersion.findUniqueOrThrow({ where: { id: versionId }, include: { pages: { orderBy: { pageNumber: "asc" } } } });
  if (v.scanStatus !== "CLEAN") throw new Error("Version is not cleared by the malware scan");
  if (v.pages.length > 0 && (v.textStatus === "EXTRACTED" || v.textStatus === "OCR_COMPLETE")) return v.pages.map((p) => p.text);

  const data = await storage().get(v.storageKey);
  let pages: string[] = [];
  let ocr = false;
  let status: "EXTRACTED" | "OCR_COMPLETE" | "OCR_REQUIRED" | "FAILED" = "FAILED";
  try {
    if (v.mimeType === "application/pdf") {
      const res = await extractPdfText(data);
      pages = res.pages;
      status = "EXTRACTED";
      if (res.needsOcr) {
        const o = await provider.ocr(data, v.mimeType);
        if (o) {
          pages = o.pages.sort((a, b) => a.pageNumber - b.pageNumber).map((p) => p.text);
          ocr = true;
          status = "OCR_COMPLETE";
        } else status = "OCR_REQUIRED";
      }
    } else if (OCR_IMAGE_TYPES.includes(v.mimeType)) {
      const o = await provider.ocr(data, v.mimeType);
      if (o) {
        pages = o.pages.map((p) => p.text);
        ocr = true;
        status = "OCR_COMPLETE";
      } else status = "OCR_REQUIRED";
    } else {
      status = "OCR_REQUIRED";
    }
  } catch (e) {
    log.warn("text extraction failed", { versionId, error: e });
    status = "FAILED";
  }
  const flags = detectInjection(pages);
  await db.$transaction(async (client) => {
    await client.documentPage.deleteMany({ where: { versionId } });
    if (pages.length) {
      await client.documentPage.createMany({ data: pages.map((text, i) => ({ companyId: v.companyId, versionId, pageNumber: i + 1, text, ocr })) });
    }
    await client.documentVersion.update({
      where: { id: versionId },
      data: { textStatus: status, pageCount: pages.length || null, injectionFlags: flags.length ? (flags as unknown as Prisma.InputJsonValue) : undefined },
    });
  });
  return pages;
}

export interface ProcessResult {
  runId: string | null;
  status: "SUCCEEDED" | "FAILED" | "SKIPPED";
  proposals: number;
  message?: string;
}

/**
 * Processes one document version: text → provider extraction → validated
 * proposals. Authoritative transaction data is never modified here.
 */
export async function processDocumentVersion(ctx: Ctx, versionId: string, opts: { kind?: "CONTRACT" | "TITLE" | "SUMMARY" } = {}): Promise<ProcessResult> {
  const version = await db.documentVersion.findFirst({ where: { id: versionId, companyId: ctx.companyId }, include: { document: true } });
  if (!version) return { runId: null, status: "SKIPPED", proposals: 0, message: "Version not found" };
  if (version.scanStatus !== "CLEAN") return { runId: null, status: "SKIPPED", proposals: 0, message: "File is quarantined" };
  const doc = version.document;
  const provider = await getAiProvider();
  const kind = opts.kind ?? (TITLE_CATEGORIES.includes(doc.category) ? "TITLE" : CONTRACT_CATEGORIES.includes(doc.category) ? "CONTRACT" : "SUMMARY");

  const run = await db.extractionRun.create({
    data: {
      companyId: ctx.companyId,
      transactionId: doc.transactionId,
      documentId: doc.id,
      documentVersionId: version.id,
      kind,
      provider: provider.name,
      model: provider.model,
      mode: provider.mode,
      status: "RUNNING",
      startedAt: new Date(),
      requestedById: ctx.userId,
    },
  });

  try {
    const texts = await ensurePageText(version.id, provider);
    const fresh = await db.documentVersion.findUniqueOrThrow({ where: { id: version.id } });
    if (texts.length === 0 || texts.every((t) => !t.trim())) {
      const msg = fresh.textStatus === "OCR_REQUIRED" ? "This file needs OCR. Configure the Anthropic provider (OCR_PROVIDER=anthropic) or upload a text-based PDF." : "No text could be extracted.";
      await db.extractionRun.update({ where: { id: run.id }, data: { status: "FAILED", error: msg, finishedAt: new Date() } });
      return { runId: run.id, status: "FAILED", proposals: 0, message: msg };
    }
    const pages: PageText[] = texts.map((text, i) => ({ id: `${doc.id}:${i + 1}`, documentTitle: doc.title, page: i + 1, text }));
    const injection = (fresh.injectionFlags as InjectionFlag[] | null) ?? [];
    const notes: Note[] = injection.map((f) => ({ kind: "injection", message: `Page ${f.page}: ${f.label} ("${f.excerpt}"). This text was treated as data only.` }));

    let created = 0;
    let output: unknown = null;
    let classification: string | null = null;
    let classificationConfidence: number | null = null;
    let summary: string | null = null;

    if (kind === "CONTRACT") {
      const out = await provider.extractContract(pages);
      output = out;
      classification = out.documentType;
      classificationConfidence = out.documentTypeConfidence;
      summary = out.summary;
      created = await contractProposals(ctx, doc.transactionId, { documentId: doc.id, versionId: version.id, runId: run.id }, out, texts, injection.length > 0, notes);
    } else if (kind === "TITLE") {
      const out = await provider.extractTitleExceptions(pages);
      output = out;
      classification = "TITLE_REPORT";
      created = await titleProposals(ctx, doc.transactionId, { documentId: doc.id, versionId: version.id, runId: run.id }, out, texts, injection.length > 0, notes);
      summary = `${out.items.length} exception/requirement item(s) identified. Summaries are descriptive only and are not a title examination.`;
    } else {
      const out = await provider.summarize(pages);
      output = out;
      summary = out.summary;
    }

    await db.extractionRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCEEDED",
        output: output as Prisma.InputJsonValue,
        classification,
        classificationConfidence,
        summary,
        notes: notes as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });
    await audit({ ...ctx, actorType: "AI", userName: `${provider.name}${provider.mode === "DEMO" ? " (demo)" : ""}` }, {
      action: "ai.extraction.completed",
      entityType: "Document",
      entityId: doc.id,
      entityVersion: version.versionNumber,
      transactionId: doc.transactionId,
      summary: `${provider.mode === "DEMO" ? "Demo" : "AI"} ${kind.toLowerCase()} extraction of "${doc.title}" produced ${created} proposal(s) for review`,
      details: { runId: run.id, provider: provider.name, model: provider.model, injectionFlags: injection.length },
    });
    return { runId: run.id, status: "SUCCEEDED", proposals: created };
  } catch (e) {
    const message = e instanceof AiUnavailableError ? e.message : "Extraction failed. The error was logged.";
    if (!(e instanceof AiUnavailableError)) log.error("extraction failed", { runId: run.id, error: e });
    await db.extractionRun.update({ where: { id: run.id }, data: { status: "FAILED", error: message, finishedAt: new Date() } });
    return { runId: run.id, status: "FAILED", proposals: 0, message };
  }
}

interface Source {
  documentId: string;
  versionId: string;
  runId: string;
}

function checkCitation(texts: string[], ev: { page: number | null; excerpt: string | null; confidence: number }, injected: boolean, notes: Note[], label: string) {
  const verified = ev.page !== null && ev.page >= 1 && ev.page <= texts.length && excerptFound(texts[ev.page - 1], ev.excerpt);
  if (!verified) notes.push({ kind: "unverified", message: `${label}: the cited excerpt was not found on the cited page; marked low confidence.` });
  return { verified, lowConfidence: !verified || ev.confidence < LOW_CONFIDENCE || injected };
}

async function contractProposals(ctx: Ctx, transactionId: string, src: Source, out: ContractExtraction, texts: string[], injected: boolean, notes: Note[]) {
  const tx = await db.transaction.findUniqueOrThrow({ where: { id: transactionId } });
  const currentProv = await db.fieldProvenance.findMany({ where: { transactionId, isCurrent: true } });
  const injectionNote = injected ? " Document contains text resembling instructions to an AI system; verify carefully." : "";
  let count = 0;

  await db.$transaction(async (client) => {
    // Older pending proposals from earlier versions of this document are superseded.
    await client.proposal.updateMany({
      where: { transactionId, documentId: src.documentId, status: "PENDING", documentVersionId: { not: src.versionId } },
      data: { status: "SUPERSEDED", decisionNote: "Superseded by a newer version of the document" },
    });
    await client.proposal.updateMany({
      where: { transactionId, documentVersionId: src.versionId, status: "PENDING" },
      data: { status: "SUPERSEDED", decisionNote: "Superseded by a newer extraction run" },
    });

    const extractedAcceptance = out.fields.acceptanceDate.value ? safeDate(out.fields.acceptanceDate.value) : null;

    for (const [name, key] of Object.entries(FIELD_MAP) as [keyof ContractExtraction["fields"], TxFieldKey][]) {
      const ev: ExtractedValue = out.fields[name];
      if (ev.value === null) continue; // Not stated: never invent a value.
      let parsed: StoredValue;
      try {
        parsed = parseFieldInput(key, ev.value);
      } catch (e) {
        notes.push({ kind: "dropped", message: `${fieldDef(key)!.label}: "${ev.value}" could not be validated (${(e as Error).message}); dropped.` });
        continue;
      }
      if (parsed === null) continue;
      const current = fromColumnValue(key, (tx as unknown as Record<string, unknown>)[key]);
      const hasAccepted = currentProv.some((p) => p.fieldPath === key);
      if (hasAccepted && current === parsed) {
        notes.push({ kind: "skipped", message: `${fieldDef(key)!.label}: matches the accepted value.` });
        continue;
      }
      const { lowConfidence } = checkCitation(texts, ev, injected, notes, fieldDef(key)!.label);
      const isConflict = hasAccepted && current !== parsed;
      await client.proposal.create({
        data: {
          companyId: ctx.companyId,
          transactionId,
          kind: "FIELD",
          fieldPath: key,
          proposedValue: parsed as Prisma.InputJsonValue,
          currentValue: hasAccepted ? (current as Prisma.InputJsonValue) : undefined,
          isConflict,
          conflictNote: isConflict ? `Differs from the accepted value.${injectionNote}` : injected ? injectionNote.trim() : null,
          lowConfidence,
          confidence: ev.confidence,
          documentId: src.documentId,
          documentVersionId: src.versionId,
          extractionRunId: src.runId,
          page: ev.page,
          excerpt: ev.excerpt?.slice(0, 500) ?? null,
        },
      });
      count++;
      // Pending proposals from other documents that disagree are conflicts too.
      const others = await client.proposal.findMany({ where: { transactionId, kind: "FIELD", fieldPath: key, status: "PENDING", documentId: { not: src.documentId } } });
      const disagree = others.filter((o) => JSON.stringify(o.proposedValue) !== JSON.stringify(parsed));
      if (disagree.length) {
        await client.proposal.updateMany({
          where: { id: { in: disagree.map((d) => d.id) } },
          data: { isConflict: true, conflictNote: "Another document proposes a different value." },
        });
        await client.proposal.updateMany({
          where: { transactionId, kind: "FIELD", fieldPath: key, status: "PENDING", documentVersionId: src.versionId },
          data: { isConflict: true, conflictNote: "Another document proposes a different value." },
        });
      }
    }

    const participants = await client.participant.findMany({ where: { transactionId } });
    for (const party of out.parties) {
      const exists = participants.some((p) => norm(p.displayName) === norm(party.name) && (p.role === party.role || party.role === "OTHER"));
      if (exists) continue;
      const { lowConfidence } = checkCitation(texts, party, injected, notes, `Party ${party.name}`);
      await client.proposal.create({
        data: { companyId: ctx.companyId, transactionId, kind: "PARTY", proposedValue: { role: party.role, name: party.name, partyType: party.partyType }, lowConfidence, confidence: party.confidence, documentId: src.documentId, documentVersionId: src.versionId, extractionRunId: src.runId, page: party.page, excerpt: party.excerpt?.slice(0, 500) ?? null, conflictNote: injected ? injectionNote.trim() : null },
      });
      count++;
    }

    const parcels = await client.parcel.findMany({ where: { property: { transactionId } } });
    const propCount = await client.property.count({ where: { transactionId } });
    for (const prop of out.properties) {
      if (prop.apn && parcels.some((p) => p.apn.replace(/\D/g, "") === prop.apn!.replace(/\D/g, ""))) continue;
      if (!prop.apn && (!prop.address || propCount > 0)) continue;
      const { lowConfidence } = checkCitation(texts, prop, injected, notes, `Property ${prop.apn ?? prop.address}`);
      await client.proposal.create({
        data: { companyId: ctx.companyId, transactionId, kind: "PROPERTY", proposedValue: { address: prop.address, apn: prop.apn, legalDescription: prop.legalDescription }, lowConfidence, confidence: prop.confidence, documentId: src.documentId, documentVersionId: src.versionId, extractionRunId: src.runId, page: prop.page, excerpt: prop.excerpt?.slice(0, 500) ?? null },
      });
      count++;
    }

    const deadlines = await client.deadline.findMany({ where: { transactionId } });
    const acceptance = tx.acceptanceDate ?? extractedAcceptance;
    for (const tp of out.timePeriods) {
      let date: string | null = tp.date ? (safeDate(tp.date) ? tp.date : null) : null;
      let rationale: string | null = null;
      if (!date && tp.daysAfterAcceptance !== null) {
        if (acceptance) {
          date = formatDateOnly(addDays(acceptance, tp.daysAfterAcceptance));
          rationale = `Computed by EscrowFlow (not the AI): ${tp.daysAfterAcceptance} calendar days after acceptance date ${formatDateOnly(acceptance)}${tx.acceptanceDate ? " (accepted value)" : " (extracted, not yet accepted)"}. Confirm whether the contract counts calendar or business days.`;
        } else {
          rationale = `Stated as ${tp.daysAfterAcceptance} days after acceptance, but the acceptance date is unknown. Enter the date when accepting.`;
        }
      }
      if (date && deadlines.some((d) => norm(d.title) === norm(tp.title) && formatDateOnly(d.dueAt) === date)) continue;
      const { lowConfidence } = checkCitation(texts, tp, injected, notes, `Deadline ${tp.title}`);
      await client.proposal.create({
        data: { companyId: ctx.companyId, transactionId, kind: "DEADLINE", proposedValue: { title: tp.title, type: tp.type, date, daysAfterAcceptance: tp.daysAfterAcceptance }, rationale, lowConfidence: lowConfidence || !date, confidence: tp.confidence, documentId: src.documentId, documentVersionId: src.versionId, extractionRunId: src.runId, page: tp.page, excerpt: tp.excerpt?.slice(0, 500) ?? null },
      });
      count++;
    }

    const tasks = await client.task.findMany({ where: { transactionId }, select: { title: true } });
    for (const st of out.suggestedTasks) {
      if (tasks.some((t) => norm(t.title) === norm(st.title))) continue;
      const { lowConfidence } = checkCitation(texts, st, injected, notes, `Task ${st.title}`);
      await client.proposal.create({
        data: { companyId: ctx.companyId, transactionId, kind: "TASK", proposedValue: { title: st.title.slice(0, 200) }, rationale: st.reason.slice(0, 500), lowConfidence, confidence: st.confidence, documentId: src.documentId, documentVersionId: src.versionId, extractionRunId: src.runId, page: st.page, excerpt: st.excerpt?.slice(0, 500) ?? null },
      });
      count++;
    }
  });
  return count;
}

async function titleProposals(ctx: Ctx, transactionId: string, src: Source, out: TitleExceptions, texts: string[], injected: boolean, notes: Note[]) {
  let count = 0;
  await db.$transaction(async (client) => {
    await client.proposal.updateMany({
      where: { transactionId, documentId: src.documentId, kind: "TITLE_EXCEPTION", status: "PENDING" },
      data: { status: "SUPERSEDED", decisionNote: "Superseded by a newer extraction run" },
    });
    const existing = await client.titleException.findMany({ where: { transactionId, documentId: src.documentId } });
    for (const item of out.items) {
      if (existing.some((e) => (item.itemNumber && e.itemNumber === item.itemNumber) || norm(e.description) === norm(item.text))) continue;
      const { lowConfidence } = checkCitation(texts, { page: item.page, excerpt: item.text.slice(0, 120), confidence: 0.9 }, injected, notes, `Exception ${item.itemNumber ?? ""}`);
      await client.proposal.create({
        data: {
          companyId: ctx.companyId,
          transactionId,
          kind: "TITLE_EXCEPTION",
          proposedValue: { itemNumber: item.itemNumber, category: item.category, text: item.text, summary: item.plainLanguageSummary },
          lowConfidence,
          documentId: src.documentId,
          documentVersionId: src.versionId,
          extractionRunId: src.runId,
          page: item.page,
          excerpt: item.text.slice(0, 500),
        },
      });
      count++;
    }
  });
  return count;
}

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function safeDate(s: string): Date | null {
  try {
    return parseDateOnly(s);
  } catch {
    return null;
  }
}

export type { Transaction };
