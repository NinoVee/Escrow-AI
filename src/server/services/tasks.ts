import { z } from "zod";
import { db } from "../db";
import { hasPermission, isExternal, requirePermission, requireUser, type Ctx } from "../context";
import { forbidden, invalid, notFound, precondition } from "../errors";
import { audit } from "../audit";
import { lockAndBump } from "../workflow/engine";
import { loadTransaction } from "./access";
import { createApproval } from "./approvals";
import { parseDateOnly } from "@/lib/dates";
import type { DeadlineStatus, DeadlineType, MilestoneKind, MilestoneStatus, TaskStatus } from "@/generated/prisma/enums";

// ---------------------------------------------------------------------------
// Tasks and blockers
// ---------------------------------------------------------------------------

export const TaskInputSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).optional(),
  category: z.string().trim().default("GENERAL"),
  stage: z.string().optional(),
  required: z.boolean().default(false),
  isBlocker: z.boolean().default(false),
  requiresApproval: z.boolean().default(false),
  assigneeUserId: z.string().optional(),
  responsibleParticipantId: z.string().optional(),
  dueDate: z.string().optional(),
});

export async function createTask(ctx: Ctx, transactionId: string, raw: z.input<typeof TaskInputSchema>, source: "MANUAL" | "AI_PROPOSAL" | "AUTOMATION" = "MANUAL") {
  requirePermission(ctx, "task.manage");
  const input = TaskInputSchema.parse(raw);
  return db.$transaction(async (client) => {
    const tx = await loadTransaction(ctx, transactionId, client);
    if (input.assigneeUserId) {
      const m = await client.membership.findFirst({ where: { companyId: ctx.companyId, userId: input.assigneeUserId, role: { not: "EXTERNAL" }, status: "ACTIVE" } });
      if (!m) throw invalid("Assignee must be an active staff member.");
    }
    if (input.responsibleParticipantId) {
      const p = await client.participant.findFirst({ where: { id: input.responsibleParticipantId, transactionId: tx.id } });
      if (!p) throw invalid("Responsible participant must belong to this file.");
    }
    await lockAndBump(client, tx.id);
    const task = await client.task.create({
      data: {
        companyId: ctx.companyId,
        transactionId: tx.id,
        title: input.title,
        description: input.description,
        category: input.isBlocker ? "BLOCKER" : input.category,
        stage: input.stage ?? tx.stage,
        required: input.required || input.isBlocker,
        isBlocker: input.isBlocker,
        requiresApproval: input.requiresApproval,
        assigneeUserId: input.assigneeUserId ?? null,
        responsibleParticipantId: input.responsibleParticipantId ?? null,
        dueAt: input.dueDate ? parseDateOnly(input.dueDate) : null,
        source,
      },
    });
    await audit(ctx, { action: input.isBlocker ? "blocker.created" : "task.created", entityType: "Task", entityId: task.id, transactionId: tx.id, summary: `${input.isBlocker ? "Blocker" : "Task"} created: ${task.title}` }, client);
    return task;
  });
}

async function loadTask(ctx: Ctx, taskId: string) {
  if (isExternal(ctx)) throw notFound("Task");
  const task = await db.task.findFirst({ where: { id: taskId, companyId: ctx.companyId } });
  if (!task) throw notFound("Task");
  return task;
}

/**
 * Resolves a task. DONE on a task that requires approval creates an approval
 * request instead; the task completes only when someone else approves it.
 * WAIVED and NOT_APPLICABLE on a required task need `task.waive` and a reason.
 */
