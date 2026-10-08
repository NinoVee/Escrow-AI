import Link from "next/link";
import { getWorkspace } from "./data";
import { Badge, StatusBadge, humanize } from "@/components/ui";
import { TabLink } from "@/components/nav-link";
import { stageLabel } from "@/server/workflow/engine";

const TABS = [
  ["", "Overview"],
  ["parties", "Parties"],
  ["property", "Property"],
  ["documents", "Documents"],
  ["tasks", "Tasks"],
  ["deadlines", "Deadlines"],
  ["title", "Title"],
  ["finances", "Finances"],
  ["communications", "Communications"],
  ["approvals", "Approvals"],
  ["activity", "Activity"],
] as const;

export default async function TransactionLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { tx, def, officer, properties } = await getWorkspace(id);
  const base = `/transactions/${tx.id}`;
  const stageIndex = def.stages.findIndex((s) => s.key === tx.stage);
  return (
    <div>
      <div className="mb-4">
        <Link href="/transactions" className="text-sm text-brand-700 hover:underline">
          ← Transactions
        </Link>
      </div>
      <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{tx.escrowNumber}</h1>
            <Badge tone={tx.type === "COMMERCIAL" ? "purple" : "info"}>{humanize(tx.type)}</Badge>
            <StatusBadge status={tx.status} />
            {tx.legalHold && <Badge tone="danger">Legal hold</Badge>}
          </div>
          <div className="mt-1 text-sm text-slate-600">
            {tx.title ? `${tx.title} · ` : ""}
            {properties[0] ? `${properties[0].street}, ${properties[0].city}` : "No property yet"}
            {properties.length > 1 ? ` (+${properties.length - 1})` : ""} · {tx.jurisdiction} · Officer: {officer?.name ?? "Unassigned"}
          </div>
        </div>
        <div className="text-sm text-slate-600">
          Stage <strong className="text-slate-900">{stageLabel(def, tx.stage)}</strong> ({stageIndex + 1} of {def.stages.length})
        </div>
      </div>
      <ol className="mb-4 hidden gap-1 lg:flex" aria-label="Workflow stages">
        {def.stages.map((s, i) => (
          <li
            key={s.key}
            className={`flex-1 truncate rounded px-1.5 py-1 text-center text-[11px] ${i < stageIndex ? "bg-brand-100 text-brand-800" : i === stageIndex ? "bg-brand-700 font-semibold text-white" : "bg-slate-100 text-slate-500"}`}
            aria-current={i === stageIndex ? "step" : undefined}
            title={s.label}
          >
            {s.label}
          </li>
        ))}
      </ol>
      <nav aria-label="Transaction sections" className="mb-6 flex overflow-x-auto border-b border-slate-200">
        {TABS.map(([slug, label]) => (
          <TabLink key={slug} href={slug ? `${base}/${slug}` : base} exact={!slug}>
            {label}
          </TabLink>
        ))}
      </nav>
      {children}
    </div>
  );
}
