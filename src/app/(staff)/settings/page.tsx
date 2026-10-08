import type { Metadata } from "next";
import { requireStaffCtx } from "@/server/auth/session";
import { hasPermission } from "@/server/context";
import { getCompany } from "@/server/services/company";
import { env } from "@/server/env";
import { ActionForm } from "@/components/action-form";
import { Alert, Card, DL, Field, Input, Select, humanize } from "@/components/ui";
import { saveSettingsAction } from "./actions";

export const metadata: Metadata = { title: "Company settings" };

export default async function SettingsPage() {
  const ctx = await requireStaffCtx();
  const { company, settings } = await getCompany(ctx);
  const canManage = hasPermission(ctx, "settings.manage");
  const envSend = env().EXTERNAL_SEND_ENABLED === "true";

  if (!canManage) {
    return (
      <Card title={company.name}>
        <DL
          items={[
            { label: "Jurisdiction", value: company.defaultJurisdiction },
            { label: "Time zone", value: settings.timezone },
            { label: "External sending", value: settings.externalSendingEnabled && envSend ? "Enabled" : "Off" },
            { label: "Staff MFA", value: settings.requireStaffMfa ? "Required" : "Optional" },
          ]}
        />
      </Card>
    );
  }

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Company configuration" className="xl:col-span-2">
        <ActionForm action={saveSettingsAction} submitLabel="Save settings" resetOnSuccess={false}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company name" htmlFor="name">
              <Input id="name" name="name" defaultValue={company.name} />
            </Field>
            <Field label="Escrow number prefix" htmlFor="escrowNumberPrefix">
              <Input id="escrowNumberPrefix" name="escrowNumberPrefix" defaultValue={settings.escrowNumberPrefix} />
            </Field>
            <Field label="Time zone" htmlFor="timezone" hint="Used for due dates and overdue calculations">
              <Select id="timezone" name="timezone" defaultValue={settings.timezone}>
                {["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
            </Field>
            <Field label="Step-up window (minutes)" htmlFor="stepUpWindowMinutes" hint="How long a TOTP re-verification lasts for sensitive actions">
              <Input id="stepUpWindowMinutes" name="stepUpWindowMinutes" type="number" min={1} max={30} defaultValue={settings.stepUpWindowMinutes} />
            </Field>
            <Field label="Retention after close (years)" htmlFor="retentionYearsAfterClose" hint="Placeholder. Confirm the required period with counsel and your regulator.">
              <Input id="retentionYearsAfterClose" name="retentionYearsAfterClose" type="number" min={1} max={50} defaultValue={settings.retentionYearsAfterClose} />
            </Field>
          </div>
          <fieldset className="mt-2 grid gap-4 sm:grid-cols-3">
            <legend className="mb-1 text-sm font-semibold">Settlement conventions</legend>
            <Field label="Proration day count" htmlFor="prorationBasis">
              <Select id="prorationBasis" name="prorationBasis" defaultValue={settings.prorationBasis}>
                <option value="ACTUAL_365">Actual days / 365</option>
                <option value="ACTUAL_ACTUAL">Actual days / actual days in period</option>
                <option value="BANKER_360">30 / 360</option>
              </Select>
            </Field>
            <Field label="Rounding" htmlFor="roundingMode">
              <Select id="roundingMode" name="roundingMode" defaultValue={settings.roundingMode}>
                <option value="HALF_UP">Half up (to cent)</option>
                <option value="HALF_EVEN">Half even (to cent)</option>
              </Select>
            </Field>
            <label className="flex items-center gap-2 self-end text-sm">
              <input type="checkbox" name="prorationSellerOwnsClosingDay" defaultChecked={settings.prorationSellerOwnsClosingDay} /> Seller owns the closing day
            </label>
          </fieldset>
          <fieldset className="mt-2 space-y-2">
            <legend className="mb-1 text-sm font-semibold">Controls and procedures</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="requireStaffMfa" defaultChecked={settings.requireStaffMfa} /> Require authenticator-app MFA for all staff
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="requireIndependentBankVerification" defaultChecked={settings.requireIndependentBankVerification} /> Bank instructions must be verified by someone other than the person who entered them
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="requireOfficerReviewOfAmendments" defaultChecked={settings.procedures.requireOfficerReviewOfAmendments} /> Officer must review amendments before changes are accepted
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="requireDocumentReviewBeforeSharing" defaultChecked={settings.procedures.requireDocumentReviewBeforeSharing} /> Documents must be reviewed and accepted before sharing with participants
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="externalSendingEnabled" defaultChecked={settings.externalSendingEnabled} /> Allow external email sending (still requires approved templates, an enabled rule or approval, and the server switch)
            </label>
          </fieldset>
        </ActionForm>
      </Card>
      <div className="space-y-4">
        <Alert tone={envSend ? "warning" : "info"} title="External sending">
          Server switch EXTERNAL_SEND_ENABLED is <strong>{envSend ? "on" : "off"}</strong>. Company switch is <strong>{settings.externalSendingEnabled ? "on" : "off"}</strong>. Email leaves the system only when both are on.
        </Alert>
        <Card title="Jurisdiction">
          <p className="text-sm text-slate-700">Pilot jurisdiction: {humanize(company.defaultJurisdiction)}</p>
          <p className="mt-1 text-xs text-slate-500">Workflows, retention and conventions are configuration, not legal advice. Each must be reviewed by a qualified professional for your jurisdiction and license type.</p>
        </Card>
      </div>
    </div>
  );
}
