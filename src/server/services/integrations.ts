import { db } from "../db";
import { isExternal, requirePermission, requireUser, type Ctx } from "../context";
import { invalid, notFound, precondition } from "../errors";
import { audit } from "../audit";
import { loadTransaction } from "./access";
import { uploadDocument } from "./documents";
import { integrationMode } from "../integrations/registry";
import { demoESign, demoProperty, demoRecordedDocs, demoRecording, demoTitle } from "../integrations/providers";
import { receiveWebhook, secretFor, signPayload } from "../integrations/webhooks";
import { formatCents } from "@/lib/money";
import { formatDateOnly } from "@/lib/dates";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Provider-backed operations. Every result records the provider, mode and
 * retrieval time. In demo mode, outputs are simulated and labeled as such.
 */

async function requireEnabled(ctx: Ctx, kind: Parameters<typeof integrationMode>[1]) {
  const mode = await integrationMode(ctx.companyId, kind);
  if (mode === "NOT_CONFIGURED") throw precondition("This integration is not configured.");
  return mode;
}

async function propertyInfo(transactionId: string) {
  const props = await db.property.findMany({ where: { transactionId }, include: { parcels: true }, orderBy: { sortOrder: "asc" } });
  return { address: props[0] ? `${props[0].street}, ${props[0].city}, ${props[0].state}` : "", apns: props.flatMap((p) => p.parcels.map((x) => x.apn)), county: props[0]?.county ?? null, props };
}

// ---- Property data and recorded documents ----------------------------------

export async function runPropertyLookup(ctx: Ctx, transactionId: string, kind: "PROPERTY_DATA" | "RECORDED_DOCUMENTS") {
  requirePermission(ctx, "title.manage");
  const userId = requireUser(ctx);
  const tx = await loadTransaction(ctx, transactionId);
  const mode = await requireEnabled(ctx, kind);
  const info = await propertyInfo(tx.id);
  if (!info.address && info.apns.length === 0) throw precondition("Add the property address or APN first.");
  if (kind === "RECORDED_DOCUMENTS" && info.apns.length === 0) throw precondition("Recorded-document search needs an APN.");
  const out = kind === "PROPERTY_DATA" ? await demoProperty.lookup({ address: info.address, apn: info.apns[0] }) : await demoRecordedDocs.search({ apn: info.apns[0], county: info.county ?? undefined });
  return db.$transaction(async (client) => {
    const row = await client.propertyLookup.create({
      data: { companyId: ctx.companyId, transactionId: tx.id, propertyId: info.props[0]?.id ?? null, kind, provider: kind === "PROPERTY_DATA" ? demoProperty.id : demoRecordedDocs.id, mode, query: { address: info.address, apn: info.apns[0] ?? null }, result: out.result as Prisma.InputJsonValue, coverageNote: out.coverageNote, requestedById: userId },
    });
    await audit(ctx, { action: "property.lookup", entityType: "PropertyLookup", entityId: row.id, transactionId: tx.id, summary: `${kind === "PROPERTY_DATA" ? "Property data lookup" : "Recorded-document search"} (${mode.toLowerCase()})` }, client);
    return row;
  });
}

// ---- Title orders ----------------------------------------------------------------

export async function submitProviderTitleOrder(ctx: Ctx, transactionId: string) {
  requirePermission(ctx, "title.manage");
  const userId = requireUser(ctx);
  const tx = await loadTransaction(ctx, transactionId);
  const mode = await requireEnabled(ctx, "TITLE");
  const info = await propertyInfo(tx.id);
  if (!info.address) throw precondition("Add the property before ordering title.");
  const res = await demoTitle.submitOrder({ escrowNumber: tx.escrowNumber, address: info.address, apns: info.apns });
  return db.$transaction(async (client) => {
    const order = await client.titleOrder.create({
      data: { companyId: ctx.companyId, transactionId: tx.id, provider: demoTitle.id, mode, externalRef: res.externalRef, status: "SUBMITTED", orderedById: userId, lastStatusAt: new Date(), notes: "Simulated order (demo provider)" },
    });
    await audit(ctx, { action: "title.order_submitted", entityType: "TitleOrder", entityId: order.id, transactionId: tx.id, summary: `Title order ${res.externalRef} submitted to ${demoTitle.id} (${mode.toLowerCase()})` }, client);
    return order;
  });
}