export async function resolveTask(
  ctx: Ctx,
  taskId: string,
  input: { status: Extract<TaskStatus, "DONE" | "WAIVED" | "NOT_APPLICABLE">; note?: string; evidenceDocumentId?: string; expectedVersion?: number },
) {
  requirePermission(ctx, "task.manage");
  const actorId = requireUser(ctx);
  const task = await loadTask(ctx, taskId);
  if (["DONE", "WAIVED", "NOT_APPLICABLE"].includes(task.status)) throw precondition("Task is already resolved.");
  if (input.expectedVersion !== undefined && input.expectedVersion !== task.version) throw precondition("Task changed since you loaded it. Reload and try again.");
  const note = input.note?.trim();
  if (input.status !== "DONE") {
    if (task.required && !hasPermission(ctx, "task.waive")) throw forbidden("Waiving a required item needs officer or manager permission.");
    if (!note || note.length < 5) throw invalid("Give a reason when waiving or marking an item not applicable.");
  }
  if (task.isBlocker && input.status !== "DONE" && !hasPermission(ctx, "task.waive")) throw forbidden();

  return db.$transaction(async (client) => {
    await loadTransaction(ctx, task.transactionId, client);
    if (input.evidenceDocumentId) {
      const d = await client.document.findFirst({ where: { id: input.evidenceDocumentId, transactionId: task.transactionId } });
      if (!d) throw invalid("Evidence document must belong to this file.");
    }
    await lockAndBump(client, task.transactionId);
    if (input.status === "DONE" && task.requiresApproval) {
      const updated = await client.task.update({
        where: { id: task.id },
        data: { status: "WAITING", resolutionNote: note ?? null, evidenceDocumentId: input.evidenceDocumentId ?? task.evidenceDocumentId, version: { increment: 1 } },
      });
      const approval = await createApproval(client, ctx, {
        type: "TASK_COMPLETION",
        transactionId: task.transactionId,
        title: `Confirm completion: ${task.title}`,
        summary: note,
        subjectType: "Task",
        subjectId: task.id,
        binding: { taskId: task.id, title: updated.title, evidenceDocumentId: updated.evidenceDocumentId, resolutionNote: updated.resolutionNote },
        requiredPermission: "task.waive",
      });
      await client.task.update({ where: { id: task.id }, data: { approvalId: approval.id } });
      return { status: "AWAITING_APPROVAL" as const, approvalId: approval.id };
    }
    await client.task.update({
      where: { id: task.id },
      data: {
        status: input.status,
        completedAt: new Date(),
        completedById: actorId,
        resolutionNote: note ?? null,
        evidenceDocumentId: input.evidenceDocumentId ?? task.evidenceDocumentId,
        version: { increment: 1 },
      },
    });
    await audit(ctx, {
      action: `task.${input.status.toLowerCase()}`,
      entityType: "Task",
      entityId: task.id,
      entityVersion: task.version + 1,
      transactionId: task.transactionId,
      summary: `${input.status === "DONE" ? "Completed" : input.status === "WAIVED" ? "Waived" : "Marked not applicable"}: ${task.title}`,
      details: { note },
    }, client);
    return { status: "RESOLVED" as const };
  });
}

export async function reopenTask(ctx: Ctx, taskId: string, reason: string) {
  requirePermission(ctx, "task.manage");
  const task = await loadTask(ctx, taskId);
  if (!reason?.trim()) throw invalid("A reason is required.");
  await db.$transaction(async (client) => {
    await loadTransaction(ctx, task.transactionId, client);
    await lockAndBump(client, task.transactionId);
    await client.task.update({ where: { id: task.id }, data: { status: "OPEN", completedAt: null, completedById: null, version: { increment: 1 } } });
    await audit(ctx, { action: "task.reopened", entityType: "Task", entityId: task.id, transactionId: task.transactionId, summary: `Reopened: ${task.title}`, details: { reason } }, client);
  });
}

export async function updateTask(ctx: Ctx, taskId: string, input: { status?: "OPEN" | "IN_PROGRESS" | "WAITING"; assigneeUserId?: string | null; dueDate?: string | null }) {
  requirePermission(ctx, "task.manage");
  const task = await loadTask(ctx, taskId);
  if (input.assigneeUserId) {
    const m = await db.membership.findFirst({ where: { companyId: ctx.companyId, userId: input.assigneeUserId, role: { not: "EXTERNAL" }, status: "ACTIVE" } });
    if (!m) throw invalid("Assignee must be an active staff member.");
  }
  await db.$transaction(async (client) => {
    await lockAndBump(client, task.transactionId);
    await client.task.update({
      where: { id: task.id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.assigneeUserId !== undefined ? { assigneeUserId: input.assigneeUserId } : {}),
        ...(input.dueDate !== undefined ? { dueAt: input.dueDate ? parseDateOnly(input.dueDate) : null } : {}),
        version: { increment: 1 },
      },
    });
    await audit(ctx, { action: "task.updated", entityType: "Task", entityId: task.id, transactionId: task.transactionId, summary: `Updated: ${task.title}`, details: input }, client);
  });
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

export async function createDeadline(
  ctx: Ctx,
  transactionId: string,
  input: { title: string; type: DeadlineType; dueDate: string; notes?: string; documentId?: string; page?: number; excerpt?: string },
  source: "MANUAL" | "AI_PROPOSAL" = "MANUAL",
) {
  requirePermission(ctx, "deadline.manage");
  if (!input.title?.trim()) throw invalid("Title is required.");
  const dueAt = parseDateOnly(input.dueDate);
  return db.$transaction(async (client) => {
    const tx = await loadTransaction(ctx, transactionId, client);
    await lockAndBump(client, tx.id);
    const d = await client.deadline.create({
      data: {
        companyId: ctx.companyId,
        transactionId: tx.id,
        title: input.title.trim(),
        type: input.type,
        dueAt,
        notes: input.notes,
        source,
        documentId: input.documentId,
        page: input.page,
        excerpt: input.excerpt,
      },
    });
    await audit(ctx, { action: "deadline.created", entityType: "Deadline", entityId: d.id, transactionId: tx.id, summary: `Deadline added: ${d.title} (${input.dueDate})` }, client);
    return d;
  });
}

