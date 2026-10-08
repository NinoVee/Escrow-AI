"use client";

import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Textarea } from "@/components/ui";
import { askAction } from "../ai-actions";
import type { CitedAnswer } from "@/server/services/assistant";

export function AskAssistant({ transactionId, mode }: { transactionId: string; mode: "LIVE" | "DEMO" }) {
  return (
    <Card title="Ask about this file" description="Answers use only documents you are permitted to see, with citations." actions={<Badge tone={mode === "LIVE" ? "success" : "purple"}>{mode === "LIVE" ? "AI" : "Demo"}</Badge>}>
      <ActionForm<CitedAnswer>
        action={askAction.bind(null, transactionId)}
        submitLabel="Ask"
        pendingLabel="Searching documents…"
        resetOnSuccess={false}
        renderResult={(r) => (
          <div className="space-y-2 rounded-md bg-slate-50 p-3 text-sm">
            {r.insufficientEvidence && <Badge tone="warning">Insufficient evidence</Badge>}
            <p className="whitespace-pre-wrap">{r.answer}</p>
            {r.citations.length > 0 && (
              <ul className="space-y-1 border-t border-slate-200 pt-2 text-xs">
                {r.citations.map((c, i) => (
                  <li key={i}>
                    <Link className="text-brand-700 hover:underline" href={`/transactions/${transactionId}/documents/${c.documentId}?page=${c.page}`}>
                      {c.documentTitle}, p. {c.page}
                    </Link>{" "}
                    {!c.verified && <Badge tone="warning">excerpt not verified</Badge>}
                    <blockquote className="mt-0.5 border-l-2 border-slate-300 pl-2 italic">“{c.excerpt}”</blockquote>
                  </li>
                ))}
              </ul>
            )}
            {r.droppedCitations > 0 && <p className="text-xs text-amber-800">{r.droppedCitations} citation(s) referenced material that was not provided and were removed.</p>}
            <p className="text-xs text-slate-500">Assistant output is not legal advice and does not confirm title, funding or signing authority.</p>
          </div>
        )}
      >
        <label htmlFor="question" className="sr-only">
          Question
        </label>
        <Textarea id="question" name="question" rows={3} required minLength={5} maxLength={1000} placeholder="e.g. When does the loan contingency expire?" />
      </ActionForm>
    </Card>
  );
}
