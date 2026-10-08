import { requireStaffCtx } from "@/server/auth/session";
import { hasPermission } from "@/server/context";
import { TabLink } from "@/components/nav-link";
import { PageHeader } from "@/components/ui";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireStaffCtx();
  return (
    <>
      <PageHeader title="Settings" />
      <nav aria-label="Settings sections" className="mb-6 flex overflow-x-auto border-b border-slate-200">
        <TabLink href="/settings" exact>
          Company
        </TabLink>
        {hasPermission(ctx, "users.manage") && <TabLink href="/settings/users">Users</TabLink>}
        <TabLink href="/settings/templates">Workflow templates</TabLink>
        <TabLink href="/settings/integrations">Integrations</TabLink>
        {hasPermission(ctx, "automation.manage") && <TabLink href="/settings/automation">Automation</TabLink>}
        {hasPermission(ctx, "jobs.manage") && <TabLink href="/settings/jobs">Jobs</TabLink>}
        {hasPermission(ctx, "audit.read") && <TabLink href="/settings/audit">Audit log</TabLink>}
      </nav>
      {children}
    </>
  );
}
