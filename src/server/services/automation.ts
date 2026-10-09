import { z } from "zod";
import { db, type Tx } from "../db";
import { requirePermission, requireUser, systemCtx, type Ctx } from "../context";
import { forbidden, invalid, notFound, precondition } from "../errors";
import { audit } from "../audit";
import { getCompanySettings } from "../settings";
import { createOutboundDraft, queueSend } from "./outbound";
import { loadDefinition, stageLabel } from "../workflow/engine";
import { addDays, displayDate, todayInZone } from "@/lib/dates";

/**
 * Deterministic communication rules. All rules are OFF by default. A rule in
 * DRAFT_FOR_REVIEW mode creates drafts that need approval; AUTO_SEND requires
 * an approved template and still passes every send-time gate (including the
 * server and company external-sending switches).
 */

export const RULE_TYPES = ["DEADLINE_REMINDER", "OVERDUE_ESCALATION", "DOCUMENT_REQUEST", "STATUS_UPDATE", "READY_NOTIFICATION"] as const;
export type RuleType = (typeof RULE_TYPES)[number];

const RuleConfigSchema = z.object({
  daysBefore: z.number().int().min(0).max(30).default(3),
  daysOverdue: z.number().int().min(0).max(60).default(1),
  audienceRoles: z.array(z.string()).default(["BUYER_AGENT", "LISTING_AGENT"]),
});

const DEFAULT_TEMPLATES = [
  { key: "deadline-reminder", name: "Deadline reminder", kind: "DEADLINE_REMINDER", subject: "Escrow {{escrowNumber}}: {{deadline}} due {{dueDate}}", body: "Hello {{recipientName}},\n\nThis is a reminder that \"{{deadline}}\" for escrow {{escrowNumber}} ({{property}}) is due {{dueDate}}. Please contact your escrow officer with any questions." },
  { key: "document-request", name: "Document request reminder", kind: "DOCUMENT_REQUEST", subject: "Escrow {{escrowNumber}}: document needed", body: "Hello {{recipientName}},\n\nWe still need the following for escrow {{escrowNumber}}: {{items}}. Please upload it through your secure portal{{dueText}}." },
  { key: "status-update", name: "Weekly status update", kind: "STATUS_UPDATE", subject: "Escrow {{escrowNumber}}: weekly status", body: "Hello {{recipientName}},\n\nEscrow {{escrowNumber}} ({{property}}) is in the \"{{stage}}\" stage. Estimated closing: {{closingDate}} (subject to change). Your portal shows current requests and documents." },
  { key: "ready-notification", name: "Document ready", kind: "READY_NOTIFICATION", subject: "Escrow {{escrowNumber}}: a document is ready", body: "Hello {{recipientName}},\n\nA document (\"{{document}}\") has been shared with you in your secure portal for escrow {{escrowNumber}}." },
];

const DEFAULT_RULES: { key: string; name: string; type: RuleType; template?: string }[] = [
  { key: "deadline-reminders", name: "Remind agents of upcoming deadlines", type: "DEADLINE_REMINDER", template: "deadline-reminder" },
  { key: "overdue-escalation", name: "Escalate overdue tasks to officer and managers (internal)", type: "OVERDUE_ESCALATION" },
  { key: "document-request-reminders", name: "Remind participants of open document requests", type: "DOCUMENT_REQUEST", template: "document-request" },
  { key: "weekly-status", name: "Weekly status update to buyer and seller", type: "STATUS_UPDATE", template: "status-update" },
  { key: "document-ready", name: "Notify participants when a document is shared", type: "READY_NOTIFICATION", template: "ready-notification" },
];

export async function installDefaultAutomation(client: Tx, companyId: string) {
  for (const t of DEFAULT_TEMPLATES) {
    await client.messageTemplate.upsert({ where: { companyId_key: { companyId, key: t.key } }, create: { companyId, ...t }, update: {} });
  }
  for (const r of DEFAULT_RULES) {
    const tpl = r.template ? await client.messageTemplate.findUnique({ where: { companyId_key: { companyId, key: r.template } } }) : null;
    await client.automationRule.upsert({ where: { companyId_key: { companyId, key: r.key } }, create: { companyId, key: r.key, name: r.name, type: r.type, templateId: tpl?.id ?? null, enabled: false, config: RuleConfigSchema.parse({}) }, update: {} });
  }
}

export function render(text: string, vars: Record<string, string>) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}

// ---- Administration ---------------------------------------------------------

export async function listAutomation(ctx: Ctx) {
  requirePermission(ctx, "comms.draft");
  const [rules, templates] = await Promise.all([
    db.automationRule.findMany({ where: { companyId: ctx.companyId }, orderBy: { name: "asc" } }),
    db.messageTemplate.findMany({ where: { companyId: ctx.companyId }, orderBy: { name: "asc" } }),
  ]);
  return { rules, templates };
}

