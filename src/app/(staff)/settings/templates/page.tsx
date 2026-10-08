import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffCtx } from "@/server/auth/session";
import { listTemplates } from "@/server/services/templates";
import { parseDefinition } from "@/server/workflow/definition";
import { Badge, Card, StatusBadge, humanize } from "@/components/ui";
import { displayDateTime } from "@/lib/dates";

export const metadata: Metadata = { title: "Workflow templates" };

export default async function TemplatesPage() {
  const ctx = await requireStaffCtx();
  const templates = await listTemplates(ctx);
  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-600">Templates are versioned. Publishing a new version affects new files only; existing files stay on the version they were opened with.</p>
      {templates.map((t) => (
        <Card key={t.id} title={t.name} description={`${humanize(t.transactionType)} · ${t.jurisdiction}${t.description ? ` · ${t.description}` : ""}`}>
          <ul className="divide-y divide-slate-100">
            {t.versions.map((v) => {
              const def = parseDefinition(v.definition);
              return (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div>
                    <Link className="font-medium text-brand-700 hover:underline" href={`/settings/templates/${v.id}`}>
                      Version {v.version}
                    </Link>{" "}
                    <StatusBadge status={v.status === "PUBLISHED" ? "ACTIVE" : v.status === "DRAFT" ? "PENDING" : "CANCELLED"} label={humanize(v.status)} />
                    <span className="ml-2 text-xs text-slate-500">
                      {def.stages.length} stages · {def.tasks.length} task templates · {v._count.transactions} files
                      {v.publishedAt && ` · published ${displayDateTime(v.publishedAt)}`}
                    </span>
                    {v.changeNote && <div className="text-xs text-slate-500">{v.changeNote}</div>}
                  </div>
                  {v.status === "DRAFT" && <Badge tone="warning">Unpublished draft</Badge>}
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
    </div>
  );
}
