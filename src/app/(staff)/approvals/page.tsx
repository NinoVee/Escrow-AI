import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffCtx } from "@/server/auth/session";
import { listApprovals } from "@/server/services/approvals";
import { can, type Permission } from "@/server/authz";
import { ApprovalList } from "@/components/approval-list";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import type { ApprovalStatus } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Approvals" };

const FILTERS: { key: string; label: string; status?: ApprovalStatus }[] = [
  { key: "mine", label: "Awaiting me", status: "PENDING" },
  { key: "pending", label: "All pending", status: "PENDING" },
  { key: "decided", label: "Decided" },
];

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const ctx = await requireStaffCtx();
  const { view = "mine" } = await searchParams;
  const f = FILTERS.find((x) => x.key === view) ?? FILTERS[0];
  let rows = await listApprovals(ctx, { status: f.status });
  if (f.key === "mine") rows = rows.filter((a) => a.requestedById !== ctx.userId && can(ctx.role, a.requiredPermission as Permission));
  if (f.key === "decided") rows = rows.filter((a) => a.status !== "PENDING");

  return (
    <>
      <PageHeader title="Approval inbox" description="You can never approve an item you prepared or requested. Payment-related approvals also require step-up authentication." />
      <nav className="mb-4 flex gap-2" aria-label="Approval filters">
        {FILTERS.map((x) => (
          <Link key={x.key} href={`/approvals?view=${x.key}`} aria-current={x.key === f.key ? "page" : undefined} className={`rounded-full px-3 py-1 text-sm ${x.key === f.key ? "bg-brand-700 text-white" : "bg-white text-slate-700 ring-1 ring-slate-300"}`}>
            {x.label}
          </Link>
        ))}
      </nav>
      <Card>{rows.length === 0 ? <EmptyState title={f.key === "mine" ? "Nothing is waiting for your decision" : "No approvals"} /> : <ApprovalList ctx={ctx} approvals={rows} />}</Card>
    </>
  );
}
