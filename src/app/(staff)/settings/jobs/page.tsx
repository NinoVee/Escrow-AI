import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffCtx } from "@/server/auth/session";
import { requirePermission } from "@/server/context";
import { jobsMode } from "@/server/jobs/queue";
import { listJobs } from "@/server/services/operations";
import { ActionForm } from "@/components/action-form";
import { Alert, Card, EmptyState, Stat, StatusBadge, Table, Td, Th } from "@/components/ui";
import { displayDateTime } from "@/lib/dates";
import { replayAction } from "../ops-actions";

export const metadata: Metadata = { title: "Jobs" };

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requireStaffCtx();
  requirePermission(ctx, "jobs.manage");
  const { status } = await searchParams;
  const { jobs, counts, webhooks } = await listJobs(ctx, { status });
  return (
    <div className="space-y-6">
      <Alert tone="info">
        Mode: <strong>{jobsMode() === "queue" ? "queue (BullMQ worker)" : "inline (in the web process)"}</strong>. Jobs retry with exponential backoff and become <em>dead</em> after their maximum attempts. Replaying is safe: every handler is idempotent and re-checks its gates.
      </Alert>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "DEAD"].map((s) => (
          <Stat key={s} label={s.toLowerCase()} value={counts[s] ?? 0} href={`/settings/jobs?status=${s}`} tone={(s === "DEAD" || s === "FAILED") && counts[s] ? "danger" : undefined} />
        ))}
      </div>
      <Card title={status ? `Jobs: ${status.toLowerCase()}` : "Recent jobs"} actions={status ? <Link className="text-sm text-brand-700" href="/settings/jobs">Show all</Link> : undefined}>
        {jobs.length === 0 ? (
          <EmptyState title="No jobs">Background work (document processing, email delivery, webhooks, automation) appears here.</EmptyState>
        ) : (
          <Table caption="Background jobs">
            <thead>
              <tr>
                <Th>Queued</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Attempts</Th>
                <Th>Last error</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {jobs.map((j) => (
                <tr key={j.id}>
                  <Td className="whitespace-nowrap text-xs tabular">{displayDateTime(j.queuedAt)}</Td>
                  <Td className="font-mono text-xs">{j.type}</Td>
                  <Td>
                    <StatusBadge status={j.status} />
                  </Td>
                  <Td className="text-xs tabular">
                    {j.attempts}/{j.maxAttempts}
                    {j.replayCount > 0 && ` · replayed ${j.replayCount}×`}
                  </Td>
                  <Td className="max-w-xs truncate text-xs text-red-700">{j.lastError}</Td>
                  <Td>{(j.status === "FAILED" || j.status === "DEAD") && <ActionForm action={replayAction.bind(null, j.id)} submitLabel="Replay" size="sm" variant="secondary" inline />}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card title="Webhook events" description="Signed provider callbacks. Duplicates are acknowledged without reprocessing; out-of-order events are marked stale.">
        {webhooks.length === 0 ? (
          <EmptyState title="No webhook events">Events appear after a provider (or a demo simulation) calls back.</EmptyState>
        ) : (
          <Table caption="Webhook events">
            <thead>
              <tr>
                <Th>Received</Th>
                <Th>Provider</Th>
                <Th>Event</Th>
                <Th>Status</Th>
                <Th>Note</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {webhooks.map((w) => (
                <tr key={w.id}>
                  <Td className="whitespace-nowrap text-xs tabular">{displayDateTime(w.receivedAt)}</Td>
                  <Td className="text-xs">{w.provider}</Td>
                  <Td className="font-mono text-xs">
                    {w.eventType} → {(w.payload as { data?: { status?: string } }).data?.status}
                  </Td>
                  <Td>
                    <StatusBadge status={w.status} />
                  </Td>
                  <Td className="text-xs text-slate-600">{w.error}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
