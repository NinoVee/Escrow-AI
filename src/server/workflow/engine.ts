import { db, type Tx } from "../db";
import { hasPermission, isExternal, requirePermission, requireUser, type Ctx } from "../context";
import { AppError, conflict, invalid, notFound, precondition } from "../errors";
import { audit } from "../audit";
import {
  conditionMatches,
  parseDefinition,
  PREREQUISITE_LABELS,
  type Facts,
  type Prerequisite,
  type WorkflowDefinition,
} from "./definition";
import { CLOSING_HARD_RULES } from "./templates";
import { addDays } from "@/lib/dates";
import type { Transaction } from "@/generated/prisma/client";
import type { MilestoneKind, TransactionStatus } from "@/generated/prisma/enums";
import { createApproval, findUsableApproval, consumeApproval } from "../services/approvals";
import { fileBalanceCents, openDisbursementCount } from "./ledger-hooks";

export const RESOLVED_TASK_STATUSES = ["DONE", "NOT_APPLICABLE", "WAIVED"] as const;
const RESOLVED = [...RESOLVED_TASK_STATUSES];

const defCache = new Map<string, WorkflowDefinition>();

export async function loadDefinition(templateVersionId: string, client: Tx | typeof db = db): Promise<WorkflowDefinition> {
  const cached = defCache.get(templateVersionId);
  if (cached) return cached;
  const v = await client.workflowTemplateVersion.findUnique({ where: { id: templateVersionId } });
  if (!v) throw notFound("Workflow template version");
  const def = parseDefinition(v.definition);
  // Published versions are immutable, so caching by id is safe.
  if (v.status !== "DRAFT") defCache.set(templateVersionId, def);
  return def;
}

/** Locks the transaction row for the remainder of the DB transaction and bumps its version. */
export async function lockAndBump(client: Tx, transactionId: string): Promise<number> {
  const rows = await client.$queryRaw<{ version: number }[]>`
    UPDATE "Transaction" SET "version" = "version" + 1, "updatedAt" = now()
    WHERE "id" = ${transactionId} RETURNING "version"`;
  if (rows.length === 0) throw notFound("Transaction");
  return rows[0].version;
}

export async function computeFacts(client: Tx | typeof db, tx: Transaction): Promise<Facts> {
  const [entityParties, parcels] = await Promise.all([
    client.participant.count({
      where: { transactionId: tx.id, partyType: { not: "INDIVIDUAL" }, role: { in: ["BUYER", "SELLER"] } },
    }),
    client.parcel.count({ where: { property: { transactionId: tx.id } } }),
  ]);
  return {
    financed: Boolean(tx.financingType && tx.financingType !== "CASH") || (tx.loanAmountCents ?? 0n) > 0n,
    hasHoa: tx.hasHoa,
    hasTenants: tx.hasTenants,
    is1031Exchange: tx.is1031Exchange,
    hasEntityParty: entityParties > 0,
    multipleParcels: parcels > 1,
  };
}

function anchorDate(tx: Transaction, anchor: "OPENED" | "ACCEPTANCE" | "CLOSING"): Date | null {
  if (anchor === "OPENED") return tx.createdAt;
  if (anchor === "ACCEPTANCE") return tx.acceptanceDate;
  return tx.proposedClosingDate;
}

/**
 * Creates template tasks that apply to the file's current facts, and marks
 * still-open template tasks NOT_APPLICABLE when facts change so they no longer
 * apply. Never deletes tasks and never touches tasks a person has worked on.
 */
