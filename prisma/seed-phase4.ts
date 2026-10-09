import type { SeedContext } from "./seed";
import { db } from "../src/server/db";
import { approveTemplate, runAutomationForCompany, updateRule } from "../src/server/services/automation";
import { createOutboundDraft, requestSendApproval } from "../src/server/services/outbound";
import { runPropertyLookup, sendForSignature, simulateProviderEvent, submitProviderTitleOrder, submitRecording } from "../src/server/services/integrations";

/** Phase 4: automation rules and templates, demo provider records, outbound email drafts. */
export async function seedPhase4(s: SeedContext) {
  const admin = s.ctx("admin");
  const officer = s.ctx("officer");
  const assistant = s.ctx("assistant");
  const golden = s.companies["golden-oak"];

  // Templates approved by an officer; one rule enabled in review mode, plus internal escalations.
  for (const key of ["deadline-reminder", "document-request"]) {
    const t = await db.messageTemplate.findUniqueOrThrow({ where: { companyId_key: { companyId: golden, key } } });
    await approveTemplate(officer, t.id);
  }
  const rule = (key: string) => db.automationRule.findUniqueOrThrow({ where: { companyId_key: { companyId: golden, key } } });
  await updateRule(admin, (await rule("deadline-reminders")).id, { enabled: true, mode: "DRAFT_FOR_REVIEW", daysBefore: 7 });
  await updateRule(admin, (await rule("overdue-escalation")).id, { enabled: true, mode: "DRAFT_FOR_REVIEW", daysOverdue: 1 });
  await runAutomationForCompany(golden);

  // A manual email awaiting approval (requested by the assistant; an officer must approve).
  const buyer = await db.participant.findFirst({ where: { transactionId: s.tx.r1, role: "BUYER" } });
  if (buyer) {
    const draft = await createOutboundDraft(assistant, { transactionId: s.tx.r1, participantIds: [buyer.id], subject: "GOE-2026-0101: open items this week", body: "Hello,\n\nPlease upload your signed escrow instructions and the homeowner's insurance binder through your secure portal. Thank you." });
    await requestSendApproval(assistant, draft.id);
  }

  // Demo provider activity.
  await runPropertyLookup(officer, s.tx.r1, "PROPERTY_DATA");
  await submitProviderTitleOrder(officer, s.tx.c1);
  const r1Docs = await db.document.findMany({ where: { transactionId: s.tx.r1, archivedAt: null }, take: 1, orderBy: { createdAt: "asc" } });
  const signers = await db.participant.findMany({ where: { transactionId: s.tx.r1, role: { in: ["BUYER", "SELLER"] } } });
  if (r1Docs.length && signers.length) {
    const env = await sendForSignature(officer, s.tx.r1, { documentIds: r1Docs.map((d) => d.id), signerParticipantIds: signers.map((p) => p.id), subject: "Escrow instructions for signature (demo)" });
    await simulateProviderEvent(officer, "ENVELOPE", env.id);
  }
  const r4Docs = await db.document.findMany({ where: { transactionId: s.tx.r4, archivedAt: null }, take: 1 });
  if (r4Docs.length) {
    const rec = await submitRecording(officer, s.tx.r4, r4Docs.map((d) => d.id));
    await simulateProviderEvent(officer, "RECORDING", rec.id);
  }
}
