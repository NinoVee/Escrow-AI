import { randomUUID } from "node:crypto";
import { db, type Tx } from "../db";
import { isExternal, requirePermission, requireUser, type Ctx } from "../context";
import { AppError, forbidden, invalid, notFound, precondition } from "../errors";
import { audit } from "../audit";
import { decryptField, encryptField, mask } from "../crypto";
import { requireStepUp } from "../auth/stepup";
import { getCompanySettings } from "../settings";
import { loadTransaction } from "./access";
import { createApproval, findUsableApproval, consumeApproval, invalidateApprovals } from "./approvals";
import { fileBalance, postEntry } from "../ledger/journal";
import { formatCents, parseMoneyToCents } from "@/lib/money";
import { todayInZone, formatDateOnly } from "@/lib/dates";
import type { BankInstruction, Disbursement } from "@/generated/prisma/client";

/**
 * Wire and disbursement CONTROLS. EscrowFlow never executes payments. Real
 * payment execution is disabled; "release" here records that a payment was
 * executed outside EscrowFlow through the company's approved banking process,
 * after every control below has passed. The AI layer has no access to this
 * module.
 */

export const PAYMENT_EXECUTION_ENABLED = false;

/** ABA routing number checksum (3-7-1 weights). */
export function validRoutingNumber(r: string) {
  if (!/^\d{9}$/.test(r)) return false;
  const d = r.split("").map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

function assertHuman(ctx: Ctx) {
  if (ctx.actorType !== "USER") throw forbidden("Payment controls require a signed-in person.");
}

// ---------------------------------------------------------------------------
// Bank instructions
// ---------------------------------------------------------------------------

export interface InstructionInput {
  payeeName: string;
  payeeParticipantId?: string;
  bankName: string;
  accountNumber: string;
  routingNumber: string;
  receivedVia: string;
}

/**
 * Records bank instructions (version 1), or a new version that replaces an
 * existing group. A new version supersedes the old one, invalidates its
 * verifications, invalidates approvals that relied on it, and returns any
 * disbursement using it to INVALIDATED.
 */
export async function saveBankInstruction(ctx: Ctx, transactionId: string, input: InstructionInput, replaceGroupId?: string) {
  assertHuman(ctx);
  requirePermission(ctx, "bank.create");
  const userId = requireUser(ctx);
  await requireStepUp(ctx);
  const tx = await loadTransaction(ctx, transactionId);
  const account = input.accountNumber.replace(/[\s-]/g, "");
  const routing = input.routingNumber.replace(/[\s-]/g, "");
  if (!input.payeeName?.trim() || !input.bankName?.trim()) throw invalid("Payee and bank name are required.");
  if (!/^\d{4,17}$/.test(account)) throw invalid("Account number must be 4 to 17 digits.");
  if (!validRoutingNumber(routing)) throw invalid("Routing number is not a valid 9-digit ABA number.");
  const via = input.receivedVia?.trim() ?? "";
  if (via.length < 5) throw invalid("Record how the instructions were received.");
  if (/^e-?mail\b|\bvia e-?mail\b|\bemail only\b/i.test(via)) throw invalid("Instructions received only by email cannot be recorded. Obtain them through an approved channel.");
  if (input.payeeParticipantId) {
    const p = await db.participant.findFirst({ where: { id: input.payeeParticipantId, transactionId: tx.id } });
    if (!p) throw invalid("Payee participant must belong to this file.");
  }

  return db.$transaction(async (client) => {
    let groupId: string = randomUUID();
    let version = 1;
    if (replaceGroupId) {
      const current = await client.bankInstruction.findFirst({ where: { groupId: replaceGroupId, companyId: ctx.companyId, transactionId: tx.id }, orderBy: { version: "desc" } });
      if (!current) throw notFound("Bank instruction");
      groupId = current.groupId;
      version = current.version + 1;
      await supersede(client, ctx, current, "Bank details were changed");
    }
    const created = await client.bankInstruction.create({
      data: {
        companyId: ctx.companyId,
        transactionId: tx.id,
        groupId,
        version,
        payeeName: input.payeeName.trim(),
        payeeParticipantId: input.payeeParticipantId ?? null,
        bankName: input.bankName.trim(),
        accountNumberEnc: encryptField(account),
        routingNumberEnc: encryptField(routing),
        accountLast4: account.slice(-4),
        routingLast4: routing.slice(-4),
        receivedVia: via,
        createdById: userId,
      },
    });
    await audit(ctx, {
      action: replaceGroupId ? "bank.instruction_changed" : "bank.instruction_created",
      entityType: "BankInstruction",
      entityId: created.id,
      entityVersion: version,
      transactionId: tx.id,
      summary: `${replaceGroupId ? "Changed" : "Recorded"} bank instructions for ${created.payeeName} (acct ${mask(account)}, v${version}); verification required`,
      details: { receivedVia: via },
    }, client);
    return created;
  });
}

async function supersede(client: Tx, ctx: Ctx, old: BankInstruction, reason: string) {
  await client.bankInstruction.update({ where: { id: old.id }, data: { status: "SUPERSEDED" } });
  await client.bankInstructionVerification.updateMany({ where: { instructionId: old.id, invalidatedAt: null }, data: { invalidatedAt: new Date(), invalidatedReason: reason } });
  const affected = await client.disbursement.findMany({ where: { instructionId: old.id, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] } } });
  for (const d of affected) {
    await client.disbursement.update({ where: { id: d.id }, data: { status: "INVALIDATED", invalidatedReason: `${reason}; re-select verified instructions and re-approve.`, version: { increment: 1 } } });
    await invalidateApprovals(client, ctx, "Disbursement", d.id, reason);
  }
}