export async function syncTemplateTasks(client: Tx, tx: Transaction, def: WorkflowDefinition, actorId: string | null) {
  const facts = await computeFacts(client, tx);
  const existing = await client.task.findMany({
    where: { transactionId: tx.id, templateKey: { not: null } },
    select: { id: true, templateKey: true, status: true, source: true, applicabilityNote: true },
  });
  const byKey = new Map(existing.map((e) => [e.templateKey!, e]));
  let created = 0;
  let retired = 0;
  for (const [i, tt] of def.tasks.entries()) {
    const applies = conditionMatches(tt.when, facts);
    const row = byKey.get(tt.key);
    if (applies && !row) {
      const anchor = tt.dueRule ? anchorDate(tx, tt.dueRule.anchor) : null;
      await client.task.create({
        data: {
          companyId: tx.companyId,
          transactionId: tx.id,
          templateKey: tt.key,
          title: tt.title,
          description: tt.description,
          category: tt.category,
          stage: tt.stage,
          required: tt.required,
          isBlocker: tt.isBlocker,
          requiresApproval: tt.requiresApproval,
          applicabilityNote: tt.applicabilityNote,
          assigneeUserId: tt.assigneeRole === "OFFICER" ? tx.officerId : tt.assigneeRole === "ASSISTANT" ? tx.assistantId : null,
          dueAt: anchor && tt.dueRule ? addDays(anchor, tt.dueRule.offsetDays) : null,
          source: "TEMPLATE",
          sortOrder: i,
        },
      });
      created++;
    } else if (applies && row && row.status === "NOT_APPLICABLE" && row.applicabilityNote?.startsWith("[auto]")) {
      await client.task.update({ where: { id: row.id }, data: { status: "OPEN", applicabilityNote: tt.applicabilityNote ?? null } });
    } else if (!applies && row && row.status === "OPEN") {
      await client.task.update({
        where: { id: row.id },
        data: { status: "NOT_APPLICABLE", applicabilityNote: "[auto] No longer applies to this file's facts.", completedById: actorId },
      });
      retired++;
    }
  }
  for (const m of def.milestones) {
    const applies = conditionMatches(m.when, facts);
    await client.milestone.upsert({
      where: { transactionId_kind: { transactionId: tx.id, kind: m.kind } },
      create: { companyId: tx.companyId, transactionId: tx.id, kind: m.kind, status: applies ? "NOT_STARTED" : "NOT_APPLICABLE" },
      update: {},
    });
  }
  return { created, retired };
}

export interface PrereqResult {
  type: Prerequisite["type"];
  label: string;
  met: boolean;
  overridable: boolean;
  detail: string;
}

export async function evaluatePrerequisites(
  client: Tx | typeof db,
  tx: Transaction,
  prereqs: Prerequisite[],
): Promise<PrereqResult[]> {
  const out: PrereqResult[] = [];
  for (const p of prereqs) {
    const r = await evaluateOne(client, tx, p);
    out.push({ type: p.type, label: labelFor(p), overridable: p.overridable, ...r });
  }
  return out;
}

function labelFor(p: Prerequisite): string {
  switch (p.type) {
    case "MILESTONE_COMPLETE":
      return `${p.kind.charAt(0)}${p.kind.slice(1).toLowerCase()} milestone complete`;
    case "TASKS_RESOLVED":
      return p.stages ? `Required tasks resolved (${p.stages.map(humanStage).join(", ")})` : "All required tasks resolved";
    case "DOCUMENT_ACCEPTED":
      return `${humanStage(p.category)} document accepted`;
    default:
      return PREREQUISITE_LABELS[p.type];
  }
}

function humanStage(s: string) {
  return s.replaceAll("_", " ").toLowerCase();
}

