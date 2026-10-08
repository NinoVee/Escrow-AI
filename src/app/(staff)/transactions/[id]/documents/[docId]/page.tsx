import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspace, staffNames } from "../../data";
import { loadDocument } from "@/server/services/access";
import { db } from "@/server/db";
import { hasPermission } from "@/server/context";
import { DOCUMENT_CATEGORIES } from "@/server/services/documents";
import { ActionForm } from "@/components/action-form";
import { ProposalCard } from "@/components/proposal-card";
import { Alert, Badge, Card, ModeBadge, Select, StatusBadge, humanize } from "@/components/ui";
import { applyCategoryAction, runExtractionAction } from "../../ai-actions";
import { displayDateTime } from "@/lib/dates";
import { CompareDocuments } from "./compare";
import type { InjectionFlag } from "@/server/ai/text";

function highlight(text: string, excerpts: string[]) {
  const ranges: [number, number][] = [];
  const lower = text.toLowerCase();
  for (const e of excerpts) {
    const needle = e.trim().toLowerCase().slice(0, 160);
    if (needle.length < 4) continue;
    const i = lower.indexOf(needle);
    if (i >= 0) ranges.push([i, i + needle.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const out: { t: string; mark: boolean }[] = [];
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s < pos) continue;
    out.push({ t: text.slice(pos, s), mark: false }, { t: text.slice(s, e), mark: true });
    pos = e;
  }
  out.push({ t: text.slice(pos), mark: false });
  return out;
}

export default async function DocumentReviewPage({ params, searchParams }: { params: Promise<{ id: string; docId: string }>; searchParams: Promise<{ page?: string; v?: string }> }) {
  const { id, docId } = await params;
  const sp = await searchParams;
  const { ctx, tx } = await getWorkspace(id);
  const doc = await loadDocument(ctx, docId).catch(() => null);
  if (!doc || doc.transactionId !== tx.id) notFound();
  const versions = await db.documentVersion.findMany({ where: { documentId: doc.id }, orderBy: { versionNumber: "desc" }, include: { pages: { orderBy: { pageNumber: "asc" } } } });
  const version = versions.find((v) => v.id === sp.v) ?? versions.find((v) => v.id === doc.currentVersionId) ?? versions[0];
  const pageNo = Math.max(1, Math.min(Number(sp.page) || 1, version?.pages.length || 1));
  const page = version?.pages.find((p) => p.pageNumber === pageNo);
  const [runs, proposals, others, names] = await Promise.all([
    db.extractionRun.findMany({ where: { documentId: doc.id, companyId: ctx.companyId }, orderBy: { createdAt: "desc" }, take: 10 }),
    db.proposal.findMany({ where: { documentId: doc.id, companyId: ctx.companyId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] }),
    db.document.findMany({ where: { transactionId: tx.id, id: { not: doc.id }, archivedAt: null, currentVersionId: { not: null } }, select: { title: true, currentVersionId: true } }),
    staffNames(ctx.companyId),
  ]);
  const latest = runs.find((r) => r.status === "SUCCEEDED");
  const pending = proposals.filter((p) => p.status === "PENDING");
  const decided = proposals.filter((p) => p.status !== "PENDING");
  const injections = (version?.injectionFlags as InjectionFlag[] | null) ?? [];
  const pageExcerpts = proposals.filter((p) => p.page === pageNo && p.documentVersionId === version?.id && p.excerpt).map((p) => p.excerpt!);
  const canAi = hasPermission(ctx, "ai.use");
  const canReview = hasPermission(ctx, "proposal.review");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href={`/transactions/${tx.id}/documents`} className="text-sm text-brand-700 hover:underline">
            ← Documents
          </Link>
          <h2 className="mt-1 text-xl font-semibold">{doc.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <Badge>{humanize(doc.category)}</Badge>
            {version && (
              <>
                <span>
                  v{version.versionNumber} · {version.originalFilename} · {version.pageCount ?? "?"} page(s)
                </span>
                <StatusBadge status={version.scanStatus} label={version.scanStatus === "CLEAN" ? "Scan clean" : humanize(version.scanStatus)} />
                <Badge tone={version.textStatus === "EXTRACTED" || version.textStatus === "OCR_COMPLETE" ? "success" : "warning"}>Text: {humanize(version.textStatus)}</Badge>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {versions.length > 1 && (
            <form className="flex items-center gap-2">
              <label htmlFor="v" className="text-sm text-slate-600">
                Version
              </label>
              <Select id="v" name="v" defaultValue={version?.id} className="w-24">
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.versionNumber}
                  </option>
                ))}
              </Select>
              <button className="text-sm text-brand-700">Go</button>
            </form>
          )}
          {version?.scanStatus === "CLEAN" && (
            <a className="text-sm font-medium text-brand-700 hover:underline" href={`/api/documents/versions/${version.id}/download`}>
              Download
            </a>
          )}
        </div>
      </div>

      {injections.length > 0 && (
        <Alert tone="danger" title="This document contains text that looks like instructions to an AI system">
          <p>EscrowFlow treated this text as document content only. It cannot approve, send, change bank details or grant permissions. Values extracted from this document are marked low confidence.</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {injections.map((f, i) => (
              <li key={i}>
                Page {f.page}: {f.label}: “{f.excerpt}”
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {version?.textStatus === "OCR_REQUIRED" && <Alert tone="warning">This file appears to be scanned. OCR requires the Anthropic provider (OCR_PROVIDER=anthropic with an API key). Until then, review it manually.</Alert>}

      <div className="grid gap-6 xl:grid-cols-5">
        <Card title="Document text" className="xl:col-span-3" description="Extracted text. Highlights show excerpts cited by proposals on this page.">
          {!version || version.pages.length === 0 ? (
            <p className="text-sm text-slate-500">No extracted text yet.</p>
          ) : (
            <>
              <nav aria-label="Pages" className="mb-3 flex flex-wrap gap-1">
                {version.pages.map((p) => (
                  <Link key={p.id} href={`?v=${version.id}&page=${p.pageNumber}`} aria-current={p.pageNumber === pageNo ? "page" : undefined} className={`rounded px-2 py-0.5 text-xs ${p.pageNumber === pageNo ? "bg-brand-700 text-white" : "bg-slate-100 text-slate-700"}`}>
                    Page {p.pageNumber}
                    {p.ocr ? " (OCR)" : ""}
                  </Link>
                ))}
              </nav>
              <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800">
                {highlight(page?.text ?? "", pageExcerpts).map((s, i) =>
                  s.mark ? (
                    <mark key={i} className="rounded bg-amber-200 px-0.5">
                      {s.t}
                    </mark>
                  ) : (
                    <span key={i}>{s.t}</span>
                  ),
                )}
              </pre>
            </>
          )}
        </Card>

        <div className="space-y-6 xl:col-span-2">
          <Card title="Extraction" actions={latest ? <ModeBadge mode={latest.mode} /> : undefined}>
            {latest ? (
              <div className="space-y-2 text-sm">
                <p className="text-xs text-slate-500">
                  {latest.provider}
                  {latest.model ? ` · ${latest.model}` : ""} · {displayDateTime(latest.finishedAt)}
                </p>
                {latest.summary && <p>{latest.summary}</p>}
                {latest.classification && latest.classification !== doc.category && latest.classification !== "OTHER" && (
                  <div className="rounded-md bg-slate-50 p-2 text-xs">
                    Suggested category: <strong>{humanize(latest.classification)}</strong>
                    {latest.classificationConfidence != null && ` (confidence ${latest.classificationConfidence.toFixed(2)})`}
                    {hasPermission(ctx, "document.upload") && (DOCUMENT_CATEGORIES as readonly string[]).includes(latest.classification) && (
                      <ActionForm action={applyCategoryAction.bind(null, tx.id, doc.id)} submitLabel="Apply category" size="sm" variant="secondary" className="mt-1">
                        <input type="hidden" name="category" value={latest.classification} />
                      </ActionForm>
                    )}
                  </div>
                )}
                {Array.isArray(latest.notes) && (latest.notes as { kind: string; message: string }[]).length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-xs text-slate-600">Validation notes ({(latest.notes as unknown[]).length})</summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-600">
                      {(latest.notes as { kind: string; message: string }[]).map((n, i) => (
                        <li key={i}>
                          <span className="font-medium">{humanize(n.kind)}:</span> {n.message}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500">Not extracted yet.</p>
            )}
            {runs.filter((r) => r.status === "FAILED").slice(0, 1).map((r) => (
              <p key={r.id} className="mt-2 text-xs text-red-700">
                Last failure ({displayDateTime(r.createdAt)}): {r.error}
              </p>
            ))}
            {canAi && version?.scanStatus === "CLEAN" && (
              <ActionForm action={runExtractionAction.bind(null, tx.id, version.id)} submitLabel="Run extraction" pendingLabel="Extracting…" size="sm" variant="secondary" className="mt-3" inline>
                <Select name="kind" aria-label="Extraction type" className="w-48" defaultValue={doc.category === "TITLE_REPORT" ? "TITLE" : "CONTRACT"}>
                  <option value="CONTRACT">Contract terms</option>
                  <option value="TITLE">Title exceptions</option>
                  <option value="SUMMARY">Summary only</option>
                </Select>
              </ActionForm>
            )}
          </Card>

          <Card title={`Proposals from this document (${pending.length} pending)`}>
            {pending.length === 0 ? (
              <p className="text-sm text-slate-500">No pending proposals.</p>
            ) : (
              <ul className="space-y-3">
                {pending.map((p) => (
                  <ProposalCard key={p.id} p={p} txId={tx.id} docTitle={doc.title} canReview={canReview} />
                ))}
              </ul>
            )}
            {decided.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-slate-600">Decided ({decided.length})</summary>
                <ul className="mt-2 space-y-1 text-xs text-slate-600">
                  {decided.map((p) => (
                    <li key={p.id}>
                      <StatusBadge status={p.status} /> {p.kind.toLowerCase().replace("_", " ")} {p.fieldPath ?? ""} {p.decidedById ? `· ${names.get(p.decidedById) ?? ""}` : ""} {p.decisionNote ? `· “${p.decisionNote}”` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>

          {version?.scanStatus === "CLEAN" && others.length > 0 && (
            <CompareDocuments txId={tx.id} versionId={version.id} options={others.map((o) => ({ id: o.currentVersionId!, title: o.title }))} />
          )}
        </div>
      </div>
    </div>
  );
}