export async function listBankInstructions(ctx: Ctx, transactionId: string) {
  if (isExternal(ctx)) throw notFound("Transaction");
  requirePermission(ctx, "bank.view_masked");
  await loadTransaction(ctx, transactionId);
  const rows = await db.bankInstruction.findMany({ where: { companyId: ctx.companyId, transactionId }, include: { verifications: { orderBy: { verifiedAt: "desc" } } }, orderBy: [{ groupId: "asc" }, { version: "desc" }] });
  // Never return ciphertext to callers that render UI.
  return rows.map(({ accountNumberEnc: _a, routingNumberEnc: _r, ...rest }) => rest);
}

/** Reveals full numbers to a permitted user after step-up. Every reveal is audited. */
export async function revealBankInstruction(ctx: Ctx, instructionId: string) {
  assertHuman(ctx);
  requirePermission(ctx, "bank.reveal");
  await requireStepUp(ctx);
  const ins = await db.bankInstruction.findFirst({ where: { id: instructionId, companyId: ctx.companyId } });
  if (!ins) throw notFound("Bank instruction");
  await audit(ctx, { action: "bank.instruction_revealed", entityType: "BankInstruction", entityId: ins.id, entityVersion: ins.version, transactionId: ins.transactionId, summary: `Full bank details revealed for ${ins.payeeName} v${ins.version}` });
  return { accountNumber: decryptField(ins.accountNumberEnc), routingNumber: decryptField(ins.routingNumberEnc) };
}

export interface VerificationInput {
  method: "CALLBACK_KNOWN_NUMBER" | "IN_PERSON" | "VIDEO_ID_CALLBACK";
  contactName: string;
  phoneLast4?: string;
  phoneSource: string;
  outcome: "CONFIRMED" | "FAILED";
  notes?: string;
  evidenceDocumentId?: string;
}

/**
 * Records an independent verification. The verifier must differ from the
 * person who entered the instructions (company setting, on by default), and
 * the callback number must come from an independent source.
 */
