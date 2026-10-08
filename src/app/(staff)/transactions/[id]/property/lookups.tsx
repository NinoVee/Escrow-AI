import { Card, ModeBadge } from "@/components/ui";

/** Phase 4 connects property-data and recorded-document provider adapters here. */
export async function PropertyLookups({ transactionId: _transactionId }: { transactionId: string }) {
  return (
    <Card title="Property data and recorded documents" actions={<ModeBadge mode="NOT_CONFIGURED" />}>
      <p className="text-sm text-slate-600">No property-data provider is configured. Property lookups are never proof of title.</p>
    </Card>
  );
}
