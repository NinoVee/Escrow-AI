import type { Role } from "@/generated/prisma/enums";
import { forbidden } from "./errors";

/**
 * Server-side permission matrix. UI hides controls using the same matrix, but
 * every service function re-checks with `requirePermission`; hiding a button is
 * never the security boundary.
 */
export const PERMISSIONS = [
  "transaction.read",
  "transaction.create",
  "transaction.update",
  "workflow.transition",
  "workflow.hold",
  "workflow.cancel",
  "workflow.reopen",
  "workflow.override",
  "task.manage",
  "task.waive",
  "deadline.manage",
  "milestone.update",
  "milestone.confirm_funding",
  "participant.manage",
  "portal.invite",
  "signer.review",
  "document.read_internal",
  "document.upload",
  "document.review",
  "document.share",
  "document.legal_hold",
  "title.manage",
  "proposal.review",
  "ai.use",
  "approval.stage",
  "comms.draft",
  "comms.approve_send",
  "ledger.read",
  "ledger.post",
  "recon.prepare",
  "recon.review",
  "bank.view_masked",
  "bank.create",
  "bank.reveal",
  "bank.verify",
  "disbursement.prepare",
  "disbursement.approve",
  "disbursement.release",
  "settings.manage",
  "users.manage",
  "templates.manage",
  "integrations.manage",
  "automation.manage",
  "jobs.manage",
  "audit.read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Non-human actors (background jobs, automation). Deliberately narrow. */
export type ActorRole = Role | "SYSTEM";

const OFFICER: Permission[] = [
  "transaction.read",
  "transaction.create",
  "transaction.update",
  "workflow.transition",
  "workflow.hold",
  "workflow.cancel",
  "task.manage",
  "task.waive",
  "deadline.manage",
  "milestone.update",
  "milestone.confirm_funding",
  "participant.manage",
  "portal.invite",
  "signer.review",
  "document.read_internal",
  "document.upload",
  "document.review",
  "document.share",
  "title.manage",
  "proposal.review",
  "ai.use",
  "approval.stage",
  "comms.draft",
  "comms.approve_send",
  "ledger.read",
  "bank.view_masked",
  "bank.create",
  "bank.verify",
  "disbursement.prepare",
  "disbursement.approve",
  "audit.read",
];

const ASSISTANT: Permission[] = [
  "transaction.read",
  "transaction.create",
  "transaction.update",
  "workflow.transition",
  "task.manage",
  "deadline.manage",
  "milestone.update",
  "participant.manage",
  "document.read_internal",
  "document.upload",
  "document.share",
  "title.manage",
  "ai.use",
  "comms.draft",
  "ledger.read",
  "bank.view_masked",
  "disbursement.prepare",
];

const ACCOUNTING: Permission[] = [
  "transaction.read",
  "document.read_internal",
  "document.upload",
  "milestone.confirm_funding",
  "ai.use",
  "ledger.read",
  "ledger.post",
  "recon.prepare",
  "recon.review",
  "bank.view_masked",
  "bank.create",
  "bank.reveal",
  "bank.verify",
  "disbursement.prepare",
  "disbursement.approve",
  "disbursement.release",
  "audit.read",
];

const MANAGER: Permission[] = [
  "transaction.read",
  "transaction.update",
  "workflow.transition",
  "workflow.hold",
  "workflow.cancel",
  "workflow.reopen",
  "workflow.override",
  "task.manage",
  "task.waive",
  "deadline.manage",
  "milestone.update",
  "signer.review",
  "document.read_internal",
  "document.review",
  "document.legal_hold",
  "proposal.review",
  "ai.use",
  "approval.stage",
  "comms.approve_send",
  "ledger.read",
  "recon.review",
  "bank.view_masked",
  "disbursement.approve",
  "audit.read",
];

const SYSTEM: Permission[] = [
  "transaction.read",
  "document.read_internal",
  "deadline.manage",
  "comms.draft",
  "task.manage",
];

const MATRIX: Record<ActorRole, ReadonlySet<Permission>> = {
  COMPANY_ADMIN: new Set(PERMISSIONS),
  ESCROW_OFFICER: new Set(OFFICER),
  ESCROW_ASSISTANT: new Set(ASSISTANT),
  ACCOUNTING: new Set(ACCOUNTING),
  MANAGER: new Set(MANAGER),
  EXTERNAL: new Set(),
  SYSTEM: new Set(SYSTEM),
};

export function can(role: ActorRole, permission: Permission): boolean {
  return MATRIX[role]?.has(permission) ?? false;
}

export function permissionsFor(role: ActorRole): Permission[] {
  return [...(MATRIX[role] ?? [])];
}

export function assertCan(role: ActorRole, permission: Permission) {
  if (!can(role, permission)) throw forbidden();
}

export const ROLE_LABELS: Record<Role, string> = {
  COMPANY_ADMIN: "Company administrator",
  ESCROW_OFFICER: "Escrow officer",
  ESCROW_ASSISTANT: "Escrow assistant",
  ACCOUNTING: "Accounting",
  MANAGER: "Manager / reviewer",
  EXTERNAL: "External participant",
};
