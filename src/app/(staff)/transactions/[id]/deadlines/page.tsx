import { getWorkspace } from "../data";
import { db } from "@/server/db";
import { hasPermission } from "@/server/context";
import { getCompanySettings } from "@/server/settings";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, EmptyState, Field, Input, Select, StatusBadge, Table, Td, Th, humanize } from "@/components/ui";
import { createDeadlineAction, resolveDeadlineAction } from "../actions";
import { daysBetween, displayDate, todayInZone } from "@/lib/dates";

const TYPES = ["CONTINGENCY", "CONTRACT", "CLOSING", "LENDER", "INTERNAL", "OTHER"];

export default async function DeadlinesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, tx } = await getWorkspace(id);
  const [deadlines, docs, settings] = await Promise.all([
    db.deadline.findMany({ where: { transactionId: tx.id }, orderBy: { dueAt: "asc" } }),
    db.document.findMany({ where: { transactionId: tx.id }, select: { id: true, title: true } }),
    getCompanySettings(ctx.companyId),
  ]);
  const today = todayInZone(settings.timezone);
  const docTitle = new Map(docs.map((d) => [d.id, d.title]));
  const canManage = hasPermission(ctx, "deadline.manage");

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Deadlines" className="xl:col-span-2" description="Contract dates should be verified against the executed agreement. Dates from documents show their source.">
        {deadlines.length === 0 ? (
          <EmptyState title="No deadlines yet">Add contract and contingency deadlines, or accept proposed deadlines from an uploaded agreement.</EmptyState>
        ) : (
          <Table caption="Deadlines">
            <thead>
              <tr>
                <Th>Due</Th>
                <Th>Deadline</Th>
                <Th>Status</Th>
                <Th>Source</Th>
                {canManage && <Th>Action</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {deadlines.map((d) => {
                const days = daysBetween(today, d.dueAt);
                return (
                  <tr key={d.id}>
                    <Td className="whitespace-nowrap tabular">
                      {displayDate(d.dueAt)}
                      {d.status === "PENDING" && <div className={`text-xs ${days < 0 ? "font-medium text-red-700" : days <= 3 ? "text-amber-800" : "text-slate-500"}`}>{days < 0 ? `${-days} days overdue` : days === 0 ? "Today" : `in ${days} days`}</div>}
                    </Td>
                    <Td>
                      <div className="font-medium">{d.title}</div>
                      <div className="text-xs text-slate-500">{humanize(d.type)}</div>
                      {d.notes && <div className="text-xs text-slate-600">{d.notes}</div>}
                    </Td>
                    <Td>
                      <StatusBadge status={d.status} />
                    </Td>
                    <Td className="text-xs">
                      <Badge tone={d.source === "AI_PROPOSAL" ? "purple" : "neutral"}>{d.source === "AI_PROPOSAL" ? "Accepted proposal" : humanize(d.source)}</Badge>
                      {d.documentId && (
                        <div className="mt-1 text-slate-600">
                          {docTitle.get(d.documentId)}
                          {d.page ? `, p. ${d.page}` : ""}
                        </div>
                      )}
                      {d.excerpt && <blockquote className="mt-1 border-l-2 border-slate-300 pl-2 italic text-slate-600">“{d.excerpt}”</blockquote>}
                    </Td>
                    {canManage && (
                      <Td>
                        {d.status === "PENDING" && (
                          <details>
                            <summary className="cursor-pointer text-sm text-brand-700">Resolve</summary>
                            <ActionForm action={resolveDeadlineAction.bind(null, tx.id, d.id)} submitLabel="Save" size="sm" className="mt-2 w-60">
                              <Field label="Outcome" htmlFor={`o-${d.id}`}>
                                <Select id={`o-${d.id}`} name="status">
                                  <option value="MET">Met</option>
                                  <option value="WAIVED">Waived</option>
                                  <option value="EXTENDED">Extended</option>
                                  <option value="MISSED">Missed</option>
                                </Select>
                              </Field>
                              <Field label="New due date (if extended)" htmlFor={`nd-${d.id}`}>
                                <Input id={`nd-${d.id}`} name="newDueDate" type="date" />
                              </Field>
                              <Field label="Note / basis" htmlFor={`n-${d.id}`} required>
                                <Input id={`n-${d.id}`} name="note" required />
                              </Field>
                            </ActionForm>
                          </details>
                        )}
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {canManage && (
        <Card title="Add deadline">
          <ActionForm action={createDeadlineAction.bind(null, tx.id)} submitLabel="Add deadline">
            <Field label="Title" htmlFor="dl-title" required>
              <Input id="dl-title" name="title" required />
            </Field>
            <Field label="Type" htmlFor="dl-type">
              <Select id="dl-type" name="type" defaultValue="CONTRACT">
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanize(t)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Due date" htmlFor="dl-due" required>
              <Input id="dl-due" name="dueDate" type="date" required />
            </Field>
            <Field label="Notes" htmlFor="dl-notes">
              <Input id="dl-notes" name="notes" />
            </Field>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
