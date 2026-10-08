"use server";

import { acceptInvitation, lookupInvitation } from "@/server/services/users";
import { isAppError } from "@/server/errors";
import type { ActionState } from "@/lib/action-types";

export async function acceptInviteAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const token = String(fd.get("token") ?? "");
  const password = String(fd.get("password") ?? "");
  const confirm = String(fd.get("confirm") ?? "");
  try {
    const inv = await lookupInvitation(token);
    if (!inv) return { ok: false, error: "This invitation is invalid or has expired." };
    if (!inv.hasAccount && password !== confirm) return { ok: false, error: "Passwords do not match." };
    await acceptInvitation(token, password);
    return { ok: true, message: "Invitation accepted. You can now sign in." };
  } catch (e) {
    return { ok: false, error: isAppError(e) ? e.message : "Could not accept the invitation." };
  }
}
