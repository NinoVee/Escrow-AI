import { registerApprovalHandler } from "./approvals";
import { executeApprovedTransition } from "../workflow/engine";
import { audit } from "../audit";

/**
 * Per-type approval behavior. `currentBinding` must return exactly the same
 * shape that was hashed when the approval was requested.
 */

registerApprovalHandler("STAGE_TRANSITION", {
  async currentBinding(client, approval) {
    const snap = approval.bindingSnapshot as { toStage: string };
    const tx = await client.transaction.findUnique({ where: { id: approval.subjectId } });
    if (!tx) return null;
    return { transactionId: tx.id, fromStage: tx.stage, toStage: snap.toStage, templateVersionId: tx.templateVersionId };
  },
  async after(ctx, approval, decision) {
    if (decision !== "APPROVED") return;
    const snap = approval.bindingSnapshot as { transactionId: string; toStage: string; reason: string; override: string | null };
    await executeApprovedTransition(ctx, snap);
  },
});

registerApprovalHandler("TASK_COMPLETION", {
  async currentBinding(client, approval) {
    const t = await client.task.findUnique({ where: { id: approval.subjectId } });
    if (!t) return null;
    return { taskId: t.id, title: t.title, evidenceDocumentId: t.evidenceDocumentId, resolutionNote: t.resolutionNote };
  },
  async within(client, ctx, approval, decision) {
    const task = await client.task.findUniqueOrThrow({ where: { id: approval.subjectId } });
    await client.task.update({
      where: { id: task.id },
      data:
        decision === "APPROVED"
          ? { status: "DONE", completedAt: new Date(), completedById: approval.requestedById, approvalId: approval.id, version: { increment: 1 } }
          : { status: "OPEN", approvalId: null, version: { increment: 1 } },
    });
    await audit(ctx, {
      action: decision === "APPROVED" ? "task.completed" : "task.completion_rejected",
      entityType: "Task",
      entityId: task.id,
      transactionId: task.transactionId,
      summary: `${decision === "APPROVED" ? "Approved completion of" : "Rejected completion of"} "${task.title}"`,
    }, client);
  },
});

registerApprovalHandler("SIGNING_AUTHORITY", {
  async currentBinding(client, approval) {
    const s = await client.entitySigner.findUnique({ where: { id: approval.subjectId } });
    if (!s) return null;
    return { signerId: s.id, participantId: s.participantId, name: s.name, title: s.title, authorityDocumentId: s.authorityDocumentId };
  },
  async within(client, ctx, approval, decision) {
    await client.entitySigner.update({
      where: { id: approval.subjectId },
      data: {
        authorityStatus: decision === "APPROVED" ? "APPROVED" : "REJECTED",
        reviewedById: ctx.userId,
        reviewedAt: new Date(),
        reviewNote: approval.decisionNote,
      },
    });
  },
});
