import { z } from "zod";

/**
 * Workflow template definition. Stored as JSON on WorkflowTemplateVersion and
 * validated with this schema on every read and publish. Published versions are
 * immutable; transactions stay pinned to the version they were opened with.
 */

export const MilestoneKindSchema = z.enum(["SIGNING", "FUNDING", "RECORDING", "DISBURSEMENT"]);

export const ConditionSchema = z
  .object({
    financed: z.boolean().optional(),
    hasHoa: z.boolean().optional(),
    hasTenants: z.boolean().optional(),
    is1031Exchange: z.boolean().optional(),
    hasEntityParty: z.boolean().optional(),
    multipleParcels: z.boolean().optional(),
  })
  .strict();
export type Condition = z.infer<typeof ConditionSchema>;

const base = { overridable: z.boolean().default(true) };

export const PrerequisiteSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("TASKS_RESOLVED"), stages: z.array(z.string()).optional(), ...base }),
  z.object({ type: z.literal("NO_OPEN_BLOCKERS"), ...base }),
  z.object({ type: z.literal("MILESTONE_COMPLETE"), kind: MilestoneKindSchema, ...base }),
  z.object({ type: z.literal("FIELDS_PRESENT"), fields: z.array(z.string()).min(1), ...base }),
  z.object({ type: z.literal("PARTICIPANT_ROLES"), roles: z.array(z.string()).min(1), ...base }),
  z.object({ type: z.literal("PROPERTY_PRESENT"), ...base }),
  z.object({ type: z.literal("OFFICER_ASSIGNED"), ...base }),
  z.object({ type: z.literal("NO_PENDING_PROPOSALS"), ...base }),
  z.object({ type: z.literal("NO_UNRESOLVED_CONFLICTS"), ...base }),
  z.object({ type: z.literal("SIGNERS_APPROVED"), ...base }),
  z.object({ type: z.literal("TITLE_EXCEPTIONS_DISPOSITIONED"), ...base }),
  z.object({ type: z.literal("DOCUMENT_ACCEPTED"), category: z.string(), ...base }),
  z.object({ type: z.literal("NO_PENDING_APPROVALS"), ...base }),
  z.object({ type: z.literal("DEADLINES_RESOLVED"), ...base }),
  z.object({ type: z.literal("FILE_BALANCE_ZERO"), ...base }),
  z.object({ type: z.literal("NO_OPEN_DISBURSEMENTS"), ...base }),
]);
export type Prerequisite = z.infer<typeof PrerequisiteSchema>;

export const StageSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  label: z.string(),
  description: z.string().optional(),
});

export const TransitionSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  prerequisites: z.array(PrerequisiteSchema).default([]),
  requiresApproval: z.boolean().default(false),
  approverPermission: z.string().default("approval.stage"),
});

export const DueRuleSchema = z.object({
  anchor: z.enum(["OPENED", "ACCEPTANCE", "CLOSING"]),
  offsetDays: z.number().int(),
});

export const TaskTemplateSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  description: z.string().optional(),
  category: z.string().default("GENERAL"),
  stage: z.string(),
  required: z.boolean().default(false),
  isBlocker: z.boolean().default(false),
  requiresApproval: z.boolean().default(false),
  when: ConditionSchema.optional(),
  applicabilityNote: z.string().optional(),
  dueRule: DueRuleSchema.optional(),
  assigneeRole: z.enum(["OFFICER", "ASSISTANT"]).optional(),
});
export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;

export const MilestoneTemplateSchema = z.object({
  kind: MilestoneKindSchema,
  when: ConditionSchema.optional(),
});

export const WorkflowDefinitionSchema = z
  .object({
    stages: z.array(StageSchema).min(2),
    initialStage: z.string(),
    closedStage: z.string(),
    reopenStage: z.string(),
    transitions: z.array(TransitionSchema).min(1),
    tasks: z.array(TaskTemplateSchema),
    milestones: z.array(MilestoneTemplateSchema),
    disclaimer: z.string().optional(),
  })
  .superRefine((def, ctx) => {
    const keys = new Set(def.stages.map((s) => s.key));
    if (keys.size !== def.stages.length) ctx.addIssue({ code: "custom", message: "Duplicate stage keys" });
    for (const k of [def.initialStage, def.closedStage, def.reopenStage]) {
      if (!keys.has(k)) ctx.addIssue({ code: "custom", message: `Unknown stage ${k}` });
    }
    for (const t of def.transitions) {
      if (!keys.has(t.from) || !keys.has(t.to)) {
        ctx.addIssue({ code: "custom", message: `Transition ${t.from}→${t.to} references unknown stage` });
      }
    }
    const taskKeys = new Set<string>();
    for (const t of def.tasks) {
      if (!keys.has(t.stage)) ctx.addIssue({ code: "custom", message: `Task ${t.key} has unknown stage ${t.stage}` });
      if (taskKeys.has(t.key)) ctx.addIssue({ code: "custom", message: `Duplicate task key ${t.key}` });
      taskKeys.add(t.key);
    }
  });

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export function parseDefinition(raw: unknown): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse(raw);
}

export interface Facts {
  financed: boolean;
  hasHoa: boolean;
  hasTenants: boolean;
  is1031Exchange: boolean;
  hasEntityParty: boolean;
  multipleParcels: boolean;
}

export function conditionMatches(cond: Condition | undefined, facts: Facts): boolean {
  if (!cond) return true;
  return (Object.keys(cond) as (keyof Condition)[]).every((k) => cond[k] === undefined || cond[k] === facts[k]);
}

export const PREREQUISITE_LABELS: Record<Prerequisite["type"], string> = {
  TASKS_RESOLVED: "Required tasks resolved",
  NO_OPEN_BLOCKERS: "No open blockers",
  MILESTONE_COMPLETE: "Milestone complete",
  FIELDS_PRESENT: "Required fields accepted",
  PARTICIPANT_ROLES: "Required participants added",
  PROPERTY_PRESENT: "Property recorded",
  OFFICER_ASSIGNED: "Escrow officer assigned",
  NO_PENDING_PROPOSALS: "No unreviewed AI proposals",
  NO_UNRESOLVED_CONFLICTS: "No unresolved data conflicts",
  SIGNERS_APPROVED: "Entity signing authority approved",
  TITLE_EXCEPTIONS_DISPOSITIONED: "Title exceptions dispositioned",
  DOCUMENT_ACCEPTED: "Document reviewed and accepted",
  NO_PENDING_APPROVALS: "No pending approvals",
  DEADLINES_RESOLVED: "Deadlines resolved",
  FILE_BALANCE_ZERO: "Escrow file ledger balance is zero",
  NO_OPEN_DISBURSEMENTS: "No unreleased disbursements",
};
