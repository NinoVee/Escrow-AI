import { z } from "zod";
import { db, type Tx } from "../db";
import { isExternal, requirePermission, requireUser, type Ctx } from "../context";
import { conflict, invalid, notFound, precondition } from "../errors";
import { audit } from "../audit";
import { loadDefinition, lockAndBump, syncTemplateTasks } from "../workflow/engine";
import { fieldDef, fromColumnValue, parseFieldInput, toColumnValue, type StoredValue, type TxFieldKey } from "../fields";
import { loadTransaction, txScope } from "./access";
import { getCompanySettings } from "../settings";
import type { Prisma, Transaction } from "@/generated/prisma/client";
import type { ParticipantRole, ParticipantSide, PartyType, ProvenanceSource, TransactionStatus, TransactionType } from "@/generated/prisma/enums";

const FACT_FIELDS: TxFieldKey[] = ["financingType", "loanAmountCents", "hasHoa", "hasTenants", "is1031Exchange", "acceptanceDate", "proposedClosingDate"];

export const CreateTransactionSchema = z.object({
  type: z.enum(["RESIDENTIAL", "COMMERCIAL"]),
  jurisdiction: z.string().default("US-CA"),
  escrowNumber: z.string().trim().max(40).optional(),
  title: z.string().trim().max(200).optional(),
  officerId: z.string().optional(),
  assistantId: z.string().optional(),
  templateVersionId: z.string().optional(),
  property: z
    .object({
      street: z.string().trim().min(1),
      unit: z.string().trim().optional(),
      city: z.string().trim().min(1),
      county: z.string().trim().optional(),
      state: z.string().trim().length(2).default("CA"),
      postalCode: z.string().trim().optional(),
      propertyType: z.string().default("SINGLE_FAMILY"),
      apn: z.string().trim().optional(),
      legalDescription: z.string().trim().optional(),
    })
    .optional(),
  parties: z
    .array(
      z.object({
        role: z.enum(["BUYER", "SELLER"]),
        displayName: z.string().trim().min(1),
        partyType: z.enum(["INDIVIDUAL", "LLC", "CORPORATION", "TRUST", "PARTNERSHIP", "ESTATE", "OTHER_ENTITY"]).default("INDIVIDUAL"),
        email: z.string().email().optional().or(z.literal("")),
      }),
    )
    .default([]),
  /** Raw field inputs (strings) keyed by TxFieldKey; parsed with the field registry. */
  fields: z.record(z.string(), z.unknown()).default({}),
});
export type CreateTransactionInput = z.input<typeof CreateTransactionSchema>;

async function nextEscrowNumber(client: Tx, companyId: string, prefix: string) {
  const year = new Date().getUTCFullYear();
  const count = await client.transaction.count({ where: { companyId, escrowNumber: { startsWith: `${prefix}-${year}-` } } });
  return `${prefix}-${year}-${String(count + 1).padStart(4, "0")}`;
}

async function assertStaffMember(client: Tx | typeof db, companyId: string, userId: string | undefined, roles?: string[]) {
  if (!userId) return;
  const m = await client.membership.findFirst({ where: { companyId, userId, status: "ACTIVE", role: { not: "EXTERNAL" } } });
  if (!m || (roles && !roles.includes(m.role))) throw invalid("Assigned user must be an active staff member of this company.");
}

