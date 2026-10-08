import { db } from "../db";
import { isExternal, requirePermission, requireUser, type Ctx } from "../context";
import { invalid, notFound } from "../errors";
import { audit } from "../audit";
import { loadTransaction } from "./access";
import type { ExceptionDisposition, IntegrationMode, ItemSource } from "@/generated/prisma/enums";

/**
 * Title workspace. The manual baseline: staff record the title order, upload
 * the report as a document (category TITLE_REPORT) and transcribe exceptions,
 * then record a disposition for each one.
 *
 * Nothing here determines whether title is clear or insurable; that is a
 * professional title examination performed by the title company.
 */

export const TITLE_DISCLAIMER =
  "Exception dispositions are escrow tracking notes. They are not a title examination, and they do not mean that title is clear or insurable. Only the title company's commitment or policy does that.";

export async function recordTitleOrder(ctx: Ctx, transactionId: string, input: { provider: string; externalRef?: string; notes?: string; mode?: IntegrationMode }) {
  requirePermission(ctx, "title.manage");
  const actorId = requireUser(ctx);
  if (!input.provider?.trim()) throw invalid("Title company or provider is required.");
  const tx = await loadTransaction(ctx, transactionId);
  return db.$transaction(async (client) => {
    const order = await client.titleOrder.create({
      data: {
        companyId: ctx.companyId,
        transactionId: tx.id,
        provider: input.provider.trim(),
        mode: input.mode ?? "NOT_CONFIGURED",
        externalRef: input.externalRef?.trim() || null,
        status: "SUBMITTED",
        orderedById: actorId,
        notes: input.notes?.trim() || null,
        lastStatusAt: new Date(),
      },
    });
    await audit(ctx, { action: "title.order_recorded", entityType: "TitleOrder", entityId: order.id, transactionId: tx.id, summary: `Title order recorded with ${order.provider}${order.mode === "NOT_CONFIGURED" ? " (manual)" : ` (${order.mode.toLowerCase()})`}` }, client);
    return order;
  });
}

export async function linkTitleReport(ctx: Ctx, orderId: string, documentId: string) {
  requirePermission(ctx, "title.manage");
  const order = await db.titleOrder.findFirst({ where: { id: orderId, companyId: ctx.companyId } });
  if (!order) throw notFound("Title order");
  const doc = await db.document.findFirst({ where: { id: documentId, transactionId: order.transactionId, companyId: ctx.companyId } });
  if (!doc) throw notFound("Document");
  await db.$transaction(async (client) => {
    await client.titleOrder.update({ where: { id: order.id }, data: { reportDocumentId: doc.id, status: "REPORT_RECEIVED", lastStatusAt: new Date() } });
    if (doc.category !== "TITLE_REPORT") await client.document.update({ where: { id: doc.id }, data: { category: "TITLE_REPORT" } });
    await audit(ctx, { action: "title.report_linked", entityType: "TitleOrder", entityId: order.id, transactionId: order.transactionId, summary: `Title report "${doc.title}" received` }, client);
  });
}

export async function addTitleException(
  ctx: Ctx,
  transactionId: string,
  input: { documentId: string; itemNumber?: string; category?: string; description: string; page?: number; aiSummary?: string },
  source: ItemSource = "MANUAL",
) {
  requirePermission(ctx, "title.manage");
  if (!input.description?.trim()) throw invalid("Describe the exception as written in the report.");
  const tx = await loadTransaction(ctx, transactionId);
  const doc = await db.document.findFirst({ where: { id: input.documentId, transactionId: tx.id, companyId: ctx.companyId } });
  if (!doc) throw invalid("Choose the title report the exception comes from.");
  return db.$transaction(async (client) => {
    const ex = await client.titleException.create({
      data: {
        companyId: ctx.companyId,
        transactionId: tx.id,
        documentId: doc.id,
        itemNumber: input.itemNumber?.trim() || null,
        category: input.category || "OTHER",
        description: input.description.trim(),
        page: input.page ?? null,
        aiSummary: input.aiSummary ?? null,
        source,
      },
    });
    await audit(ctx, { action: "title.exception_added", entityType: "TitleException", entityId: ex.id, transactionId: tx.id, summary: `Title exception ${ex.itemNumber ?? ""} added`.trim() }, client);
    return ex;
  });
}

export async function setExceptionDisposition(ctx: Ctx, exceptionId: string, disposition: ExceptionDisposition, note: string) {
  requirePermission(ctx, "title.manage");
  if (isExternal(ctx)) throw notFound("Title exception");
  const ex = await db.titleException.findFirst({ where: { id: exceptionId, companyId: ctx.companyId } });
  if (!ex) throw notFound("Title exception");
  if (disposition !== "OPEN" && !note?.trim()) throw invalid("Record the basis for this disposition (e.g. payoff demand received, buyer approval in writing).");
  await db.$transaction(async (client) => {
    await client.titleException.update({ where: { id: ex.id }, data: { disposition, dispositionNote: note?.trim() || null, updatedById: ctx.userId } });
    await audit(ctx, { action: "title.exception_disposition", entityType: "TitleException", entityId: ex.id, transactionId: ex.transactionId, summary: `Exception ${ex.itemNumber ?? ex.id.slice(-4)} → ${disposition.toLowerCase().replaceAll("_", " ")}`, details: { note } }, client);
  });
}

export async function titleWorkspace(ctx: Ctx, transactionId: string) {
  if (isExternal(ctx)) throw notFound("Transaction");
  requirePermission(ctx, "transaction.read");
  const tx = await loadTransaction(ctx, transactionId);
  const [orders, exceptions, lookups, reports] = await Promise.all([
    db.titleOrder.findMany({ where: { transactionId: tx.id, companyId: ctx.companyId }, orderBy: { orderedAt: "desc" } }),
    db.titleException.findMany({ where: { transactionId: tx.id, companyId: ctx.companyId }, orderBy: [{ itemNumber: "asc" }, { createdAt: "asc" }] }),
    db.propertyLookup.findMany({ where: { transactionId: tx.id, companyId: ctx.companyId }, orderBy: { retrievedAt: "desc" } }),
    db.document.findMany({ where: { transactionId: tx.id, companyId: ctx.companyId, category: { in: ["TITLE_REPORT", "TITLE_UNDERLYING"] }, archivedAt: null }, select: { id: true, title: true, currentVersionId: true } }),
  ]);
  return { orders, exceptions, lookups, reports };
}
