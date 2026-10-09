import { getWorkspace, staffNames } from "../data";
import { db } from "@/server/db";
import { hasPermission } from "@/server/context";
import { listStaff } from "@/server/services/users";
import { stageLabel } from "@/server/workflow/engine";
import { getCompanySettings } from "@/server/settings";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, EmptyState, Field, Input, Select, StatusBadge, Textarea, humanize } from "@/components/ui";
import { createTaskAction, reopenTaskAction, resolveTaskAction, updateTaskAction } from "../actions";
import { displayDate, todayInZone } from "@/lib/dates";

const RESOLVED = ["DONE", "NOT_APPLICABLE", "WAIVED"];

export default async function TasksPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ show?: string }> }) {
  const { id } = await params;
  const { show } = await searchParams;
  const { ctx, tx, def } = await getWorkspace(id);
  const [tasks, docs, staff, names, participants, settings] = await Promise.all([
    db.task.findMany({ where: { transactionId: tx.id }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    db.document.findMany({ where: { transactionId: tx.id, archivedAt: null }, select: { id: true, title: true } }),
    listStaff(ctx),
    staffNames(ctx.companyId),
    db.participant.findMany({ where: { transactionId: tx.id }, select: { id: true, displayName: true, role: true } }),
    getCompanySettings(ctx.companyId),
  ]);
  const today = todayInZone(settings.timezone);
  const blockers = tasks.filter((t) => t.isBlocker && !RESOLVED.includes(t.status));
  const visible = show === "all" ? tasks : tasks.filter((t) => !RESOLVED.includes(t.status));
  const stageOrder = def.stages.map((s) => s.key);
  const groups = stageOrder.map((s) => ({ stage: s, items: visible.filter((t) => (t.stage ?? "") === s && !t.isBlocker) })).filter((g) => g.items.length);
  const others = visible.filter((t) => !t.isBlocker && (!t.stage || !stageOrder.includes(t.stage)));
  const canManage = hasPermission(ctx, "task.manage");
  const participantName = new Map(participants.map((p) => [p.id, p.displayName]));
  const resolvedCount = tasks.filter((t) => RESOLVED.includes(t.status)).length;

  const renderTask = (t: (typeof tasks)[number]) => {
    const overdue = t.dueAt && t.dueAt < today && !RESOLVED.includes(t.status);
    return (
      <li key={t.id} className="py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium text-slate-900">{t.title}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <StatusBadge status={t.status} />
              {t.required && <Badge tone="brand">Required</Badge>}
              {t.isBlocker && <Badge tone="danger">Blocker</Badge>}
              {t.requiresApproval && <Badge tone="warning">Needs approval</Badge>}
              {t.source === "AI_PROPOSAL" && <Badge tone="purple">From accepted proposal</Badge>}
              <Badge>{humanize(t.category)}</Badge>
            </div>
            {t.description && <p className="mt-1 text-sm text-slate-600">{t.description}</p>}
            {t.applicabilityNote && <p className="mt-1 text-xs text-slate-500">Applicability: {t.applicabilityNote.replace("[auto] ", "")}</p>}
            <div className="mt-1 text-xs text-slate-500">
              {t.dueAt ? <span className={overdue ? "font-medium text-red-700" : ""}>Due {displayDate(t.dueAt)}{overdue ? " (overdue)" : ""}</span> : "No due date"}
              {" · "}
              {t.assigneeUserId ? names.get(t.assigneeUserId) : "Unassigned"}
              {t.responsibleParticipantId && ` · Responsible: ${participantName.get(t.responsibleParticipantId)}`}
              {t.completedAt && ` · Resolved ${displayDate(t.completedAt)} by ${names.get(t.completedById ?? "") ?? "—"}`}
              {t.resolutionNote && ` · “${t.resolutionNote}”`}
            </div>
          </div>
          {canManage && tx.status === "ACTIVE" && (
            <div className="flex flex-wrap items-start gap-2">
              {!RESOLVED.includes(t.status) && t.status !== "WAITING" && (
                <details>
                  <summary className="cursor-pointer rounded border border-slate-300 bg-white px-2 py-1 text-xs">Resolve</summary>
                  <ActionForm action={resolveTaskAction.bind(null, tx.id, t.id)} submitLabel="Save" size="sm" className="mt-2 w-72">
                    <input type="hidden" name="expectedVersion" value={t.version} />
                    <Field label="Resolution" htmlFor={`st-${t.id}`}>
                      <Select id={`st-${t.id}`} name="status" defaultValue="DONE">
                        <option value="DONE">{t.requiresApproval ? "Done (send for approval)" : "Done"}</option>
                        <option value="NOT_APPLICABLE">Not applicable</option>
                        {(!t.required || hasPermission(ctx, "task.waive")) && <option value="WAIVED">Waived</option>}
                      </Select>
                    </Field>
                    <Field label="Note" htmlFor={`nt-${t.id}`} hint="Required for waived / not applicable">
                      <Input id={`nt-${t.id}`} name="note" />
                    </Field>
                    <Field label="Evidence" htmlFor={`ev-${t.id}`}>
                      <Select id={`ev-${t.id}`} name="evidenceDocumentId" defaultValue={t.evidenceDocumentId ?? ""}>
                        <option value="">None</option>
                        {docs.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.title}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </ActionForm>
                </details>
              )}
              {!RESOLVED.includes(t.status) && (
                <details>
                  <summary className="cursor-pointer rounded border border-slate-300 bg-white px-2 py-1 text-xs">Edit</summary>
                  <ActionForm action={updateTaskAction.bind(null, tx.id, t.id)} submitLabel="Save" size="sm" className="mt-2 w-64" resetOnSuccess={false}>
                    <Field label="Status" htmlFor={`s2-${t.id}`}>
                      <Select id={`s2-${t.id}`} name="status" defaultValue={t.status}>
                        {["OPEN", "IN_PROGRESS", "WAITING"].map((s) => (
                          <option key={s} value={s}>
                            {humanize(s)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Assignee" htmlFor={`as-${t.id}`}>
                      <Select id={`as-${t.id}`} name="assigneeUserId" defaultValue={t.assigneeUserId ?? ""}>
                        <option value="">Unassigned</option>
                        {staff.map((s) => (
                          <option key={s.userId} value={s.userId}>
                            {s.user.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Due date" htmlFor={`dd-${t.id}`}>
                      <Input id={`dd-${t.id}`} name="dueDate" type="date" defaultValue={t.dueAt ? t.dueAt.toISOString().slice(0, 10) : ""} />
                    </Field>
                  </ActionForm>
                </details>
              )}
              {RESOLVED.includes(t.status) && (
                <ActionForm action={reopenTaskAction.bind(null, tx.id, t.id)} submitLabel="Reopen" size="sm" variant="ghost" inline>
                  <input type="hidden" name="reason" value="Reopened from task list" />
                </ActionForm>
              )}
            </div>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div className="space-y-6 xl:col-span-2">
        <Card title="Blockers" description="Open blockers prevent stage moves that check for them and always prevent closing.">
          {blockers.length === 0 ? <p className="text-sm text-slate-500">No open blockers.</p> : <ul className="divide-y divide-slate-100">{blockers.map(renderTask)}</ul>}
        </Card>
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-600">
            {tasks.length - resolvedCount} open · {resolvedCount} resolved
          </p>
          <a className="text-sm text-brand-700 hover:underline" href={show === "all" ? "?" : "?show=all"}>
            {show === "all" ? "Hide resolved" : "Show resolved"}
          </a>
        </div>
        {groups.length === 0 && others.length === 0 && <EmptyState title="No open tasks">All tasks are resolved.</EmptyState>}
        {groups.map((g) => (
          <Card key={g.stage} title={stageLabel(def, g.stage)} description={g.stage === tx.stage ? "Current stage" : undefined}>
            <ul className="divide-y divide-slate-100">{g.items.map(renderTask)}</ul>
          </Card>
        ))}
        {others.length > 0 && (
          <Card title="Other tasks">
            <ul className="divide-y divide-slate-100">{others.map(renderTask)}</ul>
          </Card>
        )}
      </div>
      {canManage && (
        <Card title="Add task or blocker">
          <ActionForm action={createTaskAction.bind(null, tx.id)} submitLabel="Add">
            <Field label="Title" htmlFor="t-title" required>
              <Input id="t-title" name="title" required minLength={2} />
            </Field>
            <Field label="Details" htmlFor="t-desc">
              <Textarea id="t-desc" name="description" rows={2} />
            </Field>
            <Field label="Assignee" htmlFor="t-as">
              <Select id="t-as" name="assigneeUserId" defaultValue="">
                <option value="">Unassigned</option>
                {staff.map((s) => (
                  <option key={s.userId} value={s.userId}>
                    {s.user.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Responsible participant" htmlFor="t-rp">
              <Select id="t-rp" name="responsibleParticipantId" defaultValue="">
                <option value="">None</option>
                {participants.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName} ({humanize(p.role)})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Due date" htmlFor="t-due">
              <Input id="t-due" name="dueDate" type="date" />
            </Field>
            <div className="space-y-1 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" name="required" /> Required before closing
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="isBlocker" /> This is a blocker
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="requiresApproval" /> Completion needs approval
              </label>
            </div>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
