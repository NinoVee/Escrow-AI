import type { SeedContext } from "./seed";
import { db } from "../src/server/db";
import { recordReceipt } from "../src/server/ledger/journal";
import { addSettlementItem } from "../src/server/services/settlement";
import { prepareDisbursement, requestDisbursementApproval, saveBankInstruction, verifyBankInstruction } from "../src/server/services/payments";
import { createTransaction } from "../src/server/services/transactions";
import { resolveTask, updateMilestone } from "../src/server/services/tasks";
import { uploadDocument } from "../src/server/services/documents";
import { decideApproval } from "../src/server/services/approvals";
import { transitionStage } from "../src/server/workflow/engine";
import { importBankStatement, autoMatch } from "../src/server/services/reconciliation";
import { simpleDoc } from "./fixtures";
import type { Ctx } from "../src/server/context";

async function stepUp(ctx: Ctx) {
  await db.stepUpVerification.create({ data: { userId: ctx.userId!, sessionId: ctx.sessionId!, success: true, expiresAt: new Date(Date.now() + 30 * 60_000) } });
}

async function resolveStage(ctx: Ctx, transactionId: string, stages: string[]) {
  const tasks = await db.task.findMany({ where: { transactionId, stage: { in: stages }, status: { in: ["OPEN", "IN_PROGRESS"] } } });
  for (const t of tasks) await resolveTask(ctx, t.id, { status: "DONE", note: "Completed (demo seed)" });
}

/** Moves through a transition, approving it with a second officer when required. */
async function move(requester: Ctx, approver: Ctx, transactionId: string, toStage: string, reason: string) {
  const res = await transitionStage(requester, transactionId, { toStage, reason });
  if (res.status === "AWAITING_APPROVAL") await decideApproval(approver, res.approvalId, "APPROVED", "Reviewed (demo seed)");
  else if (res.status === "BLOCKED") throw new Error(`Seed could not move to ${toStage}: ${res.unmet.map((u) => u.label + " " + u.detail).join("; ")}`);
}

