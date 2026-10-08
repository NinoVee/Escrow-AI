import { getWorkspace } from "../../data";
import { db } from "@/server/db";
import { draftStatement, SETTLEMENT_DISCLAIMER } from "@/server/services/settlement";
import { Alert } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { displayDate } from "@/lib/dates";
import { PrintButton } from "./print-button";

const m = (c: bigint) => (c === 0n ? "" : formatCents(c));

export default async function StatementPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, tx, properties } = await getWorkspace(id);
  const s = await draftStatement(ctx, tx.id);
  const parties = await db.participant.findMany({ where: { transactionId: tx.id, role: { in: ["BUYER", "SELLER"] } } });
  if (!s.ready) return <Alert tone="info">{s.reason}</Alert>;
  return (
    <article className="mx-auto max-w-3xl rounded-lg border border-slate-200 bg-white p-8 text-sm shadow-sm print:border-0 print:shadow-none">
      <div className="no-print mb-4 flex justify-end">
        <PrintButton />
      </div>
      <div className="mb-4 border-2 border-red-700 p-2 text-center text-xs font-bold uppercase tracking-wide text-red-800">Draft estimate — not an official settlement statement or closing disclosure</div>
      <h1 className="text-lg font-semibold">Estimated settlement statement</h1>
      <p className="text-slate-600">
        Escrow {tx.escrowNumber} · {properties.map((p) => `${p.street}, ${p.city}`).join("; ")} · settlement date {displayDate(s.settlementDate)}
      </p>
      <p className="text-slate-600">Buyer: {parties.filter((p) => p.role === "BUYER").map((p) => p.displayName).join(", ") || "—"} · Seller: {parties.filter((p) => p.role === "SELLER").map((p) => p.displayName).join(", ") || "—"}</p>
      <table className="mt-4 w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-slate-400 text-left">
            <th className="py-1">Description</th>
            <th className="py-1 text-right">Buyer debit</th>
            <th className="py-1 text-right">Buyer credit</th>
            <th className="py-1 text-right">Seller debit</th>
            <th className="py-1 text-right">Seller credit</th>
          </tr>
        </thead>
        <tbody>
          {s.lines.map((l, i) => (
            <tr key={i} className="border-b border-slate-200 align-top">
              <td className="py-1">
                {l.description}
                {l.detail && <div className="text-[10px] text-slate-500">{l.detail}</div>}
              </td>
              <td className="py-1 text-right tabular">{m(l.buyerDebit)}</td>
              <td className="py-1 text-right tabular">{m(l.buyerCredit)}</td>
              <td className="py-1 text-right tabular">{m(l.sellerDebit)}</td>
              <td className="py-1 text-right tabular">{m(l.sellerCredit)}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="py-1">Totals</td>
            <td className="py-1 text-right tabular">{formatCents(s.totals.buyerDebits)}</td>
            <td className="py-1 text-right tabular">{formatCents(s.totals.buyerCredits)}</td>
            <td className="py-1 text-right tabular">{formatCents(s.totals.sellerDebits)}</td>
            <td className="py-1 text-right tabular">{formatCents(s.totals.sellerCredits)}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-3">Estimated {s.totals.dueFromBuyer >= 0n ? "due from" : "refund to"} buyer: <strong>{formatCents(s.totals.dueFromBuyer < 0n ? -s.totals.dueFromBuyer : s.totals.dueFromBuyer)}</strong></p>
      <p>Estimated {s.totals.dueToSeller >= 0n ? "proceeds to" : "due from"} seller: <strong>{formatCents(s.totals.dueToSeller < 0n ? -s.totals.dueToSeller : s.totals.dueToSeller)}</strong></p>
      <p className="mt-6 text-[10px] text-slate-500">{SETTLEMENT_DISCLAIMER}</p>
    </article>
  );
}