async function evaluateOne(client: Tx | typeof db, tx: Transaction, p: Prerequisite): Promise<{ met: boolean; detail: string }> {
  switch (p.type) {
    case "TASKS_RESOLVED": {
      const open = await client.task.findMany({
        where: {
          transactionId: tx.id,
          required: true,
          status: { notIn: RESOLVED },
          ...(p.stages ? { stage: { in: p.stages } } : {}),
        },
        select: { title: true },
        take: 5,
      });
      return open.length === 0
        ? { met: true, detail: "All required tasks are resolved." }
        : { met: false, detail: `Unresolved: ${open.map((t) => t.title).join("; ")}` };
    }
    case "NO_OPEN_BLOCKERS": {
      const n = await client.task.count({ where: { transactionId: tx.id, isBlocker: true, status: { notIn: RESOLVED } } });
      return n === 0 ? { met: true, detail: "No open blockers." } : { met: false, detail: `${n} open blocker(s).` };
    }
    case "MILESTONE_COMPLETE": {
      const m = await client.milestone.findUnique({ where: { transactionId_kind: { transactionId: tx.id, kind: p.kind as MilestoneKind } } });
      const ok = m && (m.status === "COMPLETE" || m.status === "NOT_APPLICABLE");
      return ok ? { met: true, detail: m!.status === "COMPLETE" ? "Complete." : "Not applicable." } : { met: false, detail: `Status: ${m?.status ?? "not tracked"}.` };
    }
    case "FIELDS_PRESENT": {
      const missing = p.fields.filter((f) => (tx as unknown as Record<string, unknown>)[f] == null);
      return missing.length === 0 ? { met: true, detail: "Present." } : { met: false, detail: `Missing: ${missing.join(", ")}` };
    }
    case "PARTICIPANT_ROLES": {
      const rows = await client.participant.findMany({ where: { transactionId: tx.id }, select: { role: true } });
      const have = new Set(rows.map((r) => r.role as string));
      const missing = p.roles.filter((r) => !have.has(r));
      return missing.length === 0 ? { met: true, detail: "Present." } : { met: false, detail: `Missing roles: ${missing.join(", ")}` };
    }
    case "PROPERTY_PRESENT": {
      const n = await client.property.count({ where: { transactionId: tx.id } });
      return n > 0 ? { met: true, detail: `${n} propert${n === 1 ? "y" : "ies"}.` } : { met: false, detail: "No property recorded." };
    }
    case "OFFICER_ASSIGNED":
      return tx.officerId ? { met: true, detail: "Assigned." } : { met: false, detail: "No escrow officer assigned." };
    case "NO_PENDING_PROPOSALS": {
      const n = await client.proposal.count({ where: { transactionId: tx.id, status: "PENDING" } });
      return n === 0 ? { met: true, detail: "None pending." } : { met: false, detail: `${n} proposal(s) awaiting review.` };
    }
    case "NO_UNRESOLVED_CONFLICTS": {
      const n = await client.proposal.count({ where: { transactionId: tx.id, status: "PENDING", isConflict: true } });
      return n === 0 ? { met: true, detail: "No conflicts." } : { met: false, detail: `${n} conflicting value(s) need a decision.` };
    }
    case "SIGNERS_APPROVED": {
      const entityCount = await client.participant.count({
        where: { transactionId: tx.id, partyType: { not: "INDIVIDUAL" }, role: { in: ["BUYER", "SELLER"] } },
      });
      if (entityCount === 0) return { met: true, detail: "No entity parties." };
      const [approved, notApproved] = await Promise.all([
        client.entitySigner.count({ where: { participant: { transactionId: tx.id }, authorityStatus: "APPROVED" } }),
        client.entitySigner.count({ where: { participant: { transactionId: tx.id }, authorityStatus: { not: "APPROVED" } } }),
      ]);
      if (approved === 0) return { met: false, detail: "Entity parties have no approved signers." };
      return notApproved === 0 ? { met: true, detail: `${approved} signer(s) approved.` } : { met: false, detail: `${notApproved} signer(s) not approved.` };
    }
    case "TITLE_EXCEPTIONS_DISPOSITIONED": {
      const n = await client.titleException.count({ where: { transactionId: tx.id, disposition: "OPEN" } });
      return n === 0 ? { met: true, detail: "All dispositioned." } : { met: false, detail: `${n} exception(s) still open.` };
    }
    case "DOCUMENT_ACCEPTED": {
      const docs = await client.document.findMany({ where: { transactionId: tx.id, category: p.category, archivedAt: null }, select: { currentVersionId: true } });
      const ids = docs.map((d) => d.currentVersionId).filter(Boolean) as string[];
      const n = ids.length ? await client.documentReview.count({ where: { versionId: { in: ids }, decision: "ACCEPTED" } }) : 0;
      return n > 0 ? { met: true, detail: "Accepted." } : { met: false, detail: "No accepted document in this category." };
    }
    case "NO_PENDING_APPROVALS": {
      const n = await client.approval.count({ where: { transactionId: tx.id, status: "PENDING", type: { not: "STAGE_TRANSITION" } } });
      return n === 0 ? { met: true, detail: "None pending." } : { met: false, detail: `${n} approval(s) pending.` };
    }
    case "DEADLINES_RESOLVED": {
      const n = await client.deadline.count({ where: { transactionId: tx.id, status: "PENDING" } });
      return n === 0 ? { met: true, detail: "All resolved." } : { met: false, detail: `${n} deadline(s) pending.` };
    }
    case "FILE_BALANCE_ZERO": {
      const bal = await fileBalanceCents(client, tx.id);
      return bal === 0n ? { met: true, detail: "File balance is zero." } : { met: false, detail: `File ledger balance is not zero (${bal} cents).` };
    }
    case "NO_OPEN_DISBURSEMENTS": {
      const n = await openDisbursementCount(client, tx.id);
      return n === 0 ? { met: true, detail: "None open." } : { met: false, detail: `${n} disbursement(s) not released or cancelled.` };
    }
  }
}

