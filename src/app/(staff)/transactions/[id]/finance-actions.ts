"use server";

import { optStr, runAction, str } from "@/server/action";
import { recordReceipt, reverseEntry } from "@/server/ledger/journal";
import { addSettlementItem, removeSettlementItem, saveStatementSnapshot } from "@/server/services/settlement";
import {
  cancelDisbursement,
  prepareDisbursement,
  recordDisbursementRelease,
  requestDisbursementApproval,
  revealBankInstruction,
  saveBankInstruction,
  verifyBankInstruction,
} from "@/server/services/payments";
import type { ActionState } from "@/lib/action-types";

const p = (id: string) => [`/transactions/${id}`];

export async function receiptAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const res = await recordReceipt(ctx, txId, { amount: str(fd, "amount"), date: str(fd, "date"), memo: str(fd, "memo"), reference: optStr(fd, "reference"), idempotencyKey: optStr(fd, "reference") ? `receipt:${txId}:${str(fd, "reference")}` : undefined });
    return { message: res.duplicate ? "This reference was already recorded; no duplicate posted." : `Posted entry #${res.entry.entryNumber}.` };
  }, p(txId));
}

export async function reverseAction(txId: string, entryId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const r = await reverseEntry(ctx, entryId, str(fd, "reason"));
    return { message: `Reversal #${r.entry.entryNumber} posted.` };
  }, p(txId));
}

export async function addItemAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await addSettlementItem(ctx, txId, {
      kind: str(fd, "kind"),
      description: str(fd, "description"),
      payee: optStr(fd, "payee"),
      amount: str(fd, "amount"),
      chargeTo: optStr(fd, "chargeTo"),
      buyerSharePercent: optStr(fd, "buyerSharePercent"),
      proration: str(fd, "kind") === "PRORATION" ? { type: str(fd, "prorationType"), periodStart: str(fd, "periodStart"), periodEnd: str(fd, "periodEnd") } : undefined,
    });
    return { message: "Item added." };
  }, p(txId));
}

export async function removeItemAction(txId: string, itemId: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    await removeSettlementItem(ctx, itemId);
    return { message: "Removed." };
  }, p(txId));
}

export async function snapshotAction(txId: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    const s = await saveStatementSnapshot(ctx, txId);
    return { message: `Draft v${s.version} saved.` };
  }, p(txId));
}

export async function saveInstructionAction(txId: string, groupId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const ins = await saveBankInstruction(
      ctx,
      txId,
      { payeeName: str(fd, "payeeName"), bankName: str(fd, "bankName"), accountNumber: str(fd, "accountNumber"), routingNumber: str(fd, "routingNumber"), receivedVia: str(fd, "receivedVia"), payeeParticipantId: optStr(fd, "payeeParticipantId") },
      groupId ?? undefined,
    );
    return { message: `Saved as version ${ins.version}. Independent verification is required before use.` };
  }, p(txId));
}

export async function verifyInstructionAction(txId: string, instructionId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await verifyBankInstruction(ctx, instructionId, {
      method: str(fd, "method") as "CALLBACK_KNOWN_NUMBER",
      contactName: str(fd, "contactName"),
      phoneLast4: optStr(fd, "phoneLast4"),
      phoneSource: str(fd, "phoneSource"),
      outcome: str(fd, "outcome") === "FAILED" ? "FAILED" : "CONFIRMED",
      notes: optStr(fd, "notes"),
      evidenceDocumentId: optStr(fd, "evidenceDocumentId"),
    });
    return { message: "Verification recorded." };
  }, p(txId));
}

export async function revealInstructionAction(instructionId: string, _prev: ActionState<{ accountNumber: string; routingNumber: string }>): Promise<ActionState<{ accountNumber: string; routingNumber: string }>> {
  return runAction(async (ctx) => ({ data: await revealBankInstruction(ctx, instructionId) }));
}

export async function prepareDisbursementAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await prepareDisbursement(ctx, txId, { payeeName: str(fd, "payeeName"), method: str(fd, "method") === "CHECK" ? "CHECK" : "WIRE", amount: str(fd, "amount"), instructionId: optStr(fd, "instructionId"), memo: optStr(fd, "memo") });
    return { message: "Disbursement prepared. Submit it for approval when ready." };
  }, p(txId));
}

export async function submitDisbursementAction(txId: string, id: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    await requestDisbursementApproval(ctx, id);
    return { message: "Sent for approval." };
  }, [...p(txId), "/approvals"]);
}

export async function releaseDisbursementAction(txId: string, id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await recordDisbursementRelease(ctx, id, { externalReference: str(fd, "externalReference"), releaseDate: optStr(fd, "releaseDate") });
    return { message: "Release recorded and posted to the tracking ledger." };
  }, p(txId));
}

export async function cancelDisbursementAction(txId: string, id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await cancelDisbursement(ctx, id, str(fd, "reason"));
    return { message: "Cancelled." };
  }, p(txId));
}
