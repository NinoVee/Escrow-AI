import Link from "next/link";
import { ActionForm } from "./action-form";
import { Badge, Input, humanize } from "./ui";
import { displayValue, fieldDef } from "@/server/fields";
import { displayDate } from "@/lib/dates";
import { acceptProposalAction, rejectProposalAction } from "@/app/(staff)/transactions/[id]/ai-actions";
import type { Proposal } from "@/generated/prisma/client";

function show(fieldPath: string | null, v: unknown) {
  if (!fieldPath) return String(v);
  const def = fieldDef(fieldPath);
  if (def?.kind === "date") return displayDate(v as string);
  return displayValue(fieldPath, v);
}

function describe(p: Proposal) {
  const v = p.proposedValue as Record<string, unknown>;
  switch (p.kind) {
    case "FIELD":
      return { label: fieldDef(p.fieldPath ?? "")?.label ?? p.fieldPath, value: show(p.fieldPath, p.proposedValue) };
    case "PARTY":
      return { label: `${humanize(String(v.role))} (${humanize(String(v.partyType))})`, value: String(v.name) };
    case "PROPERTY":
      return { label: "Property / parcel", value: [v.address, v.apn ? `APN ${v.apn}` : null].filter(Boolean).join(" · ") };
    case "DEADLINE":
      return { label: `Deadline (${humanize(String(v.type))})`, value: `${v.title}: ${v.date ? displayDate(String(v.date)) : "date needed"}` };
    case "TASK":
      return { label: "Task", value: String(v.title) };
    case "TITLE_EXCEPTION":
      return { label: `Title item ${v.itemNumber ?? ""} (${humanize(String(v.category))})`, value: String(v.text) };
  }
}

export function ProposalCard({ p, txId, docTitle, canReview, showSource = true }: { p: Proposal; txId: string; docTitle?: string; canReview: boolean; showSource?: boolean }) {
  const d = describe(p);
  const v = p.proposedValue as Record<string, unknown>;
  return (
    <li className={`rounded-md border p-3 ${p.isConflict ? "border-red-300 bg-red-50/40" : p.lowConfidence ? "border-amber-300 bg-amber-50/40" : "border-slate-200"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="purple">Proposed</Badge>
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{d.label}</span>
            {p.isConflict && <Badge tone="danger">Conflict</Badge>}
            {p.lowConfidence && <Badge tone="warning">Low confidence</Badge>}
            {p.confidence != null && <span className="text-xs text-slate-500">conf. {p.confidence.toFixed(2)}</span>}
          </div>
          <div className="mt-1 text-base font-medium text-slate-900">{d.value}</div>
          {p.kind === "FIELD" && p.currentValue !== null && p.currentValue !== undefined && (
            <div className="text-sm text-slate-600">
              Accepted value: <strong>{show(p.fieldPath, p.currentValue)}</strong>
            </div>
          )}
          {p.kind === "TITLE_EXCEPTION" && v.summary ? <div className="mt-1 text-xs text-violet-800">Descriptive summary (not a legal conclusion): {String(v.summary)}</div> : null}
          {p.conflictNote && <div className="mt-1 text-xs text-red-800">{p.conflictNote}</div>}
          {p.rationale && <div className="mt-1 text-xs text-slate-600">{p.rationale}</div>}
          {showSource && (
            <div className="mt-2 text-xs text-slate-600">
              Source:{" "}
              {p.documentId ? (
                <Link className="text-brand-700 hover:underline" href={`/transactions/${txId}/documents/${p.documentId}${p.page ? `?page=${p.page}` : ""}`}>
                  {docTitle ?? "document"}
                  {p.page ? `, page ${p.page}` : ", page unknown"}
                </Link>
              ) : (
                "unknown"
              )}
              {p.excerpt && <blockquote className="mt-1 border-l-2 border-slate-300 pl-2 italic">“{p.excerpt}”</blockquote>}
            </div>
          )}
        </div>
        {canReview && (
          <div className="flex w-full flex-wrap gap-3 sm:w-auto sm:flex-col">
            <ActionForm action={acceptProposalAction.bind(null, txId, p.id)} submitLabel="Accept" size="sm" className="sm:w-56">
              {(p.kind === "FIELD" || p.kind === "PARTY" || p.kind === "TASK") && (
                <Input name="overrideValue" placeholder="Correct value (optional)" aria-label="Corrected value" />
              )}
              {p.kind === "DEADLINE" && !v.date && <Input name="date" type="date" required aria-label="Due date" />}
              {p.isConflict && (
                <label className="flex items-start gap-1.5 text-xs text-red-900">
                  <input type="checkbox" name="confirmConflict" required /> I compared both sources and this value should replace the other.
                </label>
              )}
            </ActionForm>
            <ActionForm action={rejectProposalAction.bind(null, txId, p.id)} submitLabel="Reject" size="sm" variant="secondary" className="sm:w-56">
              <Input name="note" placeholder="Reason" required aria-label="Rejection reason" />
            </ActionForm>
          </div>
        )}
      </div>
    </li>
  );
}
