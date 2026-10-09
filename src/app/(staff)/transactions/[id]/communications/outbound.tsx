import { db } from "@/server/db";
import { getCtx } from "@/server/auth/session";
import { hasPermission } from "@/server/context";
import { env } from "@/server/env";
import { getCompanySettings } from "@/server/settings";
import { listOutbound } from "@/server/services/outbound";
import { integrationMode } from "@/server/integrations/registry";
import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, EmptyState, Field, Input, ModeBadge, StatusBadge, Textarea, humanize } from "@/components/ui";
import { displayDateTime } from "@/lib/dates";
import { isDelivering } from "@/server/services/operations";
import { AutoRefresh } from "@/components/auto-refresh";
import { cancelOutboundAction, outboundDraftAction, requestOutboundApprovalAction } from "../integration-actions";

/** Email drafts, approval-gated sending, and automation output. */
export async function OutboundPanel({ transactionId }: { transactionId: string }) {
  const ctx = (await getCtx())!;
  if (!hasPermission(ctx, "comms.draft")) return null;
  const [messages, participants, settings, mode] = await Promise.all([
    listOutbound(ctx, transactionId),
    db.participant.findMany({ where: { transactionId, companyId: ctx.companyId }, orderBy: { createdAt: "asc" } }),
    getCompanySettings(ctx.companyId),
    integrationMode(ctx.companyId, "EMAIL"),
  ]);
  const delivering = isDelivering(messages);
  const sendingOn = env().EXTERNAL_SEND_ENABLED === "true" && settings.externalSendingEnabled;
  return (
    <Card title="Email" actions={<ModeBadge mode={mode} />} description="Every email needs approval by a person with send authority (or an enabled rule with an approved template).">
      <AutoRefresh active={delivering} />
      {!sendingOn ? (
        <Alert tone="warning" title="External sending is off">
          Approved emails are recorded as blocked and nothing leaves the system. Sending needs both the server switch and the company setting.
        </Alert>
      ) : mode === "DEMO" ? (
        <Alert tone="demo">Demo outbox: approved emails are captured here and never delivered.</Alert>
      ) : null}
      {messages.length === 0 ? (
        <div className="my-3">
          <EmptyState title="No emails">Drafts you write here, and drafts produced by automation rules, appear in this list.</EmptyState>
        </div>
      ) : (
        <ul className="my-3 space-y-2">
          {messages.map((m) => (
            <li key={m.id} className="rounded-md border border-slate-200 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.subject}</span>
                <StatusBadge status={m.status} label={m.status === "CAPTURED_DEMO" ? "Captured (demo)" : undefined} />
                {m.createdByType !== "USER" && <Badge tone="info">{humanize(m.createdByType)}</Badge>}
              </div>
              <div className="text-xs text-slate-500">
                To {(m.recipientEmails as string[]).join(", ") || "nobody"} · {displayDateTime(m.createdAt)}
                {m.sentAt && ` · sent ${displayDateTime(m.sentAt)}`}
              </div>
              {m.blockedReason && <p className="mt-1 text-xs text-red-700">{m.blockedReason}</p>}
              {Array.isArray(m.suppressedRecipients) && m.suppressedRecipients.length > 0 && (
                <p className="mt-1 text-xs text-amber-700">Not sent to: {(m.suppressedRecipients as { name: string; reason: string }[]).map((s) => `${s.name} (${s.reason})`).join("; ")}</p>
              )}
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-brand-700">Preview</summary>
                <pre className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2 font-sans text-xs">{m.body}</pre>
              </details>
              <div className="mt-2 flex flex-wrap gap-2">
                {m.status === "DRAFT" && <ActionForm action={requestOutboundApprovalAction.bind(null, transactionId, m.id)} submitLabel="Request approval to send" size="sm" inline />}
                {["DRAFT", "PENDING_APPROVAL", "APPROVED", "BLOCKED", "SUPPRESSED"].includes(m.status) && <ActionForm action={cancelOutboundAction.bind(null, transactionId, m.id)} submitLabel="Cancel" size="sm" variant="ghost" inline />}
              </div>
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer text-sm text-brand-700">Compose email</summary>
        <ActionForm action={outboundDraftAction.bind(null, transactionId)} submitLabel="Save draft" size="sm" className="mt-2">
          <fieldset className="text-sm">
            <legend className="font-medium text-slate-700">Recipients</legend>
            {participants.map((p) => (
              <label key={p.id} className="flex items-center gap-2">
                <input type="checkbox" name="participantIds" value={p.id} />
                {p.displayName} <span className="text-xs text-slate-500">({humanize(p.role)}{!p.email ? ", no email" : !p.emailNotifications ? ", email off" : ""})</span>
              </label>
            ))}
          </fieldset>
          <Field label="Subject" htmlFor="ob-subj" required>
            <Input id="ob-subj" name="subject" required />
          </Field>
          <Field label="Message" htmlFor="ob-body" required hint="Never include bank details or identity numbers. Messages containing them are blocked.">
            <Textarea id="ob-body" name="body" rows={5} required />
          </Field>
        </ActionForm>
      </details>
    </Card>
  );
}
