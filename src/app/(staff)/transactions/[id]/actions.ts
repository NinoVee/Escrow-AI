"use server";

import { bool, num, optStr, runAction, str } from "@/server/action";
import { changeStatus, transitionStage } from "@/server/workflow/engine";
import {
  addEntitySigner,
  addParcel,
  addParticipant,
  addProperty,
  assignStaff,
  requestSignerReview,
  setLegalHold,
  updateParticipantNotifications,
  updateTransactionField,
} from "@/server/services/transactions";
import { createDeadline, createTask, reopenTask, resolveDeadline, resolveTask, updateMilestone, updateTask } from "@/server/services/tasks";
import {
  archiveDocument,
  createDocumentRequest,
  reviewDocumentVersion,
  revokeShare,
  setDocumentLegalHold,
  setDocumentRequestStatus,
  shareDocument,
  updateDocumentMeta,
  uploadDocument,
} from "@/server/services/documents";
import { inviteParticipantToPortal, revokePortalAccess } from "@/server/services/users";
import { addTitleException, linkTitleReport, recordTitleOrder, setExceptionDisposition } from "@/server/services/title";
import { createThread, postMessage } from "@/server/services/messages";
import { AppError } from "@/server/errors";
import type { ActionState } from "@/lib/action-types";
import type { DeadlineType, ExceptionDisposition, MilestoneKind, MilestoneStatus, ReviewDecision } from "@/generated/prisma/enums";

const p = (id: string) => [`/transactions/${id}`];

// ---- Workflow -------------------------------------------------------------

export async function transitionAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const justification = optStr(fd, "overrideJustification");
    const res = await transitionStage(ctx, txId, {
      toStage: str(fd, "toStage"),
      reason: str(fd, "reason"),
      expectedVersion: num(fd, "expectedVersion"),
      override: bool(fd, "override") ? { justification: justification ?? "" } : undefined,
    });
    if (res.status === "BLOCKED") {
      throw new AppError("PRECONDITION_FAILED", "Prerequisites are not met.", res.unmet);
    }
    if (res.status === "AWAITING_APPROVAL") return { message: "Approval requested. The move will happen when another authorized person approves it." };
    return { message: "Stage updated." };
  }, p(txId));
}

export async function statusAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const kind = str(fd, "kind") as "HOLD" | "RESUME" | "CANCEL" | "REOPEN";
    await changeStatus(ctx, txId, kind, str(fd, "reason"), { expectedVersion: num(fd, "expectedVersion"), reopenStage: optStr(fd, "reopenStage") });
    return { message: "File status updated." };
  }, p(txId));
}

export async function updateFieldAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const key = str(fd, "field");
    const raw = fd.get("valueBool") !== null ? str(fd, "valueBool") : str(fd, "value");
    await updateTransactionField(ctx, txId, key, raw, { reason: str(fd, "reason"), expectedVersion: num(fd, "expectedVersion") });
    return { message: "Saved with history." };
  }, p(txId));
}

export async function assignStaffAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await assignStaff(ctx, txId, { officerId: optStr(fd, "officerId") ?? null, assistantId: optStr(fd, "assistantId") ?? null });
    return { message: "Assignment saved." };
  }, p(txId));
}

export async function legalHoldAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await setLegalHold(ctx, txId, str(fd, "hold") === "on", str(fd, "reason"));
    return { message: "Legal hold updated." };
  }, p(txId));
}

// ---- Property and parties -------------------------------------------------

export async function addPropertyAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const prop = await addProperty(ctx, txId, {
      label: optStr(fd, "label"),
      street: str(fd, "street"),
      unit: optStr(fd, "unit"),
      city: str(fd, "city"),
      county: optStr(fd, "county"),
      postalCode: optStr(fd, "postalCode"),
      propertyType: optStr(fd, "propertyType") ?? "SINGLE_FAMILY",
      hoaName: optStr(fd, "hoaName"),
    });
    const apn = optStr(fd, "apn");
    if (apn) await addParcel(ctx, prop.id, { apn, legalDescription: optStr(fd, "legalDescription") });
    return { message: "Property added." };
  }, p(txId));
}

export async function addParcelAction(txId: string, propertyId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await addParcel(ctx, propertyId, { apn: str(fd, "apn"), legalDescription: optStr(fd, "legalDescription") });
    return { message: "Parcel added." };
  }, p(txId));
}