export async function updateTemplate(ctx: Ctx, templateId: string, input: { subject: string; body: string }) {
  requirePermission(ctx, "automation.manage");
  const userId = requireUser(ctx);
  const t = await db.messageTemplate.findFirst({ where: { id: templateId, companyId: ctx.companyId } });
  if (!t) throw notFound("Template");
  if (!input.subject?.trim() || !input.body?.trim()) throw invalid("Subject and body are required.");
  await db.$transaction(async (client) => {
    await client.messageTemplate.update({ where: { id: t.id }, data: { subject: input.subject.trim(), body: input.body.trim(), approved: false, approvedById: null, approvedAt: null, version: { increment: 1 }, updatedById: userId } });
    // An edited template can no longer drive automatic sends until re-approved.
    await client.automationRule.updateMany({ where: { companyId: ctx.companyId, templateId: t.id, mode: "AUTO_SEND" }, data: { mode: "DRAFT_FOR_REVIEW" } });
    await audit(ctx, { action: "template.edited", entityType: "MessageTemplate", entityId: t.id, entityVersion: t.version + 1, summary: `Template "${t.name}" edited; approval reset` }, client);
  });
}

export async function approveTemplate(ctx: Ctx, templateId: string) {
  requirePermission(ctx, "comms.approve_send");
  const userId = requireUser(ctx);
  const t = await db.messageTemplate.findFirst({ where: { id: templateId, companyId: ctx.companyId } });
  if (!t) throw notFound("Template");
  if (t.updatedById && t.updatedById === userId) throw forbidden("Separation of duties: the person who edited a template cannot approve it.");
  await db.$transaction(async (client) => {
    await client.messageTemplate.update({ where: { id: t.id }, data: { approved: true, approvedById: userId, approvedAt: new Date() } });
    await audit(ctx, { action: "template.approved", entityType: "MessageTemplate", entityId: t.id, entityVersion: t.version, summary: `Template "${t.name}" v${t.version} approved for use` }, client);
  });
}

export async function updateRule(ctx: Ctx, ruleId: string, input: { enabled: boolean; mode: "DRAFT_FOR_REVIEW" | "AUTO_SEND"; daysBefore?: number; daysOverdue?: number }) {
  requirePermission(ctx, "automation.manage");
  const userId = requireUser(ctx);
  const r = await db.automationRule.findFirst({ where: { id: ruleId, companyId: ctx.companyId } });
  if (!r) throw notFound("Rule");
  if (input.mode === "AUTO_SEND") {
    if (r.type === "OVERDUE_ESCALATION") throw invalid("Escalations are internal notifications only.");
    const tpl = r.templateId ? await db.messageTemplate.findUnique({ where: { id: r.templateId } }) : null;
    if (!tpl?.approved) throw precondition("Automatic sending requires an approved template.");
  }
  const config = RuleConfigSchema.parse({ ...(r.config as object), ...(input.daysBefore !== undefined ? { daysBefore: input.daysBefore } : {}), ...(input.daysOverdue !== undefined ? { daysOverdue: input.daysOverdue } : {}) });
  await db.$transaction(async (client) => {
    await client.automationRule.update({ where: { id: r.id }, data: { enabled: input.enabled, mode: input.mode, config, updatedById: userId } });
    await audit(ctx, { action: "automation.rule_updated", entityType: "AutomationRule", entityId: r.id, summary: `Rule "${r.name}" ${input.enabled ? "enabled" : "disabled"} (${input.mode === "AUTO_SEND" ? "automatic sending" : "drafts for review"})`, details: config }, client);
  });
}

// ---- Execution (background job) -------------------------------------------------

