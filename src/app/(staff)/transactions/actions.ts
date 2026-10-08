"use server";

import { redirect } from "next/navigation";
import { optStr, runAction, str, bool } from "@/server/action";
import { createTransaction, createTransactionFromContract } from "@/server/services/transactions";
import { AppError } from "@/server/errors";
import type { ActionState } from "@/lib/action-types";

export async function createTransactionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let createdId: string | null = null;
  const res = await runAction(async (ctx) => {
    const type = str(fd, "type") === "COMMERCIAL" ? "COMMERCIAL" : "RESIDENTIAL";
    const parties = [
      { role: "BUYER" as const, displayName: str(fd, "buyerName").trim(), partyType: (optStr(fd, "buyerType") ?? "INDIVIDUAL") as "INDIVIDUAL", email: optStr(fd, "buyerEmail") ?? "" },
      { role: "SELLER" as const, displayName: str(fd, "sellerName").trim(), partyType: (optStr(fd, "sellerType") ?? "INDIVIDUAL") as "INDIVIDUAL", email: optStr(fd, "sellerEmail") ?? "" },
    ].filter((p) => p.displayName);
    const fields: Record<string, unknown> = {};
    for (const k of ["purchasePriceCents", "initialDepositCents", "loanAmountCents", "financingType", "acceptanceDate", "proposedClosingDate"]) {
      const v = optStr(fd, k);
      if (v) fields[k] = v;
    }
    for (const k of ["hasHoa", "hasTenants", "is1031Exchange"]) if (bool(fd, k)) fields[k] = true;
    const street = optStr(fd, "street");
    const tx = await createTransaction(ctx, {
      type,
      jurisdiction: "US-CA",
      escrowNumber: optStr(fd, "escrowNumber"),
      title: optStr(fd, "title"),
      officerId: optStr(fd, "officerId"),
      assistantId: optStr(fd, "assistantId"),
      property: street
        ? {
            street,
            city: str(fd, "city").trim(),
            county: optStr(fd, "county"),
            state: "CA",
            postalCode: optStr(fd, "postalCode"),
            propertyType: optStr(fd, "propertyType") ?? (type === "COMMERCIAL" ? "COMMERCIAL" : "SINGLE_FAMILY"),
            apn: optStr(fd, "apn"),
            legalDescription: optStr(fd, "legalDescription"),
          }
        : undefined,
      parties,
      fields,
    });
    createdId = tx.id;
  }, ["/transactions", "/dashboard"]);
  if (res.ok && createdId) redirect(`/transactions/${createdId}`);
  return res;
}

export async function createFromContractAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let target: string | null = null;
  const res = await runAction(async (ctx) => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("VALIDATION", "Choose the purchase agreement file.");
    const out = await createTransactionFromContract(ctx, {
      type: str(fd, "type") === "COMMERCIAL" ? "COMMERCIAL" : "RESIDENTIAL",
      filename: file.name,
      data: Buffer.from(await file.arrayBuffer()),
      officerId: optStr(fd, "officerId"),
    });
    if (out.scan.status !== "CLEAN") throw new AppError("VALIDATION", `The file was quarantined: ${out.scan.detail}`);
    target = `/transactions/${out.transaction.id}/documents/${out.document.id}`;
  }, ["/transactions"]);
  if (res.ok && target) redirect(target);
  return res;
}
