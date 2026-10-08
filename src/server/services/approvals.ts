import { db, type Tx } from "../db";
import { hasPermission, isExternal, requireUser, type Ctx } from "../context";
import { AppError, forbidden, notFound, precondition } from "../errors";
import { audit } from "../audit";
import { canonicalJson, sha256Hex } from "../crypto";
import type { Permission } from "../authz";
import type { ApprovalType, ApprovalStatus } from "@/generated/prisma/enums";
import type { Approval, Prisma } from "@/generated/prisma/client";
import { requireStepUp } from "../auth/stepup";

/**
 * Approvals bind a decision to the exact state of its subject. The binding
 * snapshot is hashed; if the subject later changes (amount, payee, bank-detail
 * version, stage, etc.) the hash no longer matches, the approval is invalidated,
 * and a fresh approval is required.
 *
 * Separation of duties: the person who requested (prepared) an item can never
 * approve it, regardless of role.
 */

export const STEP_UP_APPROVAL_TYPES: ApprovalType[] = ["DISBURSEMENT", "BANK_INSTRUCTION", "RECONCILIATION"];

export function bindingHash(binding: unknown) {
  return sha256Hex(canonicalJson(binding));
}

export interface CreateApprovalInput {
  type: ApprovalType;
  transactionId?: string | null;
  title: string;
  summary?: string;
  subjectType: string;
  subjectId: string;
  /** Full snapshot shown to the approver. */
  binding: Record<string, unknown>;
  /** Subset of the snapshot that must stay identical for the approval to remain valid. Defaults to `binding`. */
  bindingKey?: Record<string, unknown>;
  requiredPermission: Permission | string;
  assignedToId?: string | null;
}

export async function createApproval(client: Tx, ctx: Ctx, input: CreateApprovalInput) {
  const requestedById = requireUser(ctx);
  const a = await client.approval.create({
    data: {
      companyId: ctx.companyId,
      transactionId: input.transactionId ?? null,
      type: input.type,
      title: input.title,
      summary: input.summary,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      bindingHash: bindingHash(input.bindingKey ?? input.binding),
      bindingSnapshot: input.binding as Prisma.InputJsonValue,
      requiredPermission: input.requiredPermission,
      requestedById,
      assignedToId: input.assignedToId ?? null,
    },
  });
  await audit(
    ctx,
    {
      action: "approval.requested",
      entityType: "Approval",
      entityId: a.id,
      transactionId: input.transactionId ?? null,
      summary: `Approval requested: ${input.title}`,
      details: { type: input.type, subjectType: input.subjectType, subjectId: input.subjectId },
    },
    client,
  );
  return a;
}

/** An APPROVED, unconsumed approval whose binding still matches the subject's current state. */
export async function findUsableApproval(
  client: Tx,
  ctx: Ctx,
  type: ApprovalType,
  subjectType: string,
  subjectId: string,
  bindingKey: Record<string, unknown>,
) {
  const hash = bindingHash(bindingKey);
  return client.approval.findFirst({
    where: { companyId: ctx.companyId, type, subjectType, subjectId, status: "APPROVED", bindingHash: hash },
    orderBy: { decidedAt: "desc" },
  });
}

export async function consumeApproval(client: Tx, approvalId: string) {
  const res = await client.approval.updateMany({
    where: { id: approvalId, status: "APPROVED" },
    data: { status: "CONSUMED", consumedAt: new Date() },
  });
  if (res.count !== 1) throw precondition("Approval was already used or is no longer valid.");
}

/**
 * Invalidates PENDING and APPROVED approvals for a subject. Called whenever the
 * subject changes in a way that matters (bank details, amount, payee...).
 */
export async function invalidateApprovals(
  client: Tx,
  ctx: Ctx,
  subjectType: string,
  subjectId: string,
  reason: string,
  statuses: ApprovalStatus[] = ["PENDING", "APPROVED"],
) {
  const affected = await client.approval.findMany({
    where: { companyId: ctx.companyId, subjectType, subjectId, status: { in: statuses } },
    select: { id: true, transactionId: true, title: true },
  });
  if (affected.length === 0) return 0;
  await client.approval.updateMany({
    where: { id: { in: affected.map((a) => a.id) } },
    data: { status: "INVALIDATED", invalidatedReason: reason },
  });
  for (const a of affected) {
    await audit(
      ctx,
      {
        action: "approval.invalidated",
        entityType: "Approval",
        entityId: a.id,
        transactionId: a.transactionId,
        summary: `Approval invalidated: ${a.title}`,
        details: { reason },
      },
      client,
    );
  }
  return affected.length;
}

type CurrentBindingResolver = (client: Tx, approval: Approval) => Promise<Record<string, unknown> | null>;
type OnDecision = (ctx: Ctx, approval: Approval, decision: "APPROVED" | "REJECTED") => Promise<void>;