/** Retrieves the (simulated) report, stores it as a document, and runs extraction. */
export async function receiveProviderTitleReport(ctx: Ctx, orderId: string) {
  requirePermission(ctx, "title.manage");
  const order = await db.titleOrder.findFirst({ where: { id: orderId, companyId: ctx.companyId } });
  if (!order || !order.externalRef) throw notFound("Title order");
  if (order.reportDocumentId) throw precondition("The report was already received.");
  const info = await propertyInfo(order.transactionId);
  const report = await demoTitle.getReport(order.externalRef, { address: info.address, apns: info.apns });
  if (!report) throw precondition("The provider has no report yet.");
  const up = await uploadDocument(ctx, { transactionId: order.transactionId, filename: report.filename, data: report.data, title: `Simulated report ${order.externalRef} (demo, not a title report)`, category: "TITLE_REPORT" });
  await db.$transaction(async (client) => {
    await client.titleOrder.update({ where: { id: order.id }, data: { reportDocumentId: up.document.id, status: "REPORT_RECEIVED", lastStatusAt: new Date() } });
    await audit(ctx, { action: "title.report_received", entityType: "TitleOrder", entityId: order.id, transactionId: order.transactionId, summary: `Report received for ${order.externalRef} (${order.mode.toLowerCase()})` }, client);
  });
  return up.document;
}

// ---- E-signature and e-recording --------------------------------------------

export async function sendForSignature(ctx: Ctx, transactionId: string, input: { documentIds: string[]; signerParticipantIds: string[]; subject: string }) {
  requirePermission(ctx, "comms.draft");
  const userId = requireUser(ctx);
  const tx = await loadTransaction(ctx, transactionId);
  const mode = await requireEnabled(ctx, "ESIGN");
  if (!input.documentIds.length || !input.signerParticipantIds.length) throw invalid("Choose at least one document and one signer.");
  const [docs, signers] = await Promise.all([
    db.document.findMany({ where: { id: { in: input.documentIds }, transactionId: tx.id } }),
    db.participant.findMany({ where: { id: { in: input.signerParticipantIds }, transactionId: tx.id } }),
  ]);
  if (docs.length !== input.documentIds.length || signers.length !== input.signerParticipantIds.length) throw invalid("Documents and signers must belong to this file.");
  const res = await demoESign.createEnvelope({ subject: input.subject, signers: signers.map((s) => s.displayName), documentIds: docs.map((d) => d.id) });
  return db.$transaction(async (client) => {
    const env = await client.signatureEnvelope.create({
      data: { companyId: ctx.companyId, transactionId: tx.id, provider: demoESign.id, mode, externalId: res.externalId, status: "SENT", subject: input.subject.trim() || "Documents for signature", documentIds: docs.map((d) => d.id), signerNames: signers.map((s) => s.displayName), isSimulated: mode !== "LIVE", createdById: userId, lastEventAt: new Date() },
    });
    await audit(ctx, { action: "esign.envelope_sent", entityType: "SignatureEnvelope", entityId: env.id, transactionId: tx.id, summary: `Envelope ${res.externalId} sent to ${signers.map((s) => s.displayName).join(", ")} (${mode.toLowerCase()})` }, client);
    return env;
  });
}

export async function submitRecording(ctx: Ctx, transactionId: string, documentIds: string[]) {
  requirePermission(ctx, "title.manage");
  const userId = requireUser(ctx);
  const tx = await loadTransaction(ctx, transactionId);
  const mode = await requireEnabled(ctx, "RECORDING");
  const docs = await db.document.findMany({ where: { id: { in: documentIds }, transactionId: tx.id } });
  if (!docs.length || docs.length !== documentIds.length) throw invalid("Choose the documents to record.");
  const info = await propertyInfo(tx.id);
  const res = await demoRecording.submit({ county: info.county, documentIds });
  return db.$transaction(async (client) => {
    const sub = await client.recordingSubmission.create({ data: { companyId: ctx.companyId, transactionId: tx.id, provider: demoRecording.id, mode, externalId: res.externalId, documentIds, isSimulated: mode !== "LIVE", createdById: userId, lastEventAt: new Date() } });
    await audit(ctx, { action: "recording.submitted", entityType: "RecordingSubmission", entityId: sub.id, transactionId: tx.id, summary: `Submitted ${docs.length} document(s) for e-recording (${mode.toLowerCase()})` }, client);
    return sub;
  });
}

