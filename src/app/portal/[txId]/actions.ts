"use server";

import { optStr, runAction, str } from "@/server/action";
import { uploadDocument } from "@/server/services/documents";
import { postMessage } from "@/server/services/messages";
import { updateParticipantNotifications } from "@/server/services/transactions";
import { AppError } from "@/server/errors";
import type { ActionState } from "@/lib/action-types";

export async function portalUploadAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("VALIDATION", "Choose a file to upload.");
    const res = await uploadDocument(ctx, {
      transactionId: txId,
      filename: file.name,
      data: Buffer.from(await file.arrayBuffer()),
      requestId: optStr(fd, "requestId"),
      title: optStr(fd, "title"),
    });
    if (res.scan.status !== "CLEAN") return { message: "The file could not be accepted by our security scan. Contact your escrow officer." };
    return { message: "Uploaded. Your escrow team has been notified." };
  }, [`/portal/${txId}`]);
}

export async function portalMessageAction(txId: string, threadId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await postMessage(ctx, threadId, str(fd, "body"));
    return { message: "Sent." };
  }, [`/portal/${txId}`]);
}

export async function portalNotificationsAction(txId: string, participantId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await updateParticipantNotifications(ctx, participantId, str(fd, "enabled") === "true");
    return { message: "Preference saved." };
  }, [`/portal/${txId}`]);
}
