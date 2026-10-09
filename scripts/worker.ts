/**
 * Background worker: `npm run worker` (requires Redis).
 * Runs queued JobRuns with retries/backoff, and a scheduler that enqueues the
 * automation rules for each company every 15 minutes. Each scheduled run has a
 * time-window idempotency key, so restarts and multiple workers never produce
 * duplicate runs.
 */
import "dotenv/config";
import { Worker, Queue } from "bullmq";
import { QUEUE_NAME, redisConnection } from "../src/server/jobs/queue";
import { AUTOMATION_WINDOW_MS, automationTick } from "../src/server/jobs/sweep";
import { runJob } from "../src/server/jobs/runner";
import { db } from "../src/server/db";
import { log } from "../src/server/logger";

const TICK_MS = AUTOMATION_WINDOW_MS;
const SCHEDULER = "automation-tick";

async function main() {
  if (process.env.JOBS_MODE === "inline") throw new Error("JOBS_MODE=inline runs jobs in the web process; the worker is not needed.");
  const connection = redisConnection();
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.upsertJobScheduler(SCHEDULER, { every: TICK_MS }, { name: SCHEDULER, data: {} });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === SCHEDULER) return automationTick();
      const jobRunId = (job.data as { jobRunId?: string }).jobRunId;
      if (!jobRunId) throw new Error("Job is missing jobRunId");
      return runJob(jobRunId);
    },
    { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) },
  );
  worker.on("failed", (job, err) => log.warn("job attempt failed", { id: job?.id, name: job?.name, attempt: job?.attemptsMade, error: err.message }));
  log.info("worker started", { queue: QUEUE_NAME });

  const shutdown = async () => {
    log.info("worker stopping");
    await worker.close();
    await queue.close();
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log.error("worker crashed", { error: e });
  process.exit(1);
});
