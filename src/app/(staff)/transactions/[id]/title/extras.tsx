import { db } from "@/server/db";
import { getCtx } from "@/server/auth/session";
import { hasPermission } from "@/server/context";
import { ActionForm } from "@/components/action-form";
import { Card } from "@/components/ui";
import { runExtractionAction } from "../ai-actions";

/** Runs title-exception extraction on uploaded reports. Results arrive as proposals on the Documents tab. */
export async function TitleExtras({ transactionId }: { transactionId: string }) {
  const ctx = (await getCtx())!;
  if (!hasPermission(ctx, "ai.use")) return null;
  const reports = await db.document.findMany({ where: { transactionId, companyId: ctx.companyId, category: "TITLE_REPORT", archivedAt: null, currentVersionId: { not: null } }, select: { id: true, title: true, currentVersionId: true } });
  const pending = await db.proposal.count({ where: { transactionId, kind: "TITLE_EXCEPTION", status: "PENDING" } });
  if (reports.length === 0) return null;
  return (
    <Card title="Extract exceptions from a report" description={`Transcribes numbered items as proposals for review. ${pending} pending title proposal(s) on the Documents tab.`}>
      <ul className="space-y-2">
        {reports.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{r.title}</span>
            <ActionForm action={runExtractionAction.bind(null, transactionId, r.currentVersionId!)} submitLabel="Extract exceptions" pendingLabel="Extracting…" size="sm" variant="secondary" inline>
              <input type="hidden" name="kind" value="TITLE" />
            </ActionForm>
          </li>
        ))}
      </ul>
    </Card>
  );
}
