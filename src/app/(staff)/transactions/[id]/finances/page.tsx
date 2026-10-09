import Link from "next/link";
import { getWorkspace, staffNames } from "../data";
import { db } from "@/server/db";
import { hasPermission } from "@/server/context";
import { fileLedger } from "@/server/ledger/journal";
import { draftStatement, SETTLEMENT_DISCLAIMER } from "@/server/services/settlement";
import { listBankInstructions, listDisbursements, PAYMENT_EXECUTION_ENABLED } from "@/server/services/payments";
import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, EmptyState, Field, Input, Select, StatusBadge, Table, Td, Th, humanize } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { displayDate, displayDateTime, formatDateOnly, todayInZone } from "@/lib/dates";
import {
  addItemAction,
  cancelDisbursementAction,
  prepareDisbursementAction,
  receiptAction,
  releaseDisbursementAction,
  removeItemAction,
  reverseAction,
  saveInstructionAction,
  snapshotAction,
  submitDisbursementAction,
  verifyInstructionAction,
} from "../finance-actions";
import { RevealButton } from "./reveal";

const money = (c: bigint) => (c === 0n ? "" : formatCents(c));

export default async function FinancesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, tx } = await getWorkspace(id);
  if (!hasPermission(ctx, "ledger.read")) {
    return <Alert tone="info">Your role does not include access to the file ledger.</Alert>;
  }
  const [ledger, statement, instructions, disbursements, names, participants, docs, snapshots] = await Promise.all([
    fileLedger(ctx, tx.id),
    draftStatement(ctx, tx.id),
    hasPermission(ctx, "bank.view_masked") ? listBankInstructions(ctx, tx.id) : Promise.resolve([]),
    listDisbursements(ctx, tx.id),
    staffNames(ctx.companyId),
    db.participant.findMany({ where: { transactionId: tx.id }, select: { id: true, displayName: true, role: true } }),
    db.document.findMany({ where: { transactionId: tx.id, archivedAt: null }, select: { id: true, title: true } }),
    db.settlementStatement.findMany({ where: { transactionId: tx.id }, orderBy: { version: "desc" }, take: 5 }),
  ]);
  const verified = instructions.filter((i) => i.status === "VERIFIED");
  const groups = [...new Set(instructions.map((i) => i.groupId))].map((g) => instructions.filter((i) => i.groupId === g));
  const today = formatDateOnly(todayInZone());

  return (
    <div className="space-y-6">
      <Alert tone="warning" title="Internal tracking ledger">
        EscrowFlow does not hold money, move money or replace your approved trust accounting system. Payment execution is {PAYMENT_EXECUTION_ENABLED ? "enabled" : "disabled"}: releases are recorded only after they are executed through your approved banking process.
      </Alert>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="File ledger" className="xl:col-span-2" description="Double-entry, integer cents. Posted entries cannot be edited; corrections are reversals." actions={<span className="text-sm">Balance held: <strong className="tabular">{formatCents(ledger.balance)}</strong></span>}>
          {ledger.entries.length === 0 ? (
            <EmptyState title="No ledger activity for this file" />
          ) : (
            <Table caption="Journal entries">
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Date</Th>
                  <Th>Memo</Th>
                  <Th className="text-right">Into file</Th>
                  <Th className="text-right">Out of file</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ledger.entries.map((e) => {
                  const liab = e.lines.filter((l) => l.account.purpose === "ESCROW_LIABILITY" && l.transactionId === tx.id);
                  const inn = liab.reduce((a, l) => a + l.creditCents, 0n);
                  const out = liab.reduce((a, l) => a + l.debitCents, 0n);
                  return (
                    <tr key={e.id}>
                      <Td className="tabular">{e.entryNumber}</Td>
                      <Td className="whitespace-nowrap tabular">{displayDate(e.effectiveDate)}</Td>
                      <Td>
                        {e.memo}
                        <div className="text-xs text-slate-500">
                          {humanize(e.kind)}
                          {e.reference ? ` · ref ${e.reference}` : ""} · {names.get(e.postedById) ?? "—"}
                          {ledger.reversedIds.has(e.id) && <Badge tone="neutral" className="ml-1">Reversed</Badge>}
                        </div>
                      </Td>
                      <Td className="text-right tabular text-emerald-800">{money(inn)}</Td>
                      <Td className="text-right tabular text-red-800">{money(out)}</Td>
                      <Td>
                        {hasPermission(ctx, "ledger.post") && e.kind !== "REVERSAL" && !ledger.reversedIds.has(e.id) && (
                          <details>
                            <summary className="cursor-pointer text-xs text-brand-700">Reverse</summary>
                            <ActionForm action={reverseAction.bind(null, tx.id, e.id)} submitLabel="Post reversal" size="sm" variant="danger" className="mt-1 w-56">
                              <Input name="reason" placeholder="Reason" required aria-label="Reason" />
                            </ActionForm>
                          </details>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
        {hasPermission(ctx, "ledger.post") && (
          <Card title="Record receipt" description="Funds received into the trust account for this file.">
            <ActionForm action={receiptAction.bind(null, tx.id)} submitLabel="Post receipt">
              <Field label="Amount" htmlFor="r-amount" required>
                <Input id="r-amount" name="amount" inputMode="decimal" required placeholder="26,250.00" />
              </Field>
              <Field label="Date received" htmlFor="r-date" required>
                <Input id="r-date" name="date" type="date" required defaultValue={today} />
              </Field>
              <Field label="Memo" htmlFor="r-memo" required>
                <Input id="r-memo" name="memo" required placeholder="Initial deposit from buyer" />
              </Field>
              <Field label="Bank reference" htmlFor="r-ref" hint="Used to prevent duplicate posting">
                <Input id="r-ref" name="reference" />
              </Field>
            </ActionForm>
          </Card>
        )}
      </div>

      <Card
        title="Draft settlement statement"
        description={SETTLEMENT_DISCLAIMER}
        actions={
          <>
            {statement.ready && (
              <Link className="text-sm text-brand-700 hover:underline" href={`/transactions/${tx.id}/finances/statement`}>
                Printable draft
              </Link>
            )}
            {statement.ready && hasPermission(ctx, "transaction.update") && (
              <ActionForm action={snapshotAction.bind(null, tx.id)} submitLabel="Save draft version" size="sm" variant="secondary" inline>
                {null}
              </ActionForm>
            )}
          </>
        }
      >
        {!statement.ready ? (
          <Alert tone="info">{statement.reason}</Alert>
        ) : (
          <>
            <p className="mb-2 text-xs text-slate-500">
              Settlement date {displayDate(statement.settlementDate)} · prorations {statement.conventions.basis.replace("_", "/")} · rounding {statement.conventions.rounding.replace("_", " ").toLowerCase()} · seller {statement.conventions.sellerOwnsClosingDay ? "owns" : "does not own"} the closing day
            </p>
            {statement.warnings.map((w, i) => (
              <Alert key={i} tone="warning">
                {w}
              </Alert>
            ))}
            <Table caption="Draft statement">
              <thead>
                <tr>
                  <Th>Item</Th>
                  <Th className="text-right">Buyer debit</Th>
                  <Th className="text-right">Buyer credit</Th>
                  <Th className="text-right">Seller debit</Th>
                  <Th className="text-right">Seller credit</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {statement.lines.map((l, i) => (
                  <tr key={i}>
                    <Td>
                      {l.description}
                      {l.payee && <span className="text-xs text-slate-500"> · {l.payee}</span>}
                      {l.detail && <div className="text-xs text-slate-500">{l.detail}</div>}
                    </Td>
                    <Td className="text-right tabular">{money(l.buyerDebit)}</Td>
                    <Td className="text-right tabular">{money(l.buyerCredit)}</Td>
                    <Td className="text-right tabular">{money(l.sellerDebit)}</Td>
                    <Td className="text-right tabular">{money(l.sellerCredit)}</Td>
                    <Td>
                      {l.itemId && hasPermission(ctx, "transaction.update") && (
                        <ActionForm action={removeItemAction.bind(null, tx.id, l.itemId)} submitLabel="Remove" size="sm" variant="ghost" inline>
                          {null}
                        </ActionForm>
                      )}
                    </Td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <Td>Totals</Td>
                  <Td className="text-right tabular">{formatCents(statement.totals.buyerDebits)}</Td>
                  <Td className="text-right tabular">{formatCents(statement.totals.buyerCredits)}</Td>
                  <Td className="text-right tabular">{formatCents(statement.totals.sellerDebits)}</Td>
                  <Td className="text-right tabular">{formatCents(statement.totals.sellerCredits)}</Td>
                  <Td />
                </tr>
              </tbody>
            </Table>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-md bg-slate-50 p-3 text-sm">
                {statement.totals.dueFromBuyer >= 0n ? "Estimated due from buyer" : "Estimated refund to buyer"}: <strong className="tabular">{formatCents(statement.totals.dueFromBuyer >= 0n ? statement.totals.dueFromBuyer : -statement.totals.dueFromBuyer)}</strong>
              </div>
              <div className="rounded-md bg-slate-50 p-3 text-sm">
                {statement.totals.dueToSeller >= 0n ? "Estimated proceeds to seller" : "Estimated due from seller"}: <strong className="tabular">{formatCents(statement.totals.dueToSeller >= 0n ? statement.totals.dueToSeller : -statement.totals.dueToSeller)}</strong>
              </div>
            </div>
            {snapshots.length > 0 && <p className="mt-2 text-xs text-slate-500">Saved drafts: {snapshots.map((s) => `v${s.version} (${displayDateTime(s.createdAt)})`).join(", ")}</p>}
          </>
        )}
        {hasPermission(ctx, "transaction.update") && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium text-brand-700">Add settlement item</summary>
            <ActionForm action={addItemAction.bind(null, tx.id)} submitLabel="Add item" size="sm" className="mt-2">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Type" htmlFor="si-kind">
                  <Select id="si-kind" name="kind" defaultValue="FEE">
                    {["FEE", "PAYOFF", "PRORATION", "SELLER_CREDIT", "HOLDBACK", "OTHER_DEBIT", "OTHER_CREDIT"].map((k) => (
                      <option key={k} value={k}>
                        {humanize(k)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Description" htmlFor="si-desc" required>
                  <Input id="si-desc" name="description" required />
                </Field>
                <Field label="Amount" htmlFor="si-amt" required hint="For prorations: the full amount for the period">
                  <Input id="si-amt" name="amount" required inputMode="decimal" />
                </Field>
                <Field label="Payee" htmlFor="si-payee">
                  <Input id="si-payee" name="payee" />
                </Field>
                <Field label="Charged to" htmlFor="si-charge">
                  <Select id="si-charge" name="chargeTo" defaultValue="BUYER">
                    <option value="BUYER">Buyer</option>
                    <option value="SELLER">Seller</option>
                    <option value="SPLIT">Split (fees)</option>
                  </Select>
                </Field>
                <Field label="Buyer share % (split)" htmlFor="si-split">
                  <Input id="si-split" name="buyerSharePercent" inputMode="decimal" placeholder="50" />
                </Field>
              </div>
              <fieldset className="grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-3">
                <legend className="px-1 text-xs font-medium text-slate-600">Proration settings (type “Proration” only)</legend>
                <Field label="Proration type" htmlFor="si-ptype">
                  <Select id="si-ptype" name="prorationType" defaultValue="PREPAID_BY_SELLER">
                    <option value="PREPAID_BY_SELLER">Paid in advance by seller</option>
                    <option value="UNPAID_ARREARS">Unpaid / paid in arrears</option>
                    <option value="RENT_COLLECTED_BY_SELLER">Rent collected by seller</option>
                  </Select>
                </Field>
                <Field label="Period start" htmlFor="si-ps">
                  <Input id="si-ps" name="periodStart" type="date" />
                </Field>
                <Field label="Period end" htmlFor="si-pe">
                  <Input id="si-pe" name="periodEnd" type="date" />
                </Field>
              </fieldset>
            </ActionForm>
          </details>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title="Bank instructions" description="Masked. Any change creates a new version and invalidates prior verification and approvals.">
          {groups.length === 0 ? (
            <p className="text-sm text-slate-500">No bank instructions recorded.</p>
          ) : (
            <ul className="space-y-4">
              {groups.map((versions) => {
                const cur = versions[0];
                return (
                  <li key={cur.groupId} className="rounded-md border border-slate-200 p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{cur.payeeName}</span>
                      <span className="flex gap-1">
                        <Badge>v{cur.version}</Badge>
                        <StatusBadge status={cur.status} />
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-600">
                      {cur.bankName} · routing ••••{cur.routingLast4} · account ••••{cur.accountLast4} · received via {cur.receivedVia} · entered by {names.get(cur.createdById)}
                    </div>
                    {cur.verifications.map((v) => (
                      <div key={v.id} className="mt-1 text-xs text-slate-600">
                        {v.outcome === "CONFIRMED" ? "✓" : "✗"} {humanize(v.method)} with {v.contactName}
                        {v.phoneLast4 ? ` (…${v.phoneLast4})` : ""}, number source: {v.phoneSource} — {names.get(v.verifiedById)}, {displayDateTime(v.verifiedAt)}
                        {v.invalidatedAt && <span className="text-red-700"> · invalidated: {v.invalidatedReason}</span>}
                      </div>
                    ))}
                    {versions.length > 1 && <div className="mt-1 text-xs text-slate-500">Earlier versions: {versions.slice(1).map((v) => `v${v.version} (${humanize(v.status)})`).join(", ")}</div>}
                    <div className="mt-2 flex flex-wrap gap-3">
                      {hasPermission(ctx, "bank.reveal") && <RevealButton instructionId={cur.id} />}
                      {hasPermission(ctx, "bank.verify") && cur.status === "PENDING_VERIFICATION" && cur.createdById === ctx.userId && (
                        <span className="text-xs text-slate-500">You entered these instructions; someone else must verify them.</span>
                      )}
                      {hasPermission(ctx, "bank.verify") && cur.status === "PENDING_VERIFICATION" && cur.createdById !== ctx.userId && (
                        <details>
                          <summary className="cursor-pointer text-xs text-brand-700">Record verification</summary>
                          <ActionForm action={verifyInstructionAction.bind(null, tx.id, cur.id)} submitLabel="Save verification" size="sm" className="mt-2 w-72">
                            <Select name="method" aria-label="Method">
                              <option value="CALLBACK_KNOWN_NUMBER">Callback to independently sourced number</option>
                              <option value="IN_PERSON">In person with ID</option>
                              <option value="VIDEO_ID_CALLBACK">Video call with ID</option>
                            </Select>
                            <Input name="contactName" placeholder="Person who confirmed" required aria-label="Contact" />
                            <Input name="phoneLast4" placeholder="Phone last 4 (optional)" aria-label="Phone last 4" />
                            <Input name="phoneSource" placeholder="Where the number came from" required aria-label="Number source" />
                            <Select name="outcome" aria-label="Outcome">
                              <option value="CONFIRMED">Confirmed</option>
                              <option value="FAILED">Did not match / failed</option>
                            </Select>
                            <Select name="evidenceDocumentId" aria-label="Evidence" defaultValue="">
                              <option value="">No evidence document</option>
                              {docs.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.title}
                                </option>
                              ))}
                            </Select>
                          </ActionForm>
                        </details>
                      )}
                      {hasPermission(ctx, "bank.create") && (
                        <details>
                          <summary className="cursor-pointer text-xs text-brand-700">Change bank details</summary>
                          <InstructionForm txId={tx.id} groupId={cur.groupId} participants={participants} payeeName={cur.payeeName} />
                        </details>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {hasPermission(ctx, "bank.create") && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-brand-700">Record new bank instructions</summary>
              <InstructionForm txId={tx.id} groupId={null} participants={participants} />
            </details>
          )}
        </Card>

        <Card title="Disbursements" description="Preparer and approver must be different people. Approval is tied to the exact amount, payee and bank-detail version.">
          {disbursements.length === 0 ? (
            <p className="text-sm text-slate-500">No disbursements prepared.</p>
          ) : (
            <ul className="space-y-3">
              {disbursements.map((d) => (
                <li key={d.id} className="rounded-md border border-slate-200 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <strong className="tabular">{formatCents(d.amountCents)}</strong> {d.method === "WIRE" ? "wire" : "check"} to {d.payeeName}
                    </span>
                    <StatusBadge status={d.status === "RECORDED_AS_RELEASED" ? "DONE" : d.status} label={humanize(d.status)} />
                  </div>
                  <div className="text-xs text-slate-500">
                    v{d.version} · prepared by {names.get(d.preparedById)}
                    {d.memo ? ` · ${d.memo}` : ""}
                    {d.externalReference ? ` · ref ${d.externalReference}` : ""}
                    {d.releasedById ? ` · recorded by ${names.get(d.releasedById)} ${displayDateTime(d.releasedAt)}` : ""}
                  </div>
                  {d.invalidatedReason && <div className="text-xs text-red-700">{d.invalidatedReason}</div>}
                  <div className="mt-2 flex flex-wrap gap-3">
                    {d.status === "DRAFT" && d.preparedById === ctx.userId && (
                      <ActionForm action={submitDisbursementAction.bind(null, tx.id, d.id)} submitLabel="Submit for approval" size="sm" variant="secondary" inline>
                        {null}
                      </ActionForm>
                    )}
                    {d.status === "APPROVED" && hasPermission(ctx, "disbursement.release") && (
                      <details>
                        <summary className="cursor-pointer text-xs text-brand-700">Record release (executed outside EscrowFlow)</summary>
                        <ActionForm action={releaseDisbursementAction.bind(null, tx.id, d.id)} submitLabel="Record release" size="sm" className="mt-2 w-72" confirm="Confirm the payment was executed through the approved banking system. EscrowFlow will not send any money.">
                          <Input name="externalReference" placeholder="Bank confirmation / check number" required aria-label="External reference" />
                          <Input name="releaseDate" type="date" defaultValue={today} aria-label="Release date" />
                        </ActionForm>
                      </details>
                    )}
                    {["DRAFT", "PENDING_APPROVAL", "APPROVED", "INVALIDATED"].includes(d.status) && hasPermission(ctx, "disbursement.prepare") && (
                      <details>
                        <summary className="cursor-pointer text-xs text-slate-500">Cancel</summary>
                        <ActionForm action={cancelDisbursementAction.bind(null, tx.id, d.id)} submitLabel="Cancel disbursement" size="sm" variant="danger" className="mt-2 w-60">
                          <Input name="reason" placeholder="Reason" required aria-label="Reason" />
                        </ActionForm>
                      </details>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {hasPermission(ctx, "disbursement.prepare") && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-brand-700">Prepare disbursement</summary>
              <ActionForm action={prepareDisbursementAction.bind(null, tx.id)} submitLabel="Prepare" size="sm" className="mt-2">
                <Field label="Payee (must match bank instructions for wires)" htmlFor="db-payee" required>
                  <Input id="db-payee" name="payeeName" required />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Method" htmlFor="db-method">
                    <Select id="db-method" name="method">
                      <option value="WIRE">Wire</option>
                      <option value="CHECK">Check</option>
                    </Select>
                  </Field>
                  <Field label="Amount" htmlFor="db-amount" required>
                    <Input id="db-amount" name="amount" inputMode="decimal" required />
                  </Field>
                </div>
                <Field label="Verified bank instructions (wires)" htmlFor="db-ins">
                  <Select id="db-ins" name="instructionId" defaultValue="">
                    <option value="">None (check)</option>
                    {verified.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.payeeName} · ••••{i.accountLast4} (v{i.version})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Memo" htmlFor="db-memo">
                  <Input id="db-memo" name="memo" />
                </Field>
              </ActionForm>
            </details>
          )}
        </Card>
      </div>
    </div>
  );
}

function InstructionForm({ txId, groupId, participants, payeeName }: { txId: string; groupId: string | null; participants: { id: string; displayName: string; role: string }[]; payeeName?: string }) {
  return (
    <ActionForm action={saveInstructionAction.bind(null, txId, groupId)} submitLabel={groupId ? "Save new version" : "Save instructions"} size="sm" className="mt-2">
      <p className="text-xs text-amber-900">Requires step-up authentication. Never accept bank details from email alone.</p>
      <Input name="payeeName" placeholder="Payee name" defaultValue={payeeName} required aria-label="Payee name" />
      <Select name="payeeParticipantId" defaultValue="" aria-label="Payee participant">
        <option value="">Not a file participant</option>
        {participants.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName} ({humanize(p.role)})
          </option>
        ))}
      </Select>
      <Input name="bankName" placeholder="Bank name" required aria-label="Bank name" />
      <Input name="routingNumber" placeholder="Routing number (9 digits)" inputMode="numeric" autoComplete="off" required aria-label="Routing number" />
      <Input name="accountNumber" placeholder="Account number" inputMode="numeric" autoComplete="off" required aria-label="Account number" />
      <Input name="receivedVia" placeholder="How received (e.g. signed form uploaded via portal)" required aria-label="Received via" />
    </ActionForm>
  );
}
