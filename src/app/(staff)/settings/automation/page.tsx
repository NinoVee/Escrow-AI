import type { Metadata } from "next";
import { requireStaffCtx } from "@/server/auth/session";
import { hasPermission, requirePermission } from "@/server/context";
import { listAutomation } from "@/server/services/automation";
import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, Field, Input, Select, Textarea, humanize } from "@/components/ui";
import { displayDateTime } from "@/lib/dates";
import { ruleAction, templateApproveAction, templateEditAction } from "../ops-actions";

export const metadata: Metadata = { title: "Automation" };

export default async function AutomationPage() {
  const ctx = await requireStaffCtx();
  requirePermission(ctx, "automation.manage");
  const { rules, templates } = await listAutomation(ctx);
  const tplById = new Map(templates.map((t) => [t.id, t]));
  const canApprove = hasPermission(ctx, "comms.approve_send");
  return (
    <div className="space-y-6">
      <Alert tone="info" title="How automation works">
        Rules are deterministic and off by default. &ldquo;Drafts for review&rdquo; creates emails that a person with send authority must approve. &ldquo;Send automatically&rdquo; needs an approved template, and every email still passes the sensitive-content check and both external-sending switches. Escalations are internal notifications only. The AI assistant cannot enable rules or send.
      </Alert>
      <Card title="Rules">
        <ul className="divide-y divide-slate-100">
          {rules.map((r) => {
            const tpl = r.templateId ? tplById.get(r.templateId) : undefined;
            const cfg = r.config as { daysBefore?: number; daysOverdue?: number };
            return (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  {r.enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Off</Badge>}
                  {r.enabled && <Badge tone={r.mode === "AUTO_SEND" ? "warning" : "info"}>{r.mode === "AUTO_SEND" ? "Sends automatically" : "Drafts for review"}</Badge>}
                </div>
                <p className="text-xs text-slate-500">
                  {humanize(r.type)}
                  {tpl ? ` · template "${tpl.name}" ${tpl.approved ? "(approved)" : "(not approved)"}` : " · internal notification"}
                </p>
                <ActionForm action={ruleAction.bind(null, r.id)} submitLabel="Save rule" size="sm" variant="secondary" inline resetOnSuccess={false} className="mt-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="enabled" defaultChecked={r.enabled} /> Enabled
                  </label>
                  {r.type !== "OVERDUE_ESCALATION" && (
                    <label className="text-sm">
                      <span className="sr-only">Mode</span>
                      <Select name="mode" defaultValue={r.mode}>
                        <option value="DRAFT_FOR_REVIEW">Drafts for review</option>
                        <option value="AUTO_SEND" disabled={!tpl?.approved}>
                          Send automatically{!tpl?.approved ? " (needs approved template)" : ""}
                        </option>
                      </Select>
                    </label>
                  )}
                  {r.type === "DEADLINE_REMINDER" && (
                    <label className="text-sm">
                      Days before <Input name="daysBefore" type="number" min={0} max={30} defaultValue={cfg.daysBefore ?? 3} className="w-20" />
                    </label>
                  )}
                  {r.type === "OVERDUE_ESCALATION" && (
                    <label className="text-sm">
                      Days overdue <Input name="daysOverdue" type="number" min={0} max={60} defaultValue={cfg.daysOverdue ?? 1} className="w-20" />
                    </label>
                  )}
                </ActionForm>
              </li>
            );
          })}
        </ul>
      </Card>
      <Card title="Message templates" description="Placeholders: {{recipientName}}, {{escrowNumber}}, {{property}}, {{stage}}, {{closingDate}}, {{deadline}}, {{dueDate}}, {{items}}, {{document}}. Editing a template resets its approval.">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {templates.map((t) => (
            <div key={t.id} className="rounded-md border border-slate-200 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-medium">{t.name}</span>
                <Badge>v{t.version}</Badge>
                {t.approved ? <Badge tone="success">Approved {t.approvedAt ? displayDateTime(t.approvedAt) : ""}</Badge> : <Badge tone="warning">Not approved</Badge>}
              </div>
              <ActionForm action={templateEditAction.bind(null, t.id)} submitLabel="Save template" size="sm" variant="secondary" resetOnSuccess={false}>
                <Field label="Subject" htmlFor={`ts-${t.id}`}>
                  <Input id={`ts-${t.id}`} name="subject" defaultValue={t.subject} required />
                </Field>
                <Field label="Body" htmlFor={`tb-${t.id}`}>
                  <Textarea id={`tb-${t.id}`} name="body" rows={5} defaultValue={t.body} required />
                </Field>
              </ActionForm>
              {canApprove && !t.approved && <ActionForm action={templateApproveAction.bind(null, t.id)} submitLabel="Approve template" size="sm" className="mt-2" inline />}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