export async function createTransaction(ctx: Ctx, raw: CreateTransactionInput) {
  if (isExternal(ctx)) throw notFound("Transaction");
  requirePermission(ctx, "transaction.create");
  const actorId = requireUser(ctx);
  const input = CreateTransactionSchema.parse(raw);
  const settings = await getCompanySettings(ctx.companyId);

  // Parse field values before opening the DB transaction so bad input fails fast.
  const parsedFields: [TxFieldKey, StoredValue][] = [];
  for (const [k, v] of Object.entries(input.fields)) {
    if (!fieldDef(k)) throw invalid(`Unknown field ${k}`);
    try {
      const val = parseFieldInput(k as TxFieldKey, v);
      if (val !== null) parsedFields.push([k as TxFieldKey, val]);
    } catch (e) {
      throw invalid((e as Error).message);
    }
  }

  const version = input.templateVersionId
    ? await db.workflowTemplateVersion.findFirst({
        where: { id: input.templateVersionId, companyId: ctx.companyId, status: "PUBLISHED", template: { transactionType: input.type } },
      })
    : await db.workflowTemplateVersion.findFirst({
        where: { companyId: ctx.companyId, status: "PUBLISHED", template: { transactionType: input.type, jurisdiction: input.jurisdiction } },
        orderBy: { publishedAt: "desc" },
      });
  if (!version) throw precondition(`No published ${input.type.toLowerCase()} workflow template for ${input.jurisdiction}.`);
  const def = await loadDefinition(version.id);

  await assertStaffMember(db, ctx.companyId, input.officerId, ["ESCROW_OFFICER", "COMPANY_ADMIN", "MANAGER"]);
  await assertStaffMember(db, ctx.companyId, input.assistantId);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(async (client) => {
        const escrowNumber = input.escrowNumber || (await nextEscrowNumber(client, ctx.companyId, settings.escrowNumberPrefix));
        const data: Prisma.TransactionUncheckedCreateInput = {
          companyId: ctx.companyId,
          escrowNumber,
          type: input.type as TransactionType,
          jurisdiction: input.jurisdiction,
          stage: def.initialStage,
          templateVersionId: version.id,
          officerId: input.officerId ?? null,
          assistantId: input.assistantId ?? null,
          title: input.title ?? null,
          createdById: actorId,
        };
        for (const [k, v] of parsedFields) (data as Record<string, unknown>)[k] = toColumnValue(k, v);
        const tx = await client.transaction.create({ data });

        for (const [k, v] of parsedFields) {
          await client.fieldProvenance.create({
            data: { companyId: ctx.companyId, transactionId: tx.id, fieldPath: k, value: v as Prisma.InputJsonValue, source: "MANUAL", setById: actorId, reason: "Entered at file creation" },
          });
        }
        if (input.property) {
          const p = await client.property.create({
            data: {
              companyId: ctx.companyId,
              transactionId: tx.id,
              street: input.property.street,
              unit: input.property.unit,
              city: input.property.city,
              county: input.property.county,
              state: input.property.state,
              postalCode: input.property.postalCode,
              propertyType: input.property.propertyType,
            },
          });
          if (input.property.apn) {
            await client.parcel.create({
              data: { companyId: ctx.companyId, propertyId: p.id, apn: input.property.apn, legalDescription: input.property.legalDescription },
            });
          }
        }
        for (const party of input.parties) {
          await client.participant.create({
            data: {
              companyId: ctx.companyId,
              transactionId: tx.id,
              role: party.role,
              side: party.role,
              partyType: party.partyType,
              displayName: party.displayName,
              email: party.email || null,
            },
          });
        }
        await syncTemplateTasks(client, tx, def, actorId);
        await audit(
          ctx,
          {
            action: "transaction.created",
            entityType: "Transaction",
            entityId: tx.id,
            entityVersion: tx.version,
            transactionId: tx.id,
            summary: `Created ${input.type.toLowerCase()} file ${escrowNumber}`,
            details: { templateVersionId: version.id, fields: parsedFields.map(([k]) => k) },
          },
          client,
        );
        return tx;
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "P2002" && !input.escrowNumber && attempt < 2) continue; // escrow number race; retry
      if (code === "P2002") throw conflict("That escrow number is already in use.");
      throw e;
    }
  }
  throw conflict("Could not allocate an escrow number. Try again.");
}

/**
 * Sets an authoritative field value and appends provenance. Used by manual
 * edits and by acceptance of document-extraction proposals. Caller must hold
 * the transaction row lock (via lockAndBump) inside `client`.
 */
