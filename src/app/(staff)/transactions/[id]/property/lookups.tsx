import { db } from "@/server/db";
import { getCtx } from "@/server/auth/session";
import { hasPermission } from "@/server/context";
import { integrationStatuses } from "@/server/integrations/registry";
import { ActionForm } from "@/components/action-form";
import { Alert, Card, EmptyState, ModeBadge, humanize } from "@/components/ui";
import { displayDateTime } from "@/lib/dates";
import { lookupAction } from "../integration-actions";

/** Property-data and recorded-document lookups. Informational only; never proof of title. */
export async function PropertyLookups({ transactionId }: { transactionId: string }) {
  const ctx = (await getCtx())!;
  const [lookups, statuses] = await Promise.all([
    db.propertyLookup.findMany({ where: { transactionId, companyId: ctx.companyId }, orderBy: { retrievedAt: "desc" }, take: 10 }),
    integrationStatuses(ctx.companyId),
  ]);
  const prop = statuses.find((s) => s.kind === "PROPERTY_DATA")!;
  const rec = statuses.find((s) => s.kind === "RECORDED_DOCUMENTS")!;
  const canRun = hasPermission(ctx, "title.manage");
  return (
    <Card
      title="Property data and recorded documents"
      description="Lookups help preparation. They are not a title search and do not establish ownership, liens or insurability."
      actions={
        <span className="flex gap-1">
          <ModeBadge mode={prop.mode} />
        </span>
      }
    >
      {prop.mode === "DEMO" && <Alert tone="demo">Demo provider: results are simulated with fictional owners.</Alert>}
      {canRun && (
        <div className="my-3 flex flex-wrap gap-2">
          <ActionForm action={lookupAction.bind(null, transactionId, "PROPERTY_DATA")} submitLabel="Look up property data" size="sm" variant="secondary" inline />
          <ActionForm action={lookupAction.bind(null, transactionId, "RECORDED_DOCUMENTS")} submitLabel="Search recorded documents" size="sm" variant="secondary" inline />
          {rec.mode === "NOT_CONFIGURED" && <span className="text-xs text-slate-500">Recorded-document research is not configured.</span>}
        </div>
      )}
      {lookups.length === 0 ? (
        <EmptyState title="No lookups yet">Run a lookup after adding the address and APN.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {lookups.map((l) => (
            <li key={l.id} className="rounded-md border border-slate-200 p-3 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-medium">{humanize(l.kind)}</span>
                <ModeBadge mode={l.mode} />
                <span className="text-xs text-slate-500">
                  {l.provider} · retrieved {displayDateTime(l.retrievedAt)}
                </span>
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs">{JSON.stringify(l.result, null, 2)}</pre>
              <p className="mt-1 text-xs text-slate-500">{l.coverageNote}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