export async function seedPhase3(s: SeedContext) {
  const officer = s.ctx("officer");
  const officer2 = s.ctx("officer2");
  const accounting = s.ctx("accounting");
  const accounting2 = s.ctx("accounting2");
  const assistant = s.ctx("assistant");
  for (const c of [officer, accounting, accounting2]) await stepUp(c);

  // --- Residential 1: deposit, settlement inputs, payoff instructions awaiting verification
  await recordReceipt(accounting, s.tx.r1, { amount: "26,250.00", date: "2026-10-01", memo: "Initial deposit from buyer (wire)", reference: "FED-20261001-1182", idempotencyKey: "receipt:r1:FED-20261001-1182" });
  await addSettlementItem(officer, s.tx.r1, { kind: "FEE", description: "Escrow fee", payee: "Golden Oak Escrow (demo)", amount: "2,450.00", chargeTo: "SPLIT", buyerSharePercent: "50" });
  await addSettlementItem(officer, s.tx.r1, { kind: "FEE", description: "Owner's title policy", payee: "Sierra Pine Title (fictional)", amount: "2,186.00", chargeTo: "SELLER" });
  await addSettlementItem(officer, s.tx.r1, { kind: "FEE", description: "Lender's title policy", payee: "Sierra Pine Title (fictional)", amount: "1,240.00", chargeTo: "BUYER" });
  await addSettlementItem(officer, s.tx.r1, { kind: "FEE", description: "County documentary transfer tax", payee: "Sacramento County (fictional entry)", amount: "962.50", chargeTo: "SELLER" });
  await addSettlementItem(officer, s.tx.r1, { kind: "PAYOFF", description: "Payoff: Redwood Coast Mortgage loan", payee: "Redwood Coast Mortgage (fictional)", amount: "398,412.77", chargeTo: "SELLER" });
  await addSettlementItem(officer, s.tx.r1, { kind: "PRORATION", description: "County property taxes 2026-27 (paid by seller)", amount: "9,843.20", proration: { type: "PREPAID_BY_SELLER", periodStart: "2026-07-01", periodEnd: "2027-06-30" } });
  await addSettlementItem(officer, s.tx.r1, { kind: "PRORATION", description: "HOA dues, October (paid by seller)", amount: "285.00", proration: { type: "PREPAID_BY_SELLER", periodStart: "2026-10-01", periodEnd: "2026-10-31" } });
  await addSettlementItem(officer, s.tx.r1, { kind: "SELLER_CREDIT", description: "Seller credit for roof repair", amount: "3,500.00" });
  await saveBankInstruction(officer, s.tx.r1, { payeeName: "Redwood Coast Mortgage (fictional)", bankName: "Fictional Mortgage Servicing Bank", accountNumber: "000555777999", routingNumber: "121000358", receivedVia: "Payoff demand received from lender portal, uploaded by assistant" });

  // --- Commercial: earnest money, verified seller instructions, a disbursement awaiting approval
  await recordReceipt(accounting, s.tx.c1, { amount: "427,500.00", date: "2026-08-22", memo: "Earnest money deposit (Bayline)", reference: "FED-20260822-0907", idempotencyKey: "receipt:c1:FED-20260822-0907" });
  const trustIns = await saveBankInstruction(officer, s.tx.c1, { payeeName: "Keystone Exchange Services (fictional)", bankName: "Fictional Commerce Bank", accountNumber: "000111222333", routingNumber: "026009593", receivedVia: "Signed QI instruction letter delivered in person" });
  await verifyBankInstruction(accounting, trustIns.id, { method: "CALLBACK_KNOWN_NUMBER", contactName: "Keystone operations desk", phoneLast4: "4410", phoneSource: "Number from the executed exchange agreement on file, not from the instruction letter", outcome: "CONFIRMED" });
  const ext = await prepareDisbursement(accounting, s.tx.c1, { payeeName: "Keystone Exchange Services (fictional)", method: "WIRE", amount: "15,000.00", instructionId: trustIns.id, memo: "Extension fee per amendment (demo)" });
  await requestDisbursementApproval(accounting, ext.id);
  await addSettlementItem(officer, s.tx.c1, { kind: "PRORATION", description: "Rents collected for October (Arcadia Logistics)", amount: "41,250.00", proration: { type: "RENT_COLLECTED_BY_SELLER", periodStart: "2026-10-01", periodEnd: "2026-10-31" } });
  await addSettlementItem(officer, s.tx.c1, { kind: "HOLDBACK", description: "Holdback for roof replacement (post-closing obligation)", amount: "125,000.00" });
  await addSettlementItem(officer, s.tx.c1, { kind: "FEE", description: "Escrow fee", amount: "9,800.00", chargeTo: "SPLIT", buyerSharePercent: "50" });

  // --- Residential 4: driven through the workflow to disbursement review.
  const r4 = await createTransaction(officer, {
    type: "RESIDENTIAL",
    escrowNumber: "GOE-2026-0104",
    title: "Kowalczyk sale (closing week)",
    officerId: s.users.officer,
    assistantId: s.users.assistant,
    property: { street: "4410 Mesa Verde Dr", city: "Rancho Cordova", county: "Sacramento", state: "CA", postalCode: "95670", apn: "072-0560-008-0000" },
    parties: [
      { role: "BUYER", displayName: "Tanvir & Leah Chowdhury" },
      { role: "SELLER", displayName: "Irena Kowalczyk" },
    ],
    fields: { purchasePriceCents: "540,000.00", initialDepositCents: "16,200.00", financingType: "CASH", acceptanceDate: "2026-09-02", proposedClosingDate: "2026-10-09" },
  });
  s.tx.r4 = r4.id;
  await resolveStage(assistant, r4.id, ["OPEN"]);
  await move(officer, officer2, r4.id, "OPEN", "Instructions received");
  await move(officer, officer2, r4.id, "DOCUMENT_COLLECTION", "Opening complete");
  await resolveStage(assistant, r4.id, ["DOCUMENT_COLLECTION"]);
  await move(officer, officer2, r4.id, "REVIEW", "Documents collected");
  await resolveStage(officer, r4.id, ["REVIEW"]);
  await move(officer, officer2, r4.id, "READY_FOR_SIGNING", "Review complete");
  await resolveStage(assistant, r4.id, ["READY_FOR_SIGNING"]);
  await updateMilestone(officer, r4.id, "SIGNING", { status: "COMPLETE", reference: "Mobile notary appointment 10/6 (fictional)" });
  await move(officer, officer2, r4.id, "SIGNED", "All parties signed");
  await move(officer, officer2, r4.id, "FUNDING_REVIEW", "Awaiting funds");
  await recordReceipt(accounting, r4.id, { amount: "16,200.00", date: "2026-09-04", memo: "Initial deposit", reference: "FED-20260904-0311", idempotencyKey: "receipt:r4:FED-20260904-0311" });
  await recordReceipt(accounting, r4.id, { amount: "523,800.00", date: "2026-10-07", memo: "Buyer closing funds (cash purchase)", reference: "FED-20261007-2210", idempotencyKey: "receipt:r4:FED-20261007-2210" });
  const evidence = await uploadDocument(accounting, { transactionId: r4.id, filename: "bank-confirmation.pdf", title: "Incoming wire confirmation from trust bank portal", category: "FUNDING_EVIDENCE", data: simpleDoc("INCOMING WIRE CONFIRMATION (FICTIONAL)", ["Amount: $523,800.00", "Reference: FED-20261007-2210"]) });
  await updateMilestone(accounting, r4.id, "FUNDING", { status: "COMPLETE", source: "VERIFIED_BANK_CONFIRMATION", reference: "FED-20261007-2210", evidenceDocumentId: evidence.document.id });
  await resolveStage(officer, r4.id, ["FUNDING_REVIEW"]);
  await move(officer, officer2, r4.id, "READY_FOR_RECORDING", "Funds confirmed");
  await resolveStage(officer, r4.id, ["READY_FOR_RECORDING"]);
  await updateMilestone(officer, r4.id, "RECORDING", { status: "COMPLETE", reference: "Instrument 2026-1008-004417 (fictional)" });
  await move(officer, officer2, r4.id, "RECORDED", "Recording confirmed by title");
  await resolveStage(assistant, r4.id, ["RECORDED"]);
  await move(officer, officer2, r4.id, "DISBURSEMENT_REVIEW", "Ready to disburse");
  await prepareDisbursement(accounting, r4.id, { payeeName: "Irena Kowalczyk", method: "CHECK", amount: "524,615.00", memo: "Seller proceeds (demo)" });

  // --- A bank statement import so reconciliation can be demonstrated.
  const bank = await db.bankAccount.findFirstOrThrow({ where: { companyId: s.companies["golden-oak"] } });
  const csv = [
    "Date,Description,Amount,Transaction ID",
    "2026-08-22,INCOMING WIRE BAYLINE INDUSTRIAL,427500.00,SCB-0822-01",
    "2026-09-04,INCOMING WIRE CHOWDHURY,16200.00,SCB-0904-07",
    "2026-10-01,INCOMING WIRE NATARAJAN,26250.00,SCB-1001-03",
    "2026-10-07,INCOMING WIRE CHOWDHURY,523800.00,SCB-1007-11",
    "2026-10-07,BANK SERVICE FEE,-35.00,SCB-1007-12",
  ].join("\n");
  await importBankStatement(accounting, bank.id, { filename: "sierra-community-2026-10-07.csv", content: csv, statementDate: "2026-10-07", endingBalance: "993,715.00" });
  await autoMatch(accounting, bank.id);
}
