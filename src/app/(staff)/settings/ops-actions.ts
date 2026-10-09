"use server";

import { bool, num, runAction, str } from "@/server/action";
import { setIntegrationMode, type IntegrationKind } from "@/server/integrations/registry";
import { approveTemplate, updateRule, updateTemplate } from "@/server/services/automation";
import { replayJobForCompany } from "@/server/services/operations";
import type { ActionState } from "@/lib/action-types";
import type { IntegrationMode } from "@/generated/prisma/enums";

export async function integrationModeAction(kind: IntegrationKind, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await setIntegrationMode(ctx, kind, str(fd, "mode") as IntegrationMode);
    return { message: "Saved." };
  }, ["/settings/integrations"]);
}

export async function ruleAction(ruleId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await updateRule(ctx, ruleId, { enabled: bool(fd, "enabled"), mode: str(fd, "mode") === "AUTO_SEND" ? "AUTO_SEND" : "DRAFT_FOR_REVIEW", daysBefore: num(fd, "daysBefore"), daysOverdue: num(fd, "daysOverdue") });
    return { message: "Rule saved." };
  }, ["/settings/automation"]);
}

export async function templateEditAction(templateId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await updateTemplate(ctx, templateId, { subject: str(fd, "subject"), body: str(fd, "body") });
    return { message: "Template saved. Another person with send authority must approve it before automatic use." };
  }, ["/settings/automation"]);
}

export async function templateApproveAction(templateId: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    await approveTemplate(ctx, templateId);
    return { message: "Template approved." };
  }, ["/settings/automation"]);
}

export async function replayAction(jobRunId: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    await replayJobForCompany(ctx, jobRunId);
    return { message: "Job re-queued." };
  }, ["/settings/jobs"]);
}