export async function addParticipantAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await addParticipant(ctx, txId, {
      role: str(fd, "role") as "BUYER",
      partyType: (optStr(fd, "partyType") ?? "INDIVIDUAL") as "INDIVIDUAL",
      displayName: str(fd, "displayName"),
      organization: optStr(fd, "organization"),
      email: optStr(fd, "email") ?? "",
      phone: optStr(fd, "phone"),
      side: optStr(fd, "side") as "BUYER" | undefined,
    });
    return { message: "Participant added." };
  }, p(txId));
}

export async function invitePortalAction(txId: string, participantId: string, _prev: ActionState): Promise<ActionState<{ inviteUrl?: string }>> {
  return runAction(async (ctx) => {
    const res = await inviteParticipantToPortal(ctx, participantId);
    if (res.linkedExisting) return { message: "Portal access granted to the existing account." };
    return {
      message: "Invitation created. Deliver this one-time link through your approved channel; it expires in 7 days and is not shown again.",
      data: { inviteUrl: res.inviteUrl },
    };
  }, p(txId));
}

export async function revokePortalAction(txId: string, participantId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await revokePortalAccess(ctx, participantId, str(fd, "reason") || "Revoked by staff");
    return { message: "Portal access revoked." };
  }, p(txId));
}

export async function notificationsAction(txId: string, participantId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await updateParticipantNotifications(ctx, participantId, str(fd, "enabled") === "true");
    return { message: "Preference saved." };
  }, p(txId));
}

export async function addSignerAction(txId: string, participantId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await addEntitySigner(ctx, participantId, { name: str(fd, "name"), title: optStr(fd, "title"), email: optStr(fd, "email"), authorityDocumentId: optStr(fd, "authorityDocumentId") });
    return { message: "Signer added." };
  }, p(txId));
}

export async function requestSignerReviewAction(txId: string, signerId: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    await requestSignerReview(ctx, signerId);
    return { message: "Sent for authority review." };
  }, p(txId));
}

// ---- Tasks, deadlines, milestones ------------------------------------------

export async function createTaskAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await createTask(ctx, txId, {
      title: str(fd, "title"),
      description: optStr(fd, "description"),
      isBlocker: bool(fd, "isBlocker"),
      required: bool(fd, "required"),
      requiresApproval: bool(fd, "requiresApproval"),
      assigneeUserId: optStr(fd, "assigneeUserId"),
      responsibleParticipantId: optStr(fd, "responsibleParticipantId"),
      dueDate: optStr(fd, "dueDate"),
      category: optStr(fd, "category") ?? "GENERAL",
    });
    return { message: bool(fd, "isBlocker") ? "Blocker added." : "Task added." };
  }, p(txId));
}

export async function resolveTaskAction(txId: string, taskId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const res = await resolveTask(ctx, taskId, {
      status: str(fd, "status") as "DONE",
      note: optStr(fd, "note"),
      evidenceDocumentId: optStr(fd, "evidenceDocumentId"),
      expectedVersion: num(fd, "expectedVersion"),
    });
    return { message: res.status === "AWAITING_APPROVAL" ? "Completion sent for approval." : "Task updated." };
  }, p(txId));
}

export async function reopenTaskAction(txId: string, taskId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await reopenTask(ctx, taskId, str(fd, "reason") || "Reopened");
    return { message: "Task reopened." };
  }, p(txId));
}

export async function updateTaskAction(txId: string, taskId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await updateTask(ctx, taskId, {
      status: (optStr(fd, "status") as "OPEN" | undefined) ?? undefined,
      assigneeUserId: fd.has("assigneeUserId") ? (optStr(fd, "assigneeUserId") ?? null) : undefined,
      dueDate: fd.has("dueDate") ? (optStr(fd, "dueDate") ?? null) : undefined,
    });
    return { message: "Saved." };
  }, p(txId));
}

export async function createDeadlineAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await createDeadline(ctx, txId, { title: str(fd, "title"), type: (optStr(fd, "type") ?? "CONTRACT") as DeadlineType, dueDate: str(fd, "dueDate"), notes: optStr(fd, "notes") });
    return { message: "Deadline added." };
  }, p(txId));
}

export async function resolveDeadlineAction(txId: string, deadlineId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await resolveDeadline(ctx, deadlineId, str(fd, "status") as "MET", str(fd, "note"), optStr(fd, "newDueDate"));
    return { message: "Deadline updated." };
  }, p(txId));
}