export async function applyFieldValue(
  client: Tx,
  ctx: Ctx,
  tx: Transaction,
  key: TxFieldKey,
  value: StoredValue,
  meta: {
    source: ProvenanceSource;
    reason?: string;
    documentId?: string | null;
    documentVersionId?: string | null;
    page?: number | null;
    excerpt?: string | null;
    confidence?: number | null;
    proposalId?: string | null;
  },
) {
  const actorId = requireUser(ctx);
  const previous = fromColumnValue(key, (tx as unknown as Record<string, unknown>)[key]);
  await client.fieldProvenance.updateMany({
    where: { transactionId: tx.id, fieldPath: key, isCurrent: true },
    data: { isCurrent: false },
  });
  await client.fieldProvenance.create({
    data: {
      companyId: ctx.companyId,
      transactionId: tx.id,
      fieldPath: key,
      value: value as Prisma.InputJsonValue,
      source: meta.source,
      documentId: meta.documentId ?? null,
      documentVersionId: meta.documentVersionId ?? null,
      page: meta.page ?? null,
      excerpt: meta.excerpt ?? null,
      confidence: meta.confidence ?? null,
      proposalId: meta.proposalId ?? null,
      setById: actorId,
      reason: meta.reason ?? null,
    },
  });
  await client.transaction.update({ where: { id: tx.id }, data: { [key]: toColumnValue(key, value) } });
  return { previous };
}

export async function updateTransactionField(
  ctx: Ctx,
  transactionId: string,
  key: string,
  rawValue: unknown,
  opts: { reason: string; expectedVersion?: number },
) {
  if (isExternal(ctx)) throw notFound("Transaction");
  requirePermission(ctx, "transaction.update");
  const def = fieldDef(key);
  if (!def) throw invalid(`Unknown field ${key}`);
  if (!opts.reason || opts.reason.trim().length < 3) throw invalid("Explain why this value is changing.");
  let value: StoredValue;
  try {
    value = parseFieldInput(def.key, rawValue);
  } catch (e) {
    throw invalid((e as Error).message);
  }
  return db.$transaction(async (client) => {
    const tx0 = await loadTransaction(ctx, transactionId, client);
    if (opts.expectedVersion !== undefined && tx0.version !== opts.expectedVersion) {
      throw conflict("This file was changed by someone else. Reload to see the latest values.");
    }
    if (tx0.status === "CLOSED" || tx0.status === "CANCELLED") throw precondition("Reopen the file before changing terms.");
    const version = await lockAndBump(client, tx0.id);
    const tx = await client.transaction.findUniqueOrThrow({ where: { id: tx0.id } });
    const { previous } = await applyFieldValue(client, ctx, tx, def.key, value, { source: "MANUAL", reason: opts.reason });
    if (FACT_FIELDS.includes(def.key)) {
      const fresh = await client.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      await syncTemplateTasks(client, fresh, await loadDefinition(tx.templateVersionId, client), ctx.userId);
    }
    await audit(
      ctx,
      {
        action: "transaction.field_changed",
        entityType: "Transaction",
        entityId: tx.id,
        entityVersion: version,
        transactionId: tx.id,
        summary: `${def.label} changed`,
        details: { field: def.key, previous, value, reason: opts.reason },
      },
      client,
    );
    return { version };
  });
}

export async function assignStaff(ctx: Ctx, transactionId: string, input: { officerId?: string | null; assistantId?: string | null }) {
  if (isExternal(ctx)) throw notFound("Transaction");
  requirePermission(ctx, "transaction.update");
  await assertStaffMember(db, ctx.companyId, input.officerId ?? undefined, ["ESCROW_OFFICER", "COMPANY_ADMIN", "MANAGER"]);
  await assertStaffMember(db, ctx.companyId, input.assistantId ?? undefined);
  return db.$transaction(async (client) => {
    const tx = await loadTransaction(ctx, transactionId, client);
    const version = await lockAndBump(client, tx.id);
    await client.transaction.update({
      where: { id: tx.id },
      data: {
        ...(input.officerId !== undefined ? { officerId: input.officerId } : {}),
        ...(input.assistantId !== undefined ? { assistantId: input.assistantId } : {}),
      },
    });
    await audit(ctx, { action: "transaction.assigned", entityType: "Transaction", entityId: tx.id, entityVersion: version, transactionId: tx.id, summary: "Staff assignment changed", details: input }, client);
  });
}

