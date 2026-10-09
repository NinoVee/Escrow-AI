import { db } from "@/server/db";
import { getCtx } from "@/server/auth/session";
import { hasPermission } from "@/server/context";
import { integrationStatuses } from "@/server/integrations/registry";
import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, Field, Input, ModeBadge, StatusBadge } from "@/components/ui";
import { displayDateTime } from "@/lib/dates";
import { pendingProviderEvents } from "@/server/services/operations";
import { AutoRefresh } from "@/components/auto-refresh";
import { esignAction, providerReportAction, providerTitleOrderAction, recordingAction, simulateEventAction } from "../integration-actions";

/** Provider-backed title orders, e-signature and e-recording (demo adapters unless configured). */
export async function ProviderPanels({ transactionId }: { transactionId: string }) {
  const ctx = (await getCtx())!;
  const [statuses, orders, envelopes, recordings, docs, participants] = await Promise.all([
    integrationStatuses(ctx.companyId),
    db.titleOrder.findMany({ where: { transactionId, companyId: ctx.companyId, externalRef: { not: null }, provider: { endsWith: "-demo" } }, orderBy: { orderedAt: "desc" } }),
    db.signatureEnvelope.findMany({ where: { transactionId, companyId: ctx.companyId }, orderBy: { createdAt: "desc" } }),
    db.recordingSubmission.findMany({ where: { transactionId, companyId: ctx.companyId }, orderBy: { createdAt: "desc" } }),
    db.document.findMany({ where: { transactionId, companyId: ctx.companyId, archivedAt: null, currentVersionId: { not: null } }, select: { id: true, title: true }, orderBy: { createdAt: "desc" } }),
    db.participant.findMany({ where: { transactionId, companyId: ctx.companyId }, select: { id: true, displayName: true, role: true } }),
  ]);
  const mode = (k: string) => statuses.find((s) => s.kind === k)!.mode;
  const canTitle = hasPermission(ctx, "title.manage");
  const canSign = hasPermission(ctx, "comms.draft");
  const canSim = hasPermission(ctx, "transaction.update");
  const docName = new Map(docs.map((d) => [d.id, d.title]));
  const refs = [...orders.map((o) => o.externalRef!), ...envelopes.map((e) => e.externalId), ...recordings.map((r) => r.externalId)];
  const pendingEvents = await pendingProviderEvents(refs);

  return (
    <div className="space-y-6">
      <AutoRefresh active={pendingEvents > 0} />
      {pendingEvents > 0 && <Alert tone="info">Processing {pendingEvents} provider event(s)… this section updates automatically.</Alert>}
      <Card title="Provider title order" actions={<ModeBadge mode={mode("TITLE")} />} description="Status arrives by signed webhook. A simulated report is not a title report or commitment.">
        {orders.length === 0 ? <p className="text-sm text-slate-500">No provider orders.</p> : (
          <ul className="space-y-2 text-sm">
            {orders.map((o) => (
              <li key={o.id} className="rounded-md border border-slate-200 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{o.externalRef}</span> <StatusBadge status={o.status} /> <ModeBadge mode={o.mode} />
                </div>
                <div className="text-xs text-slate-500">Last status {o.lastStatusAt ? displayDateTime(o.lastStatusAt) : "—"}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {canTitle && !o.reportDocumentId && <ActionForm action={providerReportAction.bind(null, transactionId, o.id)} submitLabel="Retrieve report" size="sm" variant="secondary" inline />}
                  {canSim && o.mode !== "LIVE" && o.status === "SUBMITTED" && <ActionForm action={simulateEventAction.bind(null, transactionId, "TITLE", o.id)} submitLabel="Simulate status event" size="sm" variant="ghost" inline />}
                </div>
              </li>
            ))}
          </ul>
        )}
        {canTitle && mode("TITLE") !== "NOT_CONFIGURED" && <ActionForm action={providerTitleOrderAction.bind(null, transactionId)} submitLabel="Submit provider order" size="sm" className="mt-3" />}
      </Card>

      <Card title="E-signature" actions={<ModeBadge mode={mode("ESIGN")} />}>
        {mode("ESIGN") === "DEMO" && <Alert tone="demo">A simulated signature is not a legally completed e-signature.</Alert>}
        <ul className="my-2 space-y-2 text-sm">
          {envelopes.map((e) => (
            <li key={e.id} className="rounded-md border border-slate-200 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{e.subject}</span> <StatusBadge status={e.status} /> {e.isSimulated && <Badge tone="purple">Simulated</Badge>}
              </div>
              <div className="text-xs text-slate-500">
                {e.externalId} · signers: {(e.signerNames as string[]).join(", ")} · {(e.documentIds as string[]).map((d) => docName.get(d) ?? "document").join(", ")}
              </div>
              {canSim && e.isSimulated && !["COMPLETED", "DECLINED", "VOIDED"].includes(e.status) && <ActionForm action={simulateEventAction.bind(null, transactionId, "ENVELOPE", e.id)} submitLabel="Simulate next event" size="sm" variant="ghost" inline className="mt-1" />}
            </li>
          ))}
        </ul>
        {canSign && mode("ESIGN") !== "NOT_CONFIGURED" && docs.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm text-brand-700">New envelope</summary>
            <ActionForm action={esignAction.bind(null, transactionId)} submitLabel="Create envelope" size="sm" className="mt-2">
              <Field label="Subject" htmlFor="env-subj">
                <Input id="env-subj" name="subject" defaultValue="Documents for signature" />
              </Field>
              <fieldset className="text-sm">
                <legend className="font-medium text-slate-700">Documents</legend>
                {docs.slice(0, 15).map((d) => <label key={d.id} className="flex gap-2"><input type="checkbox" name="documentIds" value={d.id} /> {d.title}</label>)}
              </fieldset>
              <fieldset className="text-sm">
                <legend className="font-medium text-slate-700">Signers</legend>
                {participants.map((p) => <label key={p.id} className="flex gap-2"><input type="checkbox" name="signerIds" value={p.id} /> {p.displayName}</label>)}
              </fieldset>
            </ActionForm>
          </details>
        )}
      </Card>

      <Card title="E-recording" actions={<ModeBadge mode={mode("RECORDING")} />}>
        {mode("RECORDING") === "DEMO" && <Alert tone="demo">A simulated recording response is not proof of recording.</Alert>}
        <ul className="my-2 space-y-2 text-sm">
          {recordings.map((r) => (
            <li key={r.id} className="rounded-md border border-slate-200 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{r.externalId}</span> <StatusBadge status={r.status} /> {r.isSimulated && <Badge tone="purple">Simulated</Badge>}
              </div>
              {r.instrumentNumber && <div className="text-xs text-slate-500">Reported instrument {r.instrumentNumber} (confirm against the recorded document)</div>}
              {canSim && r.isSimulated && !["RECORDED", "REJECTED"].includes(r.status) && <ActionForm action={simulateEventAction.bind(null, transactionId, "RECORDING", r.id)} submitLabel="Simulate next event" size="sm" variant="ghost" inline className="mt-1" />}
            </li>
          ))}
        </ul>
        {canTitle && mode("RECORDING") !== "NOT_CONFIGURED" && docs.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm text-brand-700">Submit for recording</summary>
            <ActionForm action={recordingAction.bind(null, transactionId)} submitLabel="Submit" size="sm" className="mt-2" confirm="Submit the selected documents for (simulated) recording?">
              <fieldset className="text-sm">
                <legend className="font-medium text-slate-700">Documents</legend>
                {docs.slice(0, 15).map((d) => <label key={d.id} className="flex gap-2"><input type="checkbox" name="documentIds" value={d.id} /> {d.title}</label>)}
              </fieldset>
            </ActionForm>
          </details>
        )}
      </Card>
    </div>
  );
}