interface ApprovalHandler {
  /** Recomputes the binding key from the subject's current state. */
  currentBinding: CurrentBindingResolver;
  /** Runs after the decision commits. */
  after?: OnDecision;
  /** Runs inside the decision's DB transaction (e.g. to flip a subject's status). */
  within?: (client: Tx, ctx: Ctx, approval: Approval, decision: "APPROVED" | "REJECTED") => Promise<void>;
}

const handlers = new Map<ApprovalType, ApprovalHandler>();

export function registerApprovalHandler(type: ApprovalType, handler: ApprovalHandler) {
  handlers.set(type, handler);
}

export async function decideApproval(
  ctx: Ctx,
  approvalId: string,
  decision: "APPROVED" | "REJECTED",
  note?: string,
) {
  if (isExternal(ctx)) throw notFound("Approval");
  const deciderId = requireUser(ctx);
  await ensureHandlersLoaded();
  const approval = await db.approval.findFirst({ where: { id: approvalId, companyId: ctx.companyId } });
  if (!approval) throw notFound("Approval");
  if (approval.status !== "PENDING") throw precondition(`This approval is already ${approval.status.toLowerCase()}.`);
  if (!hasPermission(ctx, approval.requiredPermission as Permission)) throw forbidden("Your role cannot decide this approval.");
  if (approval.requestedById === deciderId) {
    throw new AppError("FORBIDDEN", "Separation of duties: the person who prepared or requested an item cannot approve it.");
  }
  if (decision === "APPROVED" && STEP_UP_APPROVAL_TYPES.includes(approval.type)) await requireStepUp(ctx);

  const handler = handlers.get(approval.type);
  const result = await db.$transaction(async (client) => {
    // Re-read under lock to avoid double decisions.
    const rows = await client.$queryRaw<{ status: string }[]>`
      SELECT "status" FROM "Approval" WHERE "id" = ${approval.id} FOR UPDATE`;
    if (rows[0]?.status !== "PENDING") throw precondition("This approval was decided by someone else.");
    if (handler && decision === "APPROVED") {
      const current = await handler.currentBinding(client, approval);
      if (!current || bindingHash(current) !== approval.bindingHash) {
        await client.approval.update({
          where: { id: approval.id },
          data: { status: "INVALIDATED", invalidatedReason: "Subject changed after the approval was requested." },
        });
        await audit(
          ctx,
          {
            action: "approval.invalidated",
            entityType: "Approval",
            entityId: approval.id,
            transactionId: approval.transactionId,
            summary: `Approval invalidated at decision time: ${approval.title}`,
            details: { reason: "binding mismatch" },
          },
          client,
        );
        return { invalidated: true as const };
      }
    }
    const updated = await client.approval.update({
      where: { id: approval.id },
      data: {
        status: decision,
        decidedById: deciderId,
        decidedAt: new Date(),
        decisionNote: note?.trim() || null,
        stepUpVerified: STEP_UP_APPROVAL_TYPES.includes(approval.type) && decision === "APPROVED",
      },
    });
    if (handler?.within) await handler.within(client, ctx, updated, decision);
    await audit(
      ctx,
      {
        action: decision === "APPROVED" ? "approval.approved" : "approval.rejected",
        entityType: "Approval",
        entityId: approval.id,
        transactionId: approval.transactionId,
        summary: `${decision === "APPROVED" ? "Approved" : "Rejected"}: ${approval.title}`,
        details: { note, type: approval.type, bindingHash: approval.bindingHash },
      },
      client,
    );
    return { invalidated: false as const, approval: updated };
  });
  if (result.invalidated) {
    throw precondition("The item changed after this approval was requested. A new approval is required.");
  }
  if (handler?.after) await handler.after(ctx, result.approval, decision);
  return result.approval;
}

let loaded = false;
/** Handler modules register themselves on import; load them lazily to avoid import cycles. */
async function ensureHandlersLoaded() {
  if (loaded) return;
  await import("./approval-handlers");
  loaded = true;
}

export async function listApprovals(ctx: Ctx, filter: { status?: ApprovalStatus; transactionId?: string } = {}) {
  if (isExternal(ctx)) return [];
  return db.approval.findMany({
    where: {
      companyId: ctx.companyId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.transactionId ? { transactionId: filter.transactionId } : {}),
    },
    include: { transaction: { select: { escrowNumber: true, type: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function cancelApproval(ctx: Ctx, approvalId: string, reason: string) {
  const userId = requireUser(ctx);
  const a = await db.approval.findFirst({ where: { id: approvalId, companyId: ctx.companyId } });
  if (!a) throw notFound("Approval");
  if (a.status !== "PENDING") throw precondition("Only pending approvals can be cancelled.");
  if (a.requestedById !== userId && !hasPermission(ctx, "workflow.override")) throw forbidden();
  await db.$transaction(async (client) => {
    await client.approval.update({ where: { id: a.id }, data: { status: "CANCELLED", decisionNote: reason } });
    await audit(ctx, { action: "approval.cancelled", entityType: "Approval", entityId: a.id, transactionId: a.transactionId, summary: `Approval request cancelled: ${a.title}`, details: { reason } }, client);
  });
}
