"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import type { FormAction } from "@/lib/action-types";

export function InviteResult({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window !== "undefined" ? `${window.location.origin}${path}` : path;
  return (
    <div className="max-w-sm rounded-md border border-amber-300 bg-amber-50 p-2 text-xs">
      <div className="break-all font-mono">{url}</div>
      <button
        type="button"
        className="mt-1 text-brand-700 underline"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}

export function InvitePortalButton({ action, label }: { action: FormAction<{ inviteUrl?: string }>; label: string }) {
  return (
    <ActionForm action={action} submitLabel={label} size="sm" variant="secondary" renderResult={(d) => (d?.inviteUrl ? <InviteResult path={d.inviteUrl} /> : null)}>
      {null}
    </ActionForm>
  );
}