export async function setLegalHold(ctx: Ctx, transactionId: string, hold: boolean, reason: string) {
  requirePermission(ctx, "document.legal_hold");
  if (!reason?.trim()) throw invalid("A reason is required.");
  return db.$transaction(async (client) => {
    const tx = await loadTransaction(ctx, transactionId, client);
    const version = await lockAndBump(client, tx.id);
    await client.transaction.update({ where: { id: tx.id }, data: { legalHold: hold } });
    await audit(ctx, { action: hold ? "retention.legal_hold_on" : "retention.legal_hold_off", entityType: "Transaction", entityId: tx.id, entityVersion: version, transactionId: tx.id, summary: hold ? "Legal hold applied" : "Legal hold released", details: { reason } }, client);
  });
}

export interface ListFilter {
  q?: string;
  type?: TransactionType;
  status?: TransactionStatus;
  stage?: string;
  mine?: boolean;
}

export async function listTransactions(ctx: Ctx, f: ListFilter = {}) {
  if (!isExternal(ctx)) requirePermission(ctx, "transaction.read");
  const q = f.q?.trim();
  const where: Prisma.TransactionWhereInput = {
    ...txScope(ctx),
    ...(f.type ? { type: f.type } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.stage ? { stage: f.stage } : {}),
    ...(f.mine && ctx.userId ? { OR: [{ officerId: ctx.userId }, { assistantId: ctx.userId }] } : {}),
    ...(q
      ? {
          AND: [
            {
              OR: [
                { escrowNumber: { contains: q, mode: "insensitive" } },
                { title: { contains: q, mode: "insensitive" } },
                { properties: { some: { OR: [{ street: { contains: q, mode: "insensitive" } }, { city: { contains: q, mode: "insensitive" } }, { parcels: { some: { apn: { contains: q } } } }] } } },
                ...(isExternal(ctx) ? [] : [{ participants: { some: { displayName: { contains: q, mode: "insensitive" as const } } } }]),
              ],
            },
          ],
        }
      : {}),
  };
  return db.transaction.findMany({
    where,
    include: {
      properties: { orderBy: { sortOrder: "asc" }, take: 3, include: { parcels: true } },
      participants: { where: { role: { in: ["BUYER", "SELLER"] } }, select: { role: true, displayName: true } },
      _count: { select: { tasks: { where: { status: { in: ["OPEN", "IN_PROGRESS", "WAITING"] } } } } },
    },
    orderBy: [{ status: "asc" }, { proposedClosingDate: "asc" }, { createdAt: "desc" }],
    take: 200,
  });
}

// ---------------------------------------------------------------------------
// Properties and parcels
// ---------------------------------------------------------------------------

export const PropertyInputSchema = z.object({
  label: z.string().trim().max(100).optional(),
  street: z.string().trim().min(1).max(200),
  unit: z.string().trim().max(50).optional(),
  city: z.string().trim().min(1).max(100),
  county: z.string().trim().max(100).optional(),
  state: z.string().trim().length(2).default("CA"),
  postalCode: z.string().trim().max(10).optional(),
  propertyType: z.string().trim().default("SINGLE_FAMILY"),
  hoaName: z.string().trim().max(200).optional(),
});

export async function addProperty(ctx: Ctx, transactionId: string, raw: z.input<typeof PropertyInputSchema>) {
  requirePermission(ctx, "transaction.update");
  const input = PropertyInputSchema.parse(raw);
  return db.$transaction(async (client) => {
    const tx = await loadTransaction(ctx, transactionId, client);
    await lockAndBump(client, tx.id);
    const count = await client.property.count({ where: { transactionId: tx.id } });
    const p = await client.property.create({ data: { ...input, companyId: ctx.companyId, transactionId: tx.id, sortOrder: count } });
    await audit(ctx, { action: "property.added", entityType: "Property", entityId: p.id, transactionId: tx.id, summary: `Added property ${p.street}, ${p.city}` }, client);
    return p;
  });
}

