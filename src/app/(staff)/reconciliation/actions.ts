"use server";

import { runAction, str } from "@/server/action";
import { autoMatch, confirmFundingFromBank, importBankStatement, matchManually, requestReconciliationReview, runReconciliation } from "@/server/services/reconciliation";
import { AppError } from "@/server/errors";
import type { ActionState } from "@/lib/action-types";

const P = ["/reconciliation"];

export async function importAction(bankAccountId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("VALIDATION", "Choose a CSV statement file.");
    if (file.size > 5 * 1024 * 1024) throw new AppError("VALIDATION", "Statement files must be under 5 MB.");
    const res = await importBankStatement(ctx, bankAccountId, { filename: file.name, content: await file.text(), statementDate: str(fd, "statementDate"), endingBalance: str(fd, "endingBalance") });
    return { message: res.duplicateFile ? "This exact file was already imported; nothing changed." : `Imported ${res.import.newRows} new row(s); skipped ${res.import.duplicateRows} duplicate(s).` };
  }, P);
}

export async function autoMatchAction(bankAccountId: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    const r = await autoMatch(ctx, bankAccountId);
    return { message: `Matched ${r.matched} item(s).` };
  }, P);
}

export async function manualMatchAction(bankTxId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await matchManually(ctx, bankTxId, str(fd, "entryId") || null);
    return { message: "Saved." };
  }, P);
}

export async function runReconAction(bankAccountId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const r = await runReconciliation(ctx, bankAccountId, str(fd, "statementId"));
    return { message: `Reconciliation saved: ${r.status.replaceAll("_", " ").toLowerCase()}.` };
  }, P);
}

export async function reviewReconAction(id: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    await requestReconciliationReview(ctx, id);
    return { message: "Sent for independent review." };
  }, [...P, "/approvals"]);
}

export async function confirmFundingAction(bankTxId: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    await confirmFundingFromBank(ctx, bankTxId);
    return { message: "Funding milestone confirmed from the bank statement." };
  }, [...P, "/transactions"]);
}
