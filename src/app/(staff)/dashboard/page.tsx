import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffCtx } from "@/server/auth/session";
import { dashboard } from "@/server/services/dashboard";
import { Badge, Card, EmptyState, LinkButton, PageHeader, Stat, StatusBadge, Table, Td, Th, humanize } from "@/components/ui";
import { displayDate } from "@/lib/dates";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const ctx = await requireStaffCtx();
  const d = await dashboard(ctx);
  const isOverdue = (date: Date) => date < d.today;

  return (
    <>
      <PageHeader title="Dashboard" description={`As of ${displayDate(d.today)} (company time zone)`} actions={<LinkButton href="/transactions/new" variant="primary">New transaction</LinkButton>} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Active residential" value={d.counts.residential} href="/transactions?type=RESIDENTIAL&status=ACTIVE" />
        <Stat label="Active commercial" value={d.counts.commercial} href="/transactions?type=COMMERCIAL&status=ACTIVE" />
        <Stat label="On hold" value={d.counts.onHold} href="/transactions?status=ON_HOLD" tone={d.counts.onHold ? "warning" : undefined} />
        <Stat label="Overdue tasks" value={d.counts.overdueTasks} tone={d.counts.overdueTasks ? "danger" : undefined} />
        <Stat label="Open blockers" value={d.counts.blockers} tone={d.counts.blockers ? "danger" : undefined} />
        <Stat label="Awaiting my approval" value={d.counts.awaitingMyApproval} href="/approvals" tone={d.counts.awaitingMyApproval ? "warning" : undefined} />
        <Stat label="AI proposals to review" value={d.counts.pendingProposals} tone={d.counts.pendingProposals ? "warning" : undefined} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title="Upcoming and overdue deadlines" description="Pending deadlines due within 14 days, including overdue">
          {d.upcomingDeadlines.length === 0 ? (
            <EmptyState title="No deadlines in the next 14 days" />
          ) : (
            <Table caption="Upcoming deadlines">
              <thead>
                <tr>
                  <Th>Due</Th>
                  <Th>Deadline</Th>
                  <Th>File</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.upcomingDeadlines.map((dl) => (
                  <tr key={dl.id}>
                    <Td className="whitespace-nowrap tabular">
                      {displayDate(dl.dueAt)} {isOverdue(dl.dueAt) && <Badge tone="danger">Overdue</Badge>}
                    </Td>
                    <Td>
                      {dl.title} <span className="text-xs text-slate-500">({humanize(dl.type)})</span>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Link className="text-brand-700 hover:underline" href={`/transactions/${dl.transaction.id}/deadlines`}>
                        {dl.transaction.escrowNumber}
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title="Items awaiting my approval">
          {d.awaitingMe.length === 0 ? (
            <EmptyState title="Nothing is waiting for you" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {d.awaitingMe.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div>
                    <Badge tone="warning">{humanize(a.type)}</Badge> <span className="ml-1">{a.title}</span>
                  </div>
                  <Link href={`/approvals#${a.id}`} className="text-brand-700 hover:underline">
                    Review
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Overdue tasks">
          {d.overdueTasks.length === 0 ? (
            <EmptyState title="No overdue tasks" />
          ) : (
            <Table caption="Overdue tasks">
              <thead>
                <tr>
                  <Th>Due</Th>
                  <Th>Task</Th>
                  <Th>File</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.overdueTasks.map((t) => (
                  <tr key={t.id}>
                    <Td className="whitespace-nowrap tabular text-red-700">{displayDate(t.dueAt)}</Td>
                    <Td>{t.title}</Td>
                    <Td className="whitespace-nowrap">
                      <Link className="text-brand-700 hover:underline" href={`/transactions/${t.transaction.id}/tasks`}>
                        {t.transaction.escrowNumber}
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title="Open blockers">
          {d.blockers.length === 0 ? (
            <EmptyState title="No open blockers" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {d.blockers.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div>
                    <Badge tone="danger">Blocker</Badge> <span className="ml-1">{b.title}</span>
                  </div>
                  <Link className="text-brand-700 hover:underline" href={`/transactions/${b.transaction.id}/tasks`}>
                    {b.transaction.escrowNumber}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Closing in the next 14 days" className="xl:col-span-2">
          {d.closingSoon.length === 0 ? (
            <EmptyState title="No proposed closings in the next 14 days" />
          ) : (
            <Table caption="Closing soon">
              <thead>
                <tr>
                  <Th>Proposed closing</Th>
                  <Th>Escrow #</Th>
                  <Th>Property</Th>
                  <Th>Type</Th>
                  <Th>Stage</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.closingSoon.map((t) => (
                  <tr key={t.id}>
                    <Td className="tabular">{displayDate(t.proposedClosingDate)}</Td>
                    <Td>
                      <Link className="font-medium text-brand-700 hover:underline" href={`/transactions/${t.id}`}>
                        {t.escrowNumber}
                      </Link>
                    </Td>
                    <Td>{t.properties[0] ? `${t.properties[0].street}, ${t.properties[0].city}` : "—"}</Td>
                    <Td>{humanize(t.type)}</Td>
                    <Td>
                      <StatusBadge status="ACTIVE" label={humanize(t.stage)} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
