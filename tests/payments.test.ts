import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { expectAppError, grantStepUp, makeCompany, makeTx, makeUser, resetDb } from "./helpers";
import {
  listBankInstructions,
  prepareDisbursement,
  recordDisbursementRelease,
  requestDisbursementApproval,
  revealBankInstruction,
  saveBankInstruction,
  updateDisbursement,
  validRoutingNumber,
  verifyBankInstruction,
} from "@/server/services/payments";
import { decideApproval } from "@/server/services/approvals";
import { fileBalance, recordReceipt } from "@/server/ledger/journal";
import { transitionStage } from "@/server/workflow/engine";
import { systemCtx, type Ctx } from "@/server/context";

const INSTR = { payeeName: "Redwood Coast Mortgage", bankName: "Fictional Bank NA", accountNumber: "000123456789", routingNumber: "121000358", receivedVia: "Payoff demand on lender letterhead, uploaded by title" };
const VERIFY = { method: "CALLBACK_KNOWN_NUMBER" as const, contactName: "Payoff department supervisor", phoneLast4: "0199", phoneSource: "Lender phone number from our approved vendor directory, not from the demand", outcome: "CONFIRMED" as const };

describe("bank instructions and disbursement controls", () => {
  let officer: Ctx, officer2: Ctx, assistant: Ctx, accounting: Ctx, accounting2: Ctx, manager: Ctx;
  let txId: string;

  beforeAll(async () => {
    await resetDb();
    const c = await makeCompany("Payments Co");
    officer = await makeUser(c.company.id, "ESCROW_OFFICER", "Officer");
    officer2 = await makeUser(c.company.id, "ESCROW_OFFICER", "Officer Two");
    assistant = await makeUser(c.company.id, "ESCROW_ASSISTANT", "Assistant");
    accounting = await makeUser(c.company.id, "ACCOUNTING", "Accountant");
    accounting2 = await makeUser(c.company.id, "ACCOUNTING", "Accountant Two");
    manager = await makeUser(c.company.id, "MANAGER", "Manager");
    for (const u of [officer, officer2, accounting, accounting2, manager]) await grantStepUp(u);
  });

  beforeEach(async () => {
    txId = (await makeTx(officer)).id;
    await recordReceipt(accounting, txId, { amount: "500,000.00", date: "2026-10-01", memo: "Buyer funds" });
  });

  async function verifiedInstruction() {
    const ins = await saveBankInstruction(officer, txId, INSTR);
    await verifyBankInstruction(accounting, ins.id, VERIFY);
    return ins;
  }

  it("validates routing numbers with the ABA checksum", () => {
    expect(validRoutingNumber("121000358")).toBe(true);
    expect(validRoutingNumber("121000359")).toBe(false);
    expect(validRoutingNumber("12100035")).toBe(false);
  });

  it("requires step-up, encrypts numbers and never returns ciphertext", async () => {
    await expectAppError(saveBankInstruction(assistant, txId, INSTR), "FORBIDDEN");
    const noStepUp = await makeUser(officer.companyId, "ESCROW_OFFICER");
    await expectAppError(saveBankInstruction(noStepUp, txId, INSTR), "STEP_UP_REQUIRED");
    await expectAppError(saveBankInstruction(officer, txId, { ...INSTR, routingNumber: "123456789" }), "VALIDATION");
    await expectAppError(saveBankInstruction(officer, txId, { ...INSTR, receivedVia: "Email from seller" }), "VALIDATION");
    const ins = await saveBankInstruction(officer, txId, INSTR);
    const raw = await db.bankInstruction.findUniqueOrThrow({ where: { id: ins.id } });
    expect(raw.accountNumberEnc).not.toContain("000123456789");
    expect(raw.accountLast4).toBe("6789");
    const listed = await listBankInstructions(assistant, txId);
    expect(JSON.stringify(listed)).not.toContain("accountNumberEnc");
    expect(JSON.stringify(listed)).not.toContain("000123456789");
  });

  it("only permitted users can reveal full numbers, and reveals are audited", async () => {
    const ins = await saveBankInstruction(officer, txId, INSTR);
    await expectAppError(revealBankInstruction(officer, ins.id), "FORBIDDEN");
    const revealed = await revealBankInstruction(accounting, ins.id);
    expect(revealed).toEqual({ accountNumber: "000123456789", routingNumber: "121000358" });
    expect(await db.auditEvent.count({ where: { action: "bank.instruction_revealed", entityId: ins.id } })).toBe(1);
  });

  it("requires independent verification through an approved method", async () => {
    const ins = await saveBankInstruction(officer, txId, INSTR);
    await expectAppError(verifyBankInstruction(officer, ins.id, VERIFY), "FORBIDDEN");
    await expectAppError(verifyBankInstruction(accounting, ins.id, { ...VERIFY, phoneSource: "Called the number in the email" }), "VALIDATION");
    await verifyBankInstruction(accounting, ins.id, VERIFY);
    expect((await db.bankInstruction.findUniqueOrThrow({ where: { id: ins.id } })).status).toBe("VERIFIED");
  });

  it("wires need verified instructions with a matching payee", async () => {
    const ins = await saveBankInstruction(officer, txId, INSTR);
    await expectAppError(prepareDisbursement(assistant, txId, { payeeName: INSTR.payeeName, method: "WIRE", amount: "398,412.77", instructionId: ins.id }), "PRECONDITION_FAILED");
    await verifyBankInstruction(accounting, ins.id, VERIFY);
    await expectAppError(prepareDisbursement(assistant, txId, { payeeName: "Someone Else", method: "WIRE", amount: "1.00", instructionId: ins.id }), "PRECONDITION_FAILED");
    await prepareDisbursement(assistant, txId, { payeeName: INSTR.payeeName, method: "WIRE", amount: "398,412.77", instructionId: ins.id });
  });

  it("separates preparer and approver and requires step-up to approve", async () => {
    const ins = await verifiedInstruction();
    const d = await prepareDisbursement(accounting, txId, { payeeName: INSTR.payeeName, method: "WIRE", amount: "398,412.77", instructionId: ins.id });
    const approval = await requestDisbursementApproval(accounting, d.id);
    await expectAppError(decideApproval(accounting, approval.id, "APPROVED"), "FORBIDDEN");
    await expectAppError(decideApproval(assistant, approval.id, "APPROVED"), "FORBIDDEN");
    const noStepUp = await makeUser(officer.companyId, "ACCOUNTING");
    await expectAppError(decideApproval(noStepUp, approval.id, "APPROVED"), "STEP_UP_REQUIRED");
    await decideApproval(accounting2, approval.id, "APPROVED");
    expect((await db.disbursement.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("APPROVED");
    const a = await db.approval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(a.stepUpVerified).toBe(true);
    expect(a.bindingSnapshot).toMatchObject({ amountCents: "39841277", payeeName: INSTR.payeeName, instructionVersion: 1, accountLast4: "6789" });
  });

  it("invalidates approval when the amount changes", async () => {
    const ins = await verifiedInstruction();
    const d = await prepareDisbursement(accounting, txId, { payeeName: INSTR.payeeName, method: "WIRE", amount: "1,000.00", instructionId: ins.id });
    const approval = await requestDisbursementApproval(accounting, d.id);
    await decideApproval(accounting2, approval.id, "APPROVED");
    await updateDisbursement(accounting, d.id, { payeeName: INSTR.payeeName, method: "WIRE", amount: "1,000.01", instructionId: ins.id });
    expect((await db.approval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe("INVALIDATED");
    const fresh = await db.disbursement.findUniqueOrThrow({ where: { id: d.id } });
    expect(fresh).toMatchObject({ status: "DRAFT", version: 2, amountCents: 100_001n });
    await expectAppError(recordDisbursementRelease(accounting2, d.id, { externalReference: "FED-1" }), "PRECONDITION_FAILED");
  });

  it("invalidates verification and approval when bank details change", async () => {
    const ins = await verifiedInstruction();
    const d = await prepareDisbursement(accounting, txId, { payeeName: INSTR.payeeName, method: "WIRE", amount: "1,000.00", instructionId: ins.id });
    const approval = await requestDisbursementApproval(accounting, d.id);
    await decideApproval(accounting2, approval.id, "APPROVED");
    const v2 = await saveBankInstruction(officer, txId, { ...INSTR, accountNumber: "000999888777", receivedVia: "Revised payoff demand uploaded by title" }, ins.groupId);
    expect(v2.version).toBe(2);
    expect((await db.bankInstruction.findUniqueOrThrow({ where: { id: ins.id } })).status).toBe("SUPERSEDED");
    expect((await db.bankInstructionVerification.findFirstOrThrow({ where: { instructionId: ins.id } })).invalidatedAt).not.toBeNull();
    expect((await db.approval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe("INVALIDATED");
    expect((await db.disbursement.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("INVALIDATED");
    expect(v2.status).toBe("PENDING_VERIFICATION");
  });

  it("detects a change between request and decision (approval bound to exact state)", async () => {
    const ins = await verifiedInstruction();
    const d = await prepareDisbursement(accounting, txId, { payeeName: INSTR.payeeName, method: "WIRE", amount: "1,000.00", instructionId: ins.id });
    const approval = await requestDisbursementApproval(accounting, d.id);
    await db.disbursement.update({ where: { id: d.id }, data: { amountCents: 9_999_999n } }); // tampering outside the service layer
    await expectAppError(decideApproval(accounting2, approval.id, "APPROVED"), "PRECONDITION_FAILED");
    expect((await db.approval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe("INVALIDATED");
  });

  it("records a release only after funding is confirmed, by someone other than the preparer, once", async () => {
    const ins = await verifiedInstruction();
    const d = await prepareDisbursement(accounting, txId, { payeeName: INSTR.payeeName, method: "WIRE", amount: "398,412.77", instructionId: ins.id });
    const approval = await requestDisbursementApproval(accounting, d.id);
    await decideApproval(manager, approval.id, "APPROVED");
    await expectAppError(recordDisbursementRelease(accounting2, d.id, { externalReference: "FED-20261030-0001" }), "PRECONDITION_FAILED"); // funding not confirmed
    await db.milestone.updateMany({ where: { transactionId: txId, kind: "FUNDING" }, data: { status: "COMPLETE" } });
    await expectAppError(recordDisbursementRelease(accounting, d.id, { externalReference: "FED-20261030-0001" }), "FORBIDDEN");
    await recordDisbursementRelease(accounting2, d.id, { externalReference: "FED-20261030-0001" });
    expect(await fileBalance(db, accounting.companyId, txId)).toBe(50_000_000n - 39_841_277n);
    expect((await db.disbursement.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("RECORDED_AS_RELEASED");
    expect((await db.approval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe("CONSUMED");
    await expectAppError(recordDisbursementRelease(accounting2, d.id, { externalReference: "again" }), "PRECONDITION_FAILED");
  });

  it("system, AI and job actors cannot touch payment controls", async () => {
    const ins = await verifiedInstruction();
    const bot = { ...systemCtx(officer.companyId, "assistant"), actorType: "AI" as const };
    await expectAppError(saveBankInstruction(bot, txId, INSTR), "FORBIDDEN");
    await expectAppError(prepareDisbursement(bot, txId, { payeeName: INSTR.payeeName, method: "WIRE", amount: "1.00", instructionId: ins.id }), "FORBIDDEN");
    const botAsAdminRole = { ...accounting2, actorType: "AI" as const };
    await expectAppError(revealBankInstruction(botAsAdminRole, ins.id), "FORBIDDEN");
  });

  it("closing is blocked by unreleased disbursements and by a non-zero file balance", async () => {
    await db.transaction.update({ where: { id: txId }, data: { stage: "DISBURSEMENT_REVIEW" } });
    await db.task.updateMany({ where: { transactionId: txId, required: true }, data: { status: "DONE" } });
    await db.milestone.updateMany({ where: { transactionId: txId }, data: { status: "COMPLETE" } });
    await prepareDisbursement(accounting, txId, { payeeName: "Seller", method: "CHECK", amount: "500,000.00" });
    const res = await transitionStage(officer, txId, { toStage: "CLOSED", reason: "close it" });
    expect(res.status).toBe("BLOCKED");
    if (res.status === "BLOCKED") expect(res.unmet.map((u) => u.type)).toEqual(expect.arrayContaining(["FILE_BALANCE_ZERO", "NO_OPEN_DISBURSEMENTS"]));
  });
});
