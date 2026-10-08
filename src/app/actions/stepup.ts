"use server";

import { headers } from "next/headers";
import { runAction, str } from "@/server/action";
import { verifyStepUp } from "@/server/auth/stepup";
import type { ActionState } from "@/lib/action-types";

export async function stepUpAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await verifyStepUp(ctx, str(fd, "code"), await headers());
    return { message: "Verified" };
  });
}
