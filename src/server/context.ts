import type { Role } from "@/generated/prisma/enums";
import { assertCan, can, type ActorRole, type Permission } from "./authz";
import { AppError } from "./errors";

/**
 * Who is acting, on behalf of which tenant. Every service function takes a Ctx
 * as its first argument; the Ctx is built server-side from the session (never
 * from client input) or by the job runner for system actors.
 */
export interface Ctx {
  actorType: "USER" | "SYSTEM" | "JOB" | "WEBHOOK" | "AI";
  userId: string | null;
  userName?: string;
  companyId: string;
  role: ActorRole;
  sessionId?: string;
  ip?: string;
  userAgent?: string;
}

export function isExternal(ctx: Ctx) {
  return ctx.role === "EXTERNAL";
}

export function isStaff(ctx: Ctx) {
  return ctx.role !== "EXTERNAL" && ctx.role !== "SYSTEM";
}

export function requirePermission(ctx: Ctx, permission: Permission) {
  assertCan(ctx.role, permission);
}

export function hasPermission(ctx: Ctx, permission: Permission) {
  return can(ctx.role, permission);
}

export function requireUser(ctx: Ctx): string {
  if (!ctx.userId) throw new AppError("FORBIDDEN", "This action requires a signed-in user.");
  return ctx.userId;
}

export function systemCtx(companyId: string, label = "system", actorType: Ctx["actorType"] = "SYSTEM"): Ctx {
  return { actorType, userId: null, userName: label, companyId, role: "SYSTEM" };
}

export function userCtx(input: {
  userId: string;
  companyId: string;
  role: Role;
  userName?: string;
  sessionId?: string;
  ip?: string;
  userAgent?: string;
}): Ctx {
  return { actorType: "USER", ...input };
}