export async function resolveDeadline(ctx: Ctx, deadlineId: string, status: Exclude<DeadlineStatus, "PENDING">, note: string, newDueDate?: string) {
  requirePermission(ctx, "deadline.manage");
  if (isExternal(ctx)) throw notFound("Deadline");
  const d = await db.deadline.findFirst({ where: { id: deadlineId, companyId: ctx.companyId } });
  if (!d) throw notFound("Deadline");
  if (!note?.trim()) throw invalid("Add a note explaining the resolution.");
  await db.$transaction(async (client) => {
    await lockAndBump(client, d.transactionId);
    if (status === "EXTENDED") {
      if (!newDueDate) throw invalid("Provide the new due date.");
      await client.deadline.update({ where: { id: d.id }, data: { status: "EXTENDED", resolvedAt: new Date(), resolvedById: ctx.userId, notes: note } });
      await client.deadline.create({
        data: { companyId: d.companyId, transactionId: d.transactionId, title: d.title, type: d.type, dueAt: parseDateOnly(newDueDate), source: "MANUAL", notes: `Extended from ${d.dueAt.toISOString().slice(0, 10)}: ${note}` },
      });
    } else {
      await client.deadline.update({ where: { id: d.id }, data: { status, resolvedAt: new Date(), resolvedById: ctx.userId, notes: note } });
    }
    await audit(ctx, { action: `deadline.${status.toLowerCase()}`, entityType: "Deadline", entityId: d.id, transactionId: d.transactionId, summary: `Deadline ${status.toLowerCase()}: ${d.title}`, details: { note, newDueDate } }, client);
  });
}

// ---------------------------------------------------------------------------
// Milestones (signing, funding, recording, disbursement tracked separately)
// ---------------------------------------------------------------------------

export const FUNDING_SOURCES = ["BANK_RECONCILIATION", "VERIFIED_BANK_CONFIRMATION", "LENDER_FUNDING_NUMBER_VERIFIED"] as const;

/**
 * Updates a milestone. Funding confirmation is special: it requires
 * `milestone.confirm_funding`, a named authorized source, a reference, and an
 * evidence document. An email or screenshot alone is not an acceptable source;
 * the AI has no access to this function.
 */
export async function updateMilestone(
  ctx: Ctx,
  transactionId: string,
  kind: MilestoneKind,
  input: { status: MilestoneStatus; source?: string; reference?: string; evidenceDocumentId?: string; notes?: string; simulated?: boolean },
) {
  if (isExternal(ctx)) throw notFound("Transaction");
  const confirmingFunding = kind === "FUNDING" && input.status === "COMPLETE";
  // Funding confirmation has its own permission (accounting, officers); other updates need milestone.update.
  requirePermission(ctx, confirmingFunding ? "milestone.confirm_funding" : "milestone.update");
  const actorId = requireUser(ctx);
  if (confirmingFunding) {
    if (!input.source || !(FUNDING_SOURCES as readonly string[]).includes(input.source)) {
      throw invalid("Funding must be confirmed from an authorized source (bank reconciliation or verified bank/lender confirmation).");
    }
    if (!input.reference?.trim()) throw invalid("Enter the bank or lender reference for the funding confirmation.");
    if (!input.evidenceDocumentId) throw invalid("Attach evidence of the funding confirmation.");
  }
  if (input.status === "NOT_APPLICABLE" && !input.notes?.trim()) throw invalid("Explain why this milestone does not apply.");
  if (input.status === "COMPLETE" && (kind === "RECORDING" || kind === "SIGNING") && !input.evidenceDocumentId && !input.reference) {
    throw invalid(`Provide a reference or evidence document for ${kind.toLowerCase()} completion.`);
  }
  return db.$transaction(async (client) => {
    const tx = await loadTransaction(ctx, transactionId, client);
    if (input.evidenceDocumentId) {
      const d = await client.document.findFirst({ where: { id: input.evidenceDocumentId, transactionId: tx.id } });
      if (!d) throw invalid("Evidence must be a document in this file.");
    }
    await lockAndBump(client, tx.id);
    const m = await client.milestone.upsert({
      where: { transactionId_kind: { transactionId: tx.id, kind } },
      create: { companyId: ctx.companyId, transactionId: tx.id, kind, status: input.status },
      update: {},
    });
    await client.milestone.update({
      where: { id: m.id },
      data: {
        status: input.status,
        completedAt: input.status === "COMPLETE" ? new Date() : null,
        confirmedById: input.status === "COMPLETE" ? actorId : null,
        confirmationSource: input.source ?? (input.status === "COMPLETE" ? "STAFF_VERIFIED" : null),
        reference: input.reference ?? null,
        evidenceDocumentId: input.evidenceDocumentId ?? null,
        notes: input.notes ?? null,
        isSimulated: Boolean(input.simulated),
      },
    });
    await audit(ctx, {
      action: "milestone.updated",
      entityType: "Milestone",
      entityId: m.id,
      transactionId: tx.id,
      summary: `${kind.charAt(0)}${kind.slice(1).toLowerCase()} milestone → ${input.status.toLowerCase().replace("_", " ")}`,
      details: { source: input.source, reference: input.reference, simulated: input.simulated },
    }, client);
  });
}
