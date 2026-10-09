import { db } from "../db";
import { systemCtx } from "../context";
import type { JobType } from "./queue";

type Handler = (payload: Record<string, unknown>, meta: { companyId: string | null; jobRunId: string }) => Promise<unknown>;

function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== "string" || !v) throw new Error(`Job payload is missing ${key}`);
  return v;
}

function requireCompany(meta: { companyId: string | null }): string {
  if (!meta.companyId) throw new Error("Job has no company scope");
  return meta.companyId;
}

/**
 * Job handlers. Each one runs with a narrow SYSTEM/JOB context scoped to the
 * JobRun's company (never a company id taken from the payload), and each is
 * idempotent so retries and manual replays are safe.
 */
export const handlers: Record<JobType, Handler> = {
  async "document.process"(payload, meta) {
    const companyId = requireCompany(meta);
    const versionId = str(payload, "versionId");
    const version = await db.documentVersion.findFirst({ where: { id: versionId, companyId }, select: { id: true } });
    if (!version) throw new Error("Document version not found for company");
    const existing = await db.extractionRun.findFirst({ where: { documentVersionId: versionId, status: { in: ["SUCCEEDED", "RUNNING"] } } });
    if (existing) return { status: "already processed", runId: existing.id };
    const { processDocumentVersion } = await import("../ai/pipeline");
    const requestedBy = typeof payload.requestedById === "string" ? payload.requestedById : null;
    const res = await processDocumentVersion({ ...systemCtx(companyId, "document-pipeline", "JOB"), userId: requestedBy }, versionId);
    // Extraction failures (e.g. OCR required) are recorded on the ExtractionRun and shown on the document; not retried.
    return res;
  },
  async "email.send"(payload, meta) {
    const { deliverOutbound } = await import("../services/outbound");
    return deliverOutbound(requireCompany(meta), str(payload, "outboundId"));
  },
  async "webhook.process"(payload) {
    const { processWebhookEvent } = await import("../integrations/webhooks");
    return processWebhookEvent(str(payload, "webhookEventId"));
  },
  async "automation.company"(_payload, meta) {
    const { runAutomationForCompany } = await import("../services/automation");
    return runAutomationForCompany(requireCompany(meta));
  },
};
