import { db } from "../db";
import { log } from "../logger";
import { handlers } from "./handlers";
import type { JobType } from "./queue";
import type { Prisma } from "@/generated/prisma/client";

const STALE_RUNNING_MS = 10 * 60_000;

/**
 * Executes one JobRun. Safe to call more than once:
 * - SUCCEEDED jobs return immediately (idempotent completion);
 * - a claim step (QUEUED/FAILED → RUNNING) prevents two workers running it at once;
 * - failures are recorded; the job becomes DEAD after maxAttempts.
 */
export async function runJob(jobRunId: string) {
  const run = await db.jobRun.findUnique({ where: { id: jobRunId } });
  if (!run) throw new Error(`JobRun ${jobRunId} not found`);
  if (run.status === "SUCCEEDED") return run.result;
  if (run.status === "DEAD") return null;

  const staleBefore = new Date(Date.now() - STALE_RUNNING_MS);
  const claimed = await db.jobRun.updateMany({
    where: { id: run.id, OR: [{ status: { in: ["QUEUED", "FAILED"] } }, { status: "RUNNING", startedAt: { lt: staleBefore } }] },
    data: { status: "RUNNING", attempts: { increment: 1 }, startedAt: new Date() },
  });
  if (claimed.count === 0) throw new Error(`JobRun ${run.id} is already running`);
  const current = await db.jobRun.findUniqueOrThrow({ where: { id: run.id } });

  const handler = handlers[run.type as JobType];
  try {
    if (!handler) throw new Error(`No handler for job type ${run.type}`);
    const result = await handler(run.payload as Record<string, unknown>, { companyId: run.companyId, jobRunId: run.id });
    await db.jobRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", finishedAt: new Date(), result: (result ?? null) as Prisma.InputJsonValue, lastError: null } });
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 500) : "Unknown error";
    const dead = current.attempts >= current.maxAttempts;
    await db.jobRun.update({ where: { id: run.id }, data: { status: dead ? "DEAD" : "FAILED", lastError: message, finishedAt: new Date() } });
    log.error("job failed", { jobRunId: run.id, type: run.type, attempts: current.attempts, dead });
    throw e;
  }
}
