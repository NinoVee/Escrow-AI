import Link from "next/link";
import { getWorkspace, staffNames } from "../data";
import { db } from "@/server/db";
import { hasPermission } from "@/server/context";
import { DOCUMENT_CATEGORIES, RESTRICTED_CATEGORIES, listDocumentRequests, listDocuments } from "@/server/services/documents";
import { env } from "@/server/env";
import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, EmptyState, Field, Input, Select, StatusBadge, Textarea, humanize } from "@/components/ui";
import { archiveDocumentAction, documentLegalHoldAction, requestDocumentAction, requestStatusAction, reviewDocumentAction, revokeShareAction, shareDocumentAction, uploadDocumentAction } from "../actions";
import { displayDate, displayDateTime } from "@/lib/dates";
import { ProposalsPanel } from "./proposals-panel";

function size(n: number) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}

export default async function DocumentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, tx } = await getWorkspace(id);
  const [docs, requests, participants, names] = await Promise.all([
    listDocuments(ctx, tx.id),
    listDocumentRequests(ctx, tx.id),
    db.participant.findMany({ where: { transactionId: tx.id }, orderBy: { createdAt: "asc" } }),
    staffNames(ctx.companyId),
  ]);
  const canUpload = hasPermission(ctx, "document.upload");
  const canShare = hasPermission(ctx, "document.share");
  const canReview = hasPermission(ctx, "document.review");
  const scanner = env().MALWARE_SCANNER;

  return (
    <div className="space-y-6">
      <ProposalsPanel transactionId={tx.id} />
      {scanner === "demo" && <Alert tone="demo">Uploads are checked by the demo scanner (EICAR test signature only). Configure ClamAV for real malware scanning.</Alert>}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {docs.length === 0 ? (
            <EmptyState title="No documents yet">Upload the purchase agreement to start. PDFs and images (PNG, JPEG, TIFF, WebP) up to {env().MAX_UPLOAD_MB} MB.</EmptyState>
          ) : (
            docs.map((d) => {
              const current = d.versions.find((v) => v.id === d.currentVersionId) ?? d.versions[0];
              const latestReview = current?.reviews[0];
              const restricted = (RESTRICTED_CATEGORIES as string[]).includes(d.category);
              return (
                <Card
                  key={d.id}
                  id={`doc-${d.id}`}
                  title={d.title}
                  description={`${humanize(d.category)} · ${d.versions.length} version${d.versions.length === 1 ? "" : "s"}`}
                  actions={
                    <>
                      {d.legalHold && <Badge tone="danger">Legal hold</Badge>}
                      {restricted && <Badge tone="warning">Restricted</Badge>}
                      <Badge tone={d.visibility === "SHARED" ? "info" : "neutral"}>{d.visibility === "SHARED" ? "Shared" : "Internal"}</Badge>
                      {current && <StatusBadge status={current.scanStatus} label={current.scanStatus === "CLEAN" ? "Scan clean" : `Quarantined: ${humanize(current.scanStatus)}`} />}
                      {latestReview && <StatusBadge status={latestReview.decision} label={`Review: ${humanize(latestReview.decision)}`} />}
                    </>
                  }
                >
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    {current?.scanStatus === "CLEAN" && (
                      <a className="font-medium text-brand-700 hover:underline" href={`/api/documents/versions/${current.id}/download`}>
                        Download v{current.versionNumber}
                      </a>
                    )}
                    <Link className="font-medium text-brand-700 hover:underline" href={`/transactions/${tx.id}/documents/${d.id}`}>
                      Review &amp; extraction →
                    </Link>
                    {d.uploadedByParticipantId && <Badge tone="info">Uploaded by participant</Badge>}
                  </div>
                  {current?.scanStatus !== "CLEAN" && current && <p className="mt-2 text-sm text-red-800">{current.scanDetail}</p>}

                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm text-slate-600">Version history</summary>
                    <ul className="mt-2 space-y-1 text-xs text-slate-600">
                      {d.versions.map((v) => (
                        <li key={v.id}>
                          v{v.versionNumber} · {v.originalFilename} · {size(v.sizeBytes)} · {displayDateTime(v.createdAt)} · {names.get(v.uploadedById ?? "") ?? "participant"} · {humanize(v.scanStatus)} ({v.scanProvider}) · sha256 {v.sha256.slice(0, 12)}…
                          {v.reviews.map((r) => (
                            <span key={r.id}> · reviewed {humanize(r.decision)}{r.note ? `: ${r.note}` : ""}</span>
                          ))}
                        </li>
                      ))}
                    </ul>
                  </details>

                  {d.shares && d.shares.length > 0 && (
                    <div className="mt-3 text-sm">
                      <span className="text-slate-500">Shared with: </span>
                      {d.shares.map((s) => (
                        <span key={s.id} className="mr-2 inline-flex items-center gap-1">
                          {s.participant.displayName} <span className="text-xs text-slate-500">({humanize(s.participant.role)})</span>
                          {canShare && (
                            <ActionForm action={revokeShareAction.bind(null, tx.id, d.id, s.participantId)} submitLabel="Revoke" size="sm" variant="ghost" inline>
                              {null}
                            </ActionForm>
                          )}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-4">
                    {canShare && !restricted && current?.scanStatus === "CLEAN" && participants.length > 0 && (
                      <ActionForm action={shareDocumentAction.bind(null, tx.id, d.id)} submitLabel="Share" size="sm" variant="secondary" inline>
                        <label className="text-xs">
                          <span className="sr-only">Share with</span>
                          <Select name="participantId" required className="w-56">
                            <option value="">Share with participant…</option>
                            {participants.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.displayName} ({humanize(p.role)})
                              </option>
                            ))}
                          </Select>
                        </label>
                      </ActionForm>
                    )}
                    {canReview && current?.scanStatus === "CLEAN" && (
                      <ActionForm action={reviewDocumentAction.bind(null, tx.id, current.id)} submitLabel="Record review" size="sm" variant="secondary" inline>
                        <label className="text-xs">
                          <span className="sr-only">Decision</span>
                          <Select name="decision" className="w-40">
                            <option value="ACCEPTED">Accept</option>
                            <option value="NEEDS_CHANGES">Needs changes</option>
                            <option value="REJECTED">Reject</option>
                          </Select>
                        </label>
                        <label className="text-xs">
                          <span className="sr-only">Note</span>
                          <Input name="note" placeholder="Note" className="w-44" />
                        </label>
                      </ActionForm>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-4">
                    {canUpload && (
                      <details>
                        <summary className="cursor-pointer text-xs text-brand-700">Upload new version</summary>
                        <ActionForm action={uploadDocumentAction.bind(null, tx.id)} submitLabel="Upload version" size="sm" className="mt-2">
                          <input type="hidden" name="documentId" value={d.id} />
                          <input type="file" name="file" required accept="application/pdf,image/png,image/jpeg,image/tiff,image/webp" className="text-sm" />
                        </ActionForm>
                      </details>
                    )}
                    {hasPermission(ctx, "document.legal_hold") && (
                      <details>
                        <summary className="cursor-pointer text-xs text-brand-700">{d.legalHold ? "Release legal hold" : "Legal hold"}</summary>
                        <ActionForm action={documentLegalHoldAction.bind(null, tx.id, d.id)} submitLabel={d.legalHold ? "Release" : "Apply hold"} size="sm" className="mt-2">
                          <input type="hidden" name="hold" value={d.legalHold ? "off" : "on"} />
                          <Input name="reason" placeholder="Reason" required aria-label="Reason" />
                        </ActionForm>
                      </details>
                    )}
                    {canUpload && !d.legalHold && (
                      <details>
                        <summary className="cursor-pointer text-xs text-slate-500">Archive</summary>
                        <ActionForm action={archiveDocumentAction.bind(null, tx.id, d.id)} submitLabel="Archive" size="sm" variant="danger" className="mt-2" confirm="Archive this document? Sharing will be revoked.">
                          <Input name="reason" placeholder="Reason" required aria-label="Reason" />
                        </ActionForm>
                      </details>
                    )}
                  </div>
                </Card>
              );
            })
          )}
        </div>

        <div className="space-y-6">
          {canUpload && (
            <Card title="Upload document">
              <ActionForm action={uploadDocumentAction.bind(null, tx.id)} submitLabel="Upload" pendingLabel="Uploading and scanning…">
                <Field label="File" htmlFor="file" required hint={`PDF or image, up to ${env().MAX_UPLOAD_MB} MB. Type is verified from file content.`}>
                  <input id="file" type="file" name="file" required accept="application/pdf,image/png,image/jpeg,image/tiff,image/webp" className="block w-full text-sm" />
                </Field>
                <Field label="Title" htmlFor="doc-title">
                  <Input id="doc-title" name="title" />
                </Field>
                <Field label="Category" htmlFor="doc-category">
                  <Select id="doc-category" name="category" defaultValue="OTHER">
                    {DOCUMENT_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {humanize(c)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </ActionForm>
            </Card>
          )}

          <Card title="Document requests" description="Participants see and fulfil their own requests in the portal.">
            {requests.length === 0 ? (
              <p className="text-sm text-slate-500">No requests yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {requests.map((r) => (
                  <li key={r.id} className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{r.title}</span>
                      <StatusBadge status={r.status} />
                    </div>
                    <div className="text-xs text-slate-500">
                      From {r.participant.displayName}
                      {r.dueAt && ` · due ${displayDate(r.dueAt)}`}
                    </div>
                    {canShare && r.status === "SUBMITTED" && (
                      <div className="mt-1 flex gap-2">
                        <ActionForm action={requestStatusAction.bind(null, tx.id, r.id)} submitLabel="Accept" size="sm" variant="secondary" inline>
                          <input type="hidden" name="status" value="ACCEPTED" />
                        </ActionForm>
                        <ActionForm action={requestStatusAction.bind(null, tx.id, r.id)} submitLabel="Reopen" size="sm" variant="ghost" inline>
                          <input type="hidden" name="status" value="OPEN" />
                        </ActionForm>
                      </div>
                    )}
                    {canShare && r.status === "OPEN" && (
                      <ActionForm action={requestStatusAction.bind(null, tx.id, r.id)} submitLabel="Cancel request" size="sm" variant="ghost" inline className="mt-1">
                        <input type="hidden" name="status" value="CANCELLED" />
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canShare && participants.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-brand-700">New request</summary>
                <ActionForm action={requestDocumentAction.bind(null, tx.id)} submitLabel="Create request" size="sm" className="mt-2">
                  <Field label="From participant" htmlFor="req-p" required>
                    <Select id="req-p" name="participantId" required>
                      {participants.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.displayName} ({humanize(p.role)})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Document" htmlFor="req-t" required>
                    <Input id="req-t" name="title" required placeholder="e.g. Signed seller information statement" />
                  </Field>
                  <Field label="Category" htmlFor="req-c">
                    <Select id="req-c" name="category" defaultValue="OTHER">
                      {DOCUMENT_CATEGORIES.filter((c) => !(RESTRICTED_CATEGORIES as string[]).includes(c)).map((c) => (
                        <option key={c} value={c}>
                          {humanize(c)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Instructions" htmlFor="req-d">
                    <Textarea id="req-d" name="description" rows={2} />
                  </Field>
                  <Field label="Due date" htmlFor="req-due">
                    <Input id="req-due" name="dueDate" type="date" />
                  </Field>
                </ActionForm>
              </details>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
