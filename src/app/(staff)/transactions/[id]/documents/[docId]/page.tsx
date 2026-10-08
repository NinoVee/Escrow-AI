import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspace } from "../../data";
import { loadDocument } from "@/server/services/access";
import { db } from "@/server/db";
import { Card, StatusBadge, humanize } from "@/components/ui";

/** Phase 1 document detail. Phase 2 replaces this with the review and extraction screen. */
export default async function DocumentDetailPage({ params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await params;
  const { ctx, tx } = await getWorkspace(id);
  const doc = await loadDocument(ctx, docId).catch(() => null);
  if (!doc || doc.transactionId !== tx.id) notFound();
  const versions = await db.documentVersion.findMany({ where: { documentId: doc.id }, orderBy: { versionNumber: "desc" } });
  return (
    <Card title={doc.title} description={humanize(doc.category)} actions={<Link href={`/transactions/${tx.id}/documents`} className="text-sm text-brand-700">Back to documents</Link>}>
      <ul className="text-sm">
        {versions.map((v) => (
          <li key={v.id}>
            v{v.versionNumber} {v.originalFilename} <StatusBadge status={v.scanStatus} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
