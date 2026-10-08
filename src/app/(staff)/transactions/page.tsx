import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffCtx } from "@/server/auth/session";
import { listTransactions } from "@/server/services/transactions";
import { STANDARD_STAGES } from "@/server/workflow/templates";
import { Badge, Card, EmptyState, Input, LinkButton, PageHeader, Select, StatusBadge, Table, Td, Th, buttonClass, humanize } from "@/components/ui";
import { displayDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import type { TransactionStatus, TransactionType } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Transactions" };

const TYPES = ["RESIDENTIAL", "COMMERCIAL"] as const;
const STATUSES = ["ACTIVE", "ON_HOLD", "CLOSED", "CANCELLED"] as const;

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireStaffCtx();
  const sp = await searchParams;
  const type = TYPES.includes(sp.type as TransactionType) ? (sp.type as TransactionType) : undefined;
  const status = STATUSES.includes(sp.status as TransactionStatus) ? (sp.status as TransactionStatus) : undefined;
  const stage = STANDARD_STAGES.some((s) => s.key === sp.stage) ? sp.stage : undefined;
  const rows = await listTransactions(ctx, { q: sp.q, type, status, stage, mine: sp.mine === "1" });
  const filtered = Boolean(sp.q || type || status || stage || sp.mine);

  return (
    <>
      <PageHeader title="Transactions" description="Search by escrow number, title, address, APN or party name." actions={<LinkButton href="/transactions/new" variant="primary">New transaction</LinkButton>} />
      <Card>
        <form className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6" role="search" aria-label="Filter transactions">
          <div className="lg:col-span-2">
            <label htmlFor="q" className="sr-only">
              Search
            </label>
            <Input id="q" name="q" type="search" placeholder="Search…" defaultValue={sp.q ?? ""} />
          </div>
          <div>
            <label htmlFor="type" className="sr-only">
              Type
            </label>
            <Select id="type" name="type" defaultValue={type ?? ""}>
              <option value="">All types</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="status" className="sr-only">
              Status
            </label>
            <Select id="status" name="status" defaultValue={status ?? ""}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="stage" className="sr-only">
              Stage
            </label>
            <Select id="stage" name="stage" defaultValue={stage ?? ""}>
              <option value="">All stages</option>
              {STANDARD_STAGES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-sm text-slate-700">
              <input type="checkbox" name="mine" value="1" defaultChecked={sp.mine === "1"} /> Mine
            </label>
            <button className={buttonClass("secondary", "sm")}>Apply</button>
            {filtered && (
              <Link href="/transactions" className="text-sm text-brand-700 hover:underline">
                Clear
              </Link>
            )}
          </div>
        </form>

        {rows.length === 0 ? (
          <EmptyState title={filtered ? "No transactions match these filters" : "No transactions yet"} action={!filtered ? <LinkButton href="/transactions/new" variant="primary">Create the first transaction</LinkButton> : undefined}>
            {filtered ? "Try a different search or clear the filters." : "Create a transaction manually or from an uploaded purchase agreement."}
          </EmptyState>
        ) : (
          <Table caption="Transactions">
            <thead>
              <tr>
                <Th>Escrow #</Th>
                <Th>Property</Th>
                <Th>Parties</Th>
                <Th>Type</Th>
                <Th>Stage</Th>
                <Th>Status</Th>
                <Th className="text-right">Price</Th>
                <Th>Closing</Th>
                <Th className="text-right">Open tasks</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <Td className="whitespace-nowrap">
                    <Link href={`/transactions/${t.id}`} className="font-medium text-brand-700 hover:underline">
                      {t.escrowNumber}
                    </Link>
                    {t.title && <div className="text-xs text-slate-500">{t.title}</div>}
                  </Td>
                  <Td>
                    {t.properties.length === 0 ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <>
                        {t.properties[0].street}, {t.properties[0].city}
                        {t.properties.length > 1 && <span className="ml-1 text-xs text-slate-500">+{t.properties.length - 1} more</span>}
                      </>
                    )}
                  </Td>
                  <Td className="text-xs text-slate-600">
                    {t.participants.map((p) => (
                      <div key={p.displayName + p.role}>
                        <span className="text-slate-400">{p.role === "BUYER" ? "B" : "S"}:</span> {p.displayName}
                      </div>
                    ))}
                  </Td>
                  <Td>
                    <Badge tone={t.type === "COMMERCIAL" ? "purple" : "info"}>{humanize(t.type)}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap">{humanize(t.stage)}</Td>
                  <Td>
                    <StatusBadge status={t.status} />
                  </Td>
                  <Td className="text-right tabular">{t.purchasePriceCents != null ? formatCents(t.purchasePriceCents) : "—"}</Td>
                  <Td className="whitespace-nowrap tabular">{displayDate(t.proposedClosingDate)}</Td>
                  <Td className="text-right tabular">{t._count.tasks}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
