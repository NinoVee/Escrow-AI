import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { makeCompany, resetDb } from "./helpers";
import { appUrl, env, resetEnvCache } from "@/server/env";
import { enqueueJob, jobsMode } from "@/server/jobs/queue";
import { automationTick, backoffMs, sweepJobs } from "@/server/jobs/sweep";
import { GET as cronGET } from "@/app/api/cron/jobs/route";

const saved = { ...process.env };

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

afterEach(() => {
  for (const k of ["STORAGE_DRIVER", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL", "APP_URL", "JOBS_MODE", "CRON_SECRET", "MAX_UPLOAD_MB"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
});

describe("Vercel deployment support", () => {
  let companyId: string;
  beforeAll(async () => {
    await resetDb();
    companyId = (await makeCompany("Deploy Co")).company.id;
  });

  it("derives the public URL from APP_URL, then the Vercel production domain, then the deployment URL", () => {
    setEnv({ APP_URL: "https://escrow.example.com/", VERCEL_URL: "x.vercel.app" });
    expect(appUrl()).toBe("https://escrow.example.com");
    setEnv({ APP_URL: undefined, VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "escrowflow.vercel.app" });
    expect(appUrl()).toBe("https://escrowflow.vercel.app");
    setEnv({ VERCEL_ENV: "preview", VERCEL_URL: "escrowflow-git-branch.vercel.app" });
    expect(appUrl()).toBe("https://escrowflow-git-branch.vercel.app");
    setEnv({ VERCEL_URL: undefined, VERCEL_ENV: undefined, VERCEL_PROJECT_PRODUCTION_URL: undefined });
    expect(appUrl()).toBe("http://localhost:3000");
  });

  it("caps uploads at the Vercel request-body limit", () => {
    setEnv({ VERCEL: "1", MAX_UPLOAD_MB: "25" });
    expect(env().MAX_UPLOAD_MB).toBe(4);
    setEnv({ VERCEL: undefined });
    expect(env().MAX_UPLOAD_MB).toBe(25);
  });

  it("defaults to deferred jobs on Vercel and runs them immediately outside a request", async () => {
    setEnv({ VERCEL: "1", NODE_ENV: "production" });
    expect(jobsMode()).toBe("deferred");
    setEnv({ NODE_ENV: "test" });
    expect(jobsMode()).toBe("inline");
    setEnv({ JOBS_MODE: "deferred" });
    // Outside a request there is no `after` scope, so the job runs right away.
    const { run } = await enqueueJob("automation.company", {}, { companyId, idempotencyKey: "deploy:deferred:1" });
    expect((await db.jobRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("SUCCEEDED");
  });

  it("uses exponential backoff with a cap", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(20)).toBe(60 * 60_000);
  });

  it("sweep retries failed jobs only after their backoff, then marks them DEAD", async () => {
    const { run } = await enqueueJob("email.send", { outboundId: "missing" }, { companyId, idempotencyKey: "deploy:sweep:fail", maxAttempts: 2 });
    let r = await db.jobRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.status).toBe("FAILED");
    expect(r.attempts).toBe(1);
    // Backoff not elapsed: untouched.
    await sweepJobs({ now: r.finishedAt!.getTime() + 1_000 });
    expect((await db.jobRun.findUniqueOrThrow({ where: { id: run.id } })).attempts).toBe(1);
    // Backoff elapsed: retried and, at max attempts, DEAD.
    await sweepJobs({ now: r.finishedAt!.getTime() + backoffMs(1) + 1 });
    r = await db.jobRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.attempts).toBe(2);
    expect(r.status).toBe("DEAD");
    // DEAD jobs are never swept.
    await sweepJobs({ now: Date.now() + 24 * 3600_000 });
    expect((await db.jobRun.findUniqueOrThrow({ where: { id: run.id } })).attempts).toBe(2);
  });

  it("sweep picks up lost QUEUED jobs and RUNNING jobs left by a timed-out function", async () => {
    const old = new Date(Date.now() - 30 * 60_000);
    const lost = await db.jobRun.create({ data: { companyId, type: "automation.company", idempotencyKey: "deploy:lost", payload: {}, queuedAt: old, runAfter: old } });
    const stuck = await db.jobRun.create({ data: { companyId, type: "automation.company", idempotencyKey: "deploy:stuck", payload: {}, status: "RUNNING", attempts: 1, queuedAt: old, startedAt: old } });
    const fresh = await db.jobRun.create({ data: { companyId, type: "automation.company", idempotencyKey: "deploy:fresh", payload: {} } });
    const res = await sweepJobs();
    expect(res.succeeded).toBeGreaterThanOrEqual(2);
    expect((await db.jobRun.findUniqueOrThrow({ where: { id: lost.id } })).status).toBe("SUCCEEDED");
    expect((await db.jobRun.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe("SUCCEEDED");
    // A just-queued job is left to its in-process dispatch.
    expect((await db.jobRun.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("QUEUED");
  });

  it("automation tick enqueues once per window and only for companies with enabled rules", async () => {
    const before = await db.jobRun.count({ where: { type: "automation.company", companyId } });
    expect((await automationTick()).companies).toBe(0);
    await db.automationRule.updateMany({ where: { companyId, key: "overdue-escalation" }, data: { enabled: true } });
    const now = Date.now();
    expect((await automationTick(now)).companies).toBe(1);
    await automationTick(now);
    expect(await db.jobRun.count({ where: { type: "automation.company", companyId } })).toBe(before + 1);
  });

  it("cron endpoint requires the CRON_SECRET bearer token", async () => {
    setEnv({ CRON_SECRET: undefined });
    expect((await cronGET(new Request("http://x/api/cron/jobs"))).status).toBe(503);
    setEnv({ CRON_SECRET: "a-long-cron-secret-value-123" });
    expect((await cronGET(new Request("http://x/api/cron/jobs"))).status).toBe(401);
    expect((await cronGET(new Request("http://x/api/cron/jobs", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    const ok = await cronGET(new Request("http://x/api/cron/jobs", { headers: { authorization: "Bearer a-long-cron-secret-value-123" } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ sweep: { considered: expect.any(Number) } });
  });

  it("defaults to database storage on Vercel when STORAGE_DRIVER is unset", () => {
    setEnv({ VERCEL: "1", STORAGE_DRIVER: undefined });
    expect(env().STORAGE_DRIVER).toBe("database");
    setEnv({ VERCEL: undefined });
    expect(env().STORAGE_DRIVER).toBe("local");
  });

  it("refuses local disk storage on Vercel", async () => {
    setEnv({ VERCEL: "1", STORAGE_DRIVER: "local" });
    vi.resetModules();
    const fresh = await import("@/server/storage/storage");
    expect(() => fresh.storage()).toThrow(/cannot be used on Vercel/);
  });

  it("database storage driver stores privately and serves through user-bound signed links", async () => {
    setEnv({ STORAGE_DRIVER: "database", VERCEL: "1" });
    vi.resetModules();
    const { storage, verifyLocalToken } = await import("@/server/storage/storage");
    const st = storage();
    expect(st.kind).toBe("database");
    await st.put("tests/a.pdf", Buffer.from("%PDF-1.4 test"), "application/pdf");
    expect((await st.get("tests/a.pdf")).toString()).toBe("%PDF-1.4 test");
    await st.move("tests/a.pdf", "tests/b.pdf");
    await expect(st.get("tests/a.pdf")).rejects.toThrow();
    const url = await st.signedDownloadUrl("tests/b.pdf", { filename: "b.pdf", contentType: "application/pdf", ttlSeconds: 60, userId: "user-1" });
    const token = url.replace("/api/files/", "");
    expect(verifyLocalToken(token)).toMatchObject({ k: "tests/b.pdf", u: "user-1" });
    expect(verifyLocalToken(token.slice(0, -2) + "00")).toBeNull();
    await expect(st.put("../escape", Buffer.from("x"), "text/plain")).rejects.toThrow(/Invalid storage key/);
    await st.remove("tests/b.pdf");
    expect(await db.storedObject.count({ where: { key: { startsWith: "tests/" } } })).toBe(0);
  });
});
