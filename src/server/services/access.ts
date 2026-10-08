import { db, type Tx } from "../db";
import { isExternal, requirePermission, type Ctx } from "../context";
import { forbidden, notFound } from "../errors";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Central access checks. Rules:
 * 1. Every lookup is filtered by ctx.companyId (tenant isolation).
 * 2. External participants can reach a transaction only through an active
 *    Participant row linked to their user account with portal access enabled.
 * 3. Missing and unauthorized records both yield NOT_FOUND.
 */

type Client = Tx | typeof db;

export function txScope(ctx: Ctx): Prisma.TransactionWhereInput {
  if (isExternal(ctx)) {
    return {
      companyId: ctx.companyId,
      participants: { some: { userId: ctx.userId ?? "__none__", portalAccess: true } },
    };
  }
  return { companyId: ctx.companyId };
}

/** Loads a transaction the actor may read, or throws NOT_FOUND. */
export async function loadTransaction(ctx: Ctx, transactionId: string, client: Client = db) {
  if (!isExternal(ctx)) requirePermission(ctx, "transaction.read");
  const tx = await client.transaction.findFirst({ where: { id: transactionId, ...txScope(ctx) } });
  if (!tx) throw notFound("Transaction");
  return tx;
}

/** Staff-only guard for internal operations on a transaction. */
export async function loadTransactionForStaff(ctx: Ctx, transactionId: string, client: Client = db) {
  if (isExternal(ctx)) throw notFound("Transaction");
  return loadTransaction(ctx, transactionId, client);
}

/** Participant rows that belong to the external user in this transaction. */
export async function myParticipantIds(ctx: Ctx, transactionId: string, client: Client = db): Promise<string[]> {
  if (!isExternal(ctx) || !ctx.userId) return [];
  const rows = await client.participant.findMany({
    where: { companyId: ctx.companyId, transactionId, userId: ctx.userId, portalAccess: true },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Document visibility filter.
 * Staff with document.read_internal see everything in their tenant.
 * External users see only documents explicitly shared with one of their
 * participant records (unrevoked), or documents they uploaded themselves.
 */
export async function documentScope(ctx: Ctx, transactionId?: string): Promise<Prisma.DocumentWhereInput> {
  if (!isExternal(ctx)) {
    requirePermission(ctx, "document.read_internal");
    return { companyId: ctx.companyId, ...(transactionId ? { transactionId } : {}) };
  }
  const participants = await db.participant.findMany({
    where: {
      companyId: ctx.companyId,
      userId: ctx.userId ?? "__none__",
      portalAccess: true,
      ...(transactionId ? { transactionId } : {}),
    },
    select: { id: true },
  });
  const ids = participants.map((p) => p.id);
  if (ids.length === 0) return { id: "__none__" };
  return {
    companyId: ctx.companyId,
    ...(transactionId ? { transactionId } : {}),
    archivedAt: null,
    OR: [
      { shares: { some: { participantId: { in: ids }, revokedAt: null } } },
      { uploadedByParticipantId: { in: ids } },
    ],
  };
}

export async function loadDocument(ctx: Ctx, documentId: string) {
  const scope = await documentScope(ctx);
  const doc = await db.document.findFirst({ where: { id: documentId, ...scope } });
  if (!doc) throw notFound("Document");
  return doc;
}

export function assertStaff(ctx: Ctx) {
  if (isExternal(ctx) || ctx.role === "SYSTEM") throw forbidden();
}
