import { getWorkspace } from "../data";
import { hasPermission } from "@/server/context";
import { ActionForm } from "@/components/action-form";
import { Card, EmptyState, Field, Input, Select, humanize } from "@/components/ui";
import { addParcelAction, addPropertyAction } from "../actions";
import { PropertyLookups } from "./lookups";

export default async function PropertyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, tx, properties } = await getWorkspace(id);
  const canEdit = hasPermission(ctx, "transaction.update");
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <div className="space-y-6 xl:col-span-2">
        {properties.length === 0 ? (
          <EmptyState title="No property recorded">Add the property and parcel numbers. Commercial files can include multiple properties and parcels.</EmptyState>
        ) : (
          properties.map((p, idx) => (
            <Card key={p.id} title={p.label || `Property ${idx + 1}`} description={`${humanize(p.propertyType)}${p.hoaName ? ` · HOA: ${p.hoaName}` : ""}`}>
              <address className="not-italic text-sm">
                {p.street}
                {p.unit ? ` ${p.unit}` : ""}
                <br />
                {p.city}, {p.state} {p.postalCode}
                {p.county && <span className="text-slate-500"> · {p.county} County</span>}
              </address>
              <div className="mt-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Parcels</div>
                {p.parcels.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-500">No parcel numbers recorded.</p>
                ) : (
                  <ul className="mt-1 divide-y divide-slate-100 text-sm">
                    {p.parcels.map((pc) => (
                      <li key={pc.id} className="py-1.5">
                        <span className="font-mono">APN {pc.apn}</span>
                        {pc.legalDescription && <p className="text-xs text-slate-600">{pc.legalDescription}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {canEdit && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-brand-700">Add parcel</summary>
                  <ActionForm action={addParcelAction.bind(null, tx.id, p.id)} submitLabel="Add parcel" size="sm" className="mt-2 max-w-md">
                    <Field label="APN" htmlFor={`apn-${p.id}`} required>
                      <Input id={`apn-${p.id}`} name="apn" required />
                    </Field>
                    <Field label="Legal description" htmlFor={`ld-${p.id}`}>
                      <Input id={`ld-${p.id}`} name="legalDescription" />
                    </Field>
                  </ActionForm>
                </details>
              )}
            </Card>
          ))
        )}
        <PropertyLookups transactionId={tx.id} />
      </div>
      {canEdit && (
        <Card title="Add property">
          <ActionForm action={addPropertyAction.bind(null, tx.id)} submitLabel="Add property">
            <Field label="Label" htmlFor="label" hint="e.g. Building A">
              <Input id="label" name="label" />
            </Field>
            <Field label="Street" htmlFor="street" required>
              <Input id="street" name="street" required />
            </Field>
            <Field label="Unit" htmlFor="unit">
              <Input id="unit" name="unit" />
            </Field>
            <Field label="City" htmlFor="city" required>
              <Input id="city" name="city" required />
            </Field>
            <Field label="County" htmlFor="county">
              <Input id="county" name="county" />
            </Field>
            <Field label="ZIP" htmlFor="postalCode">
              <Input id="postalCode" name="postalCode" />
            </Field>
            <Field label="Type" htmlFor="propertyType">
              <Select id="propertyType" name="propertyType" defaultValue={tx.type === "COMMERCIAL" ? "OFFICE" : "SINGLE_FAMILY"}>
                {["SINGLE_FAMILY", "CONDO", "MULTIFAMILY", "OFFICE", "RETAIL", "INDUSTRIAL", "LAND", "MIXED_USE"].map((t) => (
                  <option key={t} value={t}>
                    {humanize(t)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="HOA name" htmlFor="hoaName">
              <Input id="hoaName" name="hoaName" />
            </Field>
            <Field label="APN" htmlFor="apn">
              <Input id="apn" name="apn" />
            </Field>
            <Field label="Legal description" htmlFor="legalDescription">
              <Input id="legalDescription" name="legalDescription" />
            </Field>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
