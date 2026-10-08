import type { Metadata } from "next";
import Link from "next/link";
import { requirePortalCtx } from "@/server/auth/session";
import { listTransactions } from "@/server/services/transactions";
import { EmptyState, StatusBadge, humanize } from "@/components/ui";
import { displayDate } from "@/lib/dates";

export const metadata: Metadata = { title: "Your transactions" };

export default async function PortalHome() {
  const ctx = await requirePortalCtx();
  const rows = await listTransactions(ctx);
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">Your transactions</h1>
      {rows.length === 0 ? (
        <EmptyState title="No transactions shared with you">If you expected to see a file here, contact your escrow officer.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {rows.map((t) => (
            <li key={t.id}>
              <Link href={`/portal/${t.id}`} className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm hover:border-brand-600">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">Escrow {t.escrowNumber}</span>
                  <StatusBadge status={t.status} />
                </div>
                <div className="mt-1 text-sm text-slate-600">{t.properties[0] ? `${t.properties[0].street}, ${t.properties[0].city}` : humanize(t.type)}</div>
                {t.proposedClosingDate && <div className="mt-1 text-xs text-slate-500">Estimated closing {displayDate(t.proposedClosingDate)}</div>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
