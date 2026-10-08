"use client";

import { useEffect, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { revealInstructionAction } from "../finance-actions";

/** Shows full numbers for 60 seconds after a permitted, step-up-verified reveal. */
function Revealed({ d }: { d: { accountNumber: string; routingNumber: string } }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 60_000);
    return () => clearTimeout(t);
  }, []);
  if (!visible) return <p className="text-xs text-slate-500">Hidden again. Reveal is logged each time.</p>;
  return (
    <div className="rounded border border-amber-300 bg-amber-50 p-2 font-mono text-xs">
      Routing {d.routingNumber} · Account {d.accountNumber}
      <div className="font-sans text-[11px] text-amber-900">Visible for 60 seconds. Do not copy into email or messages.</div>
    </div>
  );
}

export function RevealButton({ instructionId }: { instructionId: string }) {
  return (
    <ActionForm<{ accountNumber: string; routingNumber: string }> action={revealInstructionAction.bind(null, instructionId)} submitLabel="Reveal full numbers" size="sm" variant="ghost" renderResult={(d) => <Revealed d={d} />}>
      {null}
    </ActionForm>
  );
}
