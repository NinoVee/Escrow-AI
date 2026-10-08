import { db } from "../db";
import { can, type Permission } from "../authz";
import { isExternal, requirePermission, type Ctx } from "../context";
import { addDays, todayInZone } from "@/lib/dates";
import { getCompanySettings } from "../settings";
import type { Prisma } from "@/generated/prisma/client";

const OPEN_TASK: Prisma.TaskWhereInput["status"] = { in: ["OPEN", "IN_PROGRESS", "WAITING"] };

export async function dashboard(ctx: Ctx) {
  requirePermission(ctx, "transaction.read");
  const settings = await getCompanySettings(ctx.companyId);
  const today = todayInZone(settings.timezone);
  const horizon = addDays(today, 14);
  const activeTx = { companyId: ctx.companyId, status: { in: ["ACTIVE", "ON_HOLD"] as ("ACTIVE" | "ON_HOLD")[] } };

  const [activeByType, onHold, upcomingDeadlines, overdueTasks, blockers, closingSoon, pendingApprovals, pendingProposals] = await Promise.all([
    db.transaction.groupBy({ by: ["type"], where: { companyId: ctx.companyId, status: "ACTIVE" }, _count: true }),
    db.transaction.count({ where: { companyId: ctx.companyId, status: "ON_HOLD" } }),
    db.deadline.findMany({
      where: { companyId: ctx.companyId, status: "PENDING", dueAt: { lte: horizon }, transaction: activeTx },
      include: { transaction: { select: { id: true, escrowNumber: true, type: true } } },
      orderBy: { dueAt: "asc" },
      take: 15,
    }),
    db.task.findMany({
      where: { companyId: ctx.companyId, status: OPEN_TASK, dueAt: { lt: today }, transaction: activeTx },
      include: { transaction: { select: { id: true, escrowNumber: true } } },
      orderBy: { dueAt: "asc" },
      take: 15,
    }),
    db.task.findMany({
      where: { companyId: ctx.companyId, isBlocker: true, status: OPEN_TASK, transaction: activeTx },
      include: { transaction: { select: { id: true, escrowNumber: true } } },
      orderBy: { createdAt: "asc" },
      take: 15,
    }),
    db.transaction.findMany({
      where: { companyId: ctx.companyId, status: "ACTIVE", proposedClosingDate: { gte: today, lte: horizon } },
      include: { properties: { take: 1 } },
      orderBy: { proposedClosingDate: "asc" },
      take: 10,
    }),
    db.approval.findMany({
      where: { companyId: ctx.companyId, status: "PENDING" },
      include: { transaction: { select: { id: true, escrowNumber: true } } },
      orderBy: { createdAt: "asc" },
      take: 50,
    }),
    db.proposal.count({ where: { companyId: ctx.companyId, status: "PENDING" } }),
  ]);

  const awaitingMe = pendingApprovals.filter((a) => a.requestedById !== ctx.userId && can(ctx.role, a.requiredPermission as Permission));
  return {
    today,
    counts: {
      residential: activeByType.find((g) => g.type === "RESIDENTIAL")?._count ?? 0,
      commercial: activeByType.find((g) => g.type === "COMMERCIAL")?._count ?? 0,
      onHold,
      overdueTasks: overdueTasks.length,
      blockers: blockers.length,
      awaitingMyApproval: awaitingMe.length,
      pendingProposals,
    },
    upcomingDeadlines,
    overdueTasks,
    blockers,
    closingSoon,
    awaitingMe: awaitingMe.slice(0, 10),
  };
}

export async function listAuditEvents(ctx: Ctx, filter: { transactionId?: string; take?: number } = {}) {
  if (isExternal(ctx)) return [];
  if (!filter.transactionId) requirePermission(ctx, "audit.read");
  else requirePermission(ctx, "transaction.read");
  return db.auditEvent.findMany({
    where: { companyId: ctx.companyId, ...(filter.transactionId ? { transactionId: filter.transactionId } : {}) },
    orderBy: { seq: "desc" },
    take: filter.take ?? 200,
  });
}