export async function verifyBankInstruction(ctx: Ctx, instructionId: string, input: VerificationInput) {
  assertHuman(ctx);
  requirePermission(ctx, "bank.verify");
  const userId = requireUser(ctx);
  await requireStepUp(ctx);
  const ins = await db.bankInstruction.findFirst({ where: { id: instructionId, companyId: ctx.companyId } });
  if (!ins) throw notFound("Bank instruction");
  if (ins.status !== "PENDING_VERIFICATION") throw precondition(`These instructions are ${ins.status.toLowerCase().replace("_", " ")}.`);
  const settings = await getCompanySettings(ctx.companyId);
  if (settings.requireIndependentBankVerification && ins.createdById === userId) {
    throw new AppError("FORBIDDEN", "Independent verification required: someone other than the person who entered these instructions must verify them.");
  }
  if (!["CALLBACK_KNOWN_NUMBER", "IN_PERSON", "VIDEO_ID_CALLBACK"].includes(input.method)) throw invalid("Choose an approved verification method.");
  if (!input.contactName?.trim()) throw invalid("Record who confirmed the instructions.");
  if (!input.phoneSource?.trim() || input.phoneSource.trim().length < 10) throw invalid("Describe where the callback number came from (it must not come from the instructions or an email).");
  if (/same email|from the (email|instructions)|in the email/i.test(input.phoneSource)) throw invalid("The callback number must come from an independent source, not the instructions or an email.");
  if (input.evidenceDocumentId) {
    const d = await db.document.findFirst({ where: { id: input.evidenceDocumentId, transactionId: ins.transactionId } });
    if (!d) throw invalid("Evidence must be a document in this file.");
  }
  return db.$transaction(async (client) => {
    const v = await client.bankInstructionVerification.create({
      data: {
        companyId: ctx.companyId,
        instructionId: ins.id,
        method: input.method,
        contactName: input.contactName.trim(),
        phoneLast4: input.phoneLast4?.replace(/\D/g, "").slice(-4) || null,
        phoneSource: input.phoneSource.trim(),
        outcome: input.outcome,
        notes: input.notes?.trim() || null,
        evidenceDocumentId: input.evidenceDocumentId ?? null,
        verifiedById: userId,
      },
    });
    await client.bankInstruction.update({ where: { id: ins.id }, data: { status: input.outcome === "CONFIRMED" ? "VERIFIED" : "REJECTED" } });
    await audit(ctx, {
      action: input.outcome === "CONFIRMED" ? "bank.instruction_verified" : "bank.instruction_verification_failed",
      entityType: "BankInstruction",
      entityId: ins.id,
      entityVersion: ins.version,
      transactionId: ins.transactionId,
      summary: `Bank instructions for ${ins.payeeName} v${ins.version} ${input.outcome === "CONFIRMED" ? "verified" : "FAILED verification"} by ${input.method.toLowerCase().replaceAll("_", " ")}`,
      details: { phoneSource: input.phoneSource, contactName: input.contactName },
    }, client);
    return v;
  });
}

// ---------------------------------------------------------------------------
// Disbursements
// ---------------------------------------------------------------------------

export interface DisbursementInput {
  payeeName: string;
  method: "WIRE" | "CHECK";
  amount: string;
  instructionId?: string;
  memo?: string;
}

async function validateDisbursement(client: Tx | typeof db, ctx: Ctx, transactionId: string, input: DisbursementInput) {
  let amountCents: bigint;
  try {
    amountCents = parseMoneyToCents(input.amount);
  } catch (e) {
    throw invalid((e as Error).message);
  }
  if (amountCents <= 0n) throw invalid("Amount must be greater than zero.");
  if (!input.payeeName?.trim()) throw invalid("Payee is required.");
  if (input.method === "WIRE") {
    if (!input.instructionId) throw invalid("Wires require verified bank instructions.");
    const ins = await client.bankInstruction.findFirst({ where: { id: input.instructionId, companyId: ctx.companyId, transactionId } });
    if (!ins) throw notFound("Bank instruction");
    if (ins.status !== "VERIFIED") throw precondition("The selected bank instructions are not verified.");
    if (ins.payeeName.trim().toLowerCase() !== input.payeeName.trim().toLowerCase()) throw precondition("Payee name must match the verified bank instructions.");
  }
  return amountCents;
}

export async function prepareDisbursement(ctx: Ctx, transactionId: string, input: DisbursementInput) {
  assertHuman(ctx);
  requirePermission(ctx, "disbursement.prepare");
  const userId = requireUser(ctx);
  const tx = await loadTransaction(ctx, transactionId);
  const amountCents = await validateDisbursement(db, ctx, tx.id, input);
  return db.$transaction(async (client) => {
    const d = await client.disbursement.create({
      data: { companyId: ctx.companyId, transactionId: tx.id, payeeName: input.payeeName.trim(), method: input.method, amountCents, instructionId: input.method === "WIRE" ? input.instructionId! : null, memo: input.memo?.trim() || null, preparedById: userId },
    });
    await audit(ctx, { action: "disbursement.prepared", entityType: "Disbursement", entityId: d.id, entityVersion: 1, transactionId: tx.id, summary: `Prepared ${input.method.toLowerCase()} disbursement of ${formatCents(amountCents)} to ${d.payeeName}` }, client);
    return d;
  });
}

