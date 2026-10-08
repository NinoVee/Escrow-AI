import type { SeedContext } from "./seed";
import { uploadDocument } from "../src/server/services/documents";
import { injectedAmendment, residentialAmendment } from "./fixtures";

/**
 * Phase 2 demo data. Uploading runs extraction automatically, so these create
 * pending proposals: an amendment that conflicts with accepted terms, and an
 * addendum containing text that tries to instruct an AI system.
 */
export async function seedPhase2(s: SeedContext) {
  const officer = s.ctx("officer");
  await uploadDocument(officer, {
    transactionId: s.tx.r1,
    filename: "Amendment-1.pdf",
    title: "Amendment No. 1 (closing date)",
    category: "AMENDMENT",
    data: residentialAmendment({ price: "875,000.00", closing: "November 6, 2026", effective: "October 6, 2026" }),
  });
  await uploadDocument(s.ctx("assistant"), {
    transactionId: s.tx.r2,
    filename: "Addendum-misc.pdf",
    title: "Miscellaneous addendum (received by email)",
    category: "AMENDMENT",
    data: injectedAmendment(),
  });
}
