import Link from "next/link";
import { requirePortalCtx, getSessionUser } from "@/server/auth/session";
import { SignOutButton } from "@/components/sign-out-button";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  await requirePortalCtx();
  const user = await getSessionUser();
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Link href="/portal" className="font-semibold text-brand-800">
            EscrowFlow · Secure portal
          </Link>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-slate-600 sm:inline">{user?.name}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-3xl px-4 py-6">
        {children}
      </main>
      <footer className="mx-auto max-w-3xl px-4 pb-8 text-xs text-slate-500">
        Your escrow company will never ask you to change wiring instructions by email or portal message. Always verify wire instructions by calling a known phone number before sending funds.
      </footer>
    </div>
  );
}
