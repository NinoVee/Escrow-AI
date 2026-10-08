import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffCtx } from "@/server/auth/session";
import { hasPermission } from "@/server/context";
import { getTemplateVersion } from "@/server/services/templates";
import { PREREQUISITE_LABELS } from "@/server/workflow/definition";
import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, Field, Input, StatusBadge, Table, Td, Textarea, Th, humanize } from "@/components/ui";
import { publishAction, saveDraftAction } from "../../actions";
import { NewDraftButton } from "./new-draft";

export const metadata: Metadata = { title: "Template version" };

export default async function TemplateVersionPage({ params }: { params: Promise<{ versionId: string }> }) {
  const ctx = await requireStaffCtx();
  const { versionId } = await params;
  const v = await getTemplateVersion(ctx, versionId).catch(() => null);
  if (!v) notFound();
  const def = v.parsed;
  const canManage = hasPermission(ctx, "templates.manage");
  const stageLabel = (k: string) => def.stages.find((s) => s.key === k)?.label ?? k;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href="/settings/templates" className="text-sm text-brand-700 hover:underline">
            ← Templates
          </Link>
          <h2 className="mt-1 text-lg font-semibold">
            {v.template.name} · v{v.version} <StatusBadge status={v.status === "PUBLISHED" ? "ACTIVE" : "PENDING"} label={humanize(v.status)} />
          </h2>
        </div>
        {canManage && v.status !== "DRAFT" && <NewDraftButton templateId={v.templateId} fromVersionId={v.id} />}
      </div>
      {def.disclaimer && <Alert tone="info">{def.disclaimer}</Alert>}

      <Card title="Stage transitions and prerequisites">
        <Table caption="Transitions">
          <thead>
            <tr>
              <Th>From → To</Th>
              <Th>Prerequisites</Th>
              <Th>Approval</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {def.transitions.map((t, i) => (
              <tr key={i}>
                <Td className="whitespace-nowrap">
                  {stageLabel(t.from)} → {stageLabel(t.to)}
                </Td>
                <Td className="text-xs">
                  {t.prerequisites.length === 0
                    ? "None"
                    : t.prerequisites.map((p, j) => (
                        <div key={j}>
                          {PREREQUISITE_LABELS[p.type]}
                          {"stages" in p && p.stages ? ` (${p.stages.map(stageLabel).join(", ")})` : ""}
                          {"kind" in p ? ` (${humanize(p.kind)})` : ""}
                          {!p.overridable && <Badge tone="danger" className="ml-1">no override</Badge>}
                        </div>
                      ))}
                </Td>
                <Td>{t.requiresApproval ? <Badge tone="warning">{t.approverPermission}</Badge> : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card title={`Task templates (${def.tasks.length})`}>
        <Table caption="Task templates">
          <thead>
            <tr>
              <Th>Stage</Th>
              <Th>Task</Th>
              <Th>Applies when</Th>
              <Th>Flags</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {def.tasks.map((t) => (
              <tr key={t.key}>
                <Td className="whitespace-nowrap text-xs">{stageLabel(t.stage)}</Td>
                <Td>
                  <div>{t.title}</div>
                  {t.applicabilityNote && <div className="text-xs text-slate-500">{t.applicabilityNote}</div>}
                </Td>
                <Td className="text-xs">{t.when ? Object.entries(t.when).map(([k, val]) => `${humanize(k.replace(/([A-Z])/g, "_$1"))}: ${val ? "yes" : "no"}`).join("; ") : "Always"}</Td>
                <Td className="space-x-1 whitespace-nowrap">
                  {t.required && <Badge tone="brand">Required</Badge>}
                  {t.requiresApproval && <Badge tone="warning">Approval</Badge>}
                  {t.dueRule && <Badge>{`${t.dueRule.anchor.toLowerCase()} ${t.dueRule.offsetDays >= 0 ? "+" : ""}${t.dueRule.offsetDays}d`}</Badge>}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {canManage && v.status === "DRAFT" && (
        <Card title="Edit draft definition" description="JSON validated against the workflow schema on save. Unknown stages, duplicate keys and malformed prerequisites are rejected.">
          <ActionForm action={saveDraftAction.bind(null, v.id)} submitLabel="Validate and save draft" resetOnSuccess={false}>
            <Field label="Change note" htmlFor="changeNote">
              <Input id="changeNote" name="changeNote" defaultValue={v.changeNote ?? ""} />
            </Field>
            <label htmlFor="definition" className="sr-only">
              Definition JSON
            </label>
            <Textarea id="definition" name="definition" rows={24} className="font-mono text-xs" defaultValue={JSON.stringify(def, null, 2)} />
          </ActionForm>
          <div className="mt-4 border-t border-slate-100 pt-4">
            <ActionForm action={publishAction.bind(null, v.id)} submitLabel="Publish this version" variant="secondary" confirm="Publish? New files will use this version.">
              {null}
            </ActionForm>
          </div>
        </Card>
      )}
    </div>
  );
}