export async function addParcel(ctx: Ctx, propertyId: string, input: { apn: string; legalDescription?: string }) {
  requirePermission(ctx, "transaction.update");
  const apn = input.apn?.trim();
  if (!apn) throw invalid("APN is required.");
  return db.$transaction(async (client) => {
    const property = await client.property.findFirst({ where: { id: propertyId, companyId: ctx.companyId } });
    if (!property) throw notFound("Property");
    const tx = await loadTransaction(ctx, property.transactionId, client);
    await lockAndBump(client, tx.id);
    const parcel = await client.parcel.create({ data: { companyId: ctx.companyId, propertyId, apn, legalDescription: input.legalDescription?.trim() || null } });
    await syncTemplateTasks(client, tx, await loadDefinition(tx.templateVersionId, client), ctx.userId);
    await audit(ctx, { action: "parcel.added", entityType: "Parcel", entityId: parcel.id, transactionId: tx.id, summary: `Added parcel ${apn}` }, client);
    return parcel;
  });
}

// ---------------------------------------------------------------------------
// Participants and entity signers
// ---------------------------------------------------------------------------

const SIDE_BY_ROLE: Record<ParticipantRole, ParticipantSide> = {
  BUYER: "BUYER",
  BUYER_AGENT: "BUYER",
  MORTGAGE_BROKER: "BUYER",
  LENDER: "BUYER",
  SELLER: "SELLER",
  LISTING_AGENT: "SELLER",
  PAYOFF_LENDER: "SELLER",
  TITLE_REP: "NEUTRAL",
  ATTORNEY: "NEUTRAL",
  ENTITY_REPRESENTATIVE: "NEUTRAL",
  EXCHANGE_ACCOMMODATOR: "NEUTRAL",
  HOA: "NEUTRAL",
  OTHER: "NEUTRAL",
};

