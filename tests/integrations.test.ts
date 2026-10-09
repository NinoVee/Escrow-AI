import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { expectAppError, makeCompany, makeTx, makeUser, resetDb } from "./helpers";
import { resetEnvCache } from "@/server/env";
import { systemCtx, type Ctx } from "@/server/context";
import { receiveWebhook, signPayload, verifySignature, WebhookError } from "@/server/integrations/webhooks";
import { enqueueJob } from "@/server/jobs/queue";
import { runJob } from "@/server/jobs/runner";
import { createOutboundDraft, deliverOutbound, requestSendApproval } from "@/server/services/outbound";
import { decideApproval } from "@/server/services/approvals";
import { approveTemplate, runAutomationForCompany, updateRule, updateTemplate } from "@/server/services/automation";
import { replayJobForCompany } from "@/server/services/operations";
import { integrationMode, integrationStatuses, setIntegrationMode } from "@/server/integrations/registry";
import { sendForSignature, simulateProviderEvent } from "@/server/services/integrations";
import { uploadDocument } from "@/server/services/documents";
import { disabledPayments } from "@/server/integrations/providers";
import { pdf } from "./helpers";

const SECRET = "test-esign-webhook-secret-0123456789";

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

async function setCompanySending(companyId: string, on: boolean) {
  const c = await db.company.findUniqueOrThrow({ where: { id: companyId } });
  await db.company.update({ where: { id: companyId }, data: { settings: { ...(c.settings as object), externalSendingEnabled: on } } });
}

