import type { Metadata } from "next";
import { requireStaffCtx } from "@/server/auth/session";
import { hasPermission } from "@/server/context";
import { reconciliationWorkspace } from "@/server/services/reconciliation";
import { staffNames } from "../transactions/[id]/data";
import { db } from "@/server/db";
import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, EmptyState, Field, Input, PageHeader, Select, StatusBadge, Table, Td, Th, humanize } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { displayDate, displayDateTime } from "@/lib/dates";
import { autoMatchAction, confirmFundingAction, importAction, manualMatchAction, reviewReconAction, runReconAction } from "./actions";

export const metadata: Metadata = { title: "Reconciliation" };

type Details = {
  depositsInTransit: { entryNumber: number; date: string; memo: string; amountCents: string; file: string | null }[];
  outstandingDisbursements: { entryNumber: number; date: string; memo: string; amountCents: string; file: string | null }[];
  unmatchedBankItems: { date: string; description: string; amountCents: string }[];
  fileBalances: { file: string; balanceCents: string }[];
  negativeFiles: { file: string | null; balanceCents: string }[];
};

export default async function ReconciliationPage() {
  const ctx = await requireStaffCtx();
  if (!hasPermission(ctx, "ledger.read")) return <Alert tone="info">Your role does not include ledger access.</Alert>;
  const [ws, names] = await Promise.all([reconciliationWorkspace(ctx), staffNames(ctx.companyId)]);
  const canPrepare = hasPermission(ctx, "recon.prepare");
  const entries = canPrepare
    ? await db.journalEntry.findMany({ where: { companyId: ctx.companyId }, orderBy: { entryNumber: "desc" }, take: 100, select: { id: true, entryNumber: true, memo: true, effectiveDate: true } })
    : [];

  return (
    <>
      <PageHeader title="Reconciliation" description="Three-way comparison of the bank statement, the trust book balance and the sum of escrow-file balances in the internal tracking ledger." />
      <div className="mb-6">
        <Alert tone="warning">This reconciles EscrowFlow&apos;s internal tracking ledger. It is not a substitute for the reconciliation required of your trust accounting system of record.</Alert>
      </div>
      {ws.length === 0 && <EmptyState title="No bank accounts configured" />}
      {ws.map(({ account, imports, unmatched, recent, reconciliations, bookBalance }) => (
        <div key={account.id} className="space-y-6">
          <h2 className="text-lg font-semibold">
            {account.name} <span className="text-sm font-normal text-slate-500">· {account.bankName} ••••{account.accountLast4} · book balance {formatCents(bookBalance)}</span>
          </h2>
          <div className="grid gap-6 xl:grid-cols-3">
            {canPrepare && (
              <Card title="Import bank statement" description="CSV with date, description, amount (and transaction ID if available). Re-importing the same file or overlapping rows never creates duplicates.">
                <ActionForm action={importAction.bind(null, account.id)} submitLabel="Import">
                  <Field label="CSV file" htmlFor={`f-${account.id}`} required>
                    <input id={`f-${account.id}`} type="file" name="file" accept=".csv,text/csv" required className="block w-full text-sm" />
                  </Field>
                  <Field label="Statement date" htmlFor={`sd-${account.id}`} required>
                    <Input id={`sd-${account.id}`} name="statementDate" type="date" required />
                  </Field>
                  <Field label="Statement ending balance" htmlFor={`eb-${account.id}`} required>
                    <Input id={`eb-${account.id}`} name="endingBalance" inputMode="decimal" required />
                  </Field>
                </ActionForm>
              </Card>
            )}
            <Card title={`Unmatched bank activity (${unmatched.length})`} className="xl:col-span-2" actions={canPrepare && unmatched.length > 0 ? <ActionForm action={autoMatchAction.bind(null, account.id)} submitLabel="Auto-match" size="sm" variant="secondary" inline>{null}</ActionForm> : undefined}>
              {unmatched.length === 0 ? (
                <p className="text-sm text-slate-500">Everything imported is matched to the ledger.</p>
              ) : (
                <Table caption="Unmatched bank transactions">
                  <thead>
                    <tr>
                      <Th>Date</Th>
                      <Th>Description</Th>
                      <Th className="text-right">Amount</Th>
                      <Th>Match to entry</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {unmatched.map((b) => (
                      <tr key={b.id}>
                        <Td className="whitespace-nowrap tabular">{displayDate(b.postedDate)}</Td>
                        <Td>{b.description}</Td>
                        <Td className="text-right tabular">{formatCents(b.amountCents)}</Td>
                        <Td>
                          {canPrepare && (
                            <ActionForm action={manualMatchAction.bind(null, b.id)} submitLabel="Match" size="sm" variant="ghost" inline>
                              <Select name="entryId" aria-label="Journal entry" className="w-56" required>
                                <option value="">Choose entry…</option>
                                {entries.map((e) => (
                                  <option key={e.id} value={e.id}>
                                    #{e.entryNumber} {displayDate(e.effectiveDate)} {e.memo.slice(0, 40)}
                                  </option>
                                ))}
                              </Select>
                            </ActionForm>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {recent.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-slate-600">Recently matched ({recent.length})</summary>
                  <ul className="mt-2 space-y-1 text-xs">
                    {recent.map((b) => (
                      <li key={b.id} className="flex flex-wrap items-center gap-2">
                        {displayDate(b.postedDate)} · {b.description} · {formatCents(b.amountCents)}
                        {b.amountCents > 0n && hasPermission(ctx, "milestone.confirm_funding") && (
                          <ActionForm action={confirmFundingAction.bind(null, b.id)} submitLabel="Confirm file funding from this credit" size="sm" variant="ghost" inline>
                            {null}
                          </ActionForm>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </Card>
          </div>

          <Card
            title="Reconciliations"
            actions={
              canPrepare && imports.length > 0 ? (
                <ActionForm action={runReconAction.bind(null, account.id)} submitLabel="Run reconciliation" size="sm" inline>
                  <Select name="statementId" aria-label="Statement" className="w-64">
                    {imports.map((i) => (
                      <option key={i.id} value={i.id}>
                        {displayDate(i.statementDate)} · {i.filename} · {formatCents(i.endingBalanceCents)}
                      </option>
                    ))}
                  </Select>
                </ActionForm>
              ) : undefined
            }
          >
            {reconciliations.length === 0 ? (
              <EmptyState title="No reconciliations yet">Import a statement, match activity, then run a reconciliation.</EmptyState>
            ) : (
              <ul className="space-y-4">
                {reconciliations.map((r) => {
                  const d = r.details as unknown as Details;
                  return (
                    <li key={r.id} className="rounded-md border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-medium">As of {displayDate(r.periodEnd)}</div>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={r.status === "BALANCED" || r.status === "REVIEWED" ? "DONE" : "ERROR"} label={humanize(r.status)} />
                          {canPrepare && r.status !== "REVIEWED" && (
                            <ActionForm action={reviewReconAction.bind(null, r.id)} submitLabel="Request review" size="sm" variant="secondary" inline>
                              {null}
                            </ActionForm>
                          )}
                        </div>
                      </div>
                      <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                        <div>
                          <dt className="text-xs text-slate-500">Statement balance</dt>
                          <dd className="tabular">{formatCents(r.bankBalanceCents)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-slate-500">+ Deposits in transit / − outstanding</dt>
                          <dd className="tabular">
                            {formatCents(r.outstandingDepositsCents)} / {formatCents(r.outstandingChecksCents)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-slate-500">Adjusted bank / book</dt>
                          <dd className="tabular">
                            {formatCents(r.adjustedBankCents)} / {formatCents(r.bookBalanceCents)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-slate-500">Sum of file balances</dt>
                          <dd className="tabular">{formatCents(r.fileBalancesTotalCents)}</dd>
                        </div>
                      </dl>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        <Badge tone={r.bankVsBookCents === 0n ? "success" : "danger"}>Bank vs book {formatCents(r.bankVsBookCents)}</Badge>
                        <Badge tone={r.bookVsFilesCents === 0n ? "success" : "danger"}>Book vs files {formatCents(r.bookVsFilesCents)}</Badge>
                        <Badge tone={d.unmatchedBankItems.length ? "danger" : "success"}>{d.unmatchedBankItems.length} unresolved bank item(s)</Badge>
                        {d.negativeFiles.length > 0 && <Badge tone="danger">{d.negativeFiles.length} negative file(s)</Badge>}
                      </div>
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer text-slate-600">Details</summary>
                        <div className="mt-2 grid gap-3 md:grid-cols-2">
                          <div>
                            <div className="font-medium">Deposits in transit</div>
                            {d.depositsInTransit.length === 0 ? "None" : d.depositsInTransit.map((x) => <div key={x.entryNumber}>#{x.entryNumber} {x.date} {x.file ?? ""} {formatCents(BigInt(x.amountCents))}</div>)}
                            <div className="mt-2 font-medium">Outstanding disbursements</div>
                            {d.outstandingDisbursements.length === 0 ? "None" : d.outstandingDisbursements.map((x) => <div key={x.entryNumber}>#{x.entryNumber} {x.date} {x.file ?? ""} {formatCents(BigInt(x.amountCents))}</div>)}
                          </div>
                          <div>
                            <div className="font-medium">Unresolved bank items</div>
                            {d.unmatchedBankItems.length === 0 ? "None" : d.unmatchedBankItems.map((x, i) => <div key={i}>{x.date} {x.description} {formatCents(BigInt(x.amountCents))}</div>)}
                            <div className="mt-2 font-medium">File balances</div>
                            {d.fileBalances.map((x, i) => (
                              <div key={i}>
                                {x.file}: {formatCents(BigInt(x.balanceCents))}
                              </div>
                            ))}
                          </div>
                        </div>
                      </details>
                      <p className="mt-1 text-xs text-slate-500">
                        Prepared by {names.get(r.preparedById)} {displayDateTime(r.createdAt)}
                        {r.reviewedById && ` · reviewed by ${names.get(r.reviewedById)} ${displayDateTime(r.reviewedAt)}`}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      ))}
    </>
  );
}
