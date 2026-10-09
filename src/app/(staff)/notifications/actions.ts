"use server";

import { runAction } from "@/server/action";
import { markNotificationsRead } from "@/server/services/operations";
import type { ActionState } from "@/lib/action-types";

export async function markReadAction(_prev: ActionState): Promise<ActionState> {
  return runAction(async (ctx) => {
    await markNotificationsRead(ctx);
    return { message: "Marked as read." };
  }, ["/notifications"]);
}
