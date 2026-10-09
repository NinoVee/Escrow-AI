import type { Metadata } from "next";
import { requireStaffCtx } from "@/server/auth/session";
import { hasPermission } from "@/server/context";
import { integrationStatuses } from "@/server/integrations/registry";
import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, ModeBadge, Select } from "@/components/ui";
import { integrationModeAction } from "../ops-actions";

export const metadata: Metadata = { title: "Integrations" };

const SELECTABLE = new Set(["EMAIL", "ESIGN", "TITLE", "PROPERTY_DATA", "RECORDED_DOCUMENTS", "RECORDING"]);

export default async function IntegrationsPage() {
  const ctx = await requireStaffCtx();
  const statuses = await integrationStatuses(ctx.companyId);
  const canManage = hasPermission(ctx, "integrations.manage");
  return (
    <div className="space-y-4">
      <Alert tone="info" title="What the modes mean">
        <strong>Not configured</strong>: unavailable. <strong>Demo</strong>: simulated, clearly labeled, never real data. <strong>Sandbox</strong>: provider test environment. <strong>Live</strong>: real provider. Vendor APIs (title, property data, e-signature, e-recording) ship as demo adapters; a live adapter needs the vendor&apos;s official API documentation and an agreement that includes API access. Payment execution is disabled. See docs/INTEGRATIONS.md.
      </Alert>
      <div className="grid gap-4 lg:grid-cols-2">
        {statuses.map((s) => (
          <Card key={s.kind} title={s.label} actions={<ModeBadge mode={s.mode} />} description={s.description}>
            <dl className="space-y-1 text-sm">
              <div>
                <dt className="inline text-slate-500">Provider: </dt>
                <dd className="inline">{s.provider}</dd>
              </div>
              <div>
                <dt className="inline text-slate-500">Status: </dt>
                <dd className="inline">{s.reason}</dd>
              </div>
              {s.mode === "DEMO" && (
                <div>
                  <dt className="inline text-slate-500">Demo behavior: </dt>
                  <dd className="inline">{s.info.demoNote}</dd>
                </div>
              )}
            </dl>
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-brand-700">Adapters</summary>
              <ul className="mt-1 space-y-1">
                {s.info.providers.map((p) => (
                  <li key={p.id}>
                    {p.name} {p.liveImplemented ? <Badge tone="success">Adapter implemented</Badge> : <Badge>Interface only</Badge>}
                    {p.requiredEnv.length > 0 && <span className="ml-1 font-mono text-xs text-slate-500">{p.requiredEnv.join(", ")}</span>}
                    {p.notes && <p className="text-xs text-slate-500">{p.notes}</p>}
                  </li>
                ))}
              </ul>
            </details>
            {s.kind === "ACCOUNTING" && hasPermission(ctx, "ledger.read") && (
              <a className="mt-2 inline-block text-sm text-brand-700 hover:underline" href="/api/exports/journal" download>
                Download journal CSV
              </a>
            )}
            {canManage && SELECTABLE.has(s.kind) && (
              <ActionForm action={integrationModeAction.bind(null, s.kind)} submitLabel="Save" size="sm" variant="secondary" inline className="mt-3">
                <label className="text-sm">
                  <span className="sr-only">Mode for {s.label}</span>
                  <Select name="mode" defaultValue={s.mode}>
                    <option value="NOT_CONFIGURED">Not configured</option>
                    <option value="DEMO">Demo</option>
                    <option value="SANDBOX">Sandbox</option>
                    <option value="LIVE">Live</option>
                  </Select>
                </label>
              </ActionForm>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
