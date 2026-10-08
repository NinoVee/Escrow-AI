"use server";

import { bool, optStr, runAction, str } from "@/server/action";
import { acceptProposal, rejectProposal } from "@/server/services/proposals";
import { askAssistant, compareDocuments, draftMessage, runExtraction, type CitedAnswer } from "@/server/services/assistant";
import { updateDocumentMeta } from "@/server/services/documents";
import type { ActionState } from "@/lib/action-types";
import type { DraftKind } from "@/server/ai/provider";

const p = (id: string) => [`/transactions/${id}`];

export async function acceptProposalAction(txId: string, proposalId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await acceptProposal(ctx, proposalId, { overrideValue: optStr(fd, "overrideValue"), confirmConflict: bool(fd, "confirmConflict"), date: optStr(fd, "date"), note: optStr(fd, "note") });
    return { message: "Accepted and recorded with its source." };
  }, p(txId));
}

export async function rejectProposalAction(txId: string, proposalId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await rejectProposal(ctx, proposalId, str(fd, "note"));
    return { message: "Rejected." };
  }, p(txId));
}

export async function runExtractionAction(txId: string, versionId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const kind = (optStr(fd, "kind") as "CONTRACT" | "TITLE" | "SUMMARY" | undefined) ?? undefined;
    const res = await runExtraction(ctx, versionId, kind);
    if (res.status === "FAILED") throw new Error(res.message ?? "Extraction failed");
    return { message: res.status === "SKIPPED" ? res.message : `Extraction complete: ${res.proposals} new proposal(s) for review.` };
  }, p(txId));
}

export async function applyCategoryAction(txId: string, documentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await updateDocumentMeta(ctx, documentId, { category: str(fd, "category") });
    return { message: "Category updated." };
  }, p(txId));
}

export async function askAction(txId: string, _prev: ActionState<CitedAnswer>, fd: FormData): Promise<ActionState<CitedAnswer>> {
  return runAction(async (ctx) => ({ data: await askAssistant(ctx, txId, str(fd, "question")) }));
}

export async function draftAction(txId: string, _prev: ActionState<{ subject: string; body: string; mode: string }>, fd: FormData): Promise<ActionState<{ subject: string; body: string; mode: string }>> {
  return runAction(async (ctx) => ({ data: await draftMessage(ctx, txId, str(fd, "kind") as DraftKind, optStr(fd, "participantId")) }));
}

export type Comparison = Awaited<ReturnType<typeof compareDocuments>>;
export async function compareAction(txId: string, versionId: string, _prev: ActionState<Comparison>, fd: FormData): Promise<ActionState<Comparison>> {
  return runAction(async (ctx) => ({ data: await compareDocuments(ctx, str(fd, "otherVersionId"), versionId) }));
}
