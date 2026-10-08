import type { Ctx } from "../context";
import { log } from "../logger";

/**
 * Runs after a clean document version is stored: text extraction, OCR when
 * needed, and AI/demo extraction into proposals. Failures are recorded on the
 * ExtractionRun and never block the upload itself.
 */
export async function onDocumentVersionStored(ctx: Ctx, versionId: string): Promise<void> {
  try {
    const { processDocumentVersion } = await import("../ai/pipeline");
    await processDocumentVersion(ctx, versionId);
  } catch (e) {
    log.error("document processing failed", { versionId, error: e });
  }
}
