import { getWorkspace, staffNames } from "../data";
import { db } from "@/server/db";
import { hasPermission } from "@/server/context";
import { listThreads } from "@/server/services/messages";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, EmptyState, Field, Input, Textarea, humanize } from "@/components/ui";
import { createThreadAction, postMessageAction } from "../actions";
import { displayDateTime } from "@/lib/dates";
import { OutboundPanel } from "./outbound";
import { DraftAssistant } from "./draft-assistant";

export default async function CommunicationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, tx } = await getWorkspace(id);
  const [threads, participants, names] = await Promise.all([
    listThreads(ctx, tx.id),
    db.participant.findMany({ where: { transactionId: tx.id }, orderBy: { createdAt: "asc" } }),
    staffNames(ctx.companyId),
  ]);
  const pName = new Map(participants.map((p) => [p.id, p.displayName]));
  const canDraft = hasPermission(ctx, "comms.draft");

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <h2 className="text-sm font-semibold text-slate-900">Secure portal messages</h2>
          {threads.length === 0 ? (
            <EmptyState title="No message threads">Start a thread with one or more participants. Participants only see threads they are members of.</EmptyState>
          ) : (
            threads.map((t) => (
              <Card
                key={t.id}
                title={t.subject}
                description={t.internalOnly ? "Internal staff thread" : `Members: ${t.members.map((m) => `${m.participant.displayName} (${humanize(m.participant.role)})`).join(", ")}`}
                actions={t.internalOnly ? <Badge>Internal</Badge> : <Badge tone="info">Portal</Badge>}
              >
                <ol className="space-y-3">
                  {t.messages.map((m) => (
                    <li key={m.id} className={`rounded-md p-3 text-sm ${m.authorParticipantId ? "bg-sky-50" : "bg-slate-50"}`}>
                      <div className="mb-1 text-xs text-slate-500">
                        {m.authorParticipantId ? pName.get(m.authorParticipantId) : names.get(m.authorUserId) ?? "Staff"} · {displayDateTime(m.createdAt)}
                      </div>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                    </li>
                  ))}
                </ol>
                {canDraft && (
                  <ActionForm action={postMessageAction.bind(null, tx.id, t.id)} submitLabel="Send" size="sm" className="mt-3">
                    <label className="sr-only" htmlFor={`reply-${t.id}`}>
                      Reply
                    </label>
                    <Textarea id={`reply-${t.id}`} name="body" rows={2} required placeholder="Write a reply…" />
                  </ActionForm>
                )}
              </Card>
            ))
          )}
        </div>
        {canDraft && (
          <Card title="New thread" description="Never send bank details or identity documents by message. Messages containing them are blocked.">
            <ActionForm action={createThreadAction.bind(null, tx.id)} submitLabel="Start thread">
              <Field label="Subject" htmlFor="th-s" required>
                <Input id="th-s" name="subject" required />
              </Field>
              <fieldset>
                <legend className="text-sm font-medium text-slate-700">Participants</legend>
                <div className="mt-1 max-h-48 space-y-1 overflow-y-auto">
                  {participants.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="participantIds" value={p.id} disabled={!p.portalAccess} />
                      {p.displayName} <span className="text-xs text-slate-500">({humanize(p.role)}{!p.portalAccess ? ", no portal access" : ""})</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="internalOnly" /> Internal staff thread
              </label>
              <Field label="Message" htmlFor="th-b" required>
                <Textarea id="th-b" name="body" rows={4} required />
              </Field>
            </ActionForm>
          </Card>
        )}
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <OutboundPanel transactionId={tx.id} />
        </div>
        {hasPermission(ctx, "ai.use") && canDraft && <DraftAssistant transactionId={tx.id} participants={participants.map((p) => ({ id: p.id, label: `${p.displayName} (${humanize(p.role)})` }))} />}
      </div>
    </div>
  );
}
