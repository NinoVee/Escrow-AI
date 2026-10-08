import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { expectAppError, makeCompany, makeTx, makeUser, resetDb } from "./helpers";
import { changeStatus, transitionStage } from "@/server/workflow/engine";
import { decideApproval } from "@/server/services/approvals";
import { resolveTask, createTask, updateMilestone } from "@/server/services/tasks";
import { createDraftVersion, publishVersion, saveDraftDefinition } from "@/server/services/templates";
import type { Ctx } from "@/server/context";

async function resolveStageTasks(ctx: Ctx, transactionId: string, stages: string[]) {
  await db.task.updateMany({ where: { transactionId, stage: { in: stages }, required: true }, data: { status: "DONE", completedAt: new Date() } });
  void ctx;
}

describe("workflow engine", () => {
  let officer: Ctx, officer2: Ctx, assistant: Ctx, manager: Ctx, admin: Ctx;
  let companyId: string;

  beforeAll(async () => {
    await resetDb();
    const c = await makeCompany("Workflow Co");
    companyId = c.company.id;
    admin = c.admin;
    officer = await makeUser(companyId, "ESCROW_OFFICER", "Officer One");
    officer2 = await makeUser(companyId, "ESCROW_OFFICER", "Officer Two");
    assistant = await makeUser(companyId, "ESCROW_ASSISTANT");
    manager = await makeUser(companyId, "MANAGER");
  });

  let txId: string;
  beforeEach(async () => {
    txId = (await makeTx(officer)).id;
  });

  it("requires a reason for every stage change", async () => {
    await expectAppError(transitionStage(officer, txId, { toStage: "OPEN", reason: "" }), "VALIDATION");
  });

  it("rejects transitions that are not defined (no skipping stages)", async () => {
    await expectAppError(transitionStage(officer, txId, { toStage: "REVIEW", reason: "skip ahead" }), "PRECONDITION_FAILED");
  });

  it("blocks a transition until prerequisites are met, then allows it", async () => {
    await transitionStage(officer, txId, { toStage: "OPEN", reason: "open" });
    const blocked = await transitionStage(officer, txId, { toStage: "DOCUMENT_COLLECTION", reason: "next" });
    expect(blocked.status).toBe("BLOCKED");
    if (blocked.status === "BLOCKED") expect(blocked.unmet.some((u) => u.type === "TASKS_RESOLVED")).toBe(true);
    await resolveStageTasks(officer, txId, ["OPEN"]);
    const ok = await transitionStage(officer, txId, { toStage: "DOCUMENT_COLLECTION", reason: "next" });
    expect(ok.status).toBe("TRANSITIONED");
    const tx = await db.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.stage).toBe("DOCUMENT_COLLECTION");
    const history = await db.stageTransition.findMany({ where: { transactionId: txId } });
    expect(history.map((h) => h.toStage)).toEqual(["OPEN", "DOCUMENT_COLLECTION"]);
  });

  it("only users with workflow.override can override, and they must justify it", async () => {
    await transitionStage(officer, txId, { toStage: "OPEN", reason: "open" });
    await expectAppError(transitionStage(officer, txId, { toStage: "DOCUMENT_COLLECTION", reason: "push", override: { justification: "because I said so" } }), "FORBIDDEN");
    await expectAppError(transitionStage(manager, txId, { toStage: "DOCUMENT_COLLECTION", reason: "push", override: { justification: "short" } }), "VALIDATION");
    const res = await transitionStage(manager, txId, { toStage: "DOCUMENT_COLLECTION", reason: "push", override: { justification: "Officer on leave; tasks verified by phone with parties" } });
    expect(res.status).toBe("TRANSITIONED");
    const t = await db.stageTransition.findFirstOrThrow({ where: { transactionId: txId, toStage: "DOCUMENT_COLLECTION" } });
    expect(t.overridden).toBe(true);
    expect(t.overrideJustification).toMatch(/Officer on leave/);
    expect(t.unmetPrerequisites).toBeTruthy();
    const ev = await db.auditEvent.findFirst({ where: { transactionId: txId, action: "workflow.transition.override" } });
    expect(ev).not.toBeNull();
  });

  it("non-overridable prerequisites cannot be overridden", async () => {
    await db.transaction.update({ where: { id: txId }, data: { stage: "READY_FOR_SIGNING" } });
    const res = await transitionStage(manager, txId, { toStage: "SIGNED", reason: "signed?", override: { justification: "Trust me, they signed it already" } });
    expect(res.status).toBe("BLOCKED");
    if (res.status === "BLOCKED") expect(res.unmet[0]).toMatchObject({ type: "MILESTONE_COMPLETE", overridable: false });
  });

  it("transitions that require approval need a different person to approve", async () => {
    await db.transaction.update({ where: { id: txId }, data: { stage: "REVIEW" } });
    await resolveStageTasks(officer, txId, ["REVIEW"]);
    const req = await transitionStage(officer, txId, { toStage: "READY_FOR_SIGNING", reason: "review complete" });
    expect(req.status).toBe("AWAITING_APPROVAL");
    const approvalId = req.status === "AWAITING_APPROVAL" ? req.approvalId : "";
    // A second request does not create a duplicate.
    const again = await transitionStage(officer, txId, { toStage: "READY_FOR_SIGNING", reason: "again" });
    expect(again).toMatchObject({ status: "AWAITING_APPROVAL", approvalId });
    await expectAppError(decideApproval(officer, approvalId, "APPROVED"), "FORBIDDEN");
    await expectAppError(decideApproval(assistant, approvalId, "APPROVED"), "FORBIDDEN");
    await decideApproval(officer2, approvalId, "APPROVED", "Looks good");
    const tx = await db.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.stage).toBe("READY_FOR_SIGNING");
    const a = await db.approval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(a.status).toBe("CONSUMED");
  });

  it("invalidates a stage approval when the file moves before it is decided", async () => {
    await db.transaction.update({ where: { id: txId }, data: { stage: "REVIEW" } });
    await resolveStageTasks(officer, txId, ["REVIEW"]);
    const req = await transitionStage(officer, txId, { toStage: "READY_FOR_SIGNING", reason: "review complete" });
    const approvalId = req.status === "AWAITING_APPROVAL" ? req.approvalId : "";
    await transitionStage(officer, txId, { toStage: "DOCUMENT_COLLECTION", reason: "missing doc found" });
    await expectAppError(decideApproval(officer2, approvalId, "APPROVED"), "PRECONDITION_FAILED");
    expect((await db.approval.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe("INVALIDATED");
  });

  it("rejects stale writes using the optimistic version", async () => {
    const tx = await db.transaction.findUniqueOrThrow({ where: { id: txId } });
    await transitionStage(officer, txId, { toStage: "OPEN", reason: "open", expectedVersion: tx.version });
    await expectAppError(changeStatus(officer, txId, "HOLD", "stale", { expectedVersion: tx.version }), "CONFLICT");
  });

  it("serializes concurrent transitions so exactly one wins", async () => {
    const results = await Promise.allSettled([
      transitionStage(officer, txId, { toStage: "OPEN", reason: "first" }),
      transitionStage(officer2, txId, { toStage: "OPEN", reason: "second" }),
      transitionStage(assistant, txId, { toStage: "OPEN", reason: "third" }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled" && r.value.status === "TRANSITIONED");
    expect(won).toHaveLength(1);
    expect(await db.stageTransition.count({ where: { transactionId: txId } })).toBe(1);
  });

  it("supports hold, resume, cancel and manager-only reopen", async () => {
    await changeStatus(officer, txId, "HOLD", "awaiting buyer");
    await expectAppError(transitionStage(officer, txId, { toStage: "OPEN", reason: "try while on hold" }), "PRECONDITION_FAILED");
    await changeStatus(officer, txId, "RESUME", "buyer back");
    await changeStatus(officer, txId, "CANCEL", "buyer cancelled");
    await expectAppError(changeStatus(officer, txId, "REOPEN", "oops"), "FORBIDDEN");
    await changeStatus(manager, txId, "REOPEN", "cancellation rescinded", { reopenStage: "OPEN" });
    const tx = await db.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx).toMatchObject({ status: "ACTIVE", stage: "OPEN" });
    expect((await db.stageTransition.findMany({ where: { transactionId: txId } })).map((t) => t.kind)).toEqual(["HOLD", "RESUME", "CANCEL", "REOPEN"]);
  });

  describe("closing", () => {
    async function readyToClose(id: string) {
      await db.transaction.update({ where: { id }, data: { stage: "DISBURSEMENT_REVIEW" } });
      await db.task.updateMany({ where: { transactionId: id, required: true }, data: { status: "DONE" } });
      await db.milestone.updateMany({ where: { transactionId: id }, data: { status: "COMPLETE" } });
    }

    it("is blocked by an unresolved required task, even with an override", async () => {
      await readyToClose(txId);
      const t = await db.task.findFirstOrThrow({ where: { transactionId: txId, templateKey: "final-package" } });
      await db.task.update({ where: { id: t.id }, data: { status: "OPEN" } });
      const res = await transitionStage(manager, txId, { toStage: "CLOSED", reason: "close", override: { justification: "Closing anyway, package to follow later" } });
      expect(res.status).toBe("BLOCKED");
      if (res.status === "BLOCKED") expect(res.unmet.find((u) => u.type === "TASKS_RESOLVED")?.overridable).toBe(false);
    });

    it("is blocked by an open blocker", async () => {
      await readyToClose(txId);
      await createTask(officer, txId, { title: "Lender wire not confirmed", isBlocker: true });
      const res = await transitionStage(officer, txId, { toStage: "CLOSED", reason: "close" });
      expect(res.status).toBe("BLOCKED");
      if (res.status === "BLOCKED") expect(res.unmet.map((u) => u.type)).toContain("NO_OPEN_BLOCKERS");
    });

    it("is blocked by an incomplete milestone", async () => {
      await readyToClose(txId);
      await db.milestone.updateMany({ where: { transactionId: txId, kind: "RECORDING" }, data: { status: "IN_PROGRESS" } });
      const res = await transitionStage(officer, txId, { toStage: "CLOSED", reason: "close" });
      expect(res.status).toBe("BLOCKED");
    });

    it("closes only after everything is resolved and another person approves", async () => {
      await readyToClose(txId);
      const req = await transitionStage(officer, txId, { toStage: "CLOSED", reason: "all done" });
      expect(req.status).toBe("AWAITING_APPROVAL");
      await decideApproval(manager, req.status === "AWAITING_APPROVAL" ? req.approvalId : "", "APPROVED");
      const tx = await db.transaction.findUniqueOrThrow({ where: { id: txId } });
      expect(tx).toMatchObject({ status: "CLOSED", stage: "CLOSED" });
      expect(tx.closedAt).not.toBeNull();
    });
  });

  describe("tasks", () => {
    it("requires waive permission and a reason to waive a required task", async () => {
      const t = await db.task.findFirstOrThrow({ where: { transactionId: txId, required: true } });
      await expectAppError(resolveTask(assistant, t.id, { status: "WAIVED", note: "not needed" }), "FORBIDDEN");
      await expectAppError(resolveTask(officer, t.id, { status: "WAIVED" }), "VALIDATION");
      await resolveTask(officer, t.id, { status: "WAIVED", note: "Duplicate of lender requirement" });
      expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("WAIVED");
    });

    it("tasks that require approval complete only after a different person approves", async () => {
      const t = await createTask(assistant, txId, { title: "Verify trust certification", requiresApproval: true, required: true });
      const res = await resolveTask(assistant, t.id, { status: "DONE", note: "Reviewed certification of trust" });
      expect(res.status).toBe("AWAITING_APPROVAL");
      expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("WAITING");
      const approvalId = res.status === "AWAITING_APPROVAL" ? res.approvalId : "";
      await expectAppError(decideApproval(assistant, approvalId, "APPROVED"), "FORBIDDEN");
      await decideApproval(officer, approvalId, "APPROVED");
      expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("DONE");
    });

    it("re-evaluates task applicability when facts change", async () => {
      expect(await db.task.count({ where: { transactionId: txId, templateKey: "hoa-demand" } })).toBe(0);
      const { updateTransactionField } = await import("@/server/services/transactions");
      await updateTransactionField(officer, txId, "hasHoa", "true", { reason: "HOA disclosed" });
      expect(await db.task.count({ where: { transactionId: txId, templateKey: "hoa-demand", status: "OPEN" } })).toBe(1);
      await updateTransactionField(officer, txId, "hasHoa", "false", { reason: "Not an HOA after all" });
      expect((await db.task.findFirstOrThrow({ where: { transactionId: txId, templateKey: "hoa-demand" } })).status).toBe("NOT_APPLICABLE");
    });
  });

  describe("milestones", () => {
    it("funding needs an authorized source, reference and evidence; assistants cannot confirm it", async () => {
      await expectAppError(updateMilestone(assistant, txId, "FUNDING", { status: "COMPLETE", source: "BANK_RECONCILIATION", reference: "x" }), "FORBIDDEN");
      await expectAppError(updateMilestone(officer, txId, "FUNDING", { status: "COMPLETE", source: "EMAIL", reference: "x" }), "VALIDATION");
      await expectAppError(updateMilestone(officer, txId, "FUNDING", { status: "COMPLETE", source: "BANK_RECONCILIATION", reference: "FED-123" }), "VALIDATION");
    });
  });

  describe("templates", () => {
    it("publishing a new version leaves existing files on their original version", async () => {
      const before = await db.transaction.findUniqueOrThrow({ where: { id: txId } });
      const tpl = await db.workflowTemplate.findFirstOrThrow({ where: { companyId, key: "ca-residential" } });
      const current = await db.workflowTemplateVersion.findFirstOrThrow({ where: { templateId: tpl.id, status: "PUBLISHED" } });
      await expectAppError(saveDraftDefinition(admin, current.id, JSON.stringify(current.definition)), "PRECONDITION_FAILED");
      const draft = await createDraftVersion(admin, tpl.id, current.id);
      const def = current.definition as { tasks: { title: string }[] };
      def.tasks[0].title = "Open file (edited)";
      await expectAppError(saveDraftDefinition(admin, draft.id, JSON.stringify({ ...def, initialStage: "NOPE" })), "VALIDATION");
      await saveDraftDefinition(admin, draft.id, JSON.stringify(def), "Edited first task");
      await publishVersion(admin, draft.id);
      const after = await db.transaction.findUniqueOrThrow({ where: { id: txId } });
      expect(after.templateVersionId).toBe(before.templateVersionId);
      const fresh = await makeTx(officer);
      expect(fresh.templateVersionId).toBe(draft.id);
      expect((await db.task.findFirstOrThrow({ where: { transactionId: fresh.id, templateKey: "open-file" } })).title).toBe("Open file (edited)");
      expect((await db.workflowTemplateVersion.findUniqueOrThrow({ where: { id: current.id } })).status).toBe("RETIRED");
    });

    it("only template managers can edit templates", async () => {
      const tpl = await db.workflowTemplate.findFirstOrThrow({ where: { companyId, key: "ca-commercial" } });
      const current = await db.workflowTemplateVersion.findFirstOrThrow({ where: { templateId: tpl.id, status: "PUBLISHED" } });
      await expectAppError(createDraftVersion(officer, tpl.id, current.id), "FORBIDDEN");
    });
  });
});
