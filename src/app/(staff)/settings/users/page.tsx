import type { Metadata } from "next";
import { requireStaffCtx } from "@/server/auth/session";
import { listMembers } from "@/server/services/users";
import { ROLE_LABELS } from "@/server/authz";
import { Badge, Card, Field, Input, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { membershipAction } from "../actions";
import { InviteStaffForm } from "./invite-form";

export const metadata: Metadata = { title: "Users" };

const STAFF_ROLES = ["COMPANY_ADMIN", "ESCROW_OFFICER", "ESCROW_ASSISTANT", "ACCOUNTING", "MANAGER"] as const;

export default async function UsersPage() {
  const ctx = await requireStaffCtx();
  const members = await listMembers(ctx);
  const staff = members.filter((m) => m.role !== "EXTERNAL");
  const external = members.filter((m) => m.role === "EXTERNAL");
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div className="space-y-6 xl:col-span-2">
        <Card title="Staff">
          <Table caption="Staff members">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Role</Th>
                <Th>MFA</Th>
                <Th>Status</Th>
                <Th>Change</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {staff.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <div className="font-medium">{m.user.name}</div>
                    <div className="text-xs text-slate-500">{m.user.email}</div>
                  </Td>
                  <Td>{ROLE_LABELS[m.role]}</Td>
                  <Td>{m.user.twoFactorEnabled ? <Badge tone="success">Enabled</Badge> : <Badge tone="warning">Not set up</Badge>}</Td>
                  <Td>
                    <StatusBadge status={m.status === "ACTIVE" ? "ACTIVE" : "CANCELLED"} label={m.status === "ACTIVE" ? "Active" : "Disabled"} />
                  </Td>
                  <Td>
                    {m.userId !== ctx.userId && (
                      <ActionForm action={membershipAction.bind(null, m.id)} submitLabel="Save" size="sm" variant="secondary" inline resetOnSuccess={false}>
                        <Select name="role" defaultValue={m.role} aria-label="Role" className="w-44">
                          {STAFF_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </Select>
                        <Select name="status" defaultValue={m.status} aria-label="Status" className="w-28">
                          <option value="ACTIVE">Active</option>
                          <option value="DISABLED">Disabled</option>
                        </Select>
                      </ActionForm>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card title="External participant accounts" description="Portal access is granted per transaction from the Parties tab.">
          {external.length === 0 ? (
            <p className="text-sm text-slate-500">None.</p>
          ) : (
            <ul className="text-sm">
              {external.map((m) => (
                <li key={m.id}>
                  {m.user.name} <span className="text-slate-500">({m.user.email})</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title="Invite staff member">
        <InviteStaffForm>
          <Field label="Name" htmlFor="inv-name" required>
            <Input id="inv-name" name="name" required />
          </Field>
          <Field label="Email" htmlFor="inv-email" required>
            <Input id="inv-email" name="email" type="email" required />
          </Field>
          <Field label="Role" htmlFor="inv-role">
            <Select id="inv-role" name="role" defaultValue="ESCROW_ASSISTANT">
              {STAFF_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
        </InviteStaffForm>
      </Card>
    </div>
  );
}
