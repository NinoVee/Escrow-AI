"use server";

import { optStr, runAction, str } from "@/server/action";
import { cancelApproval, decideApproval } from "@/server/services/approvals";
import type { ActionState } from "@/lib/action-types";

export async function decideApprovalAction(approvalId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    const decision = str(fd, "decision") === "REJECTED" ? "REJECTED" : "APPROVED";
    await decideApproval(ctx, approvalId, decision, optStr(fd, "note"));
    return { message: decision === "APPROVED" ? "Approved." : "Rejected." };
  }, ["/approvals", "/transactions", "/dashboard"]);
}

export async function cancelApprovalAction(approvalId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await cancelApproval(ctx, approvalId, str(fd, "reason") || "Withdrawn by requester");
    return { message: "Request withdrawn." };
  }, ["/approvals", "/transactions"]);
}
