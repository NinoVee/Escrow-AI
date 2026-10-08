import Link from "next/link";
import { db } from "@/server/db";
import { can, type Permission } from "@/server/authz";
import { STEP_UP_APPROVAL_TYPES } from "@/server/services/approvals";
import type { Ctx } from "@/server/context";
import { ActionForm } from "./action-form";
import { Badge, Input, StatusBadge, humanize } from "./ui";
import { cancelApprovalAction, decideApprovalAction } from "@/app/(staff)/approvals/actions";
import { displayDateTime } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import type { Approval } from "@/generated/prisma/client";

type Row = Approval & { transaction?: { escrowNumber: string } | null };

function renderValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (/Cents$/.test(key) && (typeof v === "string" || typeof v === "number")) return formatCents(BigInt(v));
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const HIDDEN_KEYS = new Set(["transactionId", "templateVersionId", "taskId", "signerId", "participantId", "disbursementId"]);

export async function ApprovalList({ ctx, approvals, showFile = true }: { ctx: Ctx; approvals: Row[]; showFile?: boolean }) {
  const userIds = [...new Set(approvals.flatMap((a) => [a.requestedById, a.decidedById]).filter(Boolean) as string[])];
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const name = new Map(users.map((u) => [u.id, u.name]));
  return (
    <ul className="divide-y divide-slate-100">
      {approvals.map((a) => {
        const eligible = a.status === "PENDING" && a.requestedById !== ctx.userId && can(ctx.role, a.requiredPermission as Permission);
        const snapshot = Object.entries((a.bindingSnapshot ?? {}) as Record<string, unknown>).filter(([k]) => !HIDDEN_KEYS.has(k));
        return (
          <li key={a.id} id={a.id} className="py-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="brand">{humanize(a.type)}</Badge>
                  <span className="font-medium">{a.title}</span>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {showFile && a.transactionId && a.transaction && (
                    <>
                      <Link className="text-brand-700 hover:underline" href={`/transactions/${a.transactionId}/approvals`}>
                        {a.transaction.escrowNumber}
                      </Link>{" "}
                      ·{" "}
                    </>
                  )}
                  Requested by {name.get(a.requestedById) ?? "—"} · {displayDateTime(a.createdAt)} · needs <code>{a.requiredPermission}</code>
                  {STEP_UP_APPROVAL_TYPES.includes(a.type) && " · step-up authentication required"}
                </div>
                {a.summary && <p className="mt-1 text-sm text-slate-700">{a.summary}</p>}
                {snapshot.length > 0 && (
                  <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 rounded-md bg-slate-50 p-2 text-xs sm:grid-cols-2">
                    {snapshot.map(([k, v]) => (
                      <div key={k} className="flex gap-1">
                        <dt className="text-slate-500">{humanize(k.replace(/Cents$/, "").replace(/([A-Z])/g, "_$1"))}:</dt>
                        <dd className="font-medium text-slate-800">{renderValue(k, v)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                <p className="mt-1 font-mono text-[10px] text-slate-400" title="Hash of the approved item state">
                  binding {a.bindingHash.slice(0, 16)}…
                </p>
                {a.decidedById && (
                  <p className="mt-1 text-xs text-slate-600">
                    {humanize(a.status)} by {name.get(a.decidedById)} · {displayDateTime(a.decidedAt)}
                    {a.decisionNote ? ` · “${a.decisionNote}”` : ""}
                    {a.stepUpVerified && " · step-up verified"}
                  </p>
                )}
                {a.invalidatedReason && <p className="mt-1 text-xs text-red-700">Invalidated: {a.invalidatedReason}</p>}
              </div>
              <StatusBadge status={a.status} />
            </div>
            {eligible && (
              <div className="mt-3 flex flex-wrap gap-3">
                <ActionForm action={decideApprovalAction.bind(null, a.id)} submitLabel="Approve" size="sm" inline>
                  <input type="hidden" name="decision" value="APPROVED" />
                  <Input name="note" placeholder="Note (optional)" aria-label="Approval note" className="w-56" />
                </ActionForm>
                <ActionForm action={decideApprovalAction.bind(null, a.id)} submitLabel="Reject" size="sm" variant="danger" inline>
                  <input type="hidden" name="decision" value="REJECTED" />
                  <Input name="note" placeholder="Reason (required)" aria-label="Rejection reason" required className="w-56" />
                </ActionForm>
              </div>
            )}
            {a.status === "PENDING" && a.requestedById === ctx.userId && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                You requested this; someone else must decide it.
                <ActionForm action={cancelApprovalAction.bind(null, a.id)} submitLabel="Withdraw request" size="sm" variant="ghost" inline>
                  {null}
                </ActionForm>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