describe("Phase 4: integrations, jobs, webhooks and outbound email", () => {
  let companyId: string, admin: Ctx, officer: Ctx, officer2: Ctx, assistant: Ctx, manager: Ctx, other: Ctx;
  let txId: string, buyerId: string, sellerId: string;

  beforeAll(async () => {
    await resetDb();
    setEnv({ ESIGN_WEBHOOK_SECRET: SECRET, EXTERNAL_SEND_ENABLED: "false" });
    const c = await makeCompany("Integrations Co");
    companyId = c.company.id;
    admin = c.admin;
    officer = await makeUser(companyId, "ESCROW_OFFICER", "Officer");
    officer2 = await makeUser(companyId, "ESCROW_OFFICER", "Officer Two");
    assistant = await makeUser(companyId, "ESCROW_ASSISTANT", "Assistant");
    manager = await makeUser(companyId, "MANAGER", "Manager");
    const o = await makeCompany("Other Co");
    other = await makeUser(o.company.id, "ESCROW_OFFICER", "Other officer");
    const tx = await makeTx(officer, {
      parties: [
        { role: "BUYER", displayName: "Pat Buyer", partyType: "INDIVIDUAL", email: "pat.buyer@example.com" },
        { role: "SELLER", displayName: "Sam Seller", partyType: "INDIVIDUAL", email: "" },
      ],
    });
    txId = tx.id;
    const ps = await db.participant.findMany({ where: { transactionId: txId } });
    buyerId = ps.find((p) => p.role === "BUYER")!.id;
    sellerId = ps.find((p) => p.role === "SELLER")!.id;
  });

  afterEach(() => setEnv({ EXTERNAL_SEND_ENABLED: "false" }));

  // ---- Webhooks ---------------------------------------------------------------

  describe("webhooks", () => {
    let envelopeExternalId: string;
    beforeAll(async () => {
      const up = await uploadDocument(officer, { transactionId: txId, filename: "instructions.pdf", data: pdf(["Escrow instructions (test)"]), title: "Instructions", category: "ESCROW_INSTRUCTIONS" });
      const env = await sendForSignature(officer, txId, { documentIds: [up.document.id], signerParticipantIds: [buyerId], subject: "Sign" });
      envelopeExternalId = env.externalId;
    });

    const event = (id: string, status: string, occurredAt: Date) => JSON.stringify({ id, type: "envelope.status", occurredAt: occurredAt.toISOString(), data: { externalId: envelopeExternalId, status } });

    it("rejects missing, invalid, and stale signatures", async () => {
      const body = event("e-sig", "DELIVERED", new Date());
      await expect(receiveWebhook("esign-demo", null, body)).rejects.toMatchObject({ status: 401 });
      await expect(receiveWebhook("esign-demo", signPayload("wrong-secret-wrong-secret", body), body)).rejects.toMatchObject({ status: 401 });
      const old = Math.floor(Date.now() / 1000) - 3600;
      await expect(receiveWebhook("esign-demo", signPayload(SECRET, body, old), body)).rejects.toMatchObject({ status: 401 });
      // Tampered body with a valid signature for the original.
      const tampered = body.replace("DELIVERED", "COMPLETED");
      expect(() => verifySignature(SECRET, signPayload(SECRET, body), tampered)).toThrow(WebhookError);
      await expect(receiveWebhook("unknown-provider", signPayload(SECRET, body), body)).rejects.toMatchObject({ status: 404 });
      expect(await db.webhookEvent.count({ where: { externalEventId: "e-sig" } })).toBe(0);
    });

    it("processes an event once and acknowledges duplicates without reprocessing", async () => {
      const body = event("e-1", "DELIVERED", new Date(Date.now() + 1000));
      const first = await receiveWebhook("esign-demo", signPayload(SECRET, body), body);
      const second = await receiveWebhook("esign-demo", signPayload(SECRET, body), body);
      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(await db.webhookEvent.count({ where: { externalEventId: "e-1" } })).toBe(1);
      expect(await db.jobRun.count({ where: { idempotencyKey: "webhook:esign-demo:e-1" } })).toBe(1);
      const env = await db.signatureEnvelope.findUniqueOrThrow({ where: { externalId: envelopeExternalId } });
      expect(env.status).toBe("DELIVERED");
    });

    it("ignores out-of-order events (older timestamp or lower status)", async () => {
      const completed = event("e-2", "COMPLETED", new Date(Date.now() + 5000));
      await receiveWebhook("esign-demo", signPayload(SECRET, completed), completed);
      // An older "SENT" arriving late must not move the envelope backwards.
      const late = event("e-3", "SENT", new Date(Date.now() + 2000));
      await receiveWebhook("esign-demo", signPayload(SECRET, late), late);
      const env = await db.signatureEnvelope.findUniqueOrThrow({ where: { externalId: envelopeExternalId } });
      expect(env.status).toBe("COMPLETED");
      const lateEv = await db.webhookEvent.findFirstOrThrow({ where: { externalEventId: "e-3" } });
      expect(lateEv.status).toBe("STALE");
      // Completion creates a review task; it does not complete any milestone.
      const tasks = await db.task.findMany({ where: { transactionId: txId, title: { contains: "e-signature" } } });
      expect(tasks).toHaveLength(1);
      const signing = await db.milestone.findFirst({ where: { transactionId: txId, kind: "SIGNING" } });
      expect(signing?.status ?? "NOT_STARTED").not.toBe("COMPLETE");
    });

    it("demo simulation goes through the same signed path and is tenant-scoped", async () => {
      const env = await db.signatureEnvelope.findUniqueOrThrow({ where: { externalId: envelopeExternalId } });
      await expectAppError(simulateProviderEvent(other, "ENVELOPE", env.id), "NOT_FOUND");
    });
  });

  // ---- Jobs ----------------------------------------------------------------

  describe("durable jobs", () => {
    it("creates a job once per idempotency key", async () => {
      const a = await enqueueJob("automation.company", {}, { companyId, idempotencyKey: "test:automation:1" });
      const b = await enqueueJob("automation.company", {}, { companyId, idempotencyKey: "test:automation:1" });
      expect(a.duplicate).toBe(false);
      expect(b.duplicate).toBe(true);
      expect(b.run.id).toBe(a.run.id);
      expect((await db.jobRun.findUniqueOrThrow({ where: { id: a.run.id } })).status).toBe("SUCCEEDED");
      // Running a completed job again is a no-op.
      await runJob(a.run.id);
      expect((await db.jobRun.findUniqueOrThrow({ where: { id: a.run.id } })).attempts).toBe(1);
    });

    it("records failures, becomes DEAD after max attempts, and can be replayed by an authorized user", async () => {
      const { run } = await enqueueJob("email.send", { outboundId: "does-not-exist" }, { companyId, idempotencyKey: "test:email:missing", maxAttempts: 2 });
      let r = await db.jobRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(r.status).toBe("FAILED");
      expect(r.lastError).toMatch(/not found/i);
      await expect(runJob(run.id)).rejects.toThrow();
      r = await db.jobRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(r.status).toBe("DEAD");
      await expectAppError(replayJobForCompany(officer, run.id), "FORBIDDEN");
      await expectAppError(replayJobForCompany({ ...other, role: "COMPANY_ADMIN" }, run.id), "NOT_FOUND");
      await replayJobForCompany(admin, run.id);
      r = await db.jobRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(r.replayCount).toBe(1);
      expect(r.status).toBe("FAILED"); // still failing, but visible and attributable
    });

    it("job handlers ignore payload company ids and use the JobRun's scope", async () => {
      const otherCompany = other.companyId;
      const m = await createOutboundDraft(officer, { transactionId: txId, participantIds: [buyerId], subject: "Scope", body: "Hello" });
      const { run } = await enqueueJob("email.send", { outboundId: m.id, companyId }, { companyId: otherCompany, idempotencyKey: "test:scope", maxAttempts: 1 });
      const r = await db.jobRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(r.status).toBe("DEAD");
      expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("DRAFT");
    });
  });

  // ---- Outbound email ----------------------------------------------------------

  describe("outbound email gating", () => {
    async function approvedMessage(subject: string, body = "Your file is progressing. Please check the portal.") {
      const m = await createOutboundDraft(assistant, { transactionId: txId, participantIds: [buyerId], subject, body });
      const a = await requestSendApproval(assistant, m.id);
      return { m, a };
    }

    it("default is off: an approved message is BLOCKED and nothing is sent", async () => {
      const { m, a } = await approvedMessage("Default off");
      await decideApproval(officer, a.id, "APPROVED", "ok");
      const after = await db.outboundMessage.findUniqueOrThrow({ where: { id: m.id } });
      expect(after.status).toBe("BLOCKED");
      expect(after.blockedReason).toMatch(/server switch/);
      expect(after.sentAt).toBeNull();
    });

    it("company switch must also be on", async () => {
      setEnv({ EXTERNAL_SEND_ENABLED: "true" });
      const { m, a } = await approvedMessage("Company off");
      await decideApproval(officer, a.id, "APPROVED", "ok");
      const after = await db.outboundMessage.findUniqueOrThrow({ where: { id: m.id } });
      expect(after.status).toBe("BLOCKED");
      expect(after.blockedReason).toMatch(/company setting/);
    });

    it("with both switches on and no SMTP, approved mail is captured in the demo outbox exactly once", async () => {
      setEnv({ EXTERNAL_SEND_ENABLED: "true", SMTP_HOST: undefined });
      await setCompanySending(companyId, true);
      const { m, a } = await approvedMessage("Captured");
      await decideApproval(officer, a.id, "APPROVED", "ok");
      let after = await db.outboundMessage.findUniqueOrThrow({ where: { id: m.id } });
      expect(after.status).toBe("CAPTURED_DEMO");
      expect(after.provider).toBe("demo-outbox");
      const firstSentAt = after.sentAt!.getTime();
      // Replays and duplicate deliveries do not send again.
      expect(await deliverOutbound(companyId, m.id)).toEqual({ status: "CAPTURED_DEMO" });
      await enqueueJob("email.send", { outboundId: m.id }, { companyId, idempotencyKey: `email.send:${m.id}` });
      after = await db.outboundMessage.findUniqueOrThrow({ where: { id: m.id } });
      expect(after.sentAt!.getTime()).toBe(firstSentAt);
      expect(await db.jobRun.count({ where: { idempotencyKey: `email.send:${m.id}` } })).toBe(1);
      await setCompanySending(companyId, false);
    });

    it("blocks bank details and identity numbers, even with approval", async () => {
      const m = await createOutboundDraft(officer, { transactionId: txId, participantIds: [buyerId], subject: "Wire", body: "Please wire to routing 121000358 account 000123456789" });
      expect(m.status).toBe("BLOCKED");
      await expectAppError(requestSendApproval(officer, m.id), "PRECONDITION_FAILED");
      const ssn = await createOutboundDraft(officer, { transactionId: txId, participantIds: [buyerId], subject: "ID", body: "SSN 123-45-6789" });
      expect(ssn.status).toBe("BLOCKED");
    });

    it("suppresses recipients without email or who opted out", async () => {
      const m = await createOutboundDraft(officer, { transactionId: txId, participantIds: [sellerId], subject: "Hi", body: "Hello" });
      expect(m.status).toBe("SUPPRESSED");
      await db.participant.update({ where: { id: buyerId }, data: { emailNotifications: false } });
      const m2 = await createOutboundDraft(officer, { transactionId: txId, participantIds: [buyerId, sellerId], subject: "Hi", body: "Hello" });
      expect(m2.status).toBe("SUPPRESSED");
      expect((m2.suppressedRecipients as unknown[]).length).toBe(2);
      await db.participant.update({ where: { id: buyerId }, data: { emailNotifications: true } });
    });

    it("requires a person with send authority, and the requester cannot approve", async () => {
      const { a } = await approvedMessage("Separation");
      await expectAppError(decideApproval(assistant, a.id, "APPROVED", "self"), "FORBIDDEN");
      const self = await createOutboundDraft(officer, { transactionId: txId, participantIds: [buyerId], subject: "Self", body: "Hello" });
      const sa = await requestSendApproval(officer, self.id);
      await expectAppError(decideApproval(officer, sa.id, "APPROVED", "self"), "FORBIDDEN");
      await decideApproval(officer2, sa.id, "APPROVED", "ok");
    });

    it("a draft that was never approved is not delivered by a job", async () => {
      const m = await createOutboundDraft(officer, { transactionId: txId, participantIds: [buyerId], subject: "Unapproved", body: "Hello" });
      const res = await deliverOutbound(companyId, m.id);
      expect(res).toMatchObject({ skipped: "not approved" });
      expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("DRAFT");
    });

    it("outbound records are tenant-isolated", async () => {
      const m = await createOutboundDraft(officer, { transactionId: txId, participantIds: [buyerId], subject: "Iso", body: "Hello" });
      await expectAppError(requestSendApproval(other, m.id), "NOT_FOUND");
      await expectAppError(createOutboundDraft(other, { transactionId: txId, participantIds: [buyerId], subject: "x", body: "y" }), "NOT_FOUND");
    });
  });

  // ---- Automation ----------------------------------------------------------------

  describe("automation rules", () => {
    it("rules are off by default and running them produces nothing", async () => {
      const rules = await db.automationRule.findMany({ where: { companyId } });
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((r) => !r.enabled && r.mode === "DRAFT_FOR_REVIEW")).toBe(true);
      const before = await db.outboundMessage.count({ where: { companyId } });
      await runAutomationForCompany(companyId);
      expect(await db.outboundMessage.count({ where: { companyId } })).toBe(before);
    });

    it("AUTO_SEND requires an approved template; editing resets approval and downgrades the rule", async () => {
      const rule = await db.automationRule.findUniqueOrThrow({ where: { companyId_key: { companyId, key: "deadline-reminders" } } });
      await expectAppError(updateRule(admin, rule.id, { enabled: true, mode: "AUTO_SEND" }), "PRECONDITION_FAILED");
      await expectAppError(updateRule(officer, rule.id, { enabled: true, mode: "DRAFT_FOR_REVIEW" }), "FORBIDDEN");
      // The editor cannot approve their own template.
      await updateTemplate(admin, rule.templateId!, { subject: "Escrow {{escrowNumber}}: {{deadline}} due {{dueDate}}", body: "Hello {{recipientName}}, {{deadline}} is due {{dueDate}}." });
      await expectAppError(approveTemplate(admin, rule.templateId!), "FORBIDDEN");
      await approveTemplate(manager, rule.templateId!);
      await updateRule(admin, rule.id, { enabled: true, mode: "AUTO_SEND" });
      await updateTemplate(admin, rule.templateId!, { subject: "Changed {{escrowNumber}}", body: "Changed" });
      const after = await db.automationRule.findUniqueOrThrow({ where: { id: rule.id } });
      expect(after.mode).toBe("DRAFT_FOR_REVIEW");
      expect((await db.messageTemplate.findUniqueOrThrow({ where: { id: rule.templateId! } })).approved).toBe(false);
    });

    it("review-mode rules create drafts once per window; system actors cannot approve or send", async () => {
      const rule = await db.automationRule.findUniqueOrThrow({ where: { companyId_key: { companyId, key: "deadline-reminders" } } });
      await approveTemplate(manager, rule.templateId!);
      await updateRule(admin, rule.id, { enabled: true, mode: "DRAFT_FOR_REVIEW", daysBefore: 30 });
      await db.participant.create({ data: { companyId, transactionId: txId, role: "BUYER_AGENT", side: "BUYER", displayName: "Alex Agent", partyType: "INDIVIDUAL", email: "alex.agent@example.org" } });
      const today = new Date();
      await db.deadline.create({ data: { companyId, transactionId: txId, title: "Inspection contingency removal", dueAt: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 3)), status: "PENDING" } });
      await runAutomationForCompany(companyId);
      await runAutomationForCompany(companyId);
      const drafts = await db.outboundMessage.findMany({ where: { companyId, ruleId: rule.id } });
      expect(drafts).toHaveLength(1);
      expect(drafts[0].status).toBe("DRAFT");
      expect(drafts[0].createdByType).toBe("AUTOMATION");
      const sys = systemCtx(companyId, "automation", "JOB");
      await expectAppError(requestSendApproval(officer, drafts[0].id).then((a) => decideApproval(sys, a.id, "APPROVED", "bot")), "FORBIDDEN");
      await updateRule(admin, rule.id, { enabled: false, mode: "DRAFT_FOR_REVIEW" });
    });

    it("AUTO_SEND with an approved template still respects the sending switches", async () => {
      const rule = await db.automationRule.findUniqueOrThrow({ where: { companyId_key: { companyId, key: "document-request-reminders" } } });
      await approveTemplate(manager, rule.templateId!);
      await updateRule(admin, rule.id, { enabled: true, mode: "AUTO_SEND" });
      await db.documentRequest.create({ data: { companyId, transactionId: txId, participantId: buyerId, title: "Homeowner's insurance binder", createdById: officer.userId! } });
      await runAutomationForCompany(companyId);
      const msgs = await db.outboundMessage.findMany({ where: { companyId, ruleId: rule.id } });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].status).toBe("BLOCKED"); // server switch is off
      await updateRule(admin, rule.id, { enabled: false, mode: "DRAFT_FOR_REVIEW" });
    });

    it("overdue escalation creates internal notifications only", async () => {
      const rule = await db.automationRule.findUniqueOrThrow({ where: { companyId_key: { companyId, key: "overdue-escalation" } } });
      await expectAppError(updateRule(admin, rule.id, { enabled: true, mode: "AUTO_SEND" }), "VALIDATION");
      await updateRule(admin, rule.id, { enabled: true, mode: "DRAFT_FOR_REVIEW", daysOverdue: 1 });
      await db.task.create({ data: { companyId, transactionId: txId, title: "Order payoff demand", status: "OPEN", dueAt: new Date(Date.now() - 5 * 86_400_000), assigneeUserId: assistant.userId } });
      const before = await db.outboundMessage.count({ where: { companyId } });
      await runAutomationForCompany(companyId);
      await runAutomationForCompany(companyId);
      expect(await db.outboundMessage.count({ where: { companyId } })).toBe(before);
      const notes = await db.notification.findMany({ where: { companyId, title: { contains: "Order payoff demand" } } });
      expect(new Set(notes.map((n) => n.userId))).toEqual(new Set([assistant.userId, manager.userId, officer.userId]));
      expect(notes).toHaveLength(3);
      await updateRule(admin, rule.id, { enabled: false, mode: "DRAFT_FOR_REVIEW" });
    });
  });

  // ---- Integration modes ------------------------------------------------------------

  describe("integration modes", () => {
    it("every integration reports one of the four modes; vendor adapters cannot be set live without an implemented adapter", async () => {
      const statuses = await integrationStatuses(companyId);
      for (const s of statuses) expect(["NOT_CONFIGURED", "DEMO", "SANDBOX", "LIVE"]).toContain(s.mode);
      expect(statuses.find((s) => s.kind === "BANKING")!.mode).toBe("NOT_CONFIGURED");
      await expectAppError(setIntegrationMode(admin, "TITLE", "LIVE"), "VALIDATION");
      await expectAppError(setIntegrationMode(officer, "ESIGN", "NOT_CONFIGURED"), "FORBIDDEN");
      await setIntegrationMode(admin, "ESIGN", "NOT_CONFIGURED");
      expect(await integrationMode(companyId, "ESIGN")).toBe("NOT_CONFIGURED");
      await expectAppError(sendForSignature(officer, txId, { documentIds: ["x"], signerParticipantIds: [buyerId], subject: "s" }), "PRECONDITION_FAILED");
      await setIntegrationMode(admin, "ESIGN", "DEMO");
    });

    it("payment execution is disabled", async () => {
      await expect(disabledPayments.execute()).rejects.toThrow(/disabled/);
    });
  });
});
