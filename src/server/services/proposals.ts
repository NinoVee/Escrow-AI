import { db } from "../db";
import { isExternal, requirePermission, requireUser, type Ctx } from "../context";
import { invalid, notFound, precondition } from "../errors";
import { audit } from "../audit";
import { fieldDef, fromColumnValue, parseFieldInput, type StoredValue, type TxFieldKey } from "../fields";
import { loadDefinition, lockAndBump, syncTemplateTasks } from "../workflow/engine";
import { applyFieldValue, addParticipant } from "./transactions";
import { loadTransaction } from "./access";
import { getCompanySettings } from "../settings";
import { parseDateOnly } from "@/lib/dates";
import type { Prisma } from "@/generated/prisma/client";
import type { DeadlineType } from "@/generated/prisma/enums";

/**
 * Proposals become authoritative only through these functions, which require
 * `proposal.review` (officers and managers). Nothing in the AI pipeline can
 * call them.
 */

export async function listProposals(ctx: Ctx, transactionId: string, filter: { documentId?: string; status?: "PENDING" | "ALL" } = {}) {
  if (isExternal(ctx)) throw notFound("Transaction");
  await loadTransaction(ctx, transactionId);
  return db.proposal.findMany({
    where: {
      companyId: ctx.companyId,
      transactionId,
      ...(filter.documentId ? { documentId: filter.documentId } : {}),
      ...(filter.status === "ALL" ? {} : { status: "PENDING" }),
    },
    orderBy: [{ isConflict: "desc" }, { kind: "asc" }, { createdAt: "asc" }],
  });
}

async function loadPending(ctx: Ctx, proposalId: string) {
  if (isExternal(ctx)) throw notFound("Proposal");
  requirePermission(ctx, "proposal.review");
  const p = await db.proposal.findFirst({ where: { id: proposalId, companyId: ctx.companyId } });
  if (!p) throw notFound("Proposal");
  if (p.status !== "PENDING") throw precondition(`This proposal is already ${p.status.toLowerCase()}.`);
  return p;
}

export interface AcceptOptions {
  /** Staff may correct the value before accepting (e.g. fix OCR errors). */
  overrideValue?: string;
  /** Required when the proposal conflicts with an accepted value. */
  confirmConflict?: boolean;
  /** Required for deadlines without a computed date. */
  date?: string;
  note?: string;
}