/** Any change returns the disbursement to DRAFT and invalidates prior approvals. */
export async function updateDisbursement(ctx: Ctx, disbursementId: string, input: DisbursementInput) {
  assertHuman(ctx);
  requirePermission(ctx, "disbursement.prepare");
  const d = await db.disbursement.findFirst({ where: { id: disbursementId, companyId: ctx.companyId } });
  if (!d) throw notFound("Disbursement");
  if (!["DRAFT", "PENDING_APPROVAL", "APPROVED", "INVALIDATED"].includes(d.status)) throw precondition("This disbursement can no longer be changed.");
  const amountCents = await validateDisbursement(db, ctx, d.transactionId, input);
  return db.$transaction(async (client) => {
    const updated = await client.disbursement.update({
      where: { id: d.id },
      data: { payeeName: input.payeeName.trim(), method: input.method, amountCents, instructionId: input.method === "WIRE" ? input.instructionId! : null, memo: input.memo?.trim() || null, status: "DRAFT", version: { increment: 1 }, invalidatedReason: null, preparedById: ctx.userId! },
    });
    await invalidateApprovals(client, ctx, "Disbursement", d.id, "Disbursement details changed");
    await audit(ctx, { action: "disbursement.changed", entityType: "Disbursement", entityId: d.id, entityVersion: updated.version, transactionId: d.transactionId, summary: `Disbursement changed to ${formatCents(amountCents)} to ${updated.payeeName}; prior approvals invalidated` }, client);
    return updated;
  });
}

/** The exact state an approval is bound to. */
export async function disbursementBinding(client: Tx | typeof db, d: Disbursement) {
  const ins = d.instructionId ? await client.bankInstruction.findUnique({ where: { id: d.instructionId } }) : null;
  return {
    transactionId: d.transactionId,
    disbursementId: d.id,
    disbursementVersion: d.version,
    payeeName: d.payeeName,
    method: d.method,
    amountCents: d.amountCents.toString(),
    instructionId: ins?.id ?? null,
    instructionVersion: ins?.version ?? null,
    instructionStatus: ins?.status ?? null,
    accountLast4: ins?.accountLast4 ?? null,
  };
}

export async function requestDisbursementApproval(ctx: Ctx, disbursementId: string) {
  assertHuman(ctx);
  requirePermission(ctx, "disbursement.prepare");
  const d = await db.disbursement.findFirst({ where: { id: disbursementId, companyId: ctx.companyId } });
  if (!d) throw notFound("Disbursement");
  if (d.status !== "DRAFT") throw precondition("Only draft disbursements can be submitted for approval.");
  if (d.preparedById !== ctx.userId) throw forbidden("Only the preparer can submit this disbursement for approval.");
  const tx = await loadTransaction(ctx, d.transactionId);
  const bal = await fileBalance(db, ctx.companyId, tx.id);
  if (d.amountCents > bal) throw precondition(`Insufficient file funds: ${formatCents(bal)} available.`);
  return db.$transaction(async (client) => {
    const binding = await disbursementBinding(client, d);
    const a = await createApproval(client, ctx, {
      type: "DISBURSEMENT",
      transactionId: d.transactionId,
      title: `${d.method === "WIRE" ? "Wire" : "Check"} ${formatCents(d.amountCents)} to ${d.payeeName} (${tx.escrowNumber})`,
      summary: d.memo ?? undefined,
      subjectType: "Disbursement",
      subjectId: d.id,
      binding,
      requiredPermission: "disbursement.approve",
    });
    await client.disbursement.update({ where: { id: d.id }, data: { status: "PENDING_APPROVAL", approvalId: a.id } });
    return a;
  });
}

/**
 * Records that an APPROVED disbursement was executed outside EscrowFlow.
 * Re-checks every control at the moment of release: approval still bound to
 * the exact amount/payee/instruction version, instructions still verified,
 * funding confirmed, sufficient file funds, a different person than the
 * preparer, and a fresh step-up. Then posts the ledger entry.
 */
