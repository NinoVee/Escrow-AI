import { db } from "../db";
import { requirePermission, requireUser, type Ctx } from "../context";
import { notFound, precondition } from "../errors";
import { audit } from "../audit";
import { replayJob } from "../jobs/queue";

/** Job and webhook monitoring (Settings → Jobs). */
export async function listJobs(ctx: Ctx, filter?: { status?: string }) {
  requirePermission(ctx, "jobs.manage");
  const status = filter?.status && ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "DEAD"].includes(filter.status) ? (filter.status as "FAILED") : undefined;
  const [jobs, counts, webhooks] = await Promise.all([
    db.jobRun.findMany({ where: { companyId: ctx.companyId, ...(status ? { status } : {}) }, orderBy: { queuedAt: "desc" }, take: 100 }),
    db.jobRun.groupBy({ by: ["status"], where: { companyId: ctx.companyId }, _count: true }),
    db.webhookEvent.findMany({ where: { companyId: ctx.companyId }, orderBy: { receivedAt: "desc" }, take: 50 }),
  ]);
  return { jobs, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) as Record<string, number>, webhooks };
}

/** Safe replay: handlers are idempotent and re-check every gate. */
export async function replayJobForCompany(ctx: Ctx, jobRunId: string) {
  requirePermission(ctx, "jobs.manage");
  const run = await db.jobRun.findFirst({ where: { id: jobRunId, companyId: ctx.companyId } });
  if (!run) throw notFound("Job");
  if (run.status !== "FAILED" && run.status !== "DEAD") throw precondition("Only failed jobs can be replayed.");
  await audit(ctx, { action: "job.replayed", entityType: "JobRun", entityId: run.id, summary: `Replayed ${run.type} job (attempt history: ${run.attempts}; last error: ${run.lastError ?? "none"})` });
  await replayJob(run.id);
}

export async function listNotifications(ctx: Ctx) {
  const userId = requireUser(ctx);
  return db.notification.findMany({ where: { companyId: ctx.companyId, userId }, orderBy: { createdAt: "desc" }, take: 30 });
}

export async function unreadNotificationCount(ctx: Ctx) {
  if (!ctx.userId) return 0;
  return db.notification.count({ where: { companyId: ctx.companyId, userId: ctx.userId, readAt: null } });
}

export async function markNotificationsRead(ctx: Ctx) {
  const userId = requireUser(ctx);
  await db.notification.updateMany({ where: { companyId: ctx.companyId, userId, readAt: null }, data: { readAt: new Date() } });
}
