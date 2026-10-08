import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffCtx } from "@/server/auth/session";
import { listAuditEvents } from "@/server/services/dashboard";
import { verifyAuditChain } from "@/server/audit";
import { requirePermission } from "@/server/context";
import { Alert, Badge, Card, Table, Td, Th, humanize } from "@/components/ui";
import { displayDateTime } from "@/lib/dates";

export const metadata: Metadata = { title: "Audit log" };

export default async function AuditPage() {
  const ctx = await requireStaffCtx();
  requirePermission(ctx, "audit.read");
  const [events, chain] = await Promise.all([listAuditEvents(ctx, { take: 300 }), verifyAuditChain(ctx.companyId)]);
  return (
    <div className="space-y-4">
      {chain.ok ? (
        <Alert tone="success" title="Hash chain verified">
          {chain.count} events checked. This detects edits or deletions made through the database, but it does not make the log tamper-proof. Production should also ship events to write-once storage (see docs/SECURITY.md).
        </Alert>
      ) : (
        <Alert tone="danger" title="Audit chain broken">
          Event {chain.brokenAt} does not match the chain. Investigate immediately.
        </Alert>
      )}
      <Card title="Company audit log (latest 300)">
        <Table caption="Audit events">
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Actor</Th>
              <Th>Action</Th>
              <Th>Summary</Th>
              <Th>File</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {events.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap text-xs tabular">{displayDateTime(e.createdAt)}</Td>
                <Td className="whitespace-nowrap text-xs">
                  {e.actorLabel ?? "—"} {e.actorType !== "USER" && <Badge>{humanize(e.actorType)}</Badge>}
                </Td>
                <Td className="whitespace-nowrap font-mono text-xs">{e.action}</Td>
                <Td className="text-sm">{e.summary}</Td>
                <Td className="text-xs">
                  {e.transactionId && (
                    <Link className="text-brand-700 hover:underline" href={`/transactions/${e.transactionId}/activity`}>
                      open
                    </Link>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