export async function milestoneAction(txId: string, kind: MilestoneKind, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await updateMilestone(ctx, txId, kind, {
      status: str(fd, "status") as MilestoneStatus,
      source: optStr(fd, "source"),
      reference: optStr(fd, "reference"),
      evidenceDocumentId: optStr(fd, "evidenceDocumentId"),
      notes: optStr(fd, "notes"),
    });
    return { message: "Milestone updated." };
  }, p(txId));
}

// ---- Documents --------------------------------------------------------------

export async function uploadDocumentAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("VALIDATION", "Choose a file to upload.");
    const res = await uploadDocument(ctx, {
      transactionId: txId,
      filename: file.name,
      data: Buffer.from(await file.arrayBuffer()),
      title: optStr(fd, "title"),
      category: optStr(fd, "category"),
      documentId: optStr(fd, "documentId"),
      requestId: optStr(fd, "requestId"),
    });
    if (res.scan.status !== "CLEAN") return { message: `File held in quarantine: ${res.scan.detail}` };
    return { message: "Uploaded and scanned." };
  }, p(txId));
}

export async function shareDocumentAction(txId: string, documentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await shareDocument(ctx, documentId, str(fd, "participantId"));
    return { message: "Shared." };
  }, p(txId));
}

export async function revokeShareAction(txId: string, documentId: string, participantId: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    await revokeShare(ctx, documentId, participantId);
    return { message: "Sharing revoked." };
  }, p(txId));
}

export async function reviewDocumentAction(txId: string, versionId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await reviewDocumentVersion(ctx, versionId, str(fd, "decision") as ReviewDecision, optStr(fd, "note"));
    return { message: "Review recorded." };
  }, p(txId));
}

export async function updateDocumentAction(txId: string, documentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await updateDocumentMeta(ctx, documentId, { title: optStr(fd, "title"), category: optStr(fd, "category") });
    return { message: "Saved." };
  }, p(txId));
}

export async function documentLegalHoldAction(txId: string, documentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await setDocumentLegalHold(ctx, documentId, str(fd, "hold") === "on", str(fd, "reason"));
    return { message: "Legal hold updated." };
  }, p(txId));
}

export async function archiveDocumentAction(txId: string, documentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await archiveDocument(ctx, documentId, str(fd, "reason"));
    return { message: "Archived." };
  }, p(txId));
}

export async function requestDocumentAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await createDocumentRequest(ctx, txId, { participantId: str(fd, "participantId"), title: str(fd, "title"), description: optStr(fd, "description"), category: optStr(fd, "category"), dueDate: optStr(fd, "dueDate") });
    return { message: "Request created. The participant sees it in the portal." };
  }, p(txId));
}

export async function requestStatusAction(txId: string, requestId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await setDocumentRequestStatus(ctx, requestId, str(fd, "status") as "ACCEPTED", optStr(fd, "note"));
    return { message: "Request updated." };
  }, p(txId));
}

// ---- Title ----------------------------------------------------------------------

export async function titleOrderAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await recordTitleOrder(ctx, txId, { provider: str(fd, "provider"), externalRef: optStr(fd, "externalRef"), notes: optStr(fd, "notes") });
    return { message: "Title order recorded." };
  }, p(txId));
}

export async function linkReportAction(txId: string, orderId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await linkTitleReport(ctx, orderId, str(fd, "documentId"));
    return { message: "Report linked." };
  }, p(txId));
}

export async function addExceptionAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await addTitleException(ctx, txId, { documentId: str(fd, "documentId"), itemNumber: optStr(fd, "itemNumber"), category: optStr(fd, "category"), description: str(fd, "description"), page: num(fd, "page") });
    return { message: "Exception recorded." };
  }, p(txId));
}

export async function dispositionAction(txId: string, exceptionId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await setExceptionDisposition(ctx, exceptionId, str(fd, "disposition") as ExceptionDisposition, str(fd, "note"));
    return { message: "Disposition saved." };
  }, p(txId));
}

// ---- Messages ---------------------------------------------------------------------

export async function createThreadAction(txId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await createThread(ctx, txId, { subject: str(fd, "subject"), body: str(fd, "body"), internalOnly: bool(fd, "internalOnly"), participantIds: fd.getAll("participantIds").map(String) });
    return { message: "Thread started." };
  }, p(txId));
}

export async function postMessageAction(txId: string, threadId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await postMessage(ctx, threadId, str(fd, "body"));
    return { message: "Sent." };
  }, p(txId));
}