/** Evaluates every enabled rule for one company. Idempotent per rule/target/window. */
export async function runAutomationForCompany(companyId: string, now = new Date()) {
  const settings = await getCompanySettings(companyId);
  const ctx = systemCtx(companyId, "automation", "JOB");
  const today = todayInZone(settings.timezone, now);
  const rules = await db.automationRule.findMany({ where: { companyId, enabled: true } });
  const summary: Record<string, number> = {};
  for (const rule of rules) {
    const cfg = RuleConfigSchema.parse(rule.config ?? {});
    const tpl = rule.templateId ? await db.messageTemplate.findUnique({ where: { id: rule.templateId } }) : null;
    const auto = rule.mode === "AUTO_SEND" && Boolean(tpl?.approved);
    let count = 0;

    const emit = async (transactionId: string, participantIds: string[], vars: Record<string, string>, key: string) => {
      if (!tpl || participantIds.length === 0) return;
      const exists = await db.outboundMessage.findUnique({ where: { companyId_idempotencyKey: { companyId, idempotencyKey: key } } });
      if (exists) return;
      const msg = await createOutboundDraft(ctx, { transactionId, participantIds, subject: render(tpl.subject, vars), body: render(tpl.body, vars), templateId: tpl.id, ruleId: rule.id, createdByType: "AUTOMATION", idempotencyKey: key });
      count++;
      if (auto && msg.status === "DRAFT") {
        await db.outboundMessage.update({ where: { id: msg.id }, data: { status: "APPROVED" } });
        await audit(ctx, { action: "outbound.auto_approved_by_rule", entityType: "OutboundMessage", entityId: msg.id, transactionId, summary: `Approved by enabled rule "${rule.name}" using approved template v${tpl.version}` });
        await queueSend(companyId, msg.id);
      }
    };

    const txVars = async (txId: string) => {
      const tx = await db.transaction.findUniqueOrThrow({ where: { id: txId }, include: { properties: { take: 1 } } });
      const def = await loadDefinition(tx.templateVersionId);
      return { tx, vars: { escrowNumber: tx.escrowNumber, property: tx.properties[0] ? `${tx.properties[0].street}, ${tx.properties[0].city}` : "the property", stage: stageLabel(def, tx.stage), closingDate: tx.proposedClosingDate ? displayDate(tx.proposedClosingDate) : "to be determined" } };
    };

    if (rule.type === "DEADLINE_REMINDER") {
      const deadlines = await db.deadline.findMany({ where: { companyId, status: "PENDING", dueAt: { gte: today, lte: addDays(today, cfg.daysBefore) }, transaction: { status: "ACTIVE" } } });
      for (const d of deadlines) {
        const { vars } = await txVars(d.transactionId);
        const audience = await db.participant.findMany({ where: { transactionId: d.transactionId, role: { in: cfg.audienceRoles as never[] } } });
        for (const p of audience) await emit(d.transactionId, [p.id], { ...vars, recipientName: p.displayName, deadline: d.title, dueDate: displayDate(d.dueAt) }, `rule:${rule.id}:deadline:${d.id}:${d.dueAt.toISOString().slice(0, 10)}:${p.id}`);
      }
    } else if (rule.type === "DOCUMENT_REQUEST") {
      const window = Math.floor(today.getTime() / (3 * 86_400_000)); // at most one reminder per request every 3 days
      const requests = await db.documentRequest.findMany({ where: { companyId, status: "OPEN", transaction: { status: "ACTIVE" } } });
      for (const r of requests) {
        const { vars } = await txVars(r.transactionId);
        const p = await db.participant.findUnique({ where: { id: r.participantId } });
        if (!p) continue;
        await emit(r.transactionId, [p.id], { ...vars, recipientName: p.displayName, items: r.title, dueText: r.dueAt ? ` by ${displayDate(r.dueAt)}` : "" }, `rule:${rule.id}:request:${r.id}:${window}`);
      }
    } else if (rule.type === "STATUS_UPDATE") {
      const week = Math.floor(today.getTime() / (7 * 86_400_000));
      const txs = await db.transaction.findMany({ where: { companyId, status: "ACTIVE" }, select: { id: true } });
      for (const t of txs) {
        const { vars } = await txVars(t.id);
        const principals = await db.participant.findMany({ where: { transactionId: t.id, role: { in: ["BUYER", "SELLER"] }, portalAccess: true } });
        for (const p of principals) await emit(t.id, [p.id], { ...vars, recipientName: p.displayName }, `rule:${rule.id}:status:${t.id}:${week}:${p.id}`);
      }
    } else if (rule.type === "READY_NOTIFICATION") {
      const shares = await db.documentShare.findMany({ where: { companyId, revokedAt: null, createdAt: { gte: addDays(today, -2) } }, include: { document: true } });
      for (const s of shares) {
        const { vars } = await txVars(s.document.transactionId);
        const p = await db.participant.findUnique({ where: { id: s.participantId } });
        if (!p) continue;
        await emit(s.document.transactionId, [p.id], { ...vars, recipientName: p.displayName, document: s.document.title }, `rule:${rule.id}:share:${s.id}`);
      }
    } else if (rule.type === "OVERDUE_ESCALATION") {
      const tasks = await db.task.findMany({ where: { companyId, status: { in: ["OPEN", "IN_PROGRESS", "WAITING"] }, dueAt: { lt: addDays(today, -cfg.daysOverdue) }, transaction: { status: "ACTIVE" } }, include: { transaction: { select: { escrowNumber: true, officerId: true } } } });
      const managers = await db.membership.findMany({ where: { companyId, role: "MANAGER", status: "ACTIVE" } });
      for (const t of tasks) {
        const recipients = [...new Set([t.assigneeUserId, t.transaction.officerId, ...managers.map((m) => m.userId)].filter(Boolean) as string[])];
        for (const userId of recipients) {
          const link = `/transactions/${t.transactionId}/tasks`;
          const title = `Overdue: ${t.title} (${t.transaction.escrowNumber})`;
          const dup = await db.notification.findFirst({ where: { companyId, userId, title, createdAt: { gte: today } } });
          if (dup) continue;
          await db.notification.create({ data: { companyId, userId, title, body: `Due ${displayDate(t.dueAt)}`, link } });
          count++;
        }
      }
    }
    summary[rule.key] = count;
  }
  return summary;
}
