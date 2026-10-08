import { db } from "../db";
import { requirePermission, type Ctx } from "../context";
import { invalid } from "../errors";
import { audit } from "../audit";
import { CompanySettingsSchema, getCompanySettings, type CompanySettings } from "../settings";
import type { Prisma } from "@/generated/prisma/client";

export async function getCompany(ctx: Ctx) {
  const company = await db.company.findUniqueOrThrow({ where: { id: ctx.companyId } });
  return { company, settings: await getCompanySettings(ctx.companyId) };
}

export async function updateCompanySettings(ctx: Ctx, patch: Partial<CompanySettings> & { name?: string }) {
  requirePermission(ctx, "settings.manage");
  const current = await getCompanySettings(ctx.companyId);
  const { name, ...rest } = patch;
  const merged = CompanySettingsSchema.safeParse({ ...current, ...rest, procedures: { ...current.procedures, ...(rest.procedures ?? {}) } });
  if (!merged.success) throw invalid(merged.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const changed = Object.keys(rest).filter((k) => JSON.stringify((current as Record<string, unknown>)[k]) !== JSON.stringify((merged.data as Record<string, unknown>)[k]));
  await db.$transaction(async (client) => {
    await client.company.update({ where: { id: ctx.companyId }, data: { settings: merged.data as unknown as Prisma.InputJsonValue, ...(name?.trim() ? { name: name.trim() } : {}) } });
    await audit(ctx, { action: "settings.updated", entityType: "Company", entityId: ctx.companyId, summary: `Company settings updated (${changed.join(", ") || "no changes"})`, details: { changed, externalSendingEnabled: merged.data.externalSendingEnabled } }, client);
  });
}
