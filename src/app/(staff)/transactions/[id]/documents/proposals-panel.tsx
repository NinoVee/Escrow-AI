import { db } from "@/server/db";
import { getCtx } from "@/server/auth/session";
import { hasPermission } from "@/server/context";
import { listProposals } from "@/server/services/proposals";
import { aiMode } from "@/server/ai/provider";
import { ProposalCard } from "@/components/proposal-card";
import { Card, ModeBadge } from "@/components/ui";
import { AskAssistant } from "./ask-assistant";

/** Pending proposals across all documents in the file, plus the cited Q&A assistant. */
export async function ProposalsPanel({ transactionId }: { transactionId: string }) {
  const ctx = (await getCtx())!;
  const proposals = await listProposals(ctx, transactionId);
  const docs = await db.document.findMany({ where: { transactionId }, select: { id: true, title: true } });
  const title = new Map(docs.map((d) => [d.id, d.title]));
  const canReview = hasPermission(ctx, "proposal.review");
  const conflicts = proposals.filter((p) => p.isConflict).length;
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <Card
        className="xl:col-span-2"
        title={`Proposed changes awaiting review (${proposals.length})`}
        description={`Extracted from documents. Nothing here is authoritative until ${canReview ? "you accept it" : "an officer accepts it"}.${conflicts ? ` ${conflicts} conflict(s) need a decision.` : ""}`}
        actions={<ModeBadge mode={aiMode() === "LIVE" ? "LIVE" : "DEMO"} />}
      >
        {proposals.length === 0 ? (
          <p className="text-sm text-slate-500">No pending proposals. Upload a purchase agreement, amendment or title report to generate proposals.</p>
        ) : (
          <ul className="space-y-3">
            {proposals.slice(0, 25).map((p) => (
              <ProposalCard key={p.id} p={p} txId={transactionId} docTitle={p.documentId ? title.get(p.documentId) : undefined} canReview={canReview} />
            ))}
          </ul>
        )}
        {proposals.length > 25 && <p className="mt-2 text-xs text-slate-500">Showing 25 of {proposals.length}. Open a document to review the rest.</p>}
      </Card>
      {hasPermission(ctx, "ai.use") && <AskAssistant transactionId={transactionId} mode={aiMode()} />}
    </div>
  );
}
