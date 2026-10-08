import { getWorkspace } from "../data";
import { Alert, Card, DL } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { displayValue } from "@/server/fields";

/** Phase 1: deal-term summary. Phase 3 replaces this with the internal ledger and settlement workspace. */
export default async function FinancesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { tx } = await getWorkspace(id);
  return (
    <div className="space-y-6">
      <Alert tone="info">The internal tracking ledger and draft settlement statement are not enabled yet.</Alert>
      <Card title="Deal amounts">
        <DL
          items={[
            { label: "Purchase price", value: tx.purchasePriceCents != null ? formatCents(tx.purchasePriceCents) : "—" },
            { label: "Initial deposit", value: tx.initialDepositCents != null ? formatCents(tx.initialDepositCents) : "—" },
            { label: "Loan amount", value: tx.loanAmountCents != null ? formatCents(tx.loanAmountCents) : "—" },
            { label: "Financing", value: displayValue("financingType", tx.financingType) },
          ]}
        />
      </Card>
    </div>
  );
}
