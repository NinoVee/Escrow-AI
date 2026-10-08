"use server";

import { bool, num, optStr, runAction, str } from "@/server/action";
import { updateCompanySettings } from "@/server/services/company";
import { inviteStaff, setMembership } from "@/server/services/users";
import { createDraftVersion, publishVersion, saveDraftDefinition } from "@/server/services/templates";
import type { ActionState } from "@/lib/action-types";
import type { Role } from "@/generated/prisma/enums";

export async function saveSettingsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await updateCompanySettings(ctx, {
      name: optStr(fd, "name"),
      requireStaffMfa: bool(fd, "requireStaffMfa"),
      stepUpWindowMinutes: num(fd, "stepUpWindowMinutes") ?? 10,
      externalSendingEnabled: bool(fd, "externalSendingEnabled"),
      timezone: str(fd, "timezone") || "America/Los_Angeles",
      escrowNumberPrefix: str(fd, "escrowNumberPrefix") || "ESC",
      retentionYearsAfterClose: num(fd, "retentionYearsAfterClose") ?? 7,
      requireIndependentBankVerification: bool(fd, "requireIndependentBankVerification"),
      prorationBasis: (str(fd, "prorationBasis") || "ACTUAL_365") as "ACTUAL_365",
      prorationSellerOwnsClosingDay: bool(fd, "prorationSellerOwnsClosingDay"),
      roundingMode: (str(fd, "roundingMode") || "HALF_UP") as "HALF_UP",
      procedures: {
        requireOfficerReviewOfAmendments: bool(fd, "requireOfficerReviewOfAmendments"),
        requireDocumentReviewBeforeSharing: bool(fd, "requireDocumentReviewBeforeSharing"),
      },
    });
    return { message: "Settings saved." };
  }, ["/settings"]);
}

export async function inviteStaffAction(_prev: ActionState, fd: FormData): Promise<ActionState<{ inviteUrl?: string }>> {
  return runAction(async (ctx) => {
    const res = await inviteStaff(ctx, { email: str(fd, "email"), name: str(fd, "name"), role: str(fd, "role") as Role });
    return { message: "Invitation created. Deliver this one-time link securely; it expires in 7 days.", data: { inviteUrl: res.inviteUrl } };
  }, ["/settings/users"]);
}

export async function membershipAction(membershipId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await setMembership(ctx, membershipId, { role: (optStr(fd, "role") as Role) ?? undefined, status: (optStr(fd, "status") as "ACTIVE") ?? undefined });
    return { message: "Saved." };
  }, ["/settings/users"]);
}

export async function newDraftAction(templateId: string, fromVersionId: string, _prev: ActionState): Promise<ActionState<{ id: string }>> {
  return runAction(async (ctx) => {
    const v = await createDraftVersion(ctx, templateId, fromVersionId);
    return { message: `Draft v${v.version} ready.`, data: { id: v.id } };
  }, ["/settings/templates"]);
}

export async function saveDraftAction(versionId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await saveDraftDefinition(ctx, versionId, str(fd, "definition"), optStr(fd, "changeNote"));
    return { message: "Draft saved and validated." };
  }, ["/settings/templates"]);
}

export async function publishAction(versionId: string, _prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    await publishVersion(ctx, versionId);
    return { message: "Published. New files use this version; existing files keep theirs." };
  }, ["/settings/templates"]);
}
