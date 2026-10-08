import Link from "next/link";
import { getWorkspace, staffNames } from "./data";
import { availableTransitions, stageLabel } from "@/server/workflow/engine";
import { hasPermission } from "@/server/context";
import { db } from "@/server/db";
import { TX_FIELDS, displayValue, fromColumnValue } from "@/server/fields";
import { listStaff } from "@/server/services/users";
import { FUNDING_SOURCES } from "@/server/services/tasks";
import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, Field, Input, Select, StatusBadge, Table, Td, Textarea, Th, humanize } from "@/components/ui";
import { assignStaffAction, legalHoldAction, milestoneAction, statusAction, transitionAction, updateFieldAction } from "./actions";
import { displayDate, displayDateTime } from "@/lib/dates";
import type { MilestoneKind } from "@/generated/prisma/enums";

export default async function OverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, tx, def } = await getWorkspace(id);
  const [transitions, milestones, provenance, docs, staff, names, pendingProposals, templateVersion] = await Promise.all([
    tx.status === "ACTIVE" ? availableTransitions(ctx, tx.id) : Promise.resolve([]),
    db.milestone.findMany({ where: { transactionId: tx.id } }),
    db.fieldProvenance.findMany({ where: { transactionId: tx.id }, orderBy: { createdAt: "desc" } }),
    db.document.findMany({ where: { transactionId: tx.id, archivedAt: null }, select: { id: true, title: true, category: true }, orderBy: { createdAt: "desc" } }),
    listStaff(ctx),
    staffNames(ctx.companyId),
    db.proposal.count({ where: { transactionId: tx.id, status: "PENDING" } }),
    db.workflowTemplateVersion.findUnique({ where: { id: tx.templateVersionId }, include: { template: true } }),
  ]);
  const docTitle = new Map(docs.map((d) => [d.id, d.title]));
  const canEdit = hasPermission(ctx, "transaction.update") && tx.status !== "CLOSED" && tx.status !== "CANCELLED";

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <div className="space-y-6 xl:col-span-2">
        {pendingProposals > 0 && (
          <Alert tone="warning" title={`${pendingProposals} proposed change${pendingProposals === 1 ? "" : "s"} awaiting review`}>
            Values extracted from documents are not authoritative until an officer accepts them.{" "}
            <Link className="underline" href={`/transactions/${tx.id}/documents`}>
              Review proposals
            </Link>
          </Alert>
        )}
        {tx.status === "ON_HOLD" && <Alert tone="warning" title="File on hold">{tx.holdReason}</Alert>}
        {tx.status === "CANCELLED" && <Alert tone="danger" title="File cancelled">{tx.cancelReason}</Alert>}
        {tx.status === "CLOSED" && <Alert tone="success" title={`Closed ${displayDateTime(tx.closedAt)}`}>Reopening requires manager permission and a reason.</Alert>}

        <Card title="Workflow" description={`Current stage: ${stageLabel(def, tx.stage)}. Each move is checked against its prerequisites on the server.`}>
          {tx.status !== "ACTIVE" ? (
            <p className="text-sm text-slate-600">Stage changes are paused while the file is {humanize(tx.status).toLowerCase()}.</p>
          ) : transitions.length === 0 ? (
            <p className="text-sm text-slate-600">No moves are defined from this stage.</p>
          ) : (
            <div className="space-y-5">
              {transitions.map((t) => (
                <div key={t.to} className="rounded-md border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">{t.label}</div>
                    <div className="flex gap-2">
                      {t.requiresApproval && <Badge tone="warning">Requires approval</Badge>}
                      {t.ready ? <Badge tone="success">Ready</Badge> : <Badge tone="neutral">Not ready</Badge>}
                    </div>
                  </div>
                  {t.results.length > 0 && (
                    <ul className="mt-2 space-y-1 text-sm">
                      {t.results.map((r, i) => (
                        <li key={i} className="flex gap-2">
                          <span aria-hidden className={r.met ? "text-emerald-700" : "text-red-700"}>
                            {r.met ? "✓" : "✗"}
                          </span>
                          <span className="sr-only">{r.met ? "Met:" : "Not met:"}</span>
                          <span>
                            {r.label}
                            {!r.met && <span className="text-slate-500"> — {r.detail}</span>}
                            {!r.met && !r.overridable && <Badge tone="danger" className="ml-1">Cannot be overridden</Badge>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {hasPermission(ctx, "workflow.transition") && (t.ready || t.overridePossible) && (
                    <ActionForm action={transitionAction.bind(null, tx.id)} submitLabel={t.requiresApproval ? "Request approval" : "Move stage"} className="mt-3" variant={t.ready ? "primary" : "danger"}>
                      <input type="hidden" name="toStage" value={t.to} />
                      <input type="hidden" name="expectedVersion" value={tx.version} />
                      <Field label="Reason" htmlFor={`reason-${t.to}`} required>
                        <Input id={`reason-${t.to}`} name="reason" required minLength={3} />
                      </Field>
                      {!t.ready && (
                        <div className="rounded-md border border-red-200 bg-red-50 p-2">
                          <label className="flex items-center gap-2 text-sm font-medium text-red-900">
                            <input type="checkbox" name="override" required /> Override unmet prerequisites (logged)
                          </label>
                          <div className="mt-2">
                            <Field label="Override justification" htmlFor={`just-${t.to}`} required>
                              <Textarea id={`just-${t.to}`} name="overrideJustification" rows={2} required minLength={10} />
                            </Field>
                          </div>
                        </div>
                      )}
                    </ActionForm>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-3 border-t border-slate-100 pt-3">
            {tx.status === "ACTIVE" && hasPermission(ctx, "workflow.hold") && <StatusChange txId={tx.id} version={tx.version} kind="HOLD" label="Place on hold" />}
            {tx.status === "ON_HOLD" && hasPermission(ctx, "workflow.hold") && <StatusChange txId={tx.id} version={tx.version} kind="RESUME" label="Resume" />}
            {(tx.status === "ACTIVE" || tx.status === "ON_HOLD") && hasPermission(ctx, "workflow.cancel") && <StatusChange txId={tx.id} version={tx.version} kind="CANCEL" label="Cancel file" danger />}
            {(tx.status === "CLOSED" || tx.status === "CANCELLED") && hasPermission(ctx, "workflow.reopen") && (
              <StatusChange txId={tx.id} version={tx.version} kind="REOPEN" label="Reopen file" stages={def.stages.filter((s) => s.key !== def.closedStage).map((s) => ({ key: s.key, label: s.label }))} defaultStage={def.reopenStage} />
            )}
          </div>
        </Card>

        <Card title="Key terms" description="Authoritative values. Every change records who, when, why and the source document.">
          <Table caption="Key terms">
            <thead>
              <tr>
                <Th>Field</Th>
                <Th>Value</Th>
                <Th>Source</Th>
                {canEdit && <Th className="sr-only">Edit</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {TX_FIELDS.map((f) => {
                const value = fromColumnValue(f.key, (tx as unknown as Record<string, unknown>)[f.key]);
                const history = provenance.filter((p) => p.fieldPath === f.key);
                const current = history.find((h) => h.isCurrent);
                return (
                  <tr key={f.key}>
                    <Td className="whitespace-nowrap font-medium text-slate-700">{f.label}</Td>
                    <Td className="tabular">{f.kind === "date" ? displayDate(value as string | null) : displayValue(f.key, value)}</Td>
                    <Td className="text-xs text-slate-600">
                      {current ? (
                        <>
                          <Badge tone={current.source === "MANUAL" ? "neutral" : "brand"}>{humanize(current.source)}</Badge>{" "}
                          {current.documentId && (
                            <>
                              {docTitle.get(current.documentId) ?? "document"}
                              {current.page ? `, p. ${current.page}` : ""}
                            </>
                          )}
                          <div>
                            {names.get(current.setById) ?? "Unknown"} · {displayDateTime(current.createdAt)}
                          </div>
                          {current.excerpt && <blockquote className="mt-1 border-l-2 border-slate-300 pl-2 italic">“{current.excerpt}”</blockquote>}
                          {history.length > 1 && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-brand-700">History ({history.length})</summary>
                              <ul className="mt-1 space-y-1">
                                {history.map((h) => (
                                  <li key={h.id}>
                                    {f.kind === "date" ? displayDate(h.value as string) : displayValue(f.key, h.value)} — {humanize(h.source)}, {names.get(h.setById) ?? "?"}, {displayDateTime(h.createdAt)}
                                    {h.reason ? ` (${h.reason})` : ""}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </>
                      ) : value === null || value === false ? (
                        <span className="text-slate-400">Not set</span>
                      ) : (
                        <span className="text-slate-400">Default</span>
                      )}
                    </Td>
                    {canEdit && (
                      <Td>
                        <details>
                          <summary className="cursor-pointer text-sm text-brand-700">Edit</summary>
                          <ActionForm action={updateFieldAction.bind(null, tx.id)} submitLabel="Save" size="sm" className="mt-2 w-64">
                            <input type="hidden" name="field" value={f.key} />
                            <input type="hidden" name="expectedVersion" value={tx.version} />
                            <FieldInput kind={f.kind} name={f.key} value={value} options={"options" in f ? f.options : undefined} />
                            <Field label="Reason for change" htmlFor={`r-${f.key}`} required>
                              <Input id={`r-${f.key}`} name="reason" required minLength={3} />
                            </Field>
                          </ActionForm>
                        </details>
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      </div>

      <div className="space-y-6">
        <Card title="Milestones" description="Tracked separately from the stage because their order varies.">
          <ul className="space-y-4">
            {(["SIGNING", "FUNDING", "RECORDING", "DISBURSEMENT"] as MilestoneKind[]).map((kind) => {
              const m = milestones.find((x) => x.kind === kind);
              return (
                <li key={kind} className="rounded-md border border-slate-200 p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{humanize(kind)}</span>
                    <StatusBadge status={m?.status ?? "NOT_STARTED"} />
                  </div>
                  {m?.status === "COMPLETE" && (
                    <div className="mt-1 text-xs text-slate-600">
                      {displayDateTime(m.completedAt)} by {names.get(m.confirmedById ?? "") ?? "—"} · {humanize(m.confirmationSource)}
                      {m.reference && ` · Ref ${m.reference}`}
                      {m.isSimulated && <Badge tone="purple" className="ml-1">Simulated</Badge>}
                    </div>
                  )}
                  {m?.notes && <div className="mt-1 text-xs text-slate-500">{m.notes}</div>}
                  {tx.status === "ACTIVE" && (hasPermission(ctx, "milestone.update") || (kind === "FUNDING" && hasPermission(ctx, "milestone.confirm_funding"))) && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm text-brand-700">Update</summary>
                      <ActionForm action={milestoneAction.bind(null, tx.id, kind)} submitLabel="Save milestone" size="sm" className="mt-2">
                        <Field label="Status" htmlFor={`ms-${kind}`}>
                          <Select id={`ms-${kind}`} name="status" defaultValue={m?.status ?? "NOT_STARTED"}>
                            {["NOT_STARTED", "IN_PROGRESS", "COMPLETE", "NOT_APPLICABLE"].map((s) => (
                              <option key={s} value={s}>
                                {humanize(s)}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        {kind === "FUNDING" && (
                          <Field label="Confirmation source" htmlFor={`src-${kind}`} hint="Required to mark funding complete. Email or screenshots alone are not acceptable sources.">
                            <Select id={`src-${kind}`} name="source" defaultValue="">
                              <option value="">Select…</option>
                              {FUNDING_SOURCES.map((s) => (
                                <option key={s} value={s}>
                                  {humanize(s)}
                                </option>
                              ))}
                            </Select>
                          </Field>
                        )}
                        <Field label="Reference" htmlFor={`ref-${kind}`} hint={kind === "RECORDING" ? "Instrument / document number" : "Confirmation or reference number"}>
                          <Input id={`ref-${kind}`} name="reference" />
                        </Field>
                        <Field label="Evidence document" htmlFor={`ev-${kind}`}>
                          <Select id={`ev-${kind}`} name="evidenceDocumentId" defaultValue="">
                            <option value="">None</option>
                            {docs.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.title}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Notes" htmlFor={`n-${kind}`}>
                          <Input id={`n-${kind}`} name="notes" />
                        </Field>
                      </ActionForm>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title="Assignment">
          {hasPermission(ctx, "transaction.update") ? (
            <ActionForm action={assignStaffAction.bind(null, tx.id)} submitLabel="Save assignment" size="sm" resetOnSuccess={false}>
              <Field label="Escrow officer" htmlFor="officerId">
                <Select id="officerId" name="officerId" defaultValue={tx.officerId ?? ""}>
                  <option value="">Unassigned</option>
                  {staff
                    .filter((s) => ["ESCROW_OFFICER", "COMPANY_ADMIN", "MANAGER"].includes(s.role))
                    .map((s) => (
                      <option key={s.userId} value={s.userId}>
                        {s.user.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Escrow assistant" htmlFor="assistantId">
                <Select id="assistantId" name="assistantId" defaultValue={tx.assistantId ?? ""}>
                  <option value="">Unassigned</option>
                  {staff.map((s) => (
                    <option key={s.userId} value={s.userId}>
                      {s.user.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </ActionForm>
          ) : (
            <p className="text-sm">Officer: {names.get(tx.officerId ?? "") ?? "Unassigned"}</p>
          )}
        </Card>

        <Card title="File configuration">
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-xs uppercase text-slate-500">Workflow template</dt>
              <dd>
                {templateVersion?.template.name} v{templateVersion?.version}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-500">Retention</dt>
              <dd>{tx.legalHold ? "Legal hold: retention purge suspended" : "Company default retention policy"}</dd>
            </div>
          </dl>
          {def.disclaimer && <p className="mt-3 text-xs text-slate-500">{def.disclaimer}</p>}
          {hasPermission(ctx, "document.legal_hold") && (
            <ActionForm action={legalHoldAction.bind(null, tx.id)} submitLabel={tx.legalHold ? "Release legal hold" : "Apply legal hold"} size="sm" variant="secondary" className="mt-3">
              <input type="hidden" name="hold" value={tx.legalHold ? "off" : "on"} />
              <Field label="Reason" htmlFor="lh-reason" required>
                <Input id="lh-reason" name="reason" required />
              </Field>
            </ActionForm>
          )}
        </Card>
      </div>
    </div>
  );
}

function FieldInput({ kind, name, value, options }: { kind: string; name: string; value: unknown; options?: readonly string[] }) {
  const id = `v-${name}`;
  if (kind === "boolean") {
    return (
      <Field label="Value" htmlFor={id}>
        <Select id={id} name="valueBool" defaultValue={value ? "true" : "false"}>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      </Field>
    );
  }
  if (kind === "enum") {
    return (
      <Field label="Value" htmlFor={id}>
        <Select id={id} name="value" defaultValue={(value as string) ?? ""}>
          <option value="">Unknown</option>
          {options?.map((o) => (
            <option key={o} value={o}>
              {humanize(o)}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  const display = kind === "money" && value != null ? (BigInt(value as string) / 100n).toString() + "." + (BigInt(value as string) % 100n).toString().padStart(2, "0") : ((value as string) ?? "");
  return (
    <Field label="Value" htmlFor={id} hint={kind === "money" ? "Dollars and cents, e.g. 1250.00" : undefined}>
      <Input id={id} name="value" type={kind === "date" ? "date" : "text"} defaultValue={display} inputMode={kind === "money" ? "decimal" : undefined} />
    </Field>
  );
}

function StatusChange({ txId, version, kind, label, danger, stages, defaultStage }: { txId: string; version: number; kind: string; label: string; danger?: boolean; stages?: { key: string; label: string }[]; defaultStage?: string }) {
  return (
    <details className="w-full sm:w-auto">
      <summary className={`cursor-pointer text-sm ${danger ? "text-red-700" : "text-brand-700"}`}>{label}</summary>
      <ActionForm action={statusAction.bind(null, txId)} submitLabel={label} size="sm" variant={danger ? "danger" : "primary"} className="mt-2 w-72" confirm={danger ? "Cancel this file? It can be reopened later by a manager." : undefined}>
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="expectedVersion" value={version} />
        {stages && (
          <Field label="Reopen into stage" htmlFor={`rs-${kind}`}>
            <Select id={`rs-${kind}`} name="reopenStage" defaultValue={defaultStage}>
              {stages.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Reason" htmlFor={`sr-${kind}`} required>
          <Input id={`sr-${kind}`} name="reason" required minLength={3} />
        </Field>
      </ActionForm>
    </details>
  );
}
