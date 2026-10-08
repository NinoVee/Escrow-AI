import type { Metadata } from "next";
import { lookupInvitation } from "@/server/services/users";
import { AcceptInviteForm } from "./accept-form";

export const metadata: Metadata = { title: "Accept invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await lookupInvitation(token);
  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-xl font-semibold">Accept invitation</h1>
      {!inv ? (
        <p className="mt-3 text-sm text-slate-600">This invitation link is invalid, already used, or expired. Ask your escrow officer for a new one.</p>
      ) : (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-600">
            {inv.companyName} invited <strong>{inv.email}</strong> {inv.role === "EXTERNAL" ? "to its secure transaction portal" : "to join as staff"}.
          </p>
          <AcceptInviteForm token={token} hasAccount={inv.hasAccount} />
        </div>
      )}
    </main>
  );
}