export async function acceptProposal(ctx: Ctx, proposalId: string, opts: AcceptOptions = {}) {
  const p = await loadPending(ctx, proposalId);
  const actorId = requireUser(ctx);
  if (p.isConflict && !opts.confirmConflict) {
    throw precondition("This value conflicts with an accepted value or another document. Confirm that you reviewed both sources before accepting.");
  }
  const doc = p.documentId ? await db.document.findUnique({ where: { id: p.documentId } }) : null;
  const settings = await getCompanySettings(ctx.companyId);
  if (doc?.category === "AMENDMENT" && settings.procedures.requireOfficerReviewOfAmendments && !["ESCROW_OFFICER", "MANAGER", "COMPANY_ADMIN"].includes(ctx.role as string)) {
    throw precondition("Company procedure requires an escrow officer to accept changes from amendments.");
  }
  const meta = { documentId: p.documentId, documentVersionId: p.documentVersionId, page: p.page, excerpt: p.excerpt, confidence: p.confidence, proposalId: p.id };

  if (p.kind === "FIELD") {
    const key = p.fieldPath as TxFieldKey;
    if (!fieldDef(key)) throw invalid("Unknown field.");
    let value: StoredValue = p.proposedValue as StoredValue;
    if (opts.overrideValue !== undefined && opts.overrideValue !== "") {
      try {
        value = parseFieldInput(key, opts.overrideValue);
      } catch (e) {
        throw invalid((e as Error).message);
      }
    }
    await db.$transaction(async (client) => {
      const tx0 = await loadTransaction(ctx, p.transactionId, client);
      if (tx0.status === "CLOSED" || tx0.status === "CANCELLED") throw precondition("Reopen the file before accepting changes.");
      const version = await lockAndBump(client, tx0.id);
      const tx = await client.transaction.findUniqueOrThrow({ where: { id: tx0.id } });
      const { previous } = await applyFieldValue(client, ctx, tx, key, value, {
        source: "DOCUMENT_EXTRACTION",
        reason: opts.note ?? (opts.overrideValue ? "Accepted with correction" : "Accepted from document"),
        ...meta,
      });
      await client.proposal.update({ where: { id: p.id }, data: { status: "ACCEPTED", decidedById: actorId, decidedAt: new Date(), decisionNote: opts.note ?? null, proposedValue: value as Prisma.InputJsonValue } });
      // Other pending proposals for the same field are now superseded by this decision.
      await client.proposal.updateMany({
        where: { transactionId: tx.id, kind: "FIELD", fieldPath: key, status: "PENDING", id: { not: p.id } },
        data: { status: "SUPERSEDED", decisionNote: "Another value for this field was accepted" },
      });
      const fresh = await client.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      await syncTemplateTasks(client, fresh, await loadDefinition(tx.templateVersionId, client), actorId);
      await audit(ctx, {
        action: "proposal.accepted",
        entityType: "Transaction",
        entityId: tx.id,
        entityVersion: version,
        transactionId: tx.id,
        summary: `${fieldDef(key)!.label} accepted from ${doc ? `"${doc.title}"` : "document"}${p.page ? ` p.${p.page}` : ""}${p.isConflict ? " (conflict reviewed)" : ""}`,
        details: { proposalId: p.id, field: key, previous, value, corrected: Boolean(opts.overrideValue), lowConfidence: p.lowConfidence },
      }, client);
    });
    return;
  }

  const v = p.proposedValue as Record<string, unknown>;
  if (p.kind === "PARTY") {
    await addParticipant(ctx, p.transactionId, {
      role: (v.role === "OTHER" ? "OTHER" : v.role) as "BUYER",
      displayName: String(opts.overrideValue || v.name),
      partyType: (v.partyType ?? "INDIVIDUAL") as "INDIVIDUAL",
      notes: `Added from document proposal${doc ? ` (${doc.title}${p.page ? ` p.${p.page}` : ""})` : ""}`,
    });
  } else if (p.kind === "PROPERTY") {
    await db.$transaction(async (client) => {
      const tx = await loadTransaction(ctx, p.transactionId, client);
      await lockAndBump(client, tx.id);
      let property = await client.property.findFirst({ where: { transactionId: tx.id }, orderBy: { sortOrder: "asc" } });
      const address = (opts.overrideValue || (v.address as string | null)) ?? null;
      if (!property || (address && !v.apn)) {
        const parsed = parseAddress(address);
        property = await client.property.create({ data: { companyId: ctx.companyId, transactionId: tx.id, street: parsed.street, city: parsed.city, postalCode: parsed.postalCode, state: "CA", sortOrder: await client.property.count({ where: { transactionId: tx.id } }) } });
      }
      if (v.apn) {
        await client.parcel.create({ data: { companyId: ctx.companyId, propertyId: property.id, apn: String(v.apn), legalDescription: (v.legalDescription as string | null) ?? null } });
      }
      const fresh = await client.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      await syncTemplateTasks(client, fresh, await loadDefinition(tx.templateVersionId, client), actorId);
    });
  } else if (p.kind === "DEADLINE") {
    const date = opts.date || (v.date as string | null);
    if (!date) throw invalid("Enter the due date to accept this deadline.");
    parseDateOnly(date);
    const { createDeadline } = await import("./tasks");
    await createDeadline(ctx, p.transactionId, { title: String(v.title), type: (v.type as DeadlineType) ?? "CONTRACT", dueDate: date, notes: p.rationale ?? undefined, documentId: p.documentId ?? undefined, page: p.page ?? undefined, excerpt: p.excerpt ?? undefined }, "AI_PROPOSAL");
  } else if (p.kind === "TASK") {
    const { createTask } = await import("./tasks");
    await createTask(ctx, p.transactionId, { title: String(opts.overrideValue || v.title), description: p.rationale ?? undefined }, "AI_PROPOSAL");
  } else if (p.kind === "TITLE_EXCEPTION") {
    const { addTitleException } = await import("./title");
    await addTitleException(ctx, p.transactionId, { documentId: p.documentId!, itemNumber: (v.itemNumber as string | null) ?? undefined, category: String(v.category ?? "OTHER"), description: String(v.text), page: p.page ?? undefined, aiSummary: String(v.summary ?? "") }, "AI_PROPOSAL");
  }
  await db.$transaction(async (client) => {
    await client.proposal.update({ where: { id: p.id }, data: { status: "ACCEPTED", decidedById: actorId, decidedAt: new Date(), decisionNote: opts.note ?? null } });
    await audit(ctx, { action: "proposal.accepted", entityType: "Proposal", entityId: p.id, transactionId: p.transactionId, summary: `Accepted proposed ${p.kind.toLowerCase().replace("_", " ")} from ${doc ? `"${doc.title}"` : "document"}` }, client);
  });
}

export async function rejectProposal(ctx: Ctx, proposalId: string, note: string) {
  const p = await loadPending(ctx, proposalId);
  if (!note?.trim()) throw invalid("Say why the proposal is rejected.");
  await db.$transaction(async (client) => {
    await client.proposal.update({ where: { id: p.id }, data: { status: "REJECTED", decidedById: ctx.userId, decidedAt: new Date(), decisionNote: note.trim() } });
    await audit(ctx, { action: "proposal.rejected", entityType: "Proposal", entityId: p.id, transactionId: p.transactionId, summary: `Rejected proposed ${p.kind.toLowerCase().replace("_", " ")}${p.fieldPath ? ` (${fieldDef(p.fieldPath)?.label})` : ""}`, details: { note } }, client);
  });
}

function parseAddress(address: string | null) {
  if (!address) return { street: "Address pending", city: "Unknown", postalCode: null };
  const parts = address.split(",").map((s) => s.trim());
  const zip = /\b(\d{5})(?:-\d{4})?\b/.exec(address)?.[1] ?? null;
  return { street: parts[0] || address, city: parts[1] || "Unknown", postalCode: zip };
}

/** Current value used by the review UI for side-by-side display. */
export function currentValueFor(tx: Record<string, unknown>, fieldPath: string) {
  return fromColumnValue(fieldPath as TxFieldKey, tx[fieldPath]);
}
