"use client";

import { ActionForm } from "@/components/action-form";
import { InviteResult } from "../../transactions/[id]/parties/invite-result";
import { inviteStaffAction } from "../actions";

export function InviteStaffForm({ children }: { children: React.ReactNode }) {
  return (
    <ActionForm action={inviteStaffAction} submitLabel="Create invitation" renderResult={(d) => (d?.inviteUrl ? <InviteResult path={d.inviteUrl} /> : null)}>
      {children}
    </ActionForm>
  );
}
