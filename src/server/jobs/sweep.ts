import { db } from "../db";
import { log } from "../logger";
import { enqueueJob } from "./queue";
import { runJob } from "./runner";

/** How often scheduled automation runs; also the idempotency window for each run. */
export const AUTOMATION_WINDOW_MS = 15 * 60_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const STALE_RUNNING_MS = 10 * 60_000;
const LOST_DISPATCH_MS = 2 * 60_000;

/** Enqueues the automation rules for every company with an enabled rule, once per window. */
export async function automationTick(now = Date.now()) {
  const window = Math.floor(now / AUTOMATION_WINDOW_MS);
  const companies = await db.automationRule.findMany({ where: { enabled: true }, distinct: ["companyId"], select: { companyId: true } });
  for (const c of companies) {
    await enqueueJob("automation.company", {}, { companyId: c.companyId, idempotencyKey: `automation:${c.companyId}:${window}`, maxAttempts: 3 });
  }
  return { companies: companies.length };
}

export function backoffMs(attempts: number) {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

/**
 * Retries work that the in-process job modes cannot retry on their own:
 * FAILED jobs whose exponential backoff has elapsed, QUEUED jobs that were never
 * started (lost dispatch, delayed jobs), and RUNNING jobs left behind by a
 * function that timed out. runJob's claim step keeps this safe to run
 * concurrently with other sweeps. Bounded by `limit` and `budgetMs`.
 */
export async function sweepJobs(opts: { limit?: number; budgetMs?: number; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  const candidates = await db.jobRun.findMany({
    where: {
      OR: [
        { status: "FAILED" },
        { status: "QUEUED", runAfter: { lte: new Date(now) }, queuedAt: { lt: new Date(now - LOST_DISPATCH_MS) } },
        { status: "RUNNING", startedAt: { lt: new Date(now - STALE_RUNNING_MS) } },
      ],
    },
    orderBy: { queuedAt: "asc" },
    take: (opts.limit ?? 25) * 4,
  });
  const due = candidates.filter((j) => j.status !== "FAILED" || (j.finishedAt?.getTime() ?? 0) + backoffMs(j.attempts) <= now).slice(0, opts.limit ?? 25);
  let succeeded = 0;
  let failed = 0;
  for (const j of due) {
    if (Date.now() > deadline) break;
    try {
      await runJob(j.id);
      succeeded++;
    } catch (e) {
      failed++;
      log.warn("sweep: job attempt failed", { jobRunId: j.id, type: j.type, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { considered: due.length, succeeded, failed };
}
