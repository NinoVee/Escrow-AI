import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffCtx } from "@/server/auth/session";
import { listNotifications } from "@/server/services/operations";
import { ActionForm } from "@/components/action-form";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { displayDateTime } from "@/lib/dates";
import { markReadAction } from "./actions";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const ctx = await requireStaffCtx();
  const items = await listNotifications(ctx);
  const unread = items.some((n) => !n.readAt);
  return (
    <>
      <PageHeader title="Notifications" description="Internal alerts, such as overdue-task escalations from automation rules." actions={unread ? <ActionForm action={markReadAction} submitLabel="Mark all read" size="sm" variant="secondary" inline /> : undefined} />
      <Card>
        {items.length === 0 ? (
          <EmptyState title="No notifications">Escalations and alerts appear here.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((n) => (
              <li key={n.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                <span className={n.readAt ? "text-slate-600" : "font-medium"}>
                  {n.link ? (
                    <Link href={n.link} className="hover:underline">
                      {n.title}
                    </Link>
                  ) : (
                    n.title
                  )}
                  {n.body && <span className="ml-2 text-xs text-slate-500">{n.body}</span>}
                </span>
                <span className="text-xs text-slate-500 tabular">{displayDateTime(n.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
