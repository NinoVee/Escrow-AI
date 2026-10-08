import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "danger" | "ghost";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-700 text-white hover:bg-brand-800 border border-brand-700",
  secondary: "bg-white text-slate-800 hover:bg-slate-50 border border-slate-300",
  danger: "bg-red-700 text-white hover:bg-red-800 border border-red-700",
  ghost: "bg-transparent text-brand-700 hover:bg-brand-50 border border-transparent",
};

export function buttonClass(variant: Variant = "secondary", size: "sm" | "md" = "md") {
  return cn(
    "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap",
    size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
    VARIANTS[variant],
  );
}

export function Button({ variant = "secondary", size = "md", className, ...props }: ComponentProps<"button"> & { variant?: Variant; size?: "sm" | "md" }) {
  return <button {...props} className={cn(buttonClass(variant, size), className)} />;
}

export function LinkButton({ variant = "secondary", size = "md", className, ...props }: ComponentProps<typeof Link> & { variant?: Variant; size?: "sm" | "md" }) {
  return <Link {...props} className={cn(buttonClass(variant, size), className)} />;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "brand" | "purple";
const TONES: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-300",
  info: "bg-sky-50 text-sky-800 ring-sky-200",
  success: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  warning: "bg-amber-50 text-amber-900 ring-amber-300",
  danger: "bg-red-50 text-red-800 ring-red-200",
  brand: "bg-brand-50 text-brand-800 ring-brand-100",
  purple: "bg-violet-50 text-violet-800 ring-violet-200",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function humanize(s: string | null | undefined) {
  if (!s) return "—";
  return s.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

const STATUS_TONES: Record<string, Tone> = {
  ACTIVE: "brand",
  ON_HOLD: "warning",
  CANCELLED: "neutral",
  CLOSED: "success",
  OPEN: "info",
  IN_PROGRESS: "info",
  WAITING: "warning",
  DONE: "success",
  NOT_APPLICABLE: "neutral",
  WAIVED: "neutral",
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  INVALIDATED: "danger",
  CONSUMED: "success",
  MET: "success",
  MISSED: "danger",
  EXTENDED: "neutral",
  COMPLETE: "success",
  NOT_STARTED: "neutral",
  CLEAN: "success",
  INFECTED: "danger",
  ERROR: "danger",
  ACCEPTED: "success",
  SUBMITTED: "info",
  UNVERIFIED: "warning",
  PENDING_REVIEW: "warning",
  VERIFIED: "success",
  SUPERSEDED: "neutral",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={STATUS_TONES[status] ?? "neutral"}>{label ?? humanize(status)}</Badge>;
}

export function ModeBadge({ mode }: { mode: "NOT_CONFIGURED" | "DEMO" | "SANDBOX" | "LIVE" | string }) {
  const map: Record<string, { tone: Tone; label: string; title: string }> = {
    NOT_CONFIGURED: { tone: "neutral", label: "Not configured", title: "No provider configured" },
    DEMO: { tone: "purple", label: "Demo", title: "Simulated data. Not from a real provider." },
    SANDBOX: { tone: "warning", label: "Sandbox", title: "Provider test environment. Not real data." },
    LIVE: { tone: "success", label: "Live", title: "Live provider" },
  };
  const m = map[mode] ?? map.NOT_CONFIGURED;
  return (
    <Badge tone={m.tone} title={m.title}>
      {m.label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-sm text-slate-500">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {description && <div className="mt-1 text-sm text-slate-600">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className, description, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; description?: ReactNode; id?: string }) {
  return (
    <section id={id} className={cn("rounded-lg border border-slate-200 bg-white shadow-sm", className)} aria-label={typeof title === "string" ? title : undefined}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, href, tone }: { label: string; value: ReactNode; href?: string; tone?: "danger" | "warning" }) {
  const body = (
    <div className={cn("rounded-lg border bg-white px-4 py-3 shadow-sm", tone === "danger" ? "border-red-200" : tone === "warning" ? "border-amber-200" : "border-slate-200")}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular", tone === "danger" ? "text-red-700" : tone === "warning" ? "text-amber-800" : "text-slate-900")}>{value}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="block rounded-lg hover:ring-2 hover:ring-brand-100">
      {body}
    </Link>
  ) : (
    body
  );
}

export function Alert({ tone = "info", title, children }: { tone?: "info" | "warning" | "danger" | "success" | "demo"; title?: ReactNode; children?: ReactNode }) {
  const styles = {
    info: "border-sky-200 bg-sky-50 text-sky-900",
    warning: "border-amber-300 bg-amber-50 text-amber-950",
    danger: "border-red-200 bg-red-50 text-red-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
    demo: "border-violet-200 bg-violet-50 text-violet-900",
  }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("rounded-md border px-3 py-2 text-sm", styles)}>
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={title ? "mt-0.5" : undefined}>{children}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50/60 px-4 py-8 text-center">
      <div className="text-sm font-medium text-slate-800">{title}</div>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-slate-500">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export function Table({ children, caption }: { children: ReactNode; caption?: string }) {
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th scope="col" className={cn("whitespace-nowrap px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500", className)}>{children}</th>;
}

export function Td({ children, className, colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) {
  return <td colSpan={colSpan} className={cn("px-3 py-2 align-top text-slate-800", className)}>{children}</td>;
}

// ---------------------------------------------------------------------------
// Form controls (server-renderable)
// ---------------------------------------------------------------------------

export const inputClass =
  "block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-slate-100";

export function Field({ label, htmlFor, hint, children, required }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode; required?: boolean }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="text-red-700" aria-hidden> *</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={cn(inputClass, props.className)} />;
}

export function Select(props: ComponentProps<"select">) {
  return <select {...props} className={cn(inputClass, props.className)} />;
}

export function Textarea(props: ComponentProps<"textarea">) {
  return <textarea {...props} className={cn(inputClass, props.className)} />;
}

export function DL({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.label}>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{i.label}</dt>
          <dd className="mt-0.5 text-sm text-slate-900">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}
