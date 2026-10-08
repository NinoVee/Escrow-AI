import type { Ctx } from "../context";

/**
 * Hook that runs after a clean document version is stored. Phase 1 performs
 * no processing; Phase 2 adds text extraction, OCR and AI extraction jobs.
 */
export async function onDocumentVersionStored(_ctx: Ctx, _versionId: string): Promise<void> {
  return;
}
