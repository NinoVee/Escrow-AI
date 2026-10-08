import { randomUUID } from "node:crypto";
import { db } from "../db";
import { hasPermission, isExternal, requirePermission, requireUser, type Ctx } from "../context";
import { AppError, forbidden, invalid, notFound, precondition } from "../errors";
import { audit } from "../audit";
import { env } from "../env";
import { sha256Hex } from "../crypto";
import { storage } from "../storage/storage";
import { safeFilename, sniffMime, ALLOWED_DOCUMENT_TYPES } from "../storage/filetype";
import { scanBuffer } from "../storage/scanner";
import { documentScope, loadDocument, loadTransaction, myParticipantIds } from "./access";
import { onDocumentVersionStored } from "./document-pipeline";
import { getCompanySettings } from "../settings";
import { parseDateOnly } from "@/lib/dates";
import type { ReviewDecision } from "@/generated/prisma/enums";

export const DOCUMENT_CATEGORIES = [
  "PURCHASE_AGREEMENT",
  "AMENDMENT",
  "COUNTER_OFFER",
  "ESCROW_INSTRUCTIONS",
  "TITLE_REPORT",
  "TITLE_UNDERLYING",
  "PAYOFF_STATEMENT",
  "HOA_DEMAND",
  "LENDER_INSTRUCTIONS",
  "ENTITY_DOCUMENTS",
  "SIGNING_AUTHORITY",
  "IDENTITY_VERIFICATION",
  "DISCLOSURE",
  "INSPECTION",
  "SURVEY",
  "ENVIRONMENTAL",
  "LEASE",
  "RENT_ROLL",
  "ESTOPPEL",
  "SNDA",
  "EXCHANGE_1031",
  "SETTLEMENT_STATEMENT",
  "FUNDING_EVIDENCE",
  "RECORDING_CONFIRMATION",
  "BANK_VERIFICATION_EVIDENCE",
  "CORRESPONDENCE",
  "OTHER",
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

/** Categories that must never be shared with external participants through ordinary sharing. */
export const RESTRICTED_CATEGORIES: DocumentCategory[] = ["IDENTITY_VERIFICATION", "BANK_VERIFICATION_EVIDENCE"];

export interface UploadInput {
  transactionId: string;
  filename: string;
  data: Buffer;
  title?: string;
  category?: string;
  /** Upload a new version of an existing document */
  documentId?: string;
  /** Fulfil an open document request (external uploads) */
  requestId?: string;
}

/**
 * Upload pipeline: validate size and type by content → store in quarantine →
 * scan → move to the private documents area if clean. Infected or unscanned
 * files stay quarantined and cannot be downloaded or processed.
 */
export async function uploadDocument(ctx: Ctx, input: UploadInput) {
  const actorId = requireUser(ctx);
  const external = isExternal(ctx);
  if (!external) requirePermission(ctx, "document.upload");
  const tx = await loadTransaction(ctx, input.transactionId);
  if (tx.status === "CLOSED" && external) throw precondition("This file is closed.");

  const maxBytes = env().MAX_UPLOAD_MB * 1024 * 1024;
  if (input.data.length === 0) throw invalid("The file is empty.");
  if (input.data.length > maxBytes) throw invalid(`Files must be ${env().MAX_UPLOAD_MB} MB or smaller.`);
  const mime = sniffMime(input.data);
  if (!mime) throw invalid(`Unsupported file type. Allowed: ${Object.values(ALLOWED_DOCUMENT_TYPES).join(", ")}.`);
  const category = (input.category && (DOCUMENT_CATEGORIES as readonly string[]).includes(input.category) ? input.category : "OTHER") as DocumentCategory;
  const filename = safeFilename(input.filename);

  let participantId: string | null = null;
  let request = null as Awaited<ReturnType<typeof db.documentRequest.findFirst>>;
  if (external) {
    const mine = await myParticipantIds(ctx, tx.id);
    if (mine.length === 0) throw notFound("Transaction");
    participantId = mine[0];
    if (input.documentId) throw forbidden("Participants upload new documents only.");
    if (input.requestId) {
      request = await db.documentRequest.findFirst({ where: { id: input.requestId, transactionId: tx.id, participantId: { in: mine }, status: "OPEN" } });
      if (!request) throw notFound("Document request");
      participantId = request.participantId;
    }
  } else if (input.requestId) {
    request = await db.documentRequest.findFirst({ where: { id: input.requestId, transactionId: tx.id, companyId: ctx.companyId } });
    if (!request) throw notFound("Document request");
  }

  let existing = null as Awaited<ReturnType<typeof db.document.findFirst>>;
  if (input.documentId) {
    existing = await db.document.findFirst({ where: { id: input.documentId, transactionId: tx.id, companyId: ctx.companyId } });
    if (!existing) throw notFound("Document");
  }

  const sha256 = sha256Hex(input.data);
  const quarantineKey = `quarantine/${ctx.companyId}/${randomUUID()}`;
  const store = storage();
  await store.put(quarantineKey, input.data, mime);
  const scan = await scanBuffer(input.data);

  const result = await db.$transaction(async (client) => {
    const doc =
      existing ??
      (await client.document.create({
        data: {
          companyId: ctx.companyId,
          transactionId: tx.id,
          title: input.title?.trim() || request?.title || filename,
          category: request?.category ?? category,
          uploadedById: actorId,
          uploadedByParticipantId: participantId,
          visibility: "INTERNAL",
        },
      }));
    const last = await client.documentVersion.findFirst({ where: { documentId: doc.id }, orderBy: { versionNumber: "desc" } });
    const version = await client.documentVersion.create({
      data: {
        companyId: ctx.companyId,
        documentId: doc.id,
        versionNumber: (last?.versionNumber ?? 0) + 1,
        storageKey: quarantineKey,
        originalFilename: filename,
        mimeType: mime,
        sizeBytes: input.data.length,
        sha256,
        scanStatus: scan.status === "CLEAN" ? "CLEAN" : scan.status === "INFECTED" ? "INFECTED" : "ERROR",
        scanProvider: scan.provider,
        scanDetail: scan.detail,
        scannedAt: new Date(),
        uploadedById: actorId,
        uploadedByParticipantId: participantId,
      },
    });
    if (scan.status === "CLEAN") {
      await client.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    } else if (!existing) {
      // New document whose only version failed scanning: keep it visible to staff as quarantined.
      await client.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    }
    if (request && scan.status === "CLEAN") {
      await client.documentRequest.update({ where: { id: request.id }, data: { status: "SUBMITTED", fulfilledDocumentId: doc.id } });
    }
    await audit(ctx, {
      action: scan.status === "CLEAN" ? "document.uploaded" : "document.quarantined",
      entityType: "Document",
      entityId: doc.id,
      entityVersion: version.versionNumber,
      transactionId: tx.id,
      summary: `${existing ? "New version of" : "Uploaded"} "${doc.title}" (${scan.status === "CLEAN" ? "scan clean" : `held in quarantine: ${scan.status.toLowerCase()}`})`,
      details: { versionId: version.id, sha256, sizeBytes: input.data.length, mime, scanProvider: scan.provider, requestId: request?.id },
    }, client);
    return { document: doc, version };
  });

  if (scan.status === "CLEAN") {
    const finalKey = `documents/${ctx.companyId}/${tx.id}/${result.document.id}/${result.version.id}`;
    await store.move(quarantineKey, finalKey);
    await db.documentVersion.update({ where: { id: result.version.id }, data: { storageKey: finalKey } });
    await onDocumentVersionStored(ctx, result.version.id);
  }
  return { ...result, scan };
}

export async function listDocuments(ctx: Ctx, transactionId: string) {
  await loadTransaction(ctx, transactionId);
  const scope = await documentScope(ctx, transactionId);
  const docs = await db.document.findMany({
    where: scope,
    include: {
      versions: { orderBy: { versionNumber: "desc" }, include: { reviews: { orderBy: { createdAt: "desc" }, take: 1 } } },
      shares: { where: { revokedAt: null }, include: { participant: { select: { displayName: true, role: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
  if (isExternal(ctx)) {
    // External users never see quarantined versions, scan details, or review notes.
    return docs.map((d) => ({
      ...d,
      shares: [],
      versions: d.versions.filter((v) => v.scanStatus === "CLEAN").map((v) => ({ ...v, scanDetail: null, injectionFlags: null, reviews: [] })),
    }));
  }
  return docs;
}

/**
 * Authorizes a download and returns a short-lived URL. Every successful and
 * denied attempt by a signed-in user is audited.
 */
export async function getDownloadUrl(ctx: Ctx, versionId: string) {
  const userId = requireUser(ctx);
  const version = await db.documentVersion.findFirst({ where: { id: versionId, companyId: ctx.companyId } });
  if (!version) throw notFound("Document");
  let doc;
  try {
    doc = await loadDocument(ctx, version.documentId);
  } catch (e) {
    await audit(ctx, { action: "document.download_denied", entityType: "DocumentVersion", entityId: versionId, summary: "Download denied (no access)" });
    throw e;
  }
  if (version.scanStatus !== "CLEAN") {
    await audit(ctx, { action: "document.download_denied", entityType: "DocumentVersion", entityId: versionId, transactionId: doc.transactionId, summary: "Download denied (file quarantined)" });
    throw new AppError("FORBIDDEN", "This file is quarantined and cannot be downloaded.");
  }
  if (isExternal(ctx) && version.id !== doc.currentVersionId) throw notFound("Document");
  const ttl = env().DOWNLOAD_LINK_TTL_SECONDS;
  const url = await storage().signedDownloadUrl(version.storageKey, { filename: version.originalFilename, contentType: version.mimeType, ttlSeconds: ttl, userId });
  await audit(ctx, {
    action: "document.download_link_issued",
    entityType: "DocumentVersion",
    entityId: version.id,
    entityVersion: version.versionNumber,
    transactionId: doc.transactionId,
    summary: `Download link issued for "${doc.title}" v${version.versionNumber} (${ttl}s)`,
  });
  return { url, ttl };
}

export async function shareDocument(ctx: Ctx, documentId: string, participantId: string) {
  requirePermission(ctx, "document.share");
  const doc = await loadDocument(ctx, documentId);
  if ((RESTRICTED_CATEGORIES as string[]).includes(doc.category)) {
    throw forbidden("Identity and bank-verification documents cannot be shared through the portal.");
  }
  const participant = await db.participant.findFirst({ where: { id: participantId, transactionId: doc.transactionId, companyId: ctx.companyId } });
  if (!participant) throw notFound("Participant");
  const current = doc.currentVersionId ? await db.documentVersion.findUnique({ where: { id: doc.currentVersionId } }) : null;
  if (!current || current.scanStatus !== "CLEAN") throw precondition("Only scanned, clean documents can be shared.");
  const settings = await getCompanySettings(ctx.companyId);
  if (settings.procedures.requireDocumentReviewBeforeSharing) {
    const accepted = await db.documentReview.count({ where: { versionId: current.id, decision: "ACCEPTED" } });
    if (accepted === 0) throw precondition("Company procedure requires the document to be reviewed and accepted before sharing.");
  }
  await db.$transaction(async (client) => {
    await client.documentShare.upsert({
      where: { documentId_participantId: { documentId: doc.id, participantId } },
      create: { companyId: ctx.companyId, documentId: doc.id, participantId, sharedById: ctx.userId! },
      update: { revokedAt: null, sharedById: ctx.userId! },
    });
    await client.document.update({ where: { id: doc.id }, data: { visibility: "SHARED" } });
    await audit(ctx, { action: "document.shared", entityType: "Document", entityId: doc.id, transactionId: doc.transactionId, summary: `Shared "${doc.title}" with ${participant.displayName} (${participant.role.toLowerCase().replaceAll("_", " ")})` }, client);
  });
}

export async function revokeShare(ctx: Ctx, documentId: string, participantId: string) {
  requirePermission(ctx, "document.share");
  const doc = await loadDocument(ctx, documentId);
  await db.$transaction(async (client) => {
    await client.documentShare.updateMany({ where: { documentId: doc.id, participantId, revokedAt: null }, data: { revokedAt: new Date() } });
    const remaining = await client.documentShare.count({ where: { documentId: doc.id, revokedAt: null } });
    if (remaining === 0) await client.document.update({ where: { id: doc.id }, data: { visibility: "INTERNAL" } });
    await audit(ctx, { action: "document.share_revoked", entityType: "Document", entityId: doc.id, transactionId: doc.transactionId, summary: `Revoked sharing of "${doc.title}"`, details: { participantId } }, client);
  });
}

export async function reviewDocumentVersion(ctx: Ctx, versionId: string, decision: ReviewDecision, note?: string) {
  requirePermission(ctx, "document.review");
  const version = await db.documentVersion.findFirst({ where: { id: versionId, companyId: ctx.companyId } });
  if (!version) throw notFound("Document");
  const doc = await loadDocument(ctx, version.documentId);
  if (version.scanStatus !== "CLEAN") throw precondition("Quarantined files cannot be accepted.");
  if (decision !== "ACCEPTED" && !note?.trim()) throw invalid("Add a note explaining the decision.");
  await db.$transaction(async (client) => {
    await client.documentReview.create({ data: { companyId: ctx.companyId, versionId, reviewerId: ctx.userId!, decision, note: note?.trim() || null } });
    await audit(ctx, { action: "document.reviewed", entityType: "DocumentVersion", entityId: versionId, entityVersion: version.versionNumber, transactionId: doc.transactionId, summary: `${decision.toLowerCase().replace("_", " ")}: "${doc.title}" v${version.versionNumber}`, details: { note } }, client);
  });
}

export async function updateDocumentMeta(ctx: Ctx, documentId: string, input: { title?: string; category?: string }) {
  requirePermission(ctx, "document.upload");
  const doc = await loadDocument(ctx, documentId);
  if (input.category && !(DOCUMENT_CATEGORIES as readonly string[]).includes(input.category)) throw invalid("Unknown category.");
  await db.$transaction(async (client) => {
    await client.document.update({ where: { id: doc.id }, data: { ...(input.title?.trim() ? { title: input.title.trim() } : {}), ...(input.category ? { category: input.category } : {}) } });
    await audit(ctx, { action: "document.updated", entityType: "Document", entityId: doc.id, transactionId: doc.transactionId, summary: `Updated details of "${doc.title}"`, details: input }, client);
  });
}

export async function setDocumentLegalHold(ctx: Ctx, documentId: string, hold: boolean, reason: string) {
  requirePermission(ctx, "document.legal_hold");
  if (!reason?.trim()) throw invalid("A reason is required.");
  const doc = await loadDocument(ctx, documentId);
  await db.$transaction(async (client) => {
    await client.document.update({ where: { id: doc.id }, data: { legalHold: hold } });
    await audit(ctx, { action: hold ? "document.legal_hold_on" : "document.legal_hold_off", entityType: "Document", entityId: doc.id, transactionId: doc.transactionId, summary: `${hold ? "Legal hold applied to" : "Legal hold released on"} "${doc.title}"`, details: { reason } }, client);
  });
}

export async function archiveDocument(ctx: Ctx, documentId: string, reason: string) {
  requirePermission(ctx, "document.upload");
  const doc = await loadDocument(ctx, documentId);
  if (doc.legalHold) throw precondition("Document is under legal hold.");
  if (!reason?.trim()) throw invalid("A reason is required.");
  await db.$transaction(async (client) => {
    await client.document.update({ where: { id: doc.id }, data: { archivedAt: new Date() } });
    await client.documentShare.updateMany({ where: { documentId: doc.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(ctx, { action: "document.archived", entityType: "Document", entityId: doc.id, transactionId: doc.transactionId, summary: `Archived "${doc.title}"`, details: { reason } }, client);
  });
}

// ---------------------------------------------------------------------------
// Document requests
// ---------------------------------------------------------------------------

export async function createDocumentRequest(ctx: Ctx, transactionId: string, input: { participantId: string; title: string; description?: string; category?: string; dueDate?: string }) {
  requirePermission(ctx, "document.share");
  if (!input.title?.trim()) throw invalid("Title is required.");
  const tx = await loadTransaction(ctx, transactionId);
  const participant = await db.participant.findFirst({ where: { id: input.participantId, transactionId: tx.id, companyId: ctx.companyId } });
  if (!participant) throw notFound("Participant");
  return db.$transaction(async (client) => {
    const r = await client.documentRequest.create({
      data: {
        companyId: ctx.companyId,
        transactionId: tx.id,
        participantId: participant.id,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        category: input.category && (DOCUMENT_CATEGORIES as readonly string[]).includes(input.category) ? input.category : "OTHER",
        dueAt: input.dueDate ? parseDateOnly(input.dueDate) : null,
        createdById: ctx.userId!,
      },
    });
    await audit(ctx, { action: "document_request.created", entityType: "DocumentRequest", entityId: r.id, transactionId: tx.id, summary: `Requested "${r.title}" from ${participant.displayName}` }, client);
    return r;
  });
}

export async function setDocumentRequestStatus(ctx: Ctx, requestId: string, status: "ACCEPTED" | "CANCELLED" | "OPEN", note?: string) {
  requirePermission(ctx, "document.share");
  const r = await db.documentRequest.findFirst({ where: { id: requestId, companyId: ctx.companyId } });
  if (!r) throw notFound("Document request");
  await loadTransaction(ctx, r.transactionId);
  await db.$transaction(async (client) => {
    await client.documentRequest.update({ where: { id: r.id }, data: { status } });
    await audit(ctx, { action: `document_request.${status.toLowerCase()}`, entityType: "DocumentRequest", entityId: r.id, transactionId: r.transactionId, summary: `Request "${r.title}" ${status.toLowerCase()}`, details: { note } }, client);
  });
}

export async function listDocumentRequests(ctx: Ctx, transactionId: string) {
  await loadTransaction(ctx, transactionId);
  if (isExternal(ctx)) {
    const mine = await myParticipantIds(ctx, transactionId);
    return db.documentRequest.findMany({ where: { companyId: ctx.companyId, transactionId, participantId: { in: mine } }, orderBy: { createdAt: "desc" }, include: { participant: { select: { displayName: true } } } });
  }
  return db.documentRequest.findMany({ where: { companyId: ctx.companyId, transactionId }, orderBy: { createdAt: "desc" }, include: { participant: { select: { displayName: true } } } });
}

export function canSeeInternalDocs(ctx: Ctx) {
  return !isExternal(ctx) && hasPermission(ctx, "document.read_internal");
}
