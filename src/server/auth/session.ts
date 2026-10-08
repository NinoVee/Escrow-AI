import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "./auth";
import { db } from "../db";
import { userCtx, type Ctx } from "../context";
import type { Role } from "@/generated/prisma/enums";
import { AppError } from "../errors";

export const ACTIVE_COMPANY_COOKIE = "ef_company";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  twoFactorEnabled: boolean;
  sessionId: string;
}

export interface MembershipSummary {
  companyId: string;
  companyName: string;
  role: Role;
}

/** Reads the Better Auth session. Memoized per request. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session) return null;
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    twoFactorEnabled: Boolean((session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled),
    sessionId: session.session.id,
  };
});

export const getMemberships = cache(async (userId: string): Promise<MembershipSummary[]> => {
  const rows = await db.membership.findMany({
    where: { userId, status: "ACTIVE" },
    include: { company: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((m) => ({ companyId: m.companyId, companyName: m.company.name, role: m.role }));
});

/**
 * Builds the actor context for this request. The active company comes from a
 * cookie but is only honored if the user has an ACTIVE membership there.
 */
export const getCtx = cache(async (): Promise<Ctx | null> => {
  const user = await getSessionUser();
  if (!user) return null;
  const memberships = await getMemberships(user.id);
  if (memberships.length === 0) return null;
  const wanted = (await cookies()).get(ACTIVE_COMPANY_COOKIE)?.value;
  const m = memberships.find((x) => x.companyId === wanted) ?? memberships[0];
  const h = await headers();
  return userCtx({
    userId: user.id,
    userName: user.name,
    companyId: m.companyId,
    role: m.role,
    sessionId: user.sessionId,
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    userAgent: h.get("user-agent") ?? undefined,
  });
});

/** For staff pages: redirects to sign-in or the portal as appropriate. */
export async function requireStaffCtx(): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) {
    const user = await getSessionUser();
    redirect(user ? "/no-access" : "/sign-in");
  }
  if (ctx.role === "EXTERNAL") redirect("/portal");
  const user = await getSessionUser();
  if (user && !user.twoFactorEnabled && (await staffMfaRequired(ctx.companyId))) {
    redirect("/account/security?required=1");
  }
  return ctx;
}

/** For portal pages. Staff may not use the participant portal as a participant. */
export async function requirePortalCtx(): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) redirect("/sign-in");
  if (ctx.role !== "EXTERNAL") redirect("/dashboard");
  return ctx;
}

/** For server actions and route handlers: throws instead of redirecting. */
export async function ctxOrThrow(): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) throw new AppError("UNAUTHENTICATED", "Please sign in again.");
  return ctx;
}

async function staffMfaRequired(companyId: string): Promise<boolean> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { settings: true } });
  const s = (company?.settings ?? {}) as { requireStaffMfa?: boolean };
  return s.requireStaffMfa !== false;
}
