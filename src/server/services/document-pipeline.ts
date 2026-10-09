import type { Ctx } from "../context";
import { log } from "../logger";
import { enqueueJob } from "../jobs/queue";

/**
 * Runs after a clean document version is stored: text extraction, OCR when
 * needed, and AI/demo extraction into proposals, as a durable background job
 * (inline when JOBS_MODE=inline). Failures are recorded on the JobRun and the
 * ExtractionRun and never block the upload itself.
 */
export async function onDocumentVersionStored(ctx: Ctx, versionId: string): Promise<void> {
  try {
    await enqueueJob("document.process", { versionId, requestedById: ctx.userId }, { companyId: ctx.companyId, idempotencyKey: `document.process:${versionId}`, maxAttempts: 3 });
  } catch (e) {
    log.error("could not queue document processing", { versionId, error: e });
  }
}
