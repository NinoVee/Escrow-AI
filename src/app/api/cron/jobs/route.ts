import { NextResponse } from "next/server";
import { env } from "@/server/env";
import { safeEqualHex, sha256Hex } from "@/server/crypto";
import { jobsMode } from "@/server/jobs/queue";
import { automationTick, sweepJobs } from "@/server/jobs/sweep";
import { log } from "@/server/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduled maintenance for hosts without a worker (Vercel Cron):
 * retries failed/stalled jobs and enqueues automation rules.
 * Authenticated with `Authorization: Bearer <CRON_SECRET>`; disabled when no secret is set.
 */
export async function GET(request: Request) {
  const secret = env().CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "Cron is not configured (CRON_SECRET)" }, { status: 503 });
  const header = request.headers.get("authorization") ?? "";
  if (!safeEqualHex(sha256Hex(header), sha256Hex(`Bearer ${secret}`))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (jobsMode() === "queue") return NextResponse.json({ skipped: "A BullMQ worker handles retries and scheduling in queue mode." });
  const automation = await automationTick();
  const sweep = await sweepJobs({ budgetMs: 45_000 });
  log.info("cron: jobs swept", { ...sweep, companies: automation.companies });
  return NextResponse.json({ automation, sweep });
}
