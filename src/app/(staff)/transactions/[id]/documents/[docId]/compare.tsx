"use client";

import { ActionForm } from "@/components/action-form";
import { Badge, Card, Select } from "@/components/ui";
import { compareAction, type Comparison } from "../../ai-actions";

const TONE: Record<string, "neutral" | "warning" | "success" | "info"> = { SAME: "success", CHANGED: "warning", ONLY_A: "info", ONLY_B: "info", NOT_STATED: "neutral" };

export function CompareDocuments({ txId, versionId, options }: { txId: string; versionId: string; options: { id: string; title: string }[] }) {
  return (
    <Card title="Compare with another document" description="Field-by-field comparison of extracted values and changed lines. Use it to review amendments.">
      <ActionForm<Comparison>
        action={compareAction.bind(null, txId, versionId)}
        submitLabel="Compare"
        pendingLabel="Comparing…"
        size="sm"
        resetOnSuccess={false}
        renderResult={(c) => (
          <div className="space-y-3 text-xs">
            <p className="text-slate-600">
              A: {c.a.title} v{c.a.version} → B: {c.b.title} v{c.b.version}
              {(c.a.runMode === "DEMO" || c.b.runMode === "DEMO") && <Badge tone="purple" className="ml-1">Demo extraction</Badge>}
            </p>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left">
                <thead>
                  <tr className="text-slate-500">
                    <th className="py-1 pr-2">Field</th>
                    <th className="py-1 pr-2">A</th>
                    <th className="py-1 pr-2">B</th>
                    <th className="py-1 pr-2">Accepted</th>
                  </tr>
                </thead>
                <tbody>
                  {c.rows
                    .filter((r) => r.status !== "NOT_STATED")
                    .map((r) => (
                      <tr key={r.key} className="border-t border-slate-100 align-top">
                        <td className="py-1 pr-2">
                          {r.field} <Badge tone={TONE[r.status]}>{r.status.replace("_", " ").toLowerCase()}</Badge>
                        </td>
                        <td className="py-1 pr-2">{r.a ? `${r.a.value}${r.a.page ? ` (p.${r.a.page})` : ""}` : "—"}</td>
                        <td className="py-1 pr-2">{r.b ? `${r.b.value}${r.b.page ? ` (p.${r.b.page})` : ""}` : "—"}</td>
                        <td className="py-1 pr-2">{r.accepted ?? "—"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {c.added.length > 0 && (
              <details>
                <summary className="cursor-pointer">Lines only in B ({c.added.length})</summary>
                <ul className="mt-1 space-y-0.5">
                  {c.added.map((l, i) => (
                    <li key={i} className="text-emerald-800">
                      + p.{l.page}: {l.line}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {c.removed.length > 0 && (
              <details>
                <summary className="cursor-pointer">Lines only in A ({c.removed.length})</summary>
                <ul className="mt-1 space-y-0.5">
                  {c.removed.map((l, i) => (
                    <li key={i} className="text-red-800">
                      − p.{l.page}: {l.line}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="text-slate-500">Changes become authoritative only by accepting the proposals they generate.</p>
          </div>
        )}
      >
        <label className="block text-xs">
          <span className="sr-only">Compare against</span>
          <Select name="otherVersionId" required>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </Select>
        </label>
      </ActionForm>
    </Card>
  );
}
