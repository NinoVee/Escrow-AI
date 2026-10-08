"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "./ui";

export function NavLink({ href, children, exact, badge }: { href: string; children: React.ReactNode; exact?: boolean; badge?: number }) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(href + "/");
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium",
        active ? "bg-brand-700 text-white" : "text-slate-200 hover:bg-white/10 hover:text-white",
      )}
    >
      <span>{children}</span>
      {badge ? <span className={cn("rounded-full px-1.5 text-xs tabular", active ? "bg-white/20" : "bg-amber-400 text-slate-900")}>{badge}</span> : null}
    </Link>
  );
}

export function TabLink({ href, children, exact }: { href: string; children: React.ReactNode; exact?: boolean }) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(href + "/");
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
        active ? "border-brand-700 text-brand-800" : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900",
      )}
    >
      {children}
    </Link>
  );
}
