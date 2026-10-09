import type { Queue } from "bullmq";
import { db } from "../db";
import { log } from "../logger";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Durable background jobs.
 * - JobRun (PostgreSQL) is the source of truth: one row per logical job,
 *   unique idempotency key, status, attempts, last error, replay count.
 * - BullMQ (Redis) delivers jobs to workers with retries and exponential
 *   backoff. The BullMQ job id is the JobRun id, so a job is never queued twice.
 * - JOBS_MODE=inline runs jobs in-process (tests, or local use without Redis).
 * Payloads carry ids only, never secrets or document contents.
 */
export const QUEUE_NAME = "escrowflow";

export type JobType = "document.process" | "email.send" | "webhook.process" | "automation.company";

export function jobsMode(): "inline" | "queue" {
  const m = process.env.JOBS_MODE;
  if (m === "inline" || m === "queue") return m;
  return process.env.REDIS_URL && process.env.NODE_ENV !== "test" ? "queue" : "inline";
}

export function redisConnection() {
  const u = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname !== "/" ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

let queue: Queue | null = null;
async function getQueue() {
  if (!queue) {
    const { Queue } = await import("bullmq");
    queue = new Queue(QUEUE_NAME, { connection: redisConnection() });
  }
  return queue;
}

export interface EnqueueOptions {
  companyId?: string | null;
  idempotencyKey: string;
  delayMs?: number;
  maxAttempts?: number;
}

/** Creates the job once (by idempotency key) and hands it to the queue. */
export async function enqueueJob(type: JobType, payload: Record<string, unknown>, opts: EnqueueOptions) {
  let run;
  try {
    run = await db.jobRun.create({
      data: {
        companyId: opts.companyId ?? null,
        type,
        idempotencyKey: opts.idempotencyKey,
        payload: payload as Prisma.InputJsonValue,
        maxAttempts: opts.maxAttempts ?? 5,
        runAfter: new Date(Date.now() + (opts.delayMs ?? 0)),
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return { run: await db.jobRun.findUniqueOrThrow({ where: { idempotencyKey: opts.idempotencyKey } }), duplicate: true };
    }
    throw e;
  }
  await dispatch(run.id, run.maxAttempts, opts.delayMs ?? 0);
  return { run, duplicate: false };
}

async function dispatch(jobRunId: string, maxAttempts: number, delayMs: number) {
  if (jobsMode() === "inline") {
    const { runJob } = await import("./runner");
    try {
      await runJob(jobRunId);
    } catch (e) {
      log.warn("inline job failed (recorded on JobRun)", { jobRunId, error: e });
    }
    return;
  }
  const q = await getQueue();
  const run = await db.jobRun.findUniqueOrThrow({ where: { id: jobRunId } });
  await q.add(run.type, { jobRunId }, {
    jobId: `${jobRunId}-${run.replayCount}`,
    attempts: maxAttempts,
    backoff: { type: "exponential", delay: 5_000 },
    delay: delayMs,
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}

/** Re-queues a FAILED or DEAD job. Handlers are idempotent, so replay is safe. */
export async function replayJob(jobRunId: string) {
  const run = await db.jobRun.findUniqueOrThrow({ where: { id: jobRunId } });
  if (run.status !== "FAILED" && run.status !== "DEAD") throw new Error("Only failed jobs can be replayed");
  await db.jobRun.update({ where: { id: run.id }, data: { status: "QUEUED", attempts: 0, lastError: null, replayCount: { increment: 1 } } });
  await dispatch(run.id, run.maxAttempts, 0);
}

export async function closeQueue() {
  await queue?.close();
  queue = null;
}