const NEXT_ENVELOPE: Record<string, string> = { CREATED: "SENT", SENT: "DELIVERED", DELIVERED: "COMPLETED" };
const NEXT_RECORDING: Record<string, string> = { SUBMITTED: "ACCEPTED", ACCEPTED: "RECORDED" };
const NEXT_TITLE: Record<string, string> = { SUBMITTED: "IN_PROGRESS" };

/**
 * DEMO ONLY: produces the provider's next status as a signed webhook and feeds
 * it through the same verification, de-duplication and ordering path a real
 * provider callback would use.
 */
export async function simulateProviderEvent(ctx: Ctx, kind: "ENVELOPE" | "RECORDING" | "TITLE", id: string) {
  if (isExternal(ctx)) throw notFound("Record");
  requirePermission(ctx, "transaction.update");
  let provider: string, type: string, externalId: string, status: string | undefined, simulated: boolean, extra: Record<string, string> = {};
  if (kind === "ENVELOPE") {
    const e = await db.signatureEnvelope.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!e) throw notFound("Envelope");
    [provider, type, externalId, status, simulated] = ["esign-demo", "envelope.status", e.externalId, NEXT_ENVELOPE[e.status], e.isSimulated];
  } else if (kind === "RECORDING") {
    const r = await db.recordingSubmission.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!r) throw notFound("Recording");
    [provider, type, externalId, status, simulated] = ["recording-demo", "recording.status", r.externalId, NEXT_RECORDING[r.status], r.isSimulated];
    if (status === "RECORDED") extra = { instrumentNumber: `DEMO-${formatDateOnly(new Date()).replaceAll("-", "")}-${Math.floor(Math.random() * 9000 + 1000)}` };
  } else {
    const t = await db.titleOrder.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!t?.externalRef) throw notFound("Title order");
    [provider, type, externalId, status, simulated] = ["title-demo", "title.status", t.externalRef, NEXT_TITLE[t.status], t.mode !== "LIVE"];
  }
  if (!simulated) throw precondition("Events can only be simulated for demo records.");
  if (!status) throw precondition("No further simulated events for this record.");
  const body = JSON.stringify({ id: `sim-${crypto.randomUUID()}`, type, occurredAt: new Date().toISOString(), data: { externalId, status, ...extra } });
  return receiveWebhook(provider, signPayload(secretFor(provider), body), body);
}

// ---- Accounting export -------------------------------------------------------

export async function exportJournalCsv(ctx: Ctx, from?: string, to?: string) {
  requirePermission(ctx, "ledger.read");
  const entries = await db.journalEntry.findMany({
    where: { companyId: ctx.companyId, ...(from || to ? { effectiveDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}) },
    include: { lines: { include: { account: true } } },
    orderBy: { entryNumber: "asc" },
  });
  const txs = new Map((await db.transaction.findMany({ where: { companyId: ctx.companyId }, select: { id: true, escrowNumber: true } })).map((t) => [t.id, t.escrowNumber]));
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  const rows = [["entry_number", "effective_date", "kind", "memo", "reference", "account_code", "account_name", "escrow_file", "debit", "credit", "reverses_entry_id"].join(",")];
  for (const e of entries)
    for (const l of e.lines)
      rows.push([String(e.entryNumber), formatDateOnly(e.effectiveDate), e.kind, esc(e.memo), esc(e.reference ?? ""), l.account.code, esc(l.account.name), l.transactionId ? (txs.get(l.transactionId) ?? "") : "", formatCents(l.debitCents).replace(/[$,]/g, ""), formatCents(l.creditCents).replace(/[$,]/g, ""), e.reversesEntryId ?? ""].join(","));
  await audit(ctx, { action: "ledger.exported", entityType: "Company", entityId: ctx.companyId, summary: `Exported ${entries.length} journal entries to CSV` });
  return rows.join("\n") + "\n";
}
