import { db, type Tx } from "../db";
import { requirePermission, requireUser, type Ctx } from "../context";
import { invalid, notFound, precondition } from "../errors";
import { audit } from "../audit";
import { parseDefinition, WorkflowDefinitionSchema } from "../workflow/definition";
import { DEFAULT_TEMPLATES } from "../workflow/templates";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Versioned workflow templates. Published versions are immutable. Editing
 * creates a new DRAFT version; publishing it makes it the default for NEW
 * files while existing files stay on the version they were opened with.
 */

export async function installDefaultTemplates(client: Tx, companyId: string, actorId: string | null) {
  for (const t of DEFAULT_TEMPLATES) {
    const def = WorkflowDefinitionSchema.parse(t.definition);
    const tpl = await client.workflowTemplate.upsert({
      where: { companyId_key: { companyId, key: t.key } },
      create: { companyId, key: t.key, name: t.name, transactionType: t.transactionType, jurisdiction: t.jurisdiction, description: t.description },
      update: {},
    });
    const hasVersion = await client.workflowTemplateVersion.count({ where: { templateId: tpl.id } });
    if (!hasVersion) {
      await client.workflowTemplateVersion.create({
        data: { companyId, templateId: tpl.id, version: 1, status: "PUBLISHED", definition: def as unknown as Prisma.InputJsonValue, changeNote: "Initial California pilot template", createdById: actorId, publishedById: actorId, publishedAt: new Date() },
      });
    }
  }
}

export async function listTemplates(ctx: Ctx) {
  requirePermission(ctx, "transaction.read");
  return db.workflowTemplate.findMany({
    where: { companyId: ctx.companyId },
    include: { versions: { orderBy: { version: "desc" }, include: { _count: { select: { transactions: true } } } } },
    orderBy: { name: "asc" },
  });
}

export async function getTemplateVersion(ctx: Ctx, versionId: string) {
  requirePermission(ctx, "transaction.read");
  const v = await db.workflowTemplateVersion.findFirst({ where: { id: versionId, companyId: ctx.companyId }, include: { template: true } });
  if (!v) throw notFound("Template version");
  return { ...v, parsed: parseDefinition(v.definition) };
}

export async function createDraftVersion(ctx: Ctx, templateId: string, fromVersionId: string) {
  requirePermission(ctx, "templates.manage");
  const actorId = requireUser(ctx);
  const tpl = await db.workflowTemplate.findFirst({ where: { id: templateId, companyId: ctx.companyId } });
  if (!tpl) throw notFound("Template");
  const src = await db.workflowTemplateVersion.findFirst({ where: { id: fromVersionId, templateId: tpl.id } });
  if (!src) throw notFound("Template version");
  const existingDraft = await db.workflowTemplateVersion.findFirst({ where: { templateId: tpl.id, status: "DRAFT" } });
  if (existingDraft) return existingDraft;
  return db.$transaction(async (client) => {
    const max = await client.workflowTemplateVersion.aggregate({ where: { templateId: tpl.id }, _max: { version: true } });
    const v = await client.workflowTemplateVersion.create({
      data: { companyId: ctx.companyId, templateId: tpl.id, version: (max._max.version ?? 0) + 1, status: "DRAFT", definition: src.definition as Prisma.InputJsonValue, createdById: actorId, changeNote: `Draft from v${src.version}` },
    });
    await audit(ctx, { action: "template.draft_created", entityType: "WorkflowTemplateVersion", entityId: v.id, entityVersion: v.version, summary: `Draft v${v.version} of "${tpl.name}" created` }, client);
    return v;
  });
}

export async function saveDraftDefinition(ctx: Ctx, versionId: string, json: string, changeNote?: string) {
  requirePermission(ctx, "templates.manage");
  const v = await db.workflowTemplateVersion.findFirst({ where: { id: versionId, companyId: ctx.companyId } });
  if (!v) throw notFound("Template version");
  if (v.status !== "DRAFT") throw precondition("Published versions are immutable. Create a new draft.");
  let parsed;
  try {
    parsed = WorkflowDefinitionSchema.safeParse(JSON.parse(json));
  } catch {
    throw invalid("Definition is not valid JSON.");
  }
  if (!parsed.success) throw invalid(`Definition is invalid: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  await db.$transaction(async (client) => {
    await client.workflowTemplateVersion.update({ where: { id: v.id }, data: { definition: parsed.data as unknown as Prisma.InputJsonValue, changeNote: changeNote?.trim() || v.changeNote } });
    await audit(ctx, { action: "template.draft_saved", entityType: "WorkflowTemplateVersion", entityId: v.id, entityVersion: v.version, summary: `Template draft v${v.version} saved` }, client);
  });
}

export async function publishVersion(ctx: Ctx, versionId: string) {
  requirePermission(ctx, "templates.manage");
  const actorId = requireUser(ctx);
  const v = await db.workflowTemplateVersion.findFirst({ where: { id: versionId, companyId: ctx.companyId }, include: { template: true } });
  if (!v) throw notFound("Template version");
  if (v.status !== "DRAFT") throw precondition("Only drafts can be published.");
  parseDefinition(v.definition);
  await db.$transaction(async (client) => {
    await client.workflowTemplateVersion.updateMany({ where: { templateId: v.templateId, status: "PUBLISHED" }, data: { status: "RETIRED" } });
    await client.workflowTemplateVersion.update({ where: { id: v.id }, data: { status: "PUBLISHED", publishedAt: new Date(), publishedById: actorId } });
    await audit(ctx, { action: "template.published", entityType: "WorkflowTemplateVersion", entityId: v.id, entityVersion: v.version, summary: `Published "${v.template.name}" v${v.version}. Existing files keep their original version.` }, client);
  });
}
