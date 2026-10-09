"use server";

import { runAction, str } from "@/server/action";
import { cancelOutbound, createOutboundDraft, requestSendApproval } from "@/server/services/outbound";
import { receiveProviderTitleReport, runPropertyLookup, sendForSignature, simulateProviderEvent, submitProviderTitleOrder, submitRecording } from "@/server/services/integrations";
import type { ActionState } from "@/lib/action-types";

const paths = (txId: string) => [`/transactions/${txId}`];
const all = (fd: FormData, key: string) => fd.getAll(key).filter((v): v is string => typeof v === "string" && v.length > 0);

export async function lookupAction(txId: string, kind: "PROPERTY_DATA" | "RECORDED_DOCUMENTS", _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    await runPropertyLookup(ctx, txId, kind);
    return { message: "Lookup saved. Results are informational and never proof of title." };
  }, paths(txId));
}

export async function providerTitleOrderAction(txId: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    const o = await submitProviderTitleOrder(ctx, txId);
    return { message: `Order ${o.externalRef} submitted.` };
  }, paths(txId));
}

export async function providerReportAction(txId: string, orderId: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    await receiveProviderTitleReport(ctx, orderId);
    return { message: "Report stored on the Documents tab. Review it before relying on it." };
  }, paths(txId));
}

export async function simulateEventAction(txId: string, kind: "ENVELOPE" | "RECORDING" | "TITLE", id: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    const r = await simulateProviderEvent(ctx, kind, id);
    return { message: r.duplicate ? "Duplicate event ignored." : "Simulated provider event received and processed." };
  }, paths(txId));
}

export async function esignAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await sendForSignature(ctx, txId, { documentIds: all(fd, "documentIds"), signerParticipantIds: all(fd, "signerIds"), subject: str(fd, "subject") });
    return { message: "Envelope created." };
  }, paths(txId));
}

export async function recordingAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await submitRecording(ctx, txId, all(fd, "documentIds"));
    return { message: "Submitted for e-recording." };
  }, paths(txId));
}

export async function outboundDraftAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const m = await createOutboundDraft(ctx, { transactionId: txId, participantIds: all(fd, "participantIds"), subject: str(fd, "subject"), body: str(fd, "body") });
    return { message: m.status === "DRAFT" ? "Draft saved. Request approval to send it." : `Saved as ${m.status.toLowerCase()}: ${m.blockedReason ?? ""}` };
  }, [...paths(txId), "/approvals"]);
}

export async function requestOutboundApprovalAction(txId: string, outboundId: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    await requestSendApproval(ctx, outboundId);
    return { message: "Approval requested." };
  }, [...paths(txId), "/approvals"]);
}

export async function cancelOutboundAction(txId: string, outboundId: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    await cancelOutbound(ctx, outboundId);
    return { message: "Cancelled." };
  }, [...paths(txId), "/approvals"]);
}
