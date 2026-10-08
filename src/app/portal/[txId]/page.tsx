import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePortalCtx } from "@/server/auth/session";
import { loadTransaction, myParticipantIds } from "@/server/services/access";
import { listDocumentRequests, listDocuments } from "@/server/services/documents";
import { listThreads } from "@/server/services/messages";
import { loadDefinition, stageLabel } from "@/server/workflow/engine";
import { db } from "@/server/db";
import { isAppError } from "@/server/errors";
import { ActionForm } from "@/components/action-form";
import { Card, EmptyState, Field, Input, StatusBadge, Textarea, humanize } from "@/components/ui";
import { portalMessageAction, portalNotificationsAction, portalUploadAction } from "./actions";
import { displayDate, displayDateTime } from "@/lib/dates";

export const metadata: Metadata = { title: "Transaction" };

export default async function PortalTransactionPage({ params }: { params: Promise<{ txId: string }> }) {
  const ctx = await requirePortalCtx();
  const { txId } = await params;
  let tx;
  try {
    tx = await loadTransaction(ctx, txId);
  } catch (e) {
    if (isAppError(e)) notFound();
    throw e;
  }
  const mine = await myParticipantIds(ctx, tx.id);
  const [def, me, properties, requests, docs, threads, milestones] = await Promise.all([
    loadDefinition(tx.templateVersionId),
    db.participant.findMany({ where: { id: { in: mine } } }),
    db.property.findMany({ where: { transactionId: tx.id }, orderBy: { sortOrder: "asc" } }),
    listDocumentRequests(ctx, tx.id),
    listDocuments(ctx, tx.id),
    listThreads(ctx, tx.id),
    db.milestone.findMany({ where: { transactionId: tx.id } }),
  ]);
  const openRequests = requests.filter((r) => r.status === "OPEN");
  const stageIndex = def.stages.findIndex((s) => s.key === tx.stage);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/portal" className="text-sm text-brand-700">
          ← Your transactions
        </Link>
        <h1 className="mt-2 text-xl font-semibold">Escrow {tx.escrowNumber}</h1>
        <p className="text-sm text-slate-600">{properties.map((p) => `${p.street}, ${p.city}`).join(" · ") || humanize(tx.type)}</p>
        <p className="mt-1 text-xs text-slate-500">You are participating as {me.map((p) => humanize(p.role)).join(", ")}.</p>
      </div>

      <Card title="Status">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge status={tx.status} />
          <span>
            Step {stageIndex + 1} of {def.stages.length}: <strong>{stageLabel(def, tx.stage)}</strong>
          </span>
        </div>
        <div className="mt-2 h-2 w-full rounded bg-slate-100" aria-hidden>
          <div className="h-2 rounded bg-brand-600" style={{ width: `${Math.round(((stageIndex + 1) / def.stages.length) * 100)}%` }} />
        </div>
        {tx.proposedClosingDate && <p className="mt-2 text-sm text-slate-600">Estimated closing date: {displayDate(tx.proposedClosingDate)} (subject to change)</p>}
        <ul className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          {milestones.map((m) => (
            <li key={m.id} className="rounded bg-slate-50 p-2">
              <div className="text-slate-500">{humanize(m.kind)}</div>
              <StatusBadge status={m.status} />
            </li>
          ))}
        </ul>
      </Card>

      <Card title={`Requested from you${openRequests.length ? ` (${openRequests.length})` : ""}`}>
        {requests.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing has been requested from you.</p>
        ) : (
          <ul className="space-y-4">
            {requests.map((r) => (
              <li key={r.id} className="rounded-md border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{r.title}</span>
                  <StatusBadge status={r.status} />
                </div>
                {r.description && <p className="mt-1 text-sm text-slate-600">{r.description}</p>}
                {r.dueAt && <p className="text-xs text-slate-500">Due {displayDate(r.dueAt)}</p>}
                {r.status === "OPEN" && (
                  <ActionForm action={portalUploadAction.bind(null, tx.id)} submitLabel="Upload" size="sm" className="mt-2" pendingLabel="Uploading…">
                    <input type="hidden" name="requestId" value={r.id} />
                    <label className="block text-sm">
                      <span className="sr-only">File for {r.title}</span>
                      <input type="file" name="file" required accept="application/pdf,image/png,image/jpeg,image/tiff,image/webp" className="block w-full text-sm" />
                    </label>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Documents shared with you">
        {docs.length === 0 ? (
          <EmptyState title="No documents shared yet" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {docs.map((d) => {
              const v = d.versions.find((x) => x.id === d.currentVersionId);
              return (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    {d.title}
                    {d.uploadedByParticipantId && <span className="ml-1 text-xs text-slate-500">(uploaded by you)</span>}
                  </span>
                  {v && (
                    <a href={`/api/documents/versions/${v.id}/download`} className="font-medium text-brand-700 hover:underline">
                      Download
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Messages">
        {threads.length === 0 ? (
          <p className="text-sm text-slate-500">No messages yet. Your escrow team will start a conversation here when needed.</p>
        ) : (
          <div className="space-y-5">
            {threads.map((t) => (
              <div key={t.id}>
                <h3 className="text-sm font-semibold">{t.subject}</h3>
                <ol className="mt-2 space-y-2">
                  {t.messages.map((m) => (
                    <li key={m.id} className={`rounded-md p-2 text-sm ${m.authorParticipantId && mine.includes(m.authorParticipantId) ? "ml-6 bg-brand-50" : "mr-6 bg-slate-50"}`}>
                      <div className="text-xs text-slate-500">{m.authorParticipantId && mine.includes(m.authorParticipantId) ? "You" : m.authorParticipantId ? "Participant" : "Escrow team"} · {displayDateTime(m.createdAt)}</div>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                    </li>
                  ))}
                </ol>
                <ActionForm action={portalMessageAction.bind(null, tx.id, t.id)} submitLabel="Send reply" size="sm" className="mt-2">
                  <label className="sr-only" htmlFor={`r-${t.id}`}>
                    Reply
                  </label>
                  <Textarea id={`r-${t.id}`} name="body" rows={2} required placeholder="Do not include bank account numbers or ID numbers." />
                </ActionForm>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Upload something else">
        <ActionForm action={portalUploadAction.bind(null, tx.id)} submitLabel="Upload" size="sm" pendingLabel="Uploading…">
          <Field label="Description" htmlFor="up-title">
            <Input id="up-title" name="title" />
          </Field>
          <input type="file" name="file" required aria-label="File" accept="application/pdf,image/png,image/jpeg,image/tiff,image/webp" className="block w-full text-sm" />
        </ActionForm>
        <p className="mt-2 text-xs text-slate-500">Only your escrow team (and you) can see files you upload unless they choose to share them.</p>
      </Card>

      {me.map((p) => (
        <Card key={p.id} title="Notification preferences">
          <p className="text-sm text-slate-600">Email notifications are {p.emailNotifications ? "on" : "off"}. Portal messages are always available here.</p>
          <ActionForm action={portalNotificationsAction.bind(null, tx.id, p.id)} submitLabel={p.emailNotifications ? "Turn off email notifications" : "Turn on email notifications"} size="sm" variant="secondary" className="mt-2">
            <input type="hidden" name="enabled" value={p.emailNotifications ? "false" : "true"} />
          </ActionForm>
        </Card>
      ))}
    </div>
  );
}
