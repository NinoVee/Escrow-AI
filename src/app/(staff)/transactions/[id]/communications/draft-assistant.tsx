"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Select, buttonClass } from "@/components/ui";
import { draftAction } from "../ai-actions";

type Draft = { subject: string; body: string; mode: string };

function DraftView({ d }: { d: Draft }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-md bg-slate-50 p-3 text-sm">
      <Badge tone={d.mode === "LIVE" ? "success" : "purple"}>{d.mode === "LIVE" ? "AI draft" : "Demo template"}</Badge>
      <p className="font-medium">{d.subject}</p>
      <pre className="whitespace-pre-wrap font-sans">{d.body}</pre>
      <button
        type="button"
        className={buttonClass("secondary", "sm")}
        onClick={async () => {
          await navigator.clipboard.writeText(`${d.subject}\n\n${d.body}`);
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy draft"}
      </button>
      <p className="text-xs text-slate-500">Drafts are never sent automatically. Review, edit and send through an approved channel.</p>
    </div>
  );
}

export function DraftAssistant({ transactionId, participants }: { transactionId: string; participants: { id: string; label: string }[] }) {
  return (
    <Card title="Draft a message" description="Generates a draft from file facts for you to review. Nothing is sent.">
      <ActionForm<Draft> action={draftAction.bind(null, transactionId)} submitLabel="Draft" pendingLabel="Drafting…" size="sm" resetOnSuccess={false} renderResult={(d) => <DraftView d={d} />}>
        <label className="block text-sm">
          Type
          <Select name="kind" className="mt-1">
            <option value="STATUS_UPDATE">Status update</option>
            <option value="DOCUMENT_REQUEST">Document request</option>
            <option value="DEADLINE_REMINDER">Deadline reminder</option>
          </Select>
        </label>
        <label className="block text-sm">
          Recipient
          <Select name="participantId" className="mt-1" defaultValue="">
            <option value="">General</option>
            {participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </label>
      </ActionForm>
    </Card>
  );
}