export function findTransition(def: WorkflowDefinition, from: string, to: string) {
  return def.transitions.find((t) => t.from === from && t.to === to);
}

/** Prerequisites for a move, including the non-overridable hard rules for closing. */
export function prerequisitesFor(def: WorkflowDefinition, from: string, to: string): Prerequisite[] {
  const t = findTransition(def, from, to);
  if (!t) return [];
  if (to === def.closedStage) {
    const extra = CLOSING_HARD_RULES.filter((h) => !t.prerequisites.some((p) => JSON.stringify(p) === JSON.stringify(h)));
    return [...t.prerequisites, ...extra];
  }
  return t.prerequisites;
}

export interface TransitionRequest {
  toStage: string;
  reason: string;
  expectedVersion?: number;
  override?: { justification: string };
}

export type TransitionOutcome =
  | { status: "TRANSITIONED"; version: number }
  | { status: "AWAITING_APPROVAL"; approvalId: string }
  | { status: "BLOCKED"; unmet: PrereqResult[] };

/**
 * Moves a transaction to another stage.
 * - Locks the transaction row (SELECT ... FOR UPDATE semantics via UPDATE) so
 *   concurrent changes serialize, and enforces `expectedVersion` when given.
 * - Evaluates prerequisites inside the same database transaction.
 * - An override requires `workflow.override` and a justification and can only
 *   bypass overridable prerequisites; the hard closing rules never yield.
 * - Transitions marked requiresApproval need an APPROVED approval from someone
 *   other than the requester before they execute.
 */
