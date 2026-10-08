import "server-only";
import { revalidatePath } from "next/cache";
import { ctxOrThrow } from "./auth/session";
import { isAppError, publicMessage } from "./errors";
import { log } from "./logger";
import type { Ctx } from "./context";

export type ActionResult<T = unknown> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; error: string; code?: string; details?: unknown };

export const INITIAL: ActionResult = { ok: true };

/**
 * Wraps a server action body: builds the actor context from the session,
 * converts AppErrors into user-facing messages, logs unexpected errors
 * (redacted), and revalidates paths on success.
 */
export async function runAction<T>(
  fn: (ctx: Ctx) => Promise<{ message?: string; data?: T } | void>,
  revalidate: string[] = [],
): Promise<ActionResult<T>> {
  try {
    const ctx = await ctxOrThrow();
    const res = (await fn(ctx)) ?? {};
    for (const p of revalidate) revalidatePath(p, "layout");
    return { ok: true, message: res.message, data: res.data };
  } catch (e) {
    if (isAppError(e)) return { ok: false, error: e.message, code: e.code, details: e.details };
    // Next.js redirect/notFound errors must propagate.
    if (e && typeof e === "object" && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_")) throw e;
    log.error("Unhandled server action error", { error: e });
    return { ok: false, error: publicMessage(e) };
  }
}

export function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

export function optStr(fd: FormData, key: string): string | undefined {
  const v = str(fd, key).trim();
  return v === "" ? undefined : v;
}

export function bool(fd: FormData, key: string): boolean {
  const v = fd.get(key);
  return v === "on" || v === "true" || v === "1";
}

export function num(fd: FormData, key: string): number | undefined {
  const v = optStr(fd, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
