import Link from "next/link";
import { requireStaffCtx, getMemberships, getSessionUser } from "@/server/auth/session";
import { ROLE_LABELS } from "@/server/authz";
import { hasPermission } from "@/server/context";
import { NavLink } from "@/components/nav-link";
import { SignOutButton } from "@/components/sign-out-button";
import { db } from "@/server/db";
import { aiMode } from "@/server/ai/provider";
import { unreadNotificationCount } from "@/server/services/operations";
import { CompanySwitcher } from "./company-switcher";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireStaffCtx();
  const user = await getSessionUser();
  const memberships = (await getMemberships(ctx.userId!)).filter((m) => m.role !== "EXTERNAL");
  const company = memberships.find((m) => m.companyId === ctx.companyId);
  const pending = await db.approval.count({ where: { companyId: ctx.companyId, status: "PENDING", NOT: { requestedById: ctx.userId! } } });
  const unread = await unreadNotificationCount(ctx);
  const demoAi = aiMode() === "DEMO";

  return (
    <div className="min-h-screen lg:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="bg-slate-900 lg:fixed lg:inset-y-0 lg:w-60 lg:overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-4 lg:block">
          <Link href="/dashboard" className="text-lg font-semibold tracking-tight text-white">
            EscrowFlow
          </Link>
          <div className="mt-1 hidden text-xs text-slate-400 lg:block">{company?.companyName}</div>
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-3 lg:block lg:space-y-1 lg:overflow-visible">
          <NavLink href="/dashboard">Dashboard</NavLink>
          <NavLink href="/transactions">Transactions</NavLink>
          <NavLink href="/approvals" badge={pending}>
            Approvals
          </NavLink>
          {hasPermission(ctx, "recon.prepare") || hasPermission(ctx, "ledger.read") ? <NavLink href="/reconciliation">Reconciliation</NavLink> : null}
          <NavLink href="/notifications" badge={unread}>
            Notifications
          </NavLink>
          <NavLink href="/settings">Settings</NavLink>
        </nav>
      </aside>
      <div className="min-w-0 flex-1 lg:pl-60">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2 sm:px-6">
          <div className="flex items-center gap-3 text-sm text-slate-600">
            {memberships.length > 1 ? <CompanySwitcher current={ctx.companyId} options={memberships.map((m) => ({ id: m.companyId, name: m.companyName }))} /> : <span className="lg:hidden">{company?.companyName}</span>}
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-700">
              {user?.name} <span className="text-slate-400">·</span> <span className="text-slate-500">{ROLE_LABELS[ctx.role as keyof typeof ROLE_LABELS]}</span>
            </span>
            <Link href="/account/security" className="text-brand-700 hover:underline">
              Security
            </Link>
            <SignOutButton />
          </div>
        </header>
        {demoAi && (
          <div className="border-b border-violet-200 bg-violet-50 px-4 py-1.5 text-xs text-violet-900 sm:px-6">
            Demo mode: document extraction uses a rule-based demo adapter (no AI credentials configured). External sending and payment execution are disabled.
          </div>
        )}
        <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}