export async function transitionStage(ctx: Ctx, transactionId: string, req: TransitionRequest): Promise<TransitionOutcome> {
  if (isExternal(ctx)) throw notFound("Transaction");
  requirePermission(ctx, "workflow.transition");
  const actorId = requireUser(ctx);
  const reason = req.reason?.trim();
  if (!reason || reason.length < 3) throw invalid("A reason is required for every stage change.");
  if (req.override) {
    requirePermission(ctx, "workflow.override");
    if (!req.override.justification || req.override.justification.trim().length < 10) {
      throw invalid("An override requires a justification of at least 10 characters.");
    }
  }

  return db.$transaction(async (client) => {
    const locked = await client.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Transaction" WHERE "id" = ${transactionId} AND "companyId" = ${ctx.companyId} FOR UPDATE`;
    if (locked.length === 0) throw notFound("Transaction");
    const tx = await client.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    if (req.expectedVersion !== undefined && tx.version !== req.expectedVersion) {
      throw conflict("This file was changed by someone else. Reload and try again.", { currentVersion: tx.version });
    }
    if (tx.status !== "ACTIVE") throw precondition(`File is ${tx.status.toLowerCase().replace("_", " ")}; stage changes are not allowed.`);
    const def = await loadDefinition(tx.templateVersionId, client);
    const t = findTransition(def, tx.stage, req.toStage);
    if (!t) throw precondition(`Moving from ${tx.stage} to ${req.toStage} is not an allowed transition.`);

    const results = await evaluatePrerequisites(client, tx, prerequisitesFor(def, tx.stage, req.toStage));
    const unmet = results.filter((r) => !r.met);
    const hardUnmet = unmet.filter((r) => !r.overridable);
    if (hardUnmet.length > 0 || (unmet.length > 0 && !req.override)) {
      return { status: "BLOCKED" as const, unmet };
    }

    const binding = { transactionId: tx.id, fromStage: tx.stage, toStage: req.toStage, templateVersionId: tx.templateVersionId };
    let approvalId: string | null = null;
    if (t.requiresApproval) {
      const usable = await findUsableApproval(client, ctx, "STAGE_TRANSITION", "TransactionStage", tx.id, binding);
      if (!usable) {
        const pending = await client.approval.findFirst({
          where: { companyId: ctx.companyId, type: "STAGE_TRANSITION", subjectId: tx.id, status: "PENDING" },
        });
        if (pending) return { status: "AWAITING_APPROVAL" as const, approvalId: pending.id };
        const a = await createApproval(client, ctx, {
          type: "STAGE_TRANSITION",
          transactionId: tx.id,
          title: `Move ${tx.escrowNumber} to ${stageLabel(def, req.toStage)}`,
          summary: `Requested reason: ${reason}${req.override ? ` | Override justification: ${req.override.justification}` : ""}`,
          subjectType: "TransactionStage",
          subjectId: tx.id,
          binding: { ...binding, reason, override: req.override?.justification ?? null },
          bindingKey: binding,
          requiredPermission: t.approverPermission,
        });
        return { status: "AWAITING_APPROVAL" as const, approvalId: a.id };
      }
      approvalId = usable.id;
      await consumeApproval(client, usable.id);
    }

    const toClosed = req.toStage === def.closedStage;
    const version = await lockAndBump(client, tx.id);
    await client.transaction.update({
      where: { id: tx.id },
      data: {
        stage: req.toStage,
        stageEnteredAt: new Date(),
        ...(toClosed ? { status: "CLOSED", closedAt: new Date() } : {}),
      },
    });
    const overridden = unmet.length > 0;
    await client.stageTransition.create({
      data: {
        companyId: ctx.companyId,
        transactionId: tx.id,
        kind: toClosed ? "CLOSE" : "ADVANCE",
        fromStage: tx.stage,
        toStage: req.toStage,
        fromStatus: tx.status,
        toStatus: toClosed ? "CLOSED" : tx.status,
        reason,
        actorId,
        overridden,
        overrideJustification: overridden ? req.override!.justification : null,
        unmetPrerequisites: overridden ? (unmet as unknown as object) : undefined,
        approvalId,
        templateVersionId: tx.templateVersionId,
        transactionVersion: version,
      },
    });
    await audit(
      ctx,
      {
        action: overridden ? "workflow.transition.override" : "workflow.transition",
        entityType: "Transaction",
        entityId: tx.id,
        entityVersion: version,
        transactionId: tx.id,
        summary: `${overridden ? "Override: " : ""}${stageLabel(def, tx.stage)} → ${stageLabel(def, req.toStage)}`,
        details: { reason, approvalId, unmet: overridden ? unmet.map((u) => u.label) : undefined, justification: req.override?.justification },
      },
      client,
    );
    return { status: "TRANSITIONED" as const, version };
  });
}

export function stageLabel(def: WorkflowDefinition, key: string) {
  return def.stages.find((s) => s.key === key)?.label ?? key;
}

type StatusChange = "HOLD" | "RESUME" | "CANCEL" | "REOPEN";

