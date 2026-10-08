import { getWorkspace } from "../data";
import { listAuditEvents } from "@/server/services/dashboard";
import { db } from "@/server/db";
import { Badge, Card, EmptyState, Table, Td, Th, humanize } from "@/components/ui";
import { displayDateTime } from "@/lib/dates";

export default async function ActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, tx, def } = await getWorkspace(id);
  const [events, transitions] = await Promise.all([
    listAuditEvents(ctx, { transactionId: tx.id, take: 300 }),
    db.stageTransition.findMany({ where: { transactionId: tx.id }, orderBy: { createdAt: "desc" } }),
  ]);
  const label = (k: string) => def.stages.find((s) => s.key === k)?.label ?? k;
  return (
    <div className="space-y-6">
      <Card title="Stage history">
        {transitions.length === 0 ? (
          <EmptyState title="No stage changes yet" />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {transitions.map((t) => (
              <li key={t.id} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={t.overridden ? "danger" : "neutral"}>{t.overridden ? "Override" : humanize(t.kind)}</Badge>
                  <span>
                    {label(t.fromStage)} → {label(t.toStage)}
                  </span>
                  {t.fromStatus !== t.toStatus && (
                    <span className="text-xs text-slate-500">
                      ({humanize(t.fromStatus)} → {humanize(t.toStatus)})
                    </span>
                  )}
                  <span className="text-xs text-slate-500">{displayDateTime(t.createdAt)}</span>
                </div>
                <div className="text-xs text-slate-600">Reason: {t.reason}</div>
                {t.overrideJustification && <div className="text-xs text-red-800">Override justification: {t.overrideJustification}</div>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Activity log" description="Append-only record of every action on this file, including downloads and denied attempts.">
        {events.length === 0 ? (
          <EmptyState title="No activity" />
        ) : (
          <Table caption="Activity log">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>Action</Th>
                <Th>Summary</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {events.map((e) => (
                <tr key={e.id}>
                  <Td className="whitespace-nowrap text-xs tabular">{displayDateTime(e.createdAt)}</Td>
                  <Td className="whitespace-nowrap text-xs">
                    {e.actorLabel ?? humanize(e.actorType)}
                    {e.actorType !== "USER" && <Badge className="ml-1">{humanize(e.actorType)}</Badge>}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-xs">{e.action}</Td>
                  <Td className="text-sm">
                    {e.summary}
                    {e.entityVersion != null && <span className="text-xs text-slate-500"> (v{e.entityVersion})</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