export async function recordDisbursementRelease(ctx: Ctx, disbursementId: string, input: { externalReference: string; releaseDate?: string }) {
  assertHuman(ctx);
  requirePermission(ctx, "disbursement.release");
  const userId = requireUser(ctx);
  await requireStepUp(ctx);
  if (!input.externalReference?.trim()) throw invalid("Enter the bank confirmation or check number from the approved banking system.");
  const d = await db.disbursement.findFirst({ where: { id: disbursementId, companyId: ctx.companyId } });
  if (!d) throw notFound("Disbursement");
  if (d.status !== "APPROVED") throw precondition("Only approved disbursements can be recorded as released.");
  if (d.preparedById === userId) throw forbidden("Separation of duties: the preparer cannot record the release.");
  const settings = await getCompanySettings(ctx.companyId);

  return db.$transaction(async (client) => {
    const locked = await client.$queryRaw<{ status: string }[]>`SELECT "status" FROM "Disbursement" WHERE "id" = ${d.id} FOR UPDATE`;
    if (locked[0]?.status !== "APPROVED") throw precondition("This disbursement changed. Reload and try again.");
    const fresh = await client.disbursement.findUniqueOrThrow({ where: { id: d.id } });
    const binding = await disbursementBinding(client, fresh);
    const approval = await findUsableApproval(client, ctx, "DISBURSEMENT", "Disbursement", d.id, binding);
    if (!approval) {
      await client.disbursement.update({ where: { id: d.id }, data: { status: "INVALIDATED", invalidatedReason: "Approval no longer matches the disbursement" } });
      throw precondition("The approval does not match the current amount, payee or bank details. Re-approval is required.");
    }
    if (fresh.method === "WIRE") {
      const ins = await client.bankInstruction.findUnique({ where: { id: fresh.instructionId! } });
      if (!ins || ins.status !== "VERIFIED") throw precondition("Bank instructions are no longer verified.");
    }
    const funding = await client.milestone.findUnique({ where: { transactionId_kind: { transactionId: fresh.transactionId, kind: "FUNDING" } } });
    if (!funding || (funding.status !== "COMPLETE" && funding.status !== "NOT_APPLICABLE")) throw precondition("Funding has not been confirmed from an authorized source.");
    const bal = await fileBalance(client, ctx.companyId, fresh.transactionId);
    if (fresh.amountCents > bal) throw precondition(`Insufficient file funds: ${formatCents(bal)} available.`);
    await consumeApproval(client, approval.id);
    const { entry } = await postEntry(ctx, {
      transactionId: fresh.transactionId,
      effectiveDate: input.releaseDate ?? formatDateOnly(todayInZone(settings.timezone)),
      memo: `${fresh.method === "WIRE" ? "Wire" : "Check"} to ${fresh.payeeName} (recorded; executed outside EscrowFlow)`,
      kind: "DISBURSEMENT",
      source: "DISBURSEMENT",
      reference: input.externalReference.trim(),
      idempotencyKey: `disbursement:${fresh.id}:v${fresh.version}`,
      lines: [
        { account: "ESCROW_LIABILITY", transactionId: fresh.transactionId, debit: fresh.amountCents },
        { account: "TRUST_BANK", transactionId: fresh.transactionId, credit: fresh.amountCents },
      ],
    }, client);
    await client.disbursement.update({ where: { id: d.id }, data: { status: "RECORDED_AS_RELEASED", releasedById: userId, releasedAt: new Date(), externalReference: input.externalReference.trim(), journalEntryId: entry.id } });
    await audit(ctx, { action: "disbursement.release_recorded", entityType: "Disbursement", entityId: d.id, entityVersion: fresh.version, transactionId: fresh.transactionId, summary: `Recorded release of ${formatCents(fresh.amountCents)} to ${fresh.payeeName} (ref ${input.externalReference.trim()}); no payment executed by EscrowFlow` }, client);
    return { entryId: entry.id };
  });
}

export async function cancelDisbursement(ctx: Ctx, disbursementId: string, reason: string) {
  requirePermission(ctx, "disbursement.prepare");
  if (!reason?.trim()) throw invalid("A reason is required.");
  const d = await db.disbursement.findFirst({ where: { id: disbursementId, companyId: ctx.companyId } });
  if (!d) throw notFound("Disbursement");
  if (d.status === "RECORDED_AS_RELEASED" || d.status === "CANCELLED") throw precondition("This disbursement cannot be cancelled.");
  await db.$transaction(async (client) => {
    await client.disbursement.update({ where: { id: d.id }, data: { status: "CANCELLED", invalidatedReason: reason } });
    await invalidateApprovals(client, ctx, "Disbursement", d.id, `Cancelled: ${reason}`);
    await audit(ctx, { action: "disbursement.cancelled", entityType: "Disbursement", entityId: d.id, transactionId: d.transactionId, summary: `Disbursement to ${d.payeeName} cancelled`, details: { reason } }, client);
  });
}

export async function listDisbursements(ctx: Ctx, transactionId: string) {
  if (isExternal(ctx)) throw notFound("Transaction");
  requirePermission(ctx, "ledger.read");
  await loadTransaction(ctx, transactionId);
  return db.disbursement.findMany({ where: { companyId: ctx.companyId, transactionId }, orderBy: { createdAt: "asc" } });
}
