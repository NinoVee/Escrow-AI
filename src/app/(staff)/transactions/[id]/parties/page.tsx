import { getWorkspace } from "../data";
import { db } from "@/server/db";
import { hasPermission } from "@/server/context";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, EmptyState, Field, Input, Select, StatusBadge, humanize } from "@/components/ui";
import { addParticipantAction, addSignerAction, invitePortalAction, notificationsAction, requestSignerReviewAction, revokePortalAction } from "../actions";
import { InvitePortalButton } from "./invite-result";

const ROLES = ["BUYER", "SELLER", "BUYER_AGENT", "LISTING_AGENT", "LENDER", "MORTGAGE_BROKER", "TITLE_REP", "ATTORNEY", "ENTITY_REPRESENTATIVE", "EXCHANGE_ACCOMMODATOR", "HOA", "PAYOFF_LENDER", "OTHER"];
const PARTY_TYPES = ["INDIVIDUAL", "LLC", "CORPORATION", "TRUST", "PARTNERSHIP", "ESTATE", "OTHER_ENTITY"];

export default async function PartiesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, tx } = await getWorkspace(id);
  const [participants, docs] = await Promise.all([
    db.participant.findMany({ where: { transactionId: tx.id }, include: { signers: true }, orderBy: [{ side: "asc" }, { createdAt: "asc" }] }),
    db.document.findMany({ where: { transactionId: tx.id, archivedAt: null, category: { in: ["ENTITY_DOCUMENTS", "SIGNING_AUTHORITY", "OTHER"] } }, select: { id: true, title: true } }),
  ]);
  const docTitle = new Map(docs.map((d) => [d.id, d.title]));
  const canManage = hasPermission(ctx, "participant.manage");
  const sides = ["BUYER", "SELLER", "NEUTRAL"] as const;

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div className="space-y-6 xl:col-span-2">
        {participants.length === 0 && <EmptyState title="No participants yet">Add the buyer and seller to open escrow.</EmptyState>}
        {sides.map((side) => {
          const list = participants.filter((p) => p.side === side);
          if (list.length === 0) return null;
          return (
            <Card key={side} title={side === "NEUTRAL" ? "Other participants" : `${humanize(side)} side`} description={side !== "NEUTRAL" ? "Documents are never shared across sides automatically." : undefined}>
              <ul className="divide-y divide-slate-100">
                {list.map((p) => (
                  <li key={p.id} className="py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-medium">
                          {p.displayName} {p.organization && <span className="font-normal text-slate-500">· {p.organization}</span>}
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-1.5 text-xs">
                          <Badge>{humanize(p.role)}</Badge>
                          {p.partyType !== "INDIVIDUAL" && <Badge tone="purple">{humanize(p.partyType)}</Badge>}
                          {p.portalAccess ? <Badge tone="success">Portal access</Badge> : p.invitedAt ? <Badge tone="warning">Invited</Badge> : null}
                          {!p.emailNotifications && <Badge tone="neutral">Email notifications off</Badge>}
                        </div>
                        <div className="mt-1 text-xs text-slate-600">{[p.email, p.phone].filter(Boolean).join(" · ") || "No contact details"}</div>
                      </div>
                      {hasPermission(ctx, "portal.invite") && (
                        <div className="flex flex-wrap gap-2">
                          {!p.portalAccess ? (
                            <InvitePortalButton action={invitePortalAction.bind(null, tx.id, p.id)} label={p.invitedAt ? "New invite link" : "Invite to portal"} />
                          ) : (
                            <ActionForm action={revokePortalAction.bind(null, tx.id, p.id)} submitLabel="Revoke portal" size="sm" variant="secondary" confirm="Revoke this participant's portal access?">
                              <input type="hidden" name="reason" value="Revoked by staff" />
                            </ActionForm>
                          )}
                          <ActionForm action={notificationsAction.bind(null, tx.id, p.id)} submitLabel={p.emailNotifications ? "Turn off email" : "Turn on email"} size="sm" variant="ghost">
                            <input type="hidden" name="enabled" value={p.emailNotifications ? "false" : "true"} />
                          </ActionForm>
                        </div>
                      )}
                    </div>

                    {p.partyType !== "INDIVIDUAL" && (
                      <div className="mt-3 rounded-md bg-slate-50 p-3">
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Authorized signers</div>
                        {p.signers.length === 0 ? (
                          <p className="mt-1 text-sm text-slate-600">No signers recorded. Signing authority must be reviewed by a person; the assistant cannot approve it.</p>
                        ) : (
                          <ul className="mt-1 space-y-2">
                            {p.signers.map((s) => (
                              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                <span>
                                  {s.name}
                                  {s.title && <span className="text-slate-500">, {s.title}</span>}{" "}
                                  <span className="text-xs text-slate-500">Evidence: {s.authorityDocumentId ? docTitle.get(s.authorityDocumentId) ?? "document" : "none"}</span>
                                </span>
                                <span className="flex items-center gap-2">
                                  <StatusBadge status={s.authorityStatus} />
                                  {canManage && (s.authorityStatus === "UNVERIFIED" || s.authorityStatus === "REJECTED") && (
                                    <ActionForm action={requestSignerReviewAction.bind(null, tx.id, s.id)} submitLabel="Request authority review" size="sm" variant="secondary">
                                      {null}
                                    </ActionForm>
                                  )}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {canManage && (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-sm text-brand-700">Add signer</summary>
                            <ActionForm action={addSignerAction.bind(null, tx.id, p.id)} submitLabel="Add signer" size="sm" className="mt-2 grid max-w-md gap-2">
                              <Field label="Name" htmlFor={`sn-${p.id}`} required>
                                <Input id={`sn-${p.id}`} name="name" required />
                              </Field>
                              <Field label="Title / capacity" htmlFor={`st-${p.id}`}>
                                <Input id={`st-${p.id}`} name="title" placeholder="Managing member, trustee…" />
                              </Field>
                              <Field label="Authority evidence" htmlFor={`sd-${p.id}`} hint="Upload entity documents first, then link them here.">
                                <Select id={`sd-${p.id}`} name="authorityDocumentId" defaultValue="">
                                  <option value="">None yet</option>
                                  {docs.map((d) => (
                                    <option key={d.id} value={d.id}>
                                      {d.title}
                                    </option>
                                  ))}
                                </Select>
                              </Field>
                            </ActionForm>
                          </details>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>
      {canManage && (
        <Card title="Add participant">
          <ActionForm action={addParticipantAction.bind(null, tx.id)} submitLabel="Add participant">
            <Field label="Role" htmlFor="role" required>
              <Select id="role" name="role" required>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {humanize(r)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Party type" htmlFor="partyType">
              <Select id="partyType" name="partyType">
                {PARTY_TYPES.map((r) => (
                  <option key={r} value={r}>
                    {humanize(r)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Name" htmlFor="displayName" required>
              <Input id="displayName" name="displayName" required />
            </Field>
            <Field label="Organization" htmlFor="organization">
              <Input id="organization" name="organization" />
            </Field>
            <Field label="Email" htmlFor="email">
              <Input id="email" name="email" type="email" />
            </Field>
            <Field label="Phone" htmlFor="phone">
              <Input id="phone" name="phone" type="tel" />
            </Field>
            <Field label="Side" htmlFor="side" hint="Defaults from the role">
              <Select id="side" name="side" defaultValue="">
                <option value="">Default</option>
                <option value="BUYER">Buyer side</option>
                <option value="SELLER">Seller side</option>
                <option value="NEUTRAL">Neutral</option>
              </Select>
            </Field>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
