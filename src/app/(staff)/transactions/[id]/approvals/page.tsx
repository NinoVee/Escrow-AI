import { getWorkspace } from "../data";
import { listApprovals } from "@/server/services/approvals";
import { ApprovalList } from "@/components/approval-list";
import { Card, EmptyState } from "@/components/ui";

export default async function FileApprovalsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, tx } = await getWorkspace(id);
  const approvals = await listApprovals(ctx, { transactionId: tx.id });
  return (
    <Card title="Approvals for this file" description="Every approval is tied to the exact item state it was requested for.">
      {approvals.length === 0 ? <EmptyState title="No approvals requested for this file" /> : <ApprovalList ctx={ctx} approvals={approvals} showFile={false} />}
    </Card>
  );
}
