import { getWorkspace } from "../data";
import { hasPermission } from "@/server/context";
import { titleWorkspace, TITLE_DISCLAIMER } from "@/server/services/title";
import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, EmptyState, Field, Input, ModeBadge, Select, StatusBadge, Table, Td, Textarea, Th, humanize } from "@/components/ui";
import { addExceptionAction, dispositionAction, linkReportAction, titleOrderAction } from "../actions";
import { displayDateTime } from "@/lib/dates";
import { TitleExtras } from "./extras";
import { ProviderPanels } from "./provider";

const DISPOSITIONS = ["OPEN", "TO_BE_PAID_OFF", "TO_BE_REMOVED", "BUYER_APPROVED", "CLEARED_BY_TITLE", "NO_ACTION_NEEDED"];
const CATEGORIES = ["TAXES", "DEED_OF_TRUST", "LIEN", "JUDGMENT", "EASEMENT", "CCRS", "HOA", "REQUIREMENT", "OTHER"];

export default async function TitlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, tx } = await getWorkspace(id);
  const ws = await titleWorkspace(ctx, tx.id);
  const canManage = hasPermission(ctx, "title.manage");
  const reportTitle = new Map(ws.reports.map((r) => [r.id, r.title]));

  return (
    <div className="space-y-6">
      <Alert tone="warning" title="Title tracking only">
        {TITLE_DISCLAIMER}
      </Alert>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Title orders">
            {ws.orders.length === 0 ? (
              <EmptyState title="No title order recorded">Record the order you placed with the title company, then upload the preliminary report under Documents (category: Title report).</EmptyState>
            ) : (
              <ul className="divide-y divide-slate-100">
                {ws.orders.map((o) => (
                  <li key={o.id} className="py-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-medium">{o.provider}</span> {o.externalRef && <span className="text-slate-500">· Order {o.externalRef}</span>}
                      </div>
                      <div className="flex gap-2">
                        <ModeBadge mode={o.mode} />
                        <StatusBadge status={o.status} />
                      </div>
                    </div>
                    <div className="text-xs text-slate-500">
                      Ordered {displayDateTime(o.orderedAt)}
                      {o.reportDocumentId && ` · Report: ${reportTitle.get(o.reportDocumentId) ?? "document"}`}
                    </div>
                    {canManage && !o.reportDocumentId && ws.reports.length > 0 && (
                      <ActionForm action={linkReportAction.bind(null, tx.id, o.id)} submitLabel="Link report" size="sm" variant="secondary" inline className="mt-2">
                        <Select name="documentId" aria-label="Report document" className="w-64">
                          {ws.reports.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.title}
                            </option>
                          ))}
                        </Select>
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Exceptions and requirements" description="Transcribed from the title report. Each must have a disposition before signing.">
            {ws.exceptions.length === 0 ? (
              <EmptyState title="No exceptions recorded" />
            ) : (
              <Table caption="Title exceptions">
                <thead>
                  <tr>
                    <Th>#</Th>
                    <Th>Exception (as written)</Th>
                    <Th>Disposition</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ws.exceptions.map((e) => (
                    <tr key={e.id}>
                      <Td className="whitespace-nowrap">{e.itemNumber ?? "—"}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          <Badge>{humanize(e.category)}</Badge>
                          {e.source === "AI_PROPOSAL" && <Badge tone="purple">From accepted proposal</Badge>}
                        </div>
                        <p className="mt-1 text-sm">{e.description}</p>
                        <p className="text-xs text-slate-500">
                          Source: {reportTitle.get(e.documentId) ?? "report"}
                          {e.page ? `, p. ${e.page}` : ""}
                        </p>
                        {e.aiSummary && <p className="mt-1 text-xs text-violet-800">Assistant summary (not a legal conclusion): {e.aiSummary}</p>}
                      </Td>
                      <Td className="min-w-56">
                        <StatusBadge status={e.disposition === "OPEN" ? "PENDING" : "DONE"} label={humanize(e.disposition)} />
                        {e.dispositionNote && <p className="mt-1 text-xs text-slate-600">{e.dispositionNote}</p>}
                        {canManage && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-brand-700">Set disposition</summary>
                            <ActionForm action={dispositionAction.bind(null, tx.id, e.id)} submitLabel="Save" size="sm" className="mt-1">
                              <Select name="disposition" defaultValue={e.disposition} aria-label="Disposition">
                                {DISPOSITIONS.map((d) => (
                                  <option key={d} value={d}>
                                    {humanize(d)}
                                  </option>
                                ))}
                              </Select>
                              <Input name="note" placeholder="Basis (e.g. payoff demand received)" aria-label="Basis" />
                            </ActionForm>
                          </details>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <TitleExtras transactionId={tx.id} />
          <ProviderPanels transactionId={tx.id} />
        </div>
        {canManage && (
          <div className="space-y-6">
            <Card title="Record title order">
              <ActionForm action={titleOrderAction.bind(null, tx.id)} submitLabel="Record order">
                <Field label="Title company" htmlFor="provider" required>
                  <Input id="provider" name="provider" required />
                </Field>
                <Field label="Order number" htmlFor="externalRef">
                  <Input id="externalRef" name="externalRef" />
                </Field>
                <Field label="Notes" htmlFor="tnotes">
                  <Input id="tnotes" name="notes" />
                </Field>
              </ActionForm>
            </Card>
            <Card title="Add exception">
              {ws.reports.length === 0 ? (
                <p className="text-sm text-slate-500">Upload a title report (category “Title report”) first.</p>
              ) : (
                <ActionForm action={addExceptionAction.bind(null, tx.id)} submitLabel="Add exception">
                  <Field label="Report" htmlFor="ex-doc" required>
                    <Select id="ex-doc" name="documentId" required>
                      {ws.reports.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.title}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Item #" htmlFor="ex-num">
                    <Input id="ex-num" name="itemNumber" />
                  </Field>
                  <Field label="Category" htmlFor="ex-cat">
                    <Select id="ex-cat" name="category">
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {humanize(c)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Text as written" htmlFor="ex-desc" required>
                    <Textarea id="ex-desc" name="description" rows={3} required />
                  </Field>
                  <Field label="Page" htmlFor="ex-page">
                    <Input id="ex-page" name="page" type="number" min={1} />
                  </Field>
                </ActionForm>
              )}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
