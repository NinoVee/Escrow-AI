import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { requireStaffCtx } from "@/server/auth/session";
import { db } from "@/server/db";
import { loadDefinition } from "@/server/workflow/engine";
import { isAppError } from "@/server/errors";
import { loadTransactionForStaff } from "@/server/services/access";

/** Loads the transaction for the workspace once per request; 404s on no access. */
export const getWorkspace = cache(async (id: string) => {
  const ctx = await requireStaffCtx();
  let tx;
  try {
    tx = await loadTransactionForStaff(ctx, id);
  } catch (e) {
    if (isAppError(e) && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN")) notFound();
    throw e;
  }
  const [def, officer, assistant, properties] = await Promise.all([
    loadDefinition(tx.templateVersionId),
    tx.officerId ? db.user.findUnique({ where: { id: tx.officerId }, select: { id: true, name: true } }) : null,
    tx.assistantId ? db.user.findUnique({ where: { id: tx.assistantId }, select: { id: true, name: true } }) : null,
    db.property.findMany({ where: { transactionId: tx.id }, orderBy: { sortOrder: "asc" }, include: { parcels: true } }),
  ]);
  return { ctx, tx, def, officer, assistant, properties };
});

export async function staffNames(companyId: string) {
  const members = await db.membership.findMany({ where: { companyId }, include: { user: { select: { id: true, name: true } } } });
  return new Map(members.map((m) => [m.userId, m.user.name]));
}
