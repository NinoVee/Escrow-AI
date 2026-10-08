import type { Metadata } from "next";
import { requireStaffCtx } from "@/server/auth/session";
import { listStaff } from "@/server/services/users";
import { ActionForm } from "@/components/action-form";
import { Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { createTransactionAction } from "../actions";
import { ContractIntake } from "./contract-intake";

export const metadata: Metadata = { title: "New transaction" };

const PARTY_TYPES = ["INDIVIDUAL", "LLC", "CORPORATION", "TRUST", "PARTNERSHIP", "ESTATE", "OTHER_ENTITY"];

export default async function NewTransactionPage() {
  const ctx = await requireStaffCtx();
  const staff = await listStaff(ctx);
  const officers = staff.filter((m) => ["ESCROW_OFFICER", "COMPANY_ADMIN", "MANAGER"].includes(m.role));
  const assistants = staff.filter((m) => m.role === "ESCROW_ASSISTANT" || m.role === "ESCROW_OFFICER");

  return (
    <>
      <PageHeader title="New transaction" description="Create a file manually, or upload a purchase agreement to generate proposed fields for officer review." />
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Enter details manually" className="xl:col-span-2" description="Values entered here are recorded as manual entries with your name in the field history.">
          <ActionForm action={createTransactionAction} submitLabel="Create transaction" pendingLabel="Creating…">
            <fieldset className="grid gap-4 sm:grid-cols-3">
              <legend className="mb-2 text-sm font-semibold text-slate-900">File</legend>
              <Field label="Transaction type" htmlFor="type" required>
                <Select id="type" name="type" defaultValue="RESIDENTIAL">
                  <option value="RESIDENTIAL">Residential</option>
                  <option value="COMMERCIAL">Commercial</option>
                </Select>
              </Field>
              <Field label="Jurisdiction" htmlFor="jurisdiction" hint="California pilot">
                <Input id="jurisdiction" value="US-CA (California)" disabled readOnly />
              </Field>
              <Field label="Escrow number" htmlFor="escrowNumber" hint="Leave blank to auto-assign">
                <Input id="escrowNumber" name="escrowNumber" maxLength={40} />
              </Field>
              <Field label="Escrow officer" htmlFor="officerId">
                <Select id="officerId" name="officerId" defaultValue={ctx.role === "ESCROW_OFFICER" ? ctx.userId! : ""}>
                  <option value="">Unassigned</option>
                  {officers.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.user.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Escrow assistant" htmlFor="assistantId">
                <Select id="assistantId" name="assistantId" defaultValue={ctx.role === "ESCROW_ASSISTANT" ? ctx.userId! : ""}>
                  <option value="">Unassigned</option>
                  {assistants.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.user.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="File title" htmlFor="title" hint="Optional short name">
                <Input id="title" name="title" maxLength={200} />
              </Field>
            </fieldset>

            <fieldset className="grid gap-4 sm:grid-cols-3">
              <legend className="mb-2 mt-2 text-sm font-semibold text-slate-900">Property (add more parcels later)</legend>
              <Field label="Street address" htmlFor="street">
                <Input id="street" name="street" autoComplete="off" />
              </Field>
              <Field label="City" htmlFor="city">
                <Input id="city" name="city" />
              </Field>
              <Field label="County" htmlFor="county">
                <Input id="county" name="county" />
              </Field>
              <Field label="ZIP" htmlFor="postalCode">
                <Input id="postalCode" name="postalCode" inputMode="numeric" maxLength={10} />
              </Field>
              <Field label="APN" htmlFor="apn" hint="Assessor's parcel number">
                <Input id="apn" name="apn" />
              </Field>
              <Field label="Property type" htmlFor="propertyType">
                <Select id="propertyType" name="propertyType" defaultValue="">
                  <option value="">Default for type</option>
                  {["SINGLE_FAMILY", "CONDO", "MULTIFAMILY", "OFFICE", "RETAIL", "INDUSTRIAL", "LAND", "MIXED_USE"].map((t) => (
                    <option key={t} value={t}>
                      {t.replaceAll("_", " ").toLowerCase()}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="sm:col-span-3">
                <Field label="Legal description" htmlFor="legalDescription">
                  <Input id="legalDescription" name="legalDescription" />
                </Field>
              </div>
            </fieldset>

            <fieldset className="grid gap-4 sm:grid-cols-3">
              <legend className="mb-2 mt-2 text-sm font-semibold text-slate-900">Principal parties</legend>
              <Field label="Buyer name" htmlFor="buyerName">
                <Input id="buyerName" name="buyerName" />
              </Field>
              <Field label="Buyer type" htmlFor="buyerType">
                <Select id="buyerType" name="buyerType">
                  {PARTY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replaceAll("_", " ").toLowerCase()}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Buyer email" htmlFor="buyerEmail">
                <Input id="buyerEmail" name="buyerEmail" type="email" />
              </Field>
              <Field label="Seller name" htmlFor="sellerName">
                <Input id="sellerName" name="sellerName" />
              </Field>
              <Field label="Seller type" htmlFor="sellerType">
                <Select id="sellerType" name="sellerType">
                  {PARTY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replaceAll("_", " ").toLowerCase()}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Seller email" htmlFor="sellerEmail">
                <Input id="sellerEmail" name="sellerEmail" type="email" />
              </Field>
            </fieldset>

            <fieldset className="grid gap-4 sm:grid-cols-3">
              <legend className="mb-2 mt-2 text-sm font-semibold text-slate-900">Deal terms (optional)</legend>
              <Field label="Purchase price" htmlFor="purchasePriceCents" hint="e.g. 875,000.00">
                <Input id="purchasePriceCents" name="purchasePriceCents" inputMode="decimal" />
              </Field>
              <Field label="Initial deposit" htmlFor="initialDepositCents">
                <Input id="initialDepositCents" name="initialDepositCents" inputMode="decimal" />
              </Field>
              <Field label="Loan amount" htmlFor="loanAmountCents">
                <Input id="loanAmountCents" name="loanAmountCents" inputMode="decimal" />
              </Field>
              <Field label="Financing" htmlFor="financingType">
                <Select id="financingType" name="financingType" defaultValue="">
                  <option value="">Unknown</option>
                  {["CASH", "CONVENTIONAL", "FHA", "VA", "SELLER_CARRY", "COMMERCIAL_LOAN", "OTHER"].map((t) => (
                    <option key={t} value={t}>
                      {t.replaceAll("_", " ").toLowerCase()}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Acceptance date" htmlFor="acceptanceDate">
                <Input id="acceptanceDate" name="acceptanceDate" type="date" />
              </Field>
              <Field label="Proposed closing date" htmlFor="proposedClosingDate">
                <Input id="proposedClosingDate" name="proposedClosingDate" type="date" />
              </Field>
              <div className="flex flex-wrap gap-4 sm:col-span-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="hasHoa" /> HOA applies
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="hasTenants" /> Tenants in possession
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="is1031Exchange" /> 1031 exchange
                </label>
              </div>
            </fieldset>
          </ActionForm>
        </Card>
        <ContractIntake />
      </div>
    </>
  );
}