export const ParticipantInputSchema = z.object({
  role: z.enum(["BUYER", "SELLER", "BUYER_AGENT", "LISTING_AGENT", "LENDER", "MORTGAGE_BROKER", "TITLE_REP", "ATTORNEY", "ENTITY_REPRESENTATIVE", "EXCHANGE_ACCOMMODATOR", "HOA", "PAYOFF_LENDER", "OTHER"]),
  side: z.enum(["BUYER", "SELLER", "NEUTRAL"]).optional(),
  partyType: z.enum(["INDIVIDUAL", "LLC", "CORPORATION", "TRUST", "PARTNERSHIP", "ESTATE", "OTHER_ENTITY"]).default("INDIVIDUAL"),
  displayName: z.string().trim().min(1).max(200),
  organization: z.string().trim().max(200).optional(),
  email: z.string().trim().email().optional().or(z.literal("").transform(() => undefined)),
  phone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export async function addParticipant(ctx: Ctx, transactionId: string, raw: z.input<typeof ParticipantInputSchema>) {
  requirePermission(ctx, "participant.manage");
  const input = ParticipantInputSchema.parse(raw);
  return db.$transaction(async (client) => {
    const tx = await loadTransaction(ctx, transactionId, client);
    await lockAndBump(client, tx.id);
    const p = await client.participant.create({
      data: {
        companyId: ctx.companyId,
        transactionId: tx.id,
        role: input.role as ParticipantRole,
        side: (input.side ?? SIDE_BY_ROLE[input.role as ParticipantRole]) as ParticipantSide,
        partyType: input.partyType as PartyType,
        displayName: input.displayName,
        organization: input.organization,
        email: input.email?.toLowerCase(),
        phone: input.phone,
        notes: input.notes,
      },
    });
    if (input.partyType !== "INDIVIDUAL") {
      const fresh = await client.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      await syncTemplateTasks(client, fresh, await loadDefinition(tx.templateVersionId, client), ctx.userId);
    }
    await audit(ctx, { action: "participant.added", entityType: "Participant", entityId: p.id, transactionId: tx.id, summary: `Added ${input.role.toLowerCase().replaceAll("_", " ")} ${p.displayName}` }, client);
    return p;
  });
}

export async function updateParticipantNotifications(ctx: Ctx, participantId: string, emailNotifications: boolean) {
  const p = await db.participant.findFirst({ where: { id: participantId, companyId: ctx.companyId } });
  if (!p) throw notFound("Participant");
  // Staff with participant.manage, or the participant themselves.
  if (isExternal(ctx)) {
    if (p.userId !== ctx.userId) throw notFound("Participant");
  } else requirePermission(ctx, "participant.manage");
  await db.$transaction(async (client) => {
    await client.participant.update({
      where: { id: p.id },
      data: { emailNotifications, unsubscribedAt: emailNotifications ? null : new Date() },
    });
    await audit(ctx, { action: "participant.notification_preference", entityType: "Participant", entityId: p.id, transactionId: p.transactionId, summary: `Email notifications ${emailNotifications ? "enabled" : "disabled"} for ${p.displayName}` }, client);
  });
}

export async function addEntitySigner(ctx: Ctx, participantId: string, input: { name: string; title?: string; email?: string; authorityDocumentId?: string }) {
  requirePermission(ctx, "participant.manage");
  if (!input.name?.trim()) throw invalid("Signer name is required.");
  return db.$transaction(async (client) => {
    const p = await client.participant.findFirst({ where: { id: participantId, companyId: ctx.companyId } });
    if (!p) throw notFound("Participant");
    if (p.partyType === "INDIVIDUAL") throw invalid("Authorized signers apply to entity participants only.");
    await loadTransaction(ctx, p.transactionId, client);
    if (input.authorityDocumentId) {
      const d = await client.document.findFirst({ where: { id: input.authorityDocumentId, transactionId: p.transactionId } });
      if (!d) throw invalid("Authority document must belong to this file.");
    }
    const s = await client.entitySigner.create({
      data: {
        companyId: ctx.companyId,
        participantId: p.id,
        name: input.name.trim(),
        title: input.title?.trim() || null,
        email: input.email?.trim() || null,
        authorityDocumentId: input.authorityDocumentId || null,
        authorityStatus: "UNVERIFIED",
      },
    });
    await audit(ctx, { action: "signer.added", entityType: "EntitySigner", entityId: s.id, transactionId: p.transactionId, summary: `Added authorized signer ${s.name} for ${p.displayName}` }, client);
    return s;
  });
}

/**
 * Requests human review of a signer's authority. Approval must come from a
 * different user holding `signer.review`. The AI has no path to this function.
 */
export async function requestSignerReview(ctx: Ctx, signerId: string) {
  requirePermission(ctx, "participant.manage");
  const { createApproval } = await import("./approvals");
  return db.$transaction(async (client) => {
    const s = await client.entitySigner.findFirst({ where: { id: signerId, companyId: ctx.companyId }, include: { participant: true } });
    if (!s) throw notFound("Signer");
    if (!s.authorityDocumentId) throw precondition("Attach the document that establishes signing authority before requesting review.");
    if (s.authorityStatus === "APPROVED") throw precondition("Signer is already approved.");
    const pending = await client.approval.findFirst({ where: { companyId: ctx.companyId, type: "SIGNING_AUTHORITY", subjectId: s.id, status: "PENDING" } });
    if (pending) return pending;
    await client.entitySigner.update({ where: { id: s.id }, data: { authorityStatus: "PENDING_REVIEW" } });
    return createApproval(client, ctx, {
      type: "SIGNING_AUTHORITY",
      transactionId: s.participant.transactionId,
      title: `Signing authority: ${s.name}${s.title ? `, ${s.title}` : ""} for ${s.participant.displayName}`,
      subjectType: "EntitySigner",
      subjectId: s.id,
      binding: { signerId: s.id, participantId: s.participantId, name: s.name, title: s.title, authorityDocumentId: s.authorityDocumentId },
      requiredPermission: "signer.review",
    });
  });
}

/**
 * Starts a file from an uploaded purchase agreement. Creates a DRAFT
 * transaction with no authoritative terms, stores the agreement, and runs
 * extraction. Every extracted value arrives as a proposal for officer review.
 */
export async function createTransactionFromContract(ctx: Ctx, input: { type: TransactionType; filename: string; data: Buffer; officerId?: string }) {
  const tx = await createTransaction(ctx, { type: input.type, jurisdiction: "US-CA", officerId: input.officerId, title: "New file from uploaded agreement" });
  const { uploadDocument } = await import("./documents");
  const upload = await uploadDocument(ctx, { transactionId: tx.id, filename: input.filename, data: input.data, title: "Purchase agreement (uploaded at intake)", category: "PURCHASE_AGREEMENT" });
  return { transaction: tx, document: upload.document, scan: upload.scan };
}