/** Hold, resume, cancel and reopen are status changes recorded like transitions. */
export async function changeStatus(
  ctx: Ctx,
  transactionId: string,
  kind: StatusChange,
  reason: string,
  opts: { expectedVersion?: number; reopenStage?: string } = {},
) {
  if (isExternal(ctx)) throw notFound("Transaction");
  const actorId = requireUser(ctx);
  const perm = kind === "HOLD" || kind === "RESUME" ? "workflow.hold" : kind === "CANCEL" ? "workflow.cancel" : "workflow.reopen";
  requirePermission(ctx, perm);
  if (!reason || reason.trim().length < 3) throw invalid("A reason is required.");

  return db.$transaction(async (client) => {
    const locked = await client.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Transaction" WHERE "id" = ${transactionId} AND "companyId" = ${ctx.companyId} FOR UPDATE`;
    if (locked.length === 0) throw notFound("Transaction");
    const tx = await client.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== tx.version) {
      throw conflict("This file was changed by someone else. Reload and try again.");
    }
    const def = await loadDefinition(tx.templateVersionId, client);
    const allowed: Record<StatusChange, TransactionStatus[]> = {
      HOLD: ["ACTIVE"],
      RESUME: ["ON_HOLD"],
      CANCEL: ["ACTIVE", "ON_HOLD"],
      REOPEN: ["CLOSED", "CANCELLED"],
    };
    if (!allowed[kind].includes(tx.status)) throw precondition(`Cannot ${kind.toLowerCase()} a file that is ${tx.status.toLowerCase()}.`);
    const toStatus: TransactionStatus = kind === "HOLD" ? "ON_HOLD" : kind === "CANCEL" ? "CANCELLED" : "ACTIVE";
    let toStage = tx.stage;
    if (kind === "REOPEN") {
      toStage = opts.reopenStage ?? def.reopenStage;
      if (!def.stages.some((s) => s.key === toStage) || toStage === def.closedStage) throw invalid("Choose a valid stage to reopen into.");
    }
    const version = await lockAndBump(client, tx.id);
    await client.transaction.update({
      where: { id: tx.id },
      data: {
        status: toStatus,
        stage: toStage,
        ...(kind === "HOLD" ? { holdReason: reason } : {}),
        ...(kind === "RESUME" ? { holdReason: null } : {}),
        ...(kind === "CANCEL" ? { cancelReason: reason } : {}),
        ...(kind === "REOPEN" ? { closedAt: null, cancelReason: null } : {}),
        ...(toStage !== tx.stage ? { stageEnteredAt: new Date() } : {}),
      },
    });
    await client.stageTransition.create({
      data: {
        companyId: ctx.companyId,
        transactionId: tx.id,
        kind,
        fromStage: tx.stage,
        toStage,
        fromStatus: tx.status,
        toStatus,
        reason,
        actorId,
        templateVersionId: tx.templateVersionId,
        transactionVersion: version,
      },
    });
    await audit(
      ctx,
      {
        action: `workflow.${kind.toLowerCase()}`,
        entityType: "Transaction",
        entityId: tx.id,
        entityVersion: version,
        transactionId: tx.id,
        summary: `File ${kind === "HOLD" ? "placed on hold" : kind === "RESUME" ? "resumed" : kind === "CANCEL" ? "cancelled" : "reopened"}`,
        details: { reason, toStage },
      },
      client,
    );
    return { version };
  });
}

/** Read-only view of what each outgoing transition currently needs. */
export async function availableTransitions(ctx: Ctx, transactionId: string) {
  if (isExternal(ctx)) throw notFound("Transaction");
  requirePermission(ctx, "transaction.read");
  const tx = await db.transaction.findFirst({ where: { id: transactionId, companyId: ctx.companyId } });
  if (!tx) throw notFound("Transaction");
  const def = await loadDefinition(tx.templateVersionId);
  const outgoing = def.transitions.filter((t) => t.from === tx.stage);
  const canOverride = hasPermission(ctx, "workflow.override");
  return Promise.all(
    outgoing.map(async (t) => {
      const results = await evaluatePrerequisites(db, tx, prerequisitesFor(def, t.from, t.to));
      return {
        to: t.to,
        label: t.label ?? `Move to ${stageLabel(def, t.to)}`,
        requiresApproval: t.requiresApproval,
        results,
        ready: results.every((r) => r.met),
        overridePossible: canOverride && results.every((r) => r.met || r.overridable),
      };
    }),
  );
}

/** Used by the approval inbox after a STAGE_TRANSITION approval is granted. */
export async function executeApprovedTransition(ctx: Ctx, approvalSnapshot: { transactionId: string; toStage: string; reason: string; override: string | null }) {
  try {
    return await transitionStage(ctx, approvalSnapshot.transactionId, {
      toStage: approvalSnapshot.toStage,
      reason: `${approvalSnapshot.reason} (approved)`,
      override: approvalSnapshot.override ? { justification: approvalSnapshot.override } : undefined,
    });
  } catch (e) {
    if (e instanceof AppError && e.code === "FORBIDDEN") {
      // The approver may lack override permission; the requester can execute later.
      return { status: "BLOCKED" as const, unmet: [] };
    }
    throw e;
  }
}
